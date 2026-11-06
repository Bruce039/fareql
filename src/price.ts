import {
  type DocumentNode,
  type FieldNode,
  type FragmentDefinitionNode,
  type GraphQLArgument,
  type GraphQLField,
  type GraphQLNamedType,
  type GraphQLObjectType,
  type GraphQLSchema,
  type GraphQLType,
  type OperationDefinitionNode,
  type SelectionSetNode,
  type ValueNode,
  getNamedType,
  getNullableType,
  getVariableValues,
  isAbstractType,
  isCompositeType,
  isInterfaceType,
  isListType,
  isNonNullType,
  isObjectType,
  Kind,
  valueFromASTUntyped,
} from 'graphql'

/**
 * SDL for the directives FareQL reads. Add it to your type definitions.
 *
 * `@listSize` follows the IBM GraphQL Cost Directives draft, so schemas that already
 * use it for complexity analysis price connections correctly without changes.
 * Code-first schemas can set the same values in `extensions`
 * (`{ price: '0.001' }` or `{ directives: { price: { amount: '0.001' } } }`).
 */
export const fareDirectiveTypeDefs = /* GraphQL */ `
  """
  Price of resolving this field, or of any field returning this type, in token units (e.g. "0.001").
  """
  directive @price(amount: String!) on FIELD_DEFINITION | OBJECT | INTERFACE

  """
  How many items a list or connection field returns, for pricing.
  """
  directive @listSize(
    assumedSize: Int
    slicingArguments: [String!]
    sizedFields: [String!]
    requireOneSlicingArgument: Boolean = true
  ) on FIELD_DEFINITION
`

export type FieldPriceContext = {
  /** The concrete object type the field is resolved on. */
  parentType: GraphQLObjectType
  field: GraphQLField<unknown, unknown>
  /** Argument values with variables and defaults applied. */
  args: Record<string, unknown>
  /** Response path, using aliases. */
  path: readonly string[]
}

export type PricingOptions = {
  /** Token decimals used for exact arithmetic. Default: 6 (the TIP-20 stablecoins on Tempo). */
  decimals?: number
  /** Price of a field that has no `@price` and whose type has none. Default: "0". */
  defaultFieldPrice?: string
  /**
   * Argument names read as a list length, also one level deep inside input objects
   * (`page: { limit: 50 }`). Default: first, last, limit, take, top, pageSize, perPage.
   */
  listSizeArguments?: readonly string[]
  /** List length assumed when no size argument is given, and for inner levels of nested lists. Default: 10. */
  defaultListSize?: number
  /**
   * Upper bound for a list size. Larger sizes, `null` and non-finite sizes are charged at this
   * value. Set it to your server's real page cap. Default: 100.
   */
  maxListSize?: number
  /**
   * Pagination wrappers: a non-list field given a size argument (`users(first: 50)`) passes it to
   * the list fields it selects (`edges`, `nodes`, `items`…). `sizedFields` limits it to those
   * names; `false` turns it off. `@listSize(sizedFields:)` always applies. Default: all list children.
   */
  connections?: false | { sizedFields?: readonly string[] }
  /** Reject operations (and batches) priced above this amount (token units). */
  maxPrice?: string
  /** Reject operations that need more than this many selection visits to price. Default: 10000. */
  maxFieldVisits?: number
  /** Reject operations nested deeper than this. Default: 100. */
  maxDepth?: number
  /** Price a field in code. Return undefined to fall back to `@price`. */
  fieldPrice?: (ctx: FieldPriceContext) => string | undefined
}

export type PriceBreakdownItem = {
  /** Response path of the priced field, e.g. "search.snippet" (shortened when very long). */
  path: string
  /** Price of one instance, in token units. */
  unitAmount: string
  /** How many instances the operation can resolve. */
  count: string
  /** unitAmount × count, in token units. */
  amount: string
}

export type OperationPrice = {
  /** Total price in token units as a decimal string, e.g. "0.0125". */
  amount: string
  /** Total price in base units (10^-decimals). */
  units: bigint
  decimals: number
  /** Priced fields that make up the total (at most 100; see `breakdownTruncated`). */
  breakdown: PriceBreakdownItem[]
  /** True when more priced fields exist than `breakdown` lists. */
  breakdownTruncated?: boolean
}

export type PricingErrorCode =
  | 'INVALID_PRICE'
  | 'INVALID_LIST_SIZE'
  | 'UNKNOWN_FIELD'
  | 'UNKNOWN_FRAGMENT'
  | 'UNKNOWN_OPERATION'
  | 'INVALID_VARIABLES'
  | 'SLICING_ARGUMENT_REQUIRED'
  | 'TOO_COMPLEX'
  | 'PRICE_LIMIT_EXCEEDED'
  | 'NO_PRICES'

export class PricingError extends Error {
  override name = 'PricingError'
  constructor(
    message: string,
    readonly code: PricingErrorCode,
  ) {
    super(message)
  }
}

export class PriceLimitError extends PricingError {
  override name = 'PriceLimitError'
  constructor(
    readonly amount: string,
    readonly maxPrice: string,
  ) {
    super(`Operation price ${amount} exceeds the maximum of ${maxPrice}`, 'PRICE_LIMIT_EXCEEDED')
  }
}

const DEFAULT_LIST_ARGS = ['first', 'last', 'limit', 'take', 'top', 'pageSize', 'perPage'] as const
const MAX_BREAKDOWN_ITEMS = 100
const MAX_PATH_LENGTH = 200

/** Parses a decimal token amount ("0.001") into base units at `decimals`. */
export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim())
  if (!m) throw new PricingError(`Invalid amount "${value}"`, 'INVALID_PRICE')
  const whole = m[1] ?? '0'
  const frac = m[2] ?? ''
  if (frac.length > decimals) throw new PricingError(`Amount "${value}" has more than ${decimals} decimals`, 'INVALID_PRICE')
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0')
}

/** Formats base units as a decimal token amount without trailing zeros. */
export function formatUnits(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals)
  const whole = units / base
  const frac = (units % base).toString().padStart(decimals, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : whole.toString()
}

// ── Reading prices from the schema (SDL directives or code-first extensions) ───

type DirectiveLike = { name: { value: string }; arguments?: readonly { name: { value: string }; value: ValueNode }[] }
type DirectiveHost = {
  astNode?: { directives?: readonly DirectiveLike[] } | null | undefined
  extensionASTNodes?: readonly { directives?: readonly DirectiveLike[] }[]
  extensions?: Readonly<Record<string, unknown>> | null | undefined
}

function findDirective(host: DirectiveHost | undefined, name: string): Record<string, unknown> | undefined {
  if (!host) return undefined
  for (const node of [host.astNode, ...(host.extensionASTNodes ?? [])]) {
    const d = node?.directives?.find((x) => x.name.value === name)
    if (!d) continue
    const args: Record<string, unknown> = {}
    for (const a of d.arguments ?? []) args[a.name.value] = valueFromASTUntyped(a.value)
    return args
  }
  // Code-first schemas (graphql-tools, Pothos, Nexus…): extensions.directives.<name> or extensions.<name>.
  const ext = host.extensions
  if (!ext) return undefined
  const fromDirectives = (ext['directives'] as Record<string, unknown> | undefined)?.[name]
  const value = fromDirectives ?? ext[name]
  const first = Array.isArray(value) ? value[0] : value
  if (name === 'price' && typeof first === 'string') return { amount: first }
  return first && typeof first === 'object' ? (first as Record<string, unknown>) : undefined
}

const priceCache = new WeakMap<object, string | null>()

function directivePrice(host: DirectiveHost | undefined): string | undefined {
  if (!host) return undefined
  const hit = priceCache.get(host)
  if (hit !== undefined) return hit ?? undefined
  const d = findDirective(host, 'price')
  if (d && typeof d['amount'] !== 'string') throw new PricingError('@price(amount:) must be a string such as "0.001"', 'INVALID_PRICE')
  const amount = d ? (d['amount'] as string) : undefined
  priceCache.set(host, amount ?? null)
  return amount
}

/** The higher of two prices; undefined only when both are. */
function higher(a: string | undefined, b: string | undefined, decimals: number): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return parseUnits(b, decimals) > parseUnits(a, decimals) ? b : a
}

/** Price of a field: its own @price, else the highest @price of the same field on an interface it implements. */
function fieldDirectivePrice(parent: GraphQLObjectType, field: GraphQLField<unknown, unknown>, decimals: number): string | undefined {
  const own = directivePrice(field)
  if (own !== undefined) return own
  let best: string | undefined
  for (const i of parent.getInterfaces()) best = higher(best, directivePrice(i.getFields()[field.name]), decimals)
  return best
}

/** Type-level price of an object type: its own @price, else the highest of its interfaces. */
function typePrice(type: GraphQLObjectType, decimals: number): string | undefined {
  const own = directivePrice(type)
  if (own !== undefined) return own
  let best: string | undefined
  for (const i of type.getInterfaces()) best = higher(best, directivePrice(i), decimals)
  return best
}

const schemaPriced = new WeakMap<GraphQLSchema, boolean>()

/** Whether any type or field in the schema carries a price. */
function schemaHasPrices(schema: GraphQLSchema): boolean {
  const hit = schemaPriced.get(schema)
  if (hit !== undefined) return hit
  let found = false
  for (const type of Object.values(schema.getTypeMap())) {
    if (type.name.startsWith('__') || !(isObjectType(type) || isInterfaceType(type))) continue
    if (directivePrice(type) !== undefined || Object.values(type.getFields()).some((f) => directivePrice(f) !== undefined)) {
      found = true
      break
    }
  }
  schemaPriced.set(schema, found)
  return found
}

type ListSize = { assumedSize?: number; slicingArguments: string[]; sizedFields: string[]; requireOne: boolean }

function directiveListSize(host: DirectiveHost): ListSize | undefined {
  const d = findDirective(host, 'listSize')
  if (!d) return undefined
  const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  return {
    assumedSize: typeof d['assumedSize'] === 'number' ? d['assumedSize'] : undefined,
    slicingArguments: strings(d['slicingArguments']),
    sizedFields: strings(d['sizedFields']),
    requireOne: d['requireOneSlicingArgument'] !== false,
  }
}

// ── graphql 16 / 17 compatibility ─────────────────────────────────────────────

/** Default value of an argument definition, in graphql 16 (`defaultValue`) and 17 (`default`). */
function argDefault(def: GraphQLArgument): unknown {
  const v17 = (def as { default?: { literal?: ValueNode; value?: unknown } }).default
  if (v17) return v17.literal ? valueFromASTUntyped(v17.literal) : v17.value
  return def.defaultValue
}

function coerceVariables(schema: GraphQLSchema, op: OperationDefinitionNode, inputs: Record<string, unknown>): Record<string, unknown> {
  const r = getVariableValues(schema, op.variableDefinitions ?? [], inputs) as {
    errors?: readonly { message: string }[]
    coerced?: Record<string, unknown>
    variableValues?: { coerced: Record<string, unknown> }
  }
  if (r.errors) throw new PricingError(r.errors.map((e) => e.message).join('; '), 'INVALID_VARIABLES')
  return r.coerced ?? r.variableValues?.coerced ?? {}
}

// ── Pricing walk ──────────────────────────────────────────────────────────────

type Ctx = {
  schema: GraphQLSchema
  fragments: Record<string, FragmentDefinitionNode>
  variables: Record<string, unknown>
  decimals: number
  defaultFieldUnits: bigint
  listArgs: readonly string[]
  defaultListSize: bigint
  maxListSize: bigint
  connections: { sizedFields?: readonly string[] } | undefined
  fieldPrice?: PricingOptions['fieldPrice']
  visits: number
  maxVisits: number
  maxDepth: number
}

/** Response path as a linked list, joined only for the few items that are reported. */
type Path = { prev: Path | undefined; key: string }
const pathArray = (p: Path | undefined): string[] => {
  const out: string[] = []
  for (let n = p; n; n = n.prev) out.push(n.key)
  return out.reverse()
}

type Item = { path: Path; unit: bigint; count: bigint }
type Cost = { units: bigint; items: Item[]; truncated: boolean }
const ZERO: Cost = { units: 0n, items: [], truncated: false }

function addItems(into: Item[], from: readonly Item[]): boolean {
  for (const item of from) {
    if (into.length >= MAX_BREAKDOWN_ITEMS) return true
    into.push(item)
  }
  return false
}

function tick(ctx: Ctx) {
  if (++ctx.visits > ctx.maxVisits) {
    throw new PricingError(`Operation is too complex to price (more than ${ctx.maxVisits} selections)`, 'TOO_COMPLEX')
  }
}

function conditional(node: { directives?: readonly DirectiveLike[] }, name: 'skip' | 'include', vars: Record<string, unknown>) {
  const d = node.directives?.find((x) => x.name.value === name)
  const arg = d?.arguments?.find((a) => a.name.value === 'if')
  return arg ? valueFromASTUntyped(arg.value, vars) : undefined
}

function isIncluded(node: { directives?: readonly DirectiveLike[] }, vars: Record<string, unknown>): boolean {
  return conditional(node, 'skip', vars) !== true && conditional(node, 'include', vars) !== false
}

/** Whether a fragment with type condition `condition` applies to runtime type `type`. */
function applies(ctx: Ctx, condition: GraphQLNamedType | undefined | null, type: GraphQLObjectType): boolean {
  if (!condition || condition === type) return true
  return isAbstractType(condition) && ctx.schema.isSubType(condition, type)
}

function runtimeTypes(ctx: Ctx, type: GraphQLNamedType): readonly GraphQLObjectType[] {
  if (isObjectType(type)) return [type]
  if (isAbstractType(type)) return ctx.schema.getPossibleTypes(type)
  return []
}

/**
 * graphql-js field collection: groups selections by response key for one runtime type,
 * follows fragments whose condition matches, and skips fragments already spread in this
 * selection set. Priced fields are therefore charged as often as the executor resolves them.
 */
function collectFields(
  ctx: Ctx,
  type: GraphQLObjectType,
  sets: readonly SelectionSetNode[],
  out = new Map<string, FieldNode[]>(),
  visited = new Set<string>(),
): Map<string, FieldNode[]> {
  for (const set of sets) {
    for (const sel of set.selections) {
      tick(ctx)
      if (!isIncluded(sel, ctx.variables)) continue
      if (sel.kind === Kind.FIELD) {
        const key = sel.alias?.value ?? sel.name.value
        const list = out.get(key)
        if (list) list.push(sel)
        else out.set(key, [sel])
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        const cond = sel.typeCondition ? ctx.schema.getType(sel.typeCondition.name.value) : undefined
        if (applies(ctx, cond, type)) collectFields(ctx, type, [sel.selectionSet], out, visited)
      } else if (sel.kind === Kind.FRAGMENT_SPREAD) {
        const name = sel.name.value
        if (visited.has(name)) continue
        visited.add(name)
        const frag = ctx.fragments[name]
        if (!frag) throw new PricingError(`Unknown fragment "${name}"`, 'UNKNOWN_FRAGMENT')
        if (applies(ctx, ctx.schema.getType(frag.typeCondition.name.value), type)) {
          collectFields(ctx, type, [frag.selectionSet], out, visited)
        }
      }
    }
  }
  return out
}

function argValues(field: GraphQLField<unknown, unknown>, node: FieldNode, vars: Record<string, unknown>) {
  const out: Record<string, unknown> = {}
  for (const def of field.args) {
    const d = argDefault(def)
    if (d !== undefined) out[def.name] = d
  }
  for (const a of node.arguments ?? []) {
    const v = valueFromASTUntyped(a.value, vars)
    if (v !== undefined) out[a.name.value] = v
  }
  return out
}

/** Number of list levels in a type: `[Hit]` → 1, `[[Cell!]!]!` → 2. */
function listLevels(type: GraphQLType): number {
  let levels = 0
  let t: GraphQLType = type
  while (true) {
    if (isNonNullType(t)) t = t.ofType
    else if (isListType(t)) {
      levels++
      t = t.ofType
    } else return levels
  }
}

/**
 * Size given by `names` in `args` (top level, or one level inside an input object).
 * The largest one wins. `null`, NaN and non-finite numbers mean "unbounded": maxListSize.
 * Negative sizes are refused, since resolvers that slice with them return almost everything.
 */
function sliceSize(ctx: Ctx, args: Record<string, unknown>, names: readonly string[]): bigint | undefined {
  let size: bigint | undefined
  const consider = (name: string, v: unknown) => {
    let n: bigint
    if (v === null) n = ctx.maxListSize
    else if (typeof v === 'number') {
      if (v < 0) throw new PricingError(`List size "${name}" must not be negative`, 'INVALID_LIST_SIZE')
      n = Number.isFinite(v) ? BigInt(Math.floor(v)) : ctx.maxListSize
      if (n > ctx.maxListSize) n = ctx.maxListSize
    } else return
    if (size === undefined || n > size) size = n
  }
  for (const name of names) {
    if (name in args) consider(name, args[name])
    for (const v of Object.values(args)) {
      if (v && typeof v === 'object' && !Array.isArray(v) && name in v) consider(name, (v as Record<string, unknown>)[name])
    }
  }
  return size
}

type ChildSizes = { all?: bigint; named?: ReadonlyMap<string, bigint> }
type Sizing = { multiplier: bigint; children?: ChildSizes }

function sizing(
  ctx: Ctx,
  field: GraphQLField<unknown, unknown>,
  args: Record<string, unknown>,
  path: Path,
  inherited: bigint | undefined,
): Sizing {
  const levels = listLevels(field.type)
  const inner = levels > 1 ? ctx.defaultListSize ** BigInt(levels - 1) : 1n
  const ls = directiveListSize(field)
  if (ls) {
    const names = ls.slicingArguments.length > 0 ? ls.slicingArguments : ctx.listArgs
    if (ls.requireOne && ls.slicingArguments.length > 0) {
      const given = ls.slicingArguments.filter((n) => args[n] !== undefined && args[n] !== null)
      if (given.length !== 1) {
        throw new PricingError(
          `Field "${pathArray(path).join('.')}" needs exactly one of ${ls.slicingArguments.map((n) => `"${n}"`).join(', ')}`,
          'SLICING_ARGUMENT_REQUIRED',
        )
      }
    }
    const assumed = ls.assumedSize !== undefined ? BigInt(Math.min(Math.max(ls.assumedSize, 0), Number(ctx.maxListSize))) : undefined
    const size = sliceSize(ctx, args, names) ?? assumed ?? inherited ?? ctx.defaultListSize
    if (ls.sizedFields.length > 0) {
      const self = levels > 0 ? (inherited ?? ctx.defaultListSize) * inner : 1n
      return { multiplier: self, children: { named: new Map(ls.sizedFields.map((f) => [f, size])) } }
    }
    return { multiplier: levels > 0 ? size * inner : 1n }
  }
  if (levels > 0) return { multiplier: (sliceSize(ctx, args, ctx.listArgs) ?? inherited ?? ctx.defaultListSize) * inner }
  if (ctx.connections && isCompositeType(getNamedType(field.type))) {
    const size = sliceSize(ctx, args, ctx.listArgs)
    if (size !== undefined) {
      const named = ctx.connections.sizedFields
      return { multiplier: inherited ?? 1n, children: named ? { named: new Map(named.map((f) => [f, size])) } : { all: size } }
    }
  }
  return { multiplier: inherited ?? 1n }
}

/** Cost of selection sets on one concrete runtime type, after graphql-js field collection. */
function setCostOn(
  ctx: Ctx,
  type: GraphQLObjectType,
  sets: readonly SelectionSetNode[],
  path: Path | undefined,
  scale: bigint,
  sized: ChildSizes | undefined,
  depth: number,
): Cost {
  if (depth > ctx.maxDepth) throw new PricingError(`Operation is nested deeper than ${ctx.maxDepth} levels`, 'TOO_COMPLEX')
  let units = 0n
  const items: Item[] = []
  let truncated = false
  for (const [key, nodes] of collectFields(ctx, type, sets)) {
    const c = fieldCost(ctx, type, key, nodes, path, scale, sized, depth)
    units += c.units
    truncated = addItems(items, c.items) || c.truncated || truncated
  }
  return { units, items, truncated }
}

function fieldCost(
  ctx: Ctx,
  parent: GraphQLObjectType,
  key: string,
  nodes: readonly FieldNode[],
  path: Path | undefined,
  scale: bigint,
  sized: ChildSizes | undefined,
  depth: number,
): Cost {
  const node = nodes[0] as FieldNode
  const name = node.name.value
  if (name.startsWith('__')) return ZERO // __typename and introspection are free
  tick(ctx)
  const field = parent.getFields()[name]
  if (!field) throw new PricingError(`Unknown field "${name}" on type "${parent.name}"`, 'UNKNOWN_FIELD')

  const fieldPath: Path = { prev: path, key }
  const args = argValues(field, node, ctx.variables)
  const override = ctx.fieldPrice?.({ parentType: parent, field, args, path: pathArray(fieldPath) })
  const fieldOwn = override ?? fieldDirectivePrice(parent, field, ctx.decimals)
  const isList = listLevels(field.type) > 0
  const inherited = sized?.named?.get(name) ?? (isList ? sized?.all : undefined)
  const { multiplier, children } = sizing(ctx, field, args, fieldPath, inherited)
  const count = scale * multiplier
  const named = getNamedType(field.type)
  const unitOf = (p: string | undefined) => (p !== undefined ? parseUnits(p, ctx.decimals) : ctx.defaultFieldUnits)

  const priced = (unit: bigint, rest: Cost): Cost => {
    if (unit === 0n) return { units: rest.units, items: rest.items, truncated: rest.truncated }
    const items: Item[] = [{ path: fieldPath, unit, count }]
    const truncated = addItems(items, rest.items) || rest.truncated
    return { units: unit * count + rest.units, items, truncated }
  }

  const sets = nodes.flatMap((n) => (n.selectionSet ? [n.selectionSet] : []))
  if (sets.length === 0) return priced(unitOf(fieldOwn), ZERO)

  // Abstract return types: price every possible runtime type and charge the most expensive.
  // Without a field price, the runtime type's @price applies (or its interfaces', or the return type's).
  const abstractPrice = isAbstractType(named) ? directivePrice(named as DirectiveHost) : undefined
  let best: Cost | undefined
  for (const t of runtimeTypes(ctx, named)) {
    const own = fieldOwn ?? typePrice(t, ctx.decimals) ?? abstractPrice
    const c = priced(unitOf(own), setCostOn(ctx, t, sets, fieldPath, count, children, depth + 1))
    if (!best || c.units > best.units) best = c
  }
  return best ?? priced(unitOf(fieldOwn), ZERO)
}

export type PriceInput = {
  schema: GraphQLSchema
  document: DocumentNode
  operationName?: string | null
  variables?: Record<string, unknown> | null
}

/** Selects the operation the request will execute, following GraphQL's rules. */
export function selectOperation(document: DocumentNode, operationName?: string | null): OperationDefinitionNode {
  const ops = document.definitions.filter((d): d is OperationDefinitionNode => d.kind === Kind.OPERATION_DEFINITION)
  if (operationName) {
    const matches = ops.filter((o) => o.name?.value === operationName)
    if (matches.length !== 1) {
      throw new PricingError(
        matches.length === 0 ? `Unknown operation "${operationName}"` : `Several operations are named "${operationName}"`,
        'UNKNOWN_OPERATION',
      )
    }
    return matches[0] as OperationDefinitionNode
  }
  if (ops.length !== 1) {
    throw new PricingError('Must provide operationName when the document has several operations', 'UNKNOWN_OPERATION')
  }
  return ops[0] as OperationDefinitionNode
}

const shortPath = (p: string) => (p.length > MAX_PATH_LENGTH ? `…${p.slice(-(MAX_PATH_LENGTH - 1))}` : p)

/**
 * Computes the price of the operation a GraphQL request will run. Pure and deterministic:
 * the same schema, document and variables always give the same price.
 */
export function priceOperation(input: PriceInput, options: PricingOptions = {}): OperationPrice {
  const decimals = options.decimals ?? 6
  const defaultFieldUnits = parseUnits(options.defaultFieldPrice ?? '0', decimals)
  if (!options.fieldPrice && defaultFieldUnits === 0n && !schemaHasPrices(input.schema)) {
    // Fail closed: a schema whose directives were lost (introspection copy, code-first without
    // extensions) would otherwise make every operation free.
    throw new PricingError('The schema has no @price anywhere; add fareDirectiveTypeDefs and @price, or pass fieldPrice', 'NO_PRICES')
  }
  const op = selectOperation(input.document, input.operationName)
  const fragments: Record<string, FragmentDefinitionNode> = {}
  for (const d of input.document.definitions) if (d.kind === Kind.FRAGMENT_DEFINITION) fragments[d.name.value] = d
  const root =
    op.operation === 'query'
      ? input.schema.getQueryType()
      : op.operation === 'mutation'
        ? input.schema.getMutationType()
        : input.schema.getSubscriptionType()
  if (!root) throw new PricingError(`Schema has no ${op.operation} type`, 'UNKNOWN_OPERATION')
  const ctx: Ctx = {
    schema: input.schema,
    fragments,
    variables: coerceVariables(input.schema, op, input.variables ?? {}),
    decimals,
    defaultFieldUnits,
    listArgs: options.listSizeArguments ?? DEFAULT_LIST_ARGS,
    defaultListSize: BigInt(options.defaultListSize ?? 10),
    maxListSize: BigInt(options.maxListSize ?? 100),
    connections: options.connections === false ? undefined : (options.connections ?? {}),
    fieldPrice: options.fieldPrice,
    visits: 0,
    maxVisits: options.maxFieldVisits ?? 10_000,
    maxDepth: options.maxDepth ?? 100,
  }
  let cost: Cost
  try {
    cost = setCostOn(ctx, root, [op.selectionSet], undefined, 1n, undefined, 0)
  } catch (error) {
    if (error instanceof RangeError) throw new PricingError('Operation is too complex to price', 'TOO_COMPLEX')
    throw error
  }
  const amount = formatUnits(cost.units, decimals)
  if (options.maxPrice !== undefined && cost.units > parseUnits(options.maxPrice, decimals)) {
    throw new PriceLimitError(amount, options.maxPrice)
  }
  const price: OperationPrice = {
    amount,
    units: cost.units,
    decimals,
    breakdown: cost.items.map((i) => ({
      path: shortPath(pathArray(i.path).join('.')),
      unitAmount: formatUnits(i.unit, decimals),
      count: i.count.toString(),
      amount: formatUnits(i.unit * i.count, decimals),
    })),
  }
  if (cost.truncated) price.breakdownTruncated = true
  return price
}
