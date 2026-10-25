/**
 * `untrace-mcp agent claim <link>`: the agent side of a one-time agent link from Untrace Drive
 * (Settings > Developer > Give your agent access). docs/AGENT-PAIRING.md "One-time agent link".
 *
 * The owner creates the link in Drive. The agent runs this command with it. It:
 *   1. uses this machine's agent key (from `agent init`), or creates one here;
 *   2. POSTs to {origin}/api/agent-links/{id}/claim: the link secret from the URL fragment,
 *      the PUBLIC keys, the key signature, the OAuth hash, a claim signature binding all of it
 *      to this link and this request, and the list of items the agent asks for;
 *   3. prints the fingerprint the owner must see in Drive before approving.
 *
 * Nothing secret leaves the machine except the one-time link secret, which Drive burns on claim.
 * The link host must be the Drive this server talks to (UNTRACE_BASE_URL, default
 * https://drive.untrace.network), so a link cannot point the agent at another server.
 *
 * Wire format: Drive app/api/agent-links/[id]/claim/route.ts and claimMessage() in
 * lib/cloud/agent-links/rules.ts. test/claim.test.ts pins the same message bytes.
 */
import { hostname } from "node:os"

import { agentSigner, fingerprint, keySignMessage, newClientId, newSecret } from "./keys"
import { LABEL_MAX, validLabel } from "./pairing"
import type { AgentStore, AgentRecord } from "./store"

export const DEFAULT_DRIVE = "https://drive.untrace.network"
export const CLAIM_SIGN_PREFIX = "untrace:agent-link-claim:v1"

/**
 * Connected projects: the fixed list of projects an agent may say it connects from. Mirrors
 * Drive's CONNECTED_PROJECTS (lib/cloud/agent-links/projects.ts). Drive refuses anything else
 * with 400 invalid_project, so this list must stay in step with it.
 */
export const CONNECTED_PROJECTS = ["aiteam.space"] as const
export type ConnectedProject = (typeof CONNECTED_PROJECTS)[number]

/** Undefined or empty = no project. Anything outside CONNECTED_PROJECTS throws. */
export function parseProject(v: string | undefined, source = "--project"): ConnectedProject | undefined {
  if (v === undefined || v.trim() === "") return undefined
  const t = v.trim()
  if (!(CONNECTED_PROJECTS as readonly string[]).includes(t)) {
    throw new Error(`${source} ${JSON.stringify(t)} is not a connected project. Allowed: ${CONNECTED_PROJECTS.join(", ")}`)
  }
  return t as ConnectedProject
}

export const CATEGORIES = ["vault", "files", "mail"] as const
export const MODES = ["read", "write", "read_write"] as const
export type Category = (typeof CATEGORIES)[number]
export type Mode = (typeof MODES)[number]

export interface RequestedItem {
  category: Category
  resource: string
  mode: Mode
  name: string
  kind?: "secret" | "totp"
}

// Same limits as Drive's rules.ts.
const RESOURCE_MAX = 256
const ITEM_NAME_MAX = 128
const RUNS_ON_MAX = 128
const MAX_ITEMS = 50
const SECRET_RE = /^[A-Za-z0-9_-]{22}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"])

function cleanText(v: string, max: number): string | null {
  const t = v.trim()
  return t.length > 0 && t.length <= max && !CONTROL_RE.test(t) ? t : null
}

export interface ParsedLink {
  origin: string
  id: string
  secret: string
}

/** `https://drive.untrace.network/a/<uuid>#<secret>`. The secret only ever rides in the fragment. */
export function parseAgentLink(text: string, allowedOrigin: string = DEFAULT_DRIVE): ParsedLink {
  let u: URL
  try {
    u = new URL(text.trim())
  } catch {
    throw new Error("that is not an agent link. It looks like https://drive.untrace.network/a/<id>#<secret>")
  }
  const allowed = new URL(allowedOrigin)
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOOPBACK.has(u.hostname))) throw new Error("agent links must be https")
  if (u.username || u.password) throw new Error("agent links never carry a user name or password")
  if (u.origin !== allowed.origin) {
    throw new Error(`this link is for ${u.origin}, but this server talks to ${allowed.origin}. Set UNTRACE_BASE_URL if that is intended.`)
  }
  const m = /^\/a\/([^/]+)\/?$/.exec(u.pathname)
  const secret = u.hash.replace(/^#/, "")
  if (!m || !UUID_RE.test(m[1]) || !SECRET_RE.test(secret) || u.search) {
    throw new Error("that agent link is incomplete. Copy the whole link from Drive, including the part after #")
  }
  return { origin: u.origin, id: m[1].toLowerCase(), secret }
}

/**
 * `--want files:<id>[:read|write|read_write][=Name]`, `--want vault:<id>[:read][:totp][=Name]`,
 * `--want mail:<address>[:read|write|read_write][=Name]`. Mode defaults to read.
 * The resource is everything between the category and the optional mode, so ids may hold `:`.
 */
export function parseWant(text: string): RequestedItem {
  const eq = text.indexOf("=")
  const spec = eq === -1 ? text : text.slice(0, eq)
  const label = eq === -1 ? undefined : text.slice(eq + 1)
  const parts = spec.split(":")
  const category = parts.shift() as Category
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    if ((category as string) === "wallet") throw new Error("wallet access is not available to agents")
    throw new Error(`--want ${text}: category must be ${CATEGORIES.join(", ")}`)
  }
  let kind: RequestedItem["kind"]
  if (category === "vault" && (parts.at(-1) === "totp" || parts.at(-1) === "secret")) kind = parts.pop() as RequestedItem["kind"]
  let mode: Mode = "read"
  if (parts.length > 1 && (MODES as readonly string[]).includes(parts.at(-1)!)) mode = parts.pop() as Mode
  const resource = cleanText(parts.join(":"), RESOURCE_MAX)
  if (!resource) throw new Error(`--want ${text}: missing the item id`)
  const name = label === undefined ? resource : cleanText(label, ITEM_NAME_MAX)
  if (!name) throw new Error(`--want ${text}: the name after = must be 1 to ${ITEM_NAME_MAX} characters`)
  return { category, resource, mode, name, ...(kind ? { kind } : {}) }
}

export function checkWants(items: RequestedItem[]): RequestedItem[] {
  if (items.length === 0) throw new Error("say what the agent needs, e.g. --want files:<folder id>:read_write. See agent --help.")
  if (items.length > MAX_ITEMS) throw new Error(`at most ${MAX_ITEMS} --want items`)
  const seen = new Set<string>()
  for (const i of items) {
    const k = `${i.category}:${i.resource}`
    if (seen.has(k)) throw new Error(`--want ${k} is listed twice`)
    seen.add(k)
  }
  return items
}

/**
 * Byte for byte Drive's claimMessage() (lib/cloud/agent-links/rules.ts). The `project: <name>` line
 * is there only when a project is set; without one the message is the same as before.
 */
export function claimMessage(a: {
  linkId: string
  clientId: string
  signPublicKey: string
  boxPublicKey: string
  requested: RequestedItem[]
  project?: string | null
}): string {
  const req = a.requested.map((r) => [r.category, r.resource, r.mode, r.kind ?? ""].join("|")).join("\n")
  return [
    CLAIM_SIGN_PREFIX,
    `link: ${a.linkId}`,
    `client: ${a.clientId}`,
    `sign: ${a.signPublicKey}`,
    `box: ${a.boxPublicKey}`,
    ...(a.project ? [`project: ${a.project}`] : []),
    "requested:",
    req,
  ].join("\n")
}

/** Developer key scopes the agent's Files items could end up with (record only; Drive decides). */
export function scopesFor(items: RequestedItem[]): string[] {
  const s = new Set<string>()
  for (const i of items) {
    if (i.category !== "files") continue
    if (i.mode !== "write") s.add("download")
    if (i.mode !== "read") s.add("upload")
  }
  return ["download", "upload"].filter((x) => s.has(x))
}

export interface ClaimIo {
  out(line: string): void
  err(line: string): void
  now(): number
  store: AgentStore
  fetch?: typeof fetch
  probe?(clientId: string, secret: string): Promise<"paired" | "pending" | "unreachable">
  sleep?(ms: number): Promise<void>
}

export interface ClaimOptions {
  link: string
  wants: RequestedItem[]
  label?: string
  runsOn?: string
  baseUrl?: string
  wait?: boolean
  waitMs?: number
  /** Connected project (CONNECTED_PROJECTS). Signed into the claim and sent only when set. */
  project?: string
}

const ERRORS: Record<number, string> = {
  404: "Drive does not know this link, or the part after # is wrong. Ask the owner for a new link.",
  410: "this link was already used, has expired (15 minutes) or was cancelled. Ask the owner for a new link.",
  429: "too many tries on this link. Wait a minute, or ask the owner for a new link.",
}

/** Gets or creates this machine's agent key. */
async function agentKey(io: ClaimIo, label: string, scopes: string[]): Promise<{ rec: AgentRecord; secret: string; created: boolean }> {
  const existing = await io.store.readRecord()
  if (existing) return { rec: existing, secret: await io.store.readSecret(existing), created: false }
  const secret = newSecret()
  const s = await agentSigner(secret)
  const rec = await io.store.save(
    { clientId: newClientId(), label, scopes, fingerprint: fingerprint(s.signPublicKey, s.boxPublicKey), createdAt: new Date(io.now()).toISOString() },
    secret
  )
  return { rec, secret, created: true }
}

export async function claimAgentLink(io: ClaimIo, o: ClaimOptions): Promise<number> {
  const link = parseAgentLink(o.link, o.baseUrl ?? DEFAULT_DRIVE)
  const wants = checkWants(o.wants)
  const project = parseProject(o.project)
  const label = (o.label ?? `Agent on ${hostname()}`).replace(CONTROL_RE, "").trim().slice(0, LABEL_MAX).trim()
  if (!validLabel(label)) throw new Error(`--label must be 1 to ${LABEL_MAX} characters, no control characters`)
  const runsOn = o.runsOn === undefined ? `untrace-mcp on ${hostname()}`.slice(0, RUNS_ON_MAX) : cleanText(o.runsOn, RUNS_ON_MAX)
  if (!runsOn) throw new Error(`--runs-on must be 1 to ${RUNS_ON_MAX} characters, no control characters`)

  const { rec, secret, created } = await agentKey(io, label, scopesFor(wants))
  const signer = await agentSigner(secret)
  const signPublicKey = Buffer.from(signer.signPublicKey).toString("base64")
  const boxPublicKey = Buffer.from(signer.boxPublicKey).toString("base64")
  const b64 = (u: Uint8Array) => Buffer.from(u).toString("base64")
  const body = {
    secret: link.secret,
    clientId: rec.clientId,
    signPublicKey,
    boxPublicKey,
    keySignature: b64(signer.sign(keySignMessage(rec.clientId, signer.boxPublicKey))),
    oauthHash: signer.oauthHash,
    claimSignature: b64(
      signer.sign(new TextEncoder().encode(claimMessage({ linkId: link.id, clientId: rec.clientId, signPublicKey, boxPublicKey, requested: wants, project })))
    ),
    agentName: label,
    runsOn,
    requested: wants,
    ...(project ? { project } : {}),
  }

  const res = await (io.fetch ?? fetch)(`${link.origin}/api/agent-links/${link.id}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    redirect: "error",
  })
  const json = (await res.json().catch(() => ({}))) as { fingerprint?: string; error?: string; message?: string }
  if (res.status !== 202) {
    const why = ERRORS[res.status] ?? (res.status === 400 ? `Drive refused the claim (${json.error ?? "bad request"}${json.message ? `: ${json.message}` : ""}).` : `Drive answered ${res.status}.`)
    io.err(`untrace-mcp: ${why}`)
    if (created) io.err(`The new key stays on this machine (${rec.clientId}); a new link can reuse it.`)
    return 1
  }
  const fp = fingerprint(signer.signPublicKey, signer.boxPublicKey)
  if (json.fingerprint !== fp) {
    io.err(`untrace-mcp: Drive shows fingerprint ${json.fingerprint ?? "(none)"}, this machine has ${fp}. Tell the owner to reject it.`)
    return 1
  }

  io.out(created ? "Created an agent key on this machine. The secret never leaves it." : `Using this machine's agent key ${rec.clientId}.`)
  io.out("Link claimed. The owner now approves it in Untrace Drive: Settings > Developer > Give your agent access.")
  io.out("")
  io.out(`Fingerprint: ${fp}   (the owner checks Drive shows the same)`)
  io.out(`Name:        ${label}`)
  if (project) io.out(`Project:     ${project}`)
  io.out(`Asks for:    ${wants.map((w) => `${w.category} ${w.name} (${w.mode.replace("_", "+")})`).join(", ")}`)

  if (!o.wait) {
    io.out("")
    io.out("Run `untrace-mcp agent status` to see when it is approved.")
    return 0
  }
  const deadline = io.now() + (o.waitMs ?? 15 * 60_000)
  const sleep = io.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const probe = io.probe
  if (!probe) throw new Error("internal: no probe")
  io.out("")
  io.out("Waiting for the owner to approve (up to 15 minutes)...")
  while (io.now() < deadline) {
    if ((await probe(rec.clientId, secret)) === "paired") {
      io.out("Approved. Plain `untrace-mcp` now uses this key.")
      return 0
    }
    await sleep(5_000)
  }
  io.err("untrace-mcp: not approved yet. Run `untrace-mcp agent status` later.")
  return 2
}
