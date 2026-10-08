#!/usr/bin/env node
/**
 * untrace-mcp: Untrace Drive tools over MCP stdio.
 *
 *   npx -y @untracenetwork/mcp
 *
 * Environment: UNTRACE_CLIENT_ID, UNTRACE_CLIENT_SECRET (required for file tools),
 * UNTRACE_BASE_URL (optional), UNTRACE_MCP_ROOT (optional, default cwd).
 * stdout carries the MCP protocol only; diagnostics go to stderr and never include the secret.
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { configuredSecrets, redact } from "./redact"
import { createServer } from "./server"
import { VERSION } from "./version"

function log(msg: string): void {
  process.stderr.write(`${redact(msg, configuredSecrets())}\n`)
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      [
        `untrace-mcp ${VERSION}: Untrace Drive MCP server (stdio)`,
        "",
        "Environment:",
        "  UNTRACE_CLIENT_ID      developer key client id (utc_...)",
        "  UNTRACE_CLIENT_SECRET  developer key secret (never pass it as an argument)",
        "  UNTRACE_BASE_URL       optional, default https://drive.untrace.network",
        "  UNTRACE_MCP_ROOT       folder uploads read from and downloads write to (default: cwd)",
        "",
        "Docs: https://untrace.network/docs/mcp",
        "",
      ].join("\n")
    )
    return
  }
  if (!process.env.UNTRACE_CLIENT_ID || !process.env.UNTRACE_CLIENT_SECRET) {
    log("untrace-mcp: UNTRACE_CLIENT_ID / UNTRACE_CLIENT_SECRET are not set. File tools will answer with setup help; untrace_setup_guide works.")
  }
  const server = createServer()
  await server.connect(new StdioServerTransport())
  log(`untrace-mcp ${VERSION} ready on stdio`)
}

main().catch((err) => {
  log(`untrace-mcp: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
