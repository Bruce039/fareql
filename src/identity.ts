import { PricingError, formatUnits } from './price.js'

/**
 * The outcome of an identity check, structurally compatible with `mppx/identity` verifiers.
 * `valid` carries the verified value; `missing` means no proof was presented; any other
 * status means a proof was presented and refused.
 */
export type IdentityVerification =
  | { status: 'valid'; value: unknown }
  | { status: 'missing'; code?: number | undefined; reason?: string | undefined }
  | { status: string; code?: number | undefined; reason?: string | undefined }

/**
 * An identity verifier: any `mppx/identity` verifier (`Identity.from`, `EmailOtp.Server.verifier`,
 * `WebBotAuth.Server.verifier`, `Identity.anyOf(...)`) or your own object with this shape.
 * Only request-stage verifiers can price a request, since they run before any Challenge exists.
 */
export type IdentityVerifier = {
  stage?: 'request' | 'payment' | undefined
  verify: (request: Request, context: Record<string, never>) => IdentityVerification | Promise<IdentityVerification>
}

/** One identity tier: callers whose proof `verifier` accepts pay the base price times `multiplier`. */
export type Tier = {
  /** Shown in 402 bodies and bound into the Challenge scope. Letters, digits, `_` and `-`; not `anonymous`. */
  name: string
  verifier: IdentityVerifier
  /** Decimal string applied to the base price, e.g. "0.5". "0" makes the operation free for this tier. */
  multiplier: string
}

export type TierOptions = {
  /** Best first: the first tier whose verifier accepts the request sets the price. */
  tiers?: readonly Tier[]
  /** Let callers without any proof pay the base price. Default: true. With false they get a 401. */
  anonymous?: boolean
}

/** The tier a request resolved to; `anonymous` when no tier matched. */
export type ResolvedTier = { name: string; multiplier: string; value?: unknown }

export const ANONYMOUS: ResolvedTier = { name: 'anonymous', multiplier: '1' }

/** A presented proof was refused, or a proof is required and none was presented. */
export class IdentityError extends PricingError {
  override name = 'IdentityError'
  constructor(
    message: string,
    readonly status: 401 | 403 | 503,
  ) {
    super(message, status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'FORBIDDEN' : 'IDENTITY_UNAVAILABLE')
  }
}

/** HTTP status for a refused operation: identity errors carry their own, pricing errors are 400. */
export function errorStatus(error: PricingError): number {
  return error instanceof IdentityError ? error.status : 400
}

const TIER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const MULTIPLIER = /^(\d{1,9})(?:\.(\d{1,18}))?$/

type Checked = { tiers: readonly Tier[]; ratios: Map<Tier, [bigint, bigint]> }
const checked = new WeakMap<readonly Tier[], Checked>()

/** Validates tier configuration once per tiers array. Misconfiguration throws: it is a server bug, not a client error. */
function check(tiers: readonly Tier[]): Checked {
  const hit = checked.get(tiers)
  if (hit) return hit
  const names = new Set<string>()
  const ratios = new Map<Tier, [bigint, bigint]>()
  for (const tier of tiers) {
    if (!TIER_NAME.test(tier.name) || tier.name === 'anonymous') throw new Error(`fareql: invalid tier name "${tier.name}"`)
    if (names.has(tier.name)) throw new Error(`fareql: duplicate tier name "${tier.name}"`)
    names.add(tier.name)
    if (typeof tier.verifier?.verify !== 'function') throw new Error(`fareql: tier "${tier.name}" needs a verifier`)
    if (tier.verifier.stage === 'payment') {
      throw new Error(`fareql: tier "${tier.name}" uses a payment-stage verifier; tiers need request-stage verifiers`)
    }
    const m = MULTIPLIER.exec(tier.multiplier)
    if (!m) throw new Error(`fareql: invalid multiplier "${tier.multiplier}" for tier "${tier.name}"`)
    const frac = m[2] ?? ''
    const scale = 10n ** BigInt(frac.length)
    ratios.set(tier, [BigInt(m[1] ?? '0') * scale + BigInt(frac || '0'), scale])
  }
  const result = { tiers, ratios }
  checked.set(tiers, result)
  return result
}

/** Validates `options.tiers` up front, so a misconfigured server fails at startup rather than on the first paid request. */
export function checkTiers(options: TierOptions): void {
  if (options.tiers) check(options.tiers)
}

/** A copy the verifier may read without touching the original body. */
function copyOf(request: Request): Request {
  try {
    return request.clone()
  } catch {
    return new Request(request.url, { method: request.method, headers: request.headers })
  }
}

/**
 * Runs each tier's verifier once, best first. A presented proof that is refused stops the
 * request instead of falling back to a dearer tier: a client that sent a wrong key should
 * hear so, not silently pay more.
 */
export async function resolveTier(request: Request, options: TierOptions): Promise<ResolvedTier> {
  const tiers = options.tiers ?? []
  check(tiers)
  for (const tier of tiers) {
    const result = await tier.verifier.verify(copyOf(request), {})
    if (result.status === 'valid') return { name: tier.name, multiplier: tier.multiplier, value: (result as { value: unknown }).value }
    if (result.status === 'missing') continue
    const refused = result as { status: string; code?: number | undefined; reason?: string | undefined }
    const reason = refused.reason || `Identity proof for tier "${tier.name}" was not accepted`
    const status =
      refused.code === 403 || refused.status === 'forbidden' ? 403 : refused.code === 503 || refused.status === 'unavailable' ? 503 : 401
    throw new IdentityError(reason, status)
  }
  if (options.anonymous === false && tiers.length > 0) throw new IdentityError('An identity proof is required for this operation', 401)
  return ANONYMOUS
}

/** Base price times the tier's multiplier, rounded up to the smallest unit. */
export function applyTier(units: bigint, tier: ResolvedTier, tiers: readonly Tier[] | undefined): bigint {
  if (tier === ANONYMOUS || !tiers) return units
  const match = tiers.find((t) => t.name === tier.name)
  const ratio = match ? check(tiers).ratios.get(match) : undefined
  if (!ratio) return units
  const [num, den] = ratio
  return (units * num + den - 1n) / den
}

/** The tiers a caller could reach and what this operation would cost in each, for 402 bodies. */
export function tierPrices(units: bigint, decimals: number, tiers: readonly Tier[] | undefined): { tier: string; amount: string }[] {
  if (!tiers) return []
  return tiers.map((t) => ({ tier: t.name, amount: formatUnits(applyTier(units, { name: t.name, multiplier: t.multiplier }, tiers), decimals) }))
}
