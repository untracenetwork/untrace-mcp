/**
 * @untracenetwork/mcp: the Untrace Drive MCP server as a library.
 * The `untrace-mcp` bin (src/cli.ts) serves it over stdio.
 */
export { createServer, TOOL_NAMES, MAX_UPLOAD_BYTES, type ServerOptions, type UntraceLike } from "./server"
export { redact } from "./redact"
export { describeError, ToolRefusal } from "./errors"
export { setupGuide, FRAMEWORKS, type Framework } from "./guide"
export { VERSION } from "./version"
