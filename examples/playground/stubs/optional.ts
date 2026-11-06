// Stand-in for optional mppx integrations (MCP, framework adapters) that the playground never
// loads; it only keeps the Worker bundler from looking for packages that are not installed.
export class McpError extends Error {}
export const ErrorCode = {}
export default {}
