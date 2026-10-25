/**
 * `untrace-mcp agent <init|code|claim|status>`: create this agent's developer key on THIS machine and
 * pair it with an Untrace Drive account. docs/AGENT-PAIRING.md.
 *
 *   agent claim <link> --want <category:id[:mode]> ... [--label <name>] [--runs-on <text>] [--project <name>] [--wait]
 *      claim a one-time agent link from Drive (Settings > Developer > Give your agent access)
 *
 *   agent init [--label <name>] [--scopes download,upload] [--ttl <minutes>] [--force]
 *   agent code [--scopes ...] [--ttl <minutes>]     a fresh pairing code for the same key
 *   agent status [--offline]                        fingerprint, storage, paired or not
 *
 * The secret is generated here and stored in the OS keychain or a 0600 file. Only the pairing
 * code (public keys and signatures) is printed. After the owner approves it in Drive, plain
 * `untrace-mcp` (stdio or http) uses this key when UNTRACE_CLIENT_ID / UNTRACE_CLIENT_SECRET are
 * not set.
 */
import { hostname } from "node:os"

import { UntraceClient } from "@untracenetwork/sdk"

import { claimAgentLink, CONNECTED_PROJECTS, parseProject, parseWant, type RequestedItem } from "./claim"
import { agentSigner, fingerprint, newClientId, newSecret, randomNonce } from "./keys"
import { encodePairingCode, LABEL_MAX, PAIRING_SCOPES, PAIRING_TTL_SECONDS, parseScopeList, validLabel, type PairingScope } from "./pairing"
import { AgentStore, type AgentRecord } from "./store"

export interface AgentIo {
  out(line: string): void
  err(line: string): void
  now(): number
  store: AgentStore
  /** Drive origin for `agent claim` (default UNTRACE_BASE_URL, else https://drive.untrace.network). */
  baseUrl?: string
  fetch?: typeof fetch
  sleep?(ms: number): Promise<void>
  /** Probe whether Drive accepts this key. Injected in tests. */
  probe?(clientId: string, secret: string): Promise<"paired" | "pending" | "unreachable">
  /** Environment for UNTRACE_BASE_URL and UNTRACE_AGENT_PROJECT (default process.env). Injected in tests. */
  env?: NodeJS.ProcessEnv
}

export const AGENT_HELP = [
  "untrace-mcp agent: a developer key generated on this machine",
  "",
  "  untrace-mcp agent init [--label <name>] [--scopes download,upload] [--ttl <minutes>] [--force]",
  "      create the key here, store it in the OS keychain (or a 0600 file), print a pairing code",
  "  untrace-mcp agent code [--scopes ...] [--ttl <minutes>]",
  "      print a fresh pairing code for the existing key",
  "  untrace-mcp agent claim <link> --want <category:id[:mode][=Name]> ... [--label <name>] [--runs-on <text>] [--project <name>] [--wait]",
  "      claim a one-time agent link the owner made in Drive (Settings > Developer > Give your agent access)",
  "      e.g. --want files:<folder id>:read_write --want vault:<entry id>=OPENAI_API_KEY --want mail:agent@acme.com",
  "      categories: files, vault (add :totp for a 2FA code), mail. Modes: read (default), write, read_write.",
  "      Uses this machine's agent key, or creates one. --wait waits for the owner to approve.",
  `      --project names the connected project the agent works for (${CONNECTED_PROJECTS.join(", ")}). Default: UNTRACE_AGENT_PROJECT.`,
  "  untrace-mcp agent status [--offline]",
  "      show the fingerprint, where the key is stored, and whether Drive has approved it",
  "",
  `Scopes: ${PAIRING_SCOPES.join(", ")}. Default: download. Codes expire after 15 minutes (max 1440).`,
  "Approve the code in Untrace Drive: Settings > Developer keys > Pair an agent.",
  "",
].join("\n")

interface Flags {
  label?: string
  scopes?: string
  ttl?: string
  force: boolean
  offline: boolean
  wants: RequestedItem[]
  runsOn?: string
  project?: string
  wait: boolean
  positional: string[]
}

export function parseFlags(args: string[]): Flags {
  const f: Flags = { force: false, offline: false, wants: [], wait: false, positional: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const [name, inline] = a.startsWith("--") && a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined]
    const value = () => {
      const v = inline ?? args[++i]
      if (v === undefined) throw new Error(`${name} needs a value`)
      return v
    }
    if (name === "--label") f.label = value()
    else if (name === "--scopes") f.scopes = value()
    else if (name === "--ttl") f.ttl = value()
    else if (name === "--force") f.force = true
    else if (name === "--offline") f.offline = true
    else if (name === "--want") f.wants.push(parseWant(value()))
    else if (name === "--runs-on") f.runsOn = value()
    else if (name === "--project") f.project = value()
    else if (name === "--wait") f.wait = true
    else if (!a.startsWith("-")) f.positional.push(a)
    else throw new Error(`unknown option ${a}. See untrace-mcp agent --help.`)
  }
  return f
}

function ttlSeconds(ttl: string | undefined): number {
  if (ttl === undefined) return PAIRING_TTL_SECONDS
  const m = Number(ttl)
  if (!Number.isInteger(m) || m < 1 || m > 1440) throw new Error("--ttl is minutes, 1 to 1440")
  return m * 60
}

export function defaultLabel(host = hostname()): string {
  const clean = host.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim() || "this machine"
  return `Agent on ${clean}`.slice(0, LABEL_MAX).trim()
}

async function printCode(io: AgentIo, rec: AgentRecord, secret: string, scopes: readonly PairingScope[], ttl: number): Promise<void> {
  const signer = await agentSigner(secret)
  const expiresAt = Math.floor(io.now() / 1000) + ttl
  const code = encodePairingCode({ clientId: rec.clientId, label: rec.label, scopes, nonce: randomNonce(), expiresAt }, signer)
  io.out("Pairing code (paste it in Untrace Drive: Settings > Developer keys > Pair an agent):")
  io.out("")
  io.out(code)
  io.out("")
  io.out(`Name:        ${rec.label}`)
  io.out(`Fingerprint: ${rec.fingerprint}   (check Drive shows the same)`)
  io.out(`Asks for:    ${scopes.join(", ")}`)
  io.out(`Expires:     ${new Date(expiresAt * 1000).toISOString()}`)
}

async function init(io: AgentIo, f: Flags): Promise<number> {
  const existing = await io.store.readRecord()
  if (existing && !f.force) {
    io.err(`untrace-mcp: this machine already has an agent key (${existing.clientId}, fingerprint ${existing.fingerprint}).`)
    io.err("Run `untrace-mcp agent code` for a new pairing code, or `agent init --force` to replace the key (the old one stops working here; revoke it in Drive).")
    return 1
  }
  const label = (f.label ?? defaultLabel()).trim()
  if (!validLabel(label)) throw new Error(`--label must be 1 to ${LABEL_MAX} characters, no control characters`)
  const scopes = f.scopes ? parseScopeList(f.scopes) : (["download"] as PairingScope[])
  const ttl = ttlSeconds(f.ttl)
  if (existing) await io.store.remove(existing)

  const secret = newSecret()
  const signer = await agentSigner(secret)
  const clientId = newClientId()
  const rec = await io.store.save(
    { clientId, label, scopes: [...scopes], fingerprint: fingerprint(signer.signPublicKey, signer.boxPublicKey), createdAt: new Date(io.now()).toISOString() },
    secret
  )
  io.out(`Created an agent key on this machine. The secret never leaves it.`)
  io.out(`Stored in:   ${rec.storage === "keychain" ? "the OS keychain" : `${io.store.dir} (file, mode 0600)`}`)
  io.out(`Client ID:   ${clientId}`)
  io.out("")
  await printCode(io, rec, secret, scopes, ttl)
  return 0
}

async function code(io: AgentIo, f: Flags): Promise<number> {
  const rec = await io.store.readRecord()
  if (!rec) {
    io.err("untrace-mcp: no agent key on this machine. Run `untrace-mcp agent init` first.")
    return 1
  }
  const scopes = f.scopes ? parseScopeList(f.scopes) : (rec.scopes as PairingScope[])
  await printCode(io, rec, await io.store.readSecret(rec), scopes, ttlSeconds(f.ttl))
  return 0
}

/** Paired = Drive issues a token for this key. invalid_client = not approved yet (or revoked). */
export async function probeDrive(clientId: string, secret: string): Promise<"paired" | "pending" | "unreachable"> {
  try {
    await new UntraceClient({ clientId, clientSecret: secret, maxRetries: 0, timeoutMs: 10_000 }).getToken()
    return "paired"
  } catch (err) {
    const status = (err as { status?: number }).status
    return status === 400 || status === 401 ? "pending" : "unreachable"
  }
}

async function status(io: AgentIo, f: Flags): Promise<number> {
  const rec = await io.store.readRecord()
  if (!rec) {
    io.out("No agent key on this machine. Run `untrace-mcp agent init`.")
    return 1
  }
  const secret = await io.store.readSecret(rec)
  io.out(`Name:        ${rec.label}`)
  io.out(`Client ID:   ${rec.clientId}`)
  io.out(`Fingerprint: ${rec.fingerprint}`)
  io.out(`Stored in:   ${rec.storage === "keychain" ? "the OS keychain" : `${io.store.dir} (file, mode 0600)`}`)
  io.out(`Created:     ${rec.createdAt}`)
  if (f.offline) {
    io.out("Paired:      not checked (--offline)")
    return 0
  }
  const state = await (io.probe ?? probeDrive)(rec.clientId, secret)
  io.out(
    `Paired:      ${
      state === "paired"
        ? "yes, Drive accepts this key"
        : state === "pending"
          ? "no. Approve the pairing code in Drive (or it was revoked: run `agent init --force`)"
          : "unknown, Drive could not be reached"
    }`
  )
  return state === "paired" ? 0 : 2
}

export async function runAgent(args: string[], io: AgentIo): Promise<number> {
  const [sub, ...rest] = args
  if (sub === undefined || sub === "--help" || sub === "-h" || sub === "help") {
    io.out(AGENT_HELP)
    return sub === undefined ? 1 : 0
  }
  const f = parseFlags(rest)
  if (sub !== "claim" && f.positional.length) throw new Error(`unexpected argument ${f.positional[0]}. See untrace-mcp agent --help.`)
  if (sub === "init") return init(io, f)
  if (sub === "code") return code(io, f)
  if (sub === "status") return status(io, f)
  if (sub === "claim") {
    if (f.positional.length !== 1) throw new Error("usage: untrace-mcp agent claim <link> --want <category:id[:mode]>. See agent --help.")
    const env = io.env ?? process.env
    // The flag wins over UNTRACE_AGENT_PROJECT. Both are checked before any network call.
    if (f.project !== undefined && f.project.trim() === "") throw new Error("--project needs a value")
    const project = f.project !== undefined ? parseProject(f.project, "--project") : parseProject(env.UNTRACE_AGENT_PROJECT, "UNTRACE_AGENT_PROJECT")
    return claimAgentLink(
      { ...io, probe: io.probe ?? probeDrive },
      { link: f.positional[0], wants: f.wants, label: f.label, runsOn: f.runsOn, wait: f.wait, project, baseUrl: io.baseUrl ?? env.UNTRACE_BASE_URL }
    )
  }
  throw new Error(`unknown agent command ${sub}. See untrace-mcp agent --help.`)
}

/**
 * For `untrace-mcp` / `untrace-mcp http`: when the environment has no developer key, use the
 * agent key from this machine. Sets UNTRACE_CLIENT_ID / UNTRACE_CLIENT_SECRET in this process
 * only, so the SDK and the redaction list pick it up unchanged. Returns the client id or null.
 */
export async function loadAgentCredentials(env: NodeJS.ProcessEnv = process.env, store = new AgentStore()): Promise<string | null> {
  if (env.UNTRACE_CLIENT_ID || env.UNTRACE_CLIENT_SECRET) return null
  const rec = await store.readRecord()
  if (!rec) return null
  env.UNTRACE_CLIENT_SECRET = await store.readSecret(rec)
  env.UNTRACE_CLIENT_ID = rec.clientId
  return rec.clientId
}
