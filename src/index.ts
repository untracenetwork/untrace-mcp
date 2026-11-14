/**
 * @untracenetwork/mcp: the Untrace Drive MCP server as a library.
 * The `untrace-mcp` bin (src/cli.ts) serves it over stdio or Streamable HTTP with OAuth.
 */
export { createServer, TOOL_NAMES, MAX_UPLOAD_BYTES, DEFAULT_MAX_INLINE_BYTES, type ServerOptions, type UntraceLike } from "./server"
export { createHttpApp, listen, MCP_PATH, DEFAULT_REDIRECT_URIS, ACCESS_TOKEN_TTL_S, REFRESH_TOKEN_TTL_S, type HttpOptions } from "./http"
export { redact } from "./redact"
export { describeError, ToolRefusal } from "./errors"
export { setupGuide, FRAMEWORKS, type Framework } from "./guide"
export { buildGenerateLink, MAX_GENERATE_HTML_BYTES, MAX_GENERATE_PAYLOAD_CHARS, type GenerateFormat, type GenerateLink } from "./generate"
export { GENERATE_TEMPLATES, TEMPLATE_IDS, fillTemplate, templateById, templateFields, MAX_FIELDS, MAX_FIELD_VALUE_CHARS, type GenerateTemplate, type TemplateId, type FilledTemplate } from "./templates"
export { VERSION } from "./version"
