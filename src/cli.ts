#!/usr/bin/env node
/**
 * untrace-mcp: Untrace Drive tools over MCP.
 *
 *   npx -y @untracenetwork/mcp                       stdio (Claude Desktop, Claude Code, Cursor, ...)
 *   npx -y @untracenetwork/mcp http                  Streamable HTTP + OAuth (Claude connector, ChatGPT app)
 *   npx -y @untracenetwork/mcp new-connector-secret  print a fresh UNTRACE_MCP_OAUTH_CLIENT_SECRET
 *   npx -y @untracenetwork/mcp agent init            create this agent's key HERE and print a pairing code
 *
 * stdio: stdout carries the MCP protocol only; diagnostics go to stderr and never include a secret.
 */
import { randomBytes } from "node:crypto"

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"

import { AgentStore } from "./agent/store"
import { loadAgentCredentials, runAgent } from "./agent/command"
import { createHttpApp, listen, MCP_PATH } from "./http"
import { configuredSecrets, redact } from "./redact"
import { createServer } from "./server"
import { VERSION } from "./version"

function log(msg: string): void {
  process.stderr.write(`${redact(msg, configuredSecrets())}\n`)
}

const HELP = [
  `untrace-mcp ${VERSION}: Untrace Drive MCP server`,
  "",
  "Usage:",
  "  untrace-mcp                        serve over stdio (default)",
  "  untrace-mcp http                   serve Streamable HTTP with OAuth at <public url>/mcp",
  "  untrace-mcp new-connector-secret   print a new random UNTRACE_MCP_OAUTH_CLIENT_SECRET",
  "  untrace-mcp agent init|code|claim|status  create a key on THIS machine and pair it (agent --help)",
  "  untrace-mcp --version | --help",
  "",
  "Environment (all modes):",
  "  UNTRACE_CLIENT_ID      developer key client id (utc_...)",
  "  UNTRACE_CLIENT_SECRET  developer key secret (never pass it as an argument)",
  "                         (both unset: the key from `untrace-mcp agent init` is used)",
  "  UNTRACE_BASE_URL       optional, default https://drive.untrace.network",
  "  UNTRACE_MCP_ROOT       folder path uploads read from and downloads write to",
  "                         (stdio default: the working directory; http default: paths off)",
  "",
  "Environment (http):",
  "  UNTRACE_MCP_PUBLIC_URL           public https origin, e.g. https://mcp.example.com",
  "  UNTRACE_MCP_OAUTH_CLIENT_SECRET  OAuth client secret you give Claude or ChatGPT (32+ chars)",
  "  PORT, HOST                       listen address, default 8787 on 127.0.0.1",
  "  UNTRACE_MCP_REDIRECT_URIS        extra allowed OAuth redirect URIs, comma separated",
  "  UNTRACE_MCP_ALLOW_LOOPBACK_REDIRECTS=1  allow http://localhost redirects (local testing only)",
  "",
  "Docs: https://untrace.network/docs/mcp",
  "",
].join("\n")

async function stdio(): Promise<void> {
  const agent = await loadAgentCredentials()
  if (agent) log(`untrace-mcp: using the agent key ${agent} from this machine`)
  if (!process.env.UNTRACE_CLIENT_ID || !process.env.UNTRACE_CLIENT_SECRET) {
    log("untrace-mcp: UNTRACE_CLIENT_ID / UNTRACE_CLIENT_SECRET are not set. File tools will answer with setup help; untrace_setup_guide works.")
  }
  const server = createServer()
  await server.connect(new StdioServerTransport())
  log(`untrace-mcp ${VERSION} ready on stdio`)
}

async function http(): Promise<void> {
  const env = process.env
  const agent = await loadAgentCredentials(env)
  if (agent) log(`untrace-mcp: using the agent key ${agent} from this machine`)
  const missing = ["UNTRACE_CLIENT_ID", "UNTRACE_CLIENT_SECRET", "UNTRACE_MCP_PUBLIC_URL", "UNTRACE_MCP_OAUTH_CLIENT_SECRET"].filter((k) => !env[k])
  if (missing.length) throw new Error(`missing environment: ${missing.join(", ")}. See untrace-mcp --help.`)
  const host = env.HOST || "127.0.0.1"
  const port = Number(env.PORT || 8787)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1 to 65535")
  const { app, resource } = createHttpApp({
    publicUrl: env.UNTRACE_MCP_PUBLIC_URL!,
    clientId: env.UNTRACE_CLIENT_ID!.trim(),
    oauthClientSecret: env.UNTRACE_MCP_OAUTH_CLIENT_SECRET!.trim(),
    redirectUris: (env.UNTRACE_MCP_REDIRECT_URIS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    allowLoopbackRedirects: env.UNTRACE_MCP_ALLOW_LOOPBACK_REDIRECTS === "1",
    host,
  })
  await listen(app, port, host)
  log(`untrace-mcp ${VERSION} listening on http://${host}:${port}${MCP_PATH}; public MCP URL ${resource}`)
}

async function main(): Promise<void> {
  const arg = process.argv[2]
  if (arg === "--version" || arg === "-v") {
    process.stdout.write(`${VERSION}\n`)
    return
  }
  if (arg === "--help" || arg === "-h") {
    process.stdout.write(HELP)
    return
  }
  if (arg === "new-connector-secret") {
    process.stdout.write(`${randomBytes(32).toString("base64url")}\n`)
    return
  }
  if (arg === "http") return http()
  if (arg === "agent") {
    const code = await runAgent(process.argv.slice(3), {
      out: (l) => process.stdout.write(`${l}\n`),
      err: (l) => log(l),
      now: () => Date.now(),
      store: new AgentStore(),
    })
    if (code !== 0) process.exitCode = code
    return
  }
  if (arg === undefined || arg === "stdio") return stdio()
  throw new Error(`unknown command ${arg}. See untrace-mcp --help.`)
}

main().catch((err) => {
  log(`untrace-mcp: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
})
