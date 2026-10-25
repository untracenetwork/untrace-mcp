/**
 * `untrace-mcp agent claim`: link parsing, --want parsing, the claim message (pinned to Drive's
 * claimMessage() bytes), the request it sends, and every refusal. Drive is a fake fetch that
 * checks the two signatures the way Drive's claim route does.
 */
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPublicKey, verify } from "node:crypto"

import { exportClientSecret } from "@untracenetwork/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
  CLAIM_SIGN_PREFIX,
  CONNECTED_PROJECTS,
  checkWants,
  claimMessage,
  parseAgentLink,
  parseProject,
  parseWant,
  scopesFor,
  type RequestedItem,
} from "../src/agent/claim"
import { runAgent, type AgentIo } from "../src/agent/command"
import { agentSigner, fingerprint, keySignMessage } from "../src/agent/keys"
import { AgentStore } from "../src/agent/store"

const ID = "0b8f3c2e-5d4a-4f1b-9c7e-2a6d8e1f4b3c"
const SECRET = "AbCdEfGhIjKlMnOpQrStUv"
const LINK = `https://drive.untrace.network/a/${ID}#${SECRET}`

const edVerify = (msg: Uint8Array, sig: Uint8Array, pub: Uint8Array) =>
  verify(null, msg, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") }, format: "jwk" }), sig)
const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"))

describe("parseAgentLink", () => {
  it("takes id and secret, secret from the fragment only", () => {
    expect(parseAgentLink(LINK)).toEqual({ origin: "https://drive.untrace.network", id: ID, secret: SECRET })
    expect(parseAgentLink(`  ${LINK.replace(ID, ID.toUpperCase())}  `).id).toBe(ID)
  })
  it("refuses another host, http, credentials, query, missing or bad parts", () => {
    for (const bad of [
      `https://evil.example/a/${ID}#${SECRET}`,
      `https://drive.untrace.network.evil.example/a/${ID}#${SECRET}`,
      `http://drive.untrace.network/a/${ID}#${SECRET}`,
      `https://user:pw@drive.untrace.network/a/${ID}#${SECRET}`,
      `https://drive.untrace.network:8443/a/${ID}#${SECRET}`,
      `https://drive.untrace.network/a/${ID}?s=${SECRET}`,
      `https://drive.untrace.network/a/${ID}`,
      `https://drive.untrace.network/a/${ID}#short`,
      `https://drive.untrace.network/a/not-a-uuid#${SECRET}`,
      `https://drive.untrace.network/x/${ID}#${SECRET}`,
      "utp1_notalink",
    ]) {
      expect(() => parseAgentLink(bad), bad).toThrow()
    }
  })
  it("follows UNTRACE_BASE_URL, and allows loopback http for local Drive", () => {
    expect(parseAgentLink(`http://localhost:3000/a/${ID}#${SECRET}`, "http://localhost:3000").origin).toBe("http://localhost:3000")
    expect(() => parseAgentLink(LINK, "http://localhost:3000")).toThrow(/this server talks to/)
  })
})

describe("parseWant", () => {
  it("defaults to read and the id as name", () => {
    expect(parseWant("files:folder-q3")).toEqual({ category: "files", resource: "folder-q3", mode: "read", name: "folder-q3" })
  })
  it("reads mode, 2FA kind and a display name", () => {
    expect(parseWant("files:folder-q3:read_write=Q3 board pack")).toEqual({ category: "files", resource: "folder-q3", mode: "read_write", name: "Q3 board pack" })
    expect(parseWant("vault:entry-gh:totp=GitHub 2FA")).toEqual({ category: "vault", resource: "entry-gh", mode: "read", name: "GitHub 2FA", kind: "totp" })
    expect(parseWant("vault:entry-gh:read:totp").kind).toBe("totp")
    expect(parseWant("mail:agent@acme.test:write")).toMatchObject({ resource: "agent@acme.test", mode: "write" })
  })
  it("keeps colons inside an id", () => {
    expect(parseWant("files:a:b:c:write")).toMatchObject({ resource: "a:b:c", mode: "write" })
    expect(parseWant("files:a:b")).toMatchObject({ resource: "a:b", mode: "read" })
  })
  it("refuses wallet, unknown categories, empty ids and names, control characters", () => {
    expect(() => parseWant("wallet:w1")).toThrow(/wallet access is not available/)
    for (const bad of ["photos:x", "files:", "files::read", "files:x=", "files:a\u0007b"]) expect(() => parseWant(bad), bad).toThrow()
  })
  it("checkWants needs at least one, no duplicates, at most 50", () => {
    expect(() => checkWants([])).toThrow(/say what the agent needs/)
    const a = parseWant("files:x")
    expect(() => checkWants([a, { ...a, mode: "write" }])).toThrow(/twice/)
    expect(() => checkWants(Array.from({ length: 51 }, (_, i) => parseWant(`files:f${i}`)))).toThrow(/at most 50/)
  })
  it("scopesFor maps Files modes like Drive", () => {
    expect(scopesFor([parseWant("files:a:read_write"), parseWant("vault:v:read_write")])).toEqual(["download", "upload"])
    expect(scopesFor([parseWant("files:a:write")])).toEqual(["upload"])
    expect(scopesFor([parseWant("mail:m")])).toEqual([])
  })
})

describe("claim message (cross-repo)", () => {
  it("matches Drive's claimMessage() byte for byte", () => {
    // Same text Drive's lib/cloud/agent-links/rules.ts claimMessage() returns for these inputs.
    const requested: RequestedItem[] = [
      { category: "files", resource: "folder-q3", mode: "read_write", name: "Q3" },
      { category: "vault", resource: "entry-gh", mode: "read", name: "GitHub 2FA", kind: "totp" },
    ]
    expect(claimMessage({ linkId: ID, clientId: "utc_AAAAAAAAAAAbbbbbbbbbbb", signPublicKey: "S=", boxPublicKey: "B=", requested })).toBe(
      [
        "untrace:agent-link-claim:v1",
        `link: ${ID}`,
        "client: utc_AAAAAAAAAAAbbbbbbbbbbb",
        "sign: S=",
        "box: B=",
        "requested:",
        "files|folder-q3|read_write|\nvault|entry-gh|read|totp",
      ].join("\n")
    )
    expect(CLAIM_SIGN_PREFIX).toBe("untrace:agent-link-claim:v1")
  })
  it("a null or empty project leaves the message unchanged", () => {
    const a = { linkId: ID, clientId: "utc_AAAAAAAAAAAbbbbbbbbbbb", signPublicKey: "S=", boxPublicKey: "B=", requested: [{ category: "files", resource: "f", mode: "read", name: "f" }] as RequestedItem[] }
    const golden = ["untrace:agent-link-claim:v1", `link: ${ID}`, "client: utc_AAAAAAAAAAAbbbbbbbbbbb", "sign: S=", "box: B=", "requested:", "files|f|read|"].join("\n")
    expect(claimMessage(a)).toBe(golden)
    expect(claimMessage({ ...a, project: null })).toBe(golden)
    expect(claimMessage({ ...a, project: "" })).toBe(golden)
  })
  it("with a project, matches Drive's message: the project line sits after box and before requested", () => {
    // Drive main 931e5be, lib/cloud/agent-links/rules.ts claimMessage() with project "aiteam.space".
    const requested: RequestedItem[] = [
      { category: "files", resource: "folder-q3", mode: "read_write", name: "Q3" },
      { category: "vault", resource: "entry-gh", mode: "read", name: "GitHub 2FA", kind: "totp" },
    ]
    expect(claimMessage({ linkId: ID, clientId: "utc_AAAAAAAAAAAbbbbbbbbbbb", signPublicKey: "S=", boxPublicKey: "B=", requested, project: "aiteam.space" })).toBe(
      `untrace:agent-link-claim:v1\nlink: ${ID}\nclient: utc_AAAAAAAAAAAbbbbbbbbbbb\nsign: S=\nbox: B=\nproject: aiteam.space\nrequested:\nfiles|folder-q3|read_write|\nvault|entry-gh|read|totp`
    )
  })
})

describe("parseProject", () => {
  it("mirrors Drive's connected projects list", () => {
    expect(CONNECTED_PROJECTS).toEqual(["aiteam.space"])
    expect(parseProject("aiteam.space")).toBe("aiteam.space")
    expect(parseProject(" aiteam.space ")).toBe("aiteam.space")
    expect(parseProject(undefined)).toBeUndefined()
    expect(parseProject("")).toBeUndefined()
  })
  it("refuses anything else, naming where it came from", () => {
    for (const bad of ["AITEAM.SPACE", "aiteam.space.evil.example", "www.aiteam.space", "evil.example", "aiteam.space\nrequested:"]) expect(() => parseProject(bad), bad).toThrow(/not a connected project/)
    expect(() => parseProject("x", "UNTRACE_AGENT_PROJECT")).toThrow(/^UNTRACE_AGENT_PROJECT/)
  })
})

describe("agent claim", () => {
  let dir: string
  let lines: string[]
  let errs: string[]
  let calls: Array<{ url: string; init: RequestInit }>
  let reply: (body: Record<string, unknown>) => Response

  /** Drive's checks: key signature, claim signature, then fingerprint. */
  const driveLike = (body: Record<string, unknown>) => {
    const sign = b64(body.signPublicKey as string)
    const box = b64(body.boxPublicKey as string)
    const keyOk = edVerify(keySignMessage(body.clientId as string, box), b64(body.keySignature as string), sign)
    const msg = claimMessage({
      linkId: ID,
      clientId: body.clientId as string,
      signPublicKey: body.signPublicKey as string,
      boxPublicKey: body.boxPublicKey as string,
      requested: body.requested as RequestedItem[],
      project: body.project as string | undefined,
    })
    const claimOk = edVerify(new TextEncoder().encode(msg), b64(body.claimSignature as string), sign)
    if (!keyOk) return Response.json({ error: "key_signature" }, { status: 400 })
    if (!claimOk) return Response.json({ error: "claim_signature" }, { status: 400 })
    return Response.json({ id: ID, status: "claimed", fingerprint: fingerprint(sign, box) }, { status: 202 })
  }

  const io = (extra: Partial<AgentIo> = {}): AgentIo => ({
    out: (l) => lines.push(l),
    err: (l) => errs.push(l),
    now: () => Date.now(),
    store: new AgentStore(dir, []),
    env: {},
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return reply(JSON.parse(String(init.body)))
    }) as unknown as typeof fetch,
    ...extra,
  })

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "untrace-claim-"))
    lines = []
    errs = []
    calls = []
    reply = driveLike
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  const WANTS = ["--want", "files:folder-q3:read_write=Q3 board pack", "--want", "vault:entry-openai=OPENAI_API_KEY", "--want", "mail:agent@acme.test"]

  it("creates a key, claims, prints the fingerprint Drive shows; sends no secret but the link's", async () => {
    expect(await runAgent(["claim", LINK, ...WANTS, "--label", "Codex on laptop"], io())).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(`https://drive.untrace.network/api/agent-links/${ID}/claim`)
    expect(calls[0].init.method).toBe("POST")
    expect(calls[0].init.redirect).toBe("error")
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(
      ["agentName", "boxPublicKey", "claimSignature", "clientId", "keySignature", "oauthHash", "requested", "runsOn", "secret", "signPublicKey"].sort()
    )
    expect(body.secret).toBe(SECRET)
    expect(body.agentName).toBe("Codex on laptop")
    expect(body.requested).toEqual([
      { category: "files", resource: "folder-q3", mode: "read_write", name: "Q3 board pack" },
      { category: "vault", resource: "entry-openai", mode: "read", name: "OPENAI_API_KEY" },
      { category: "mail", resource: "agent@acme.test", mode: "read", name: "agent@acme.test" },
    ])

    const store = new AgentStore(dir, [])
    const rec = (await store.readRecord())!
    const secret = await store.readSecret(rec)
    expect(String(calls[0].init.body)).not.toContain(secret)
    expect(rec.clientId).toBe(body.clientId)
    expect(rec.scopes).toEqual(["download", "upload"])
    expect(lines.join("\n")).toContain(`Fingerprint: ${rec.fingerprint}`)
    expect(lines.join("\n")).toContain("Created an agent key")
  })

  it("reuses the key from agent init", async () => {
    expect(await runAgent(["init", "--label", "Release agent"], io())).toBe(0)
    const rec = (await new AgentStore(dir, []).readRecord())!
    lines = []
    expect(await runAgent(["claim", LINK, ...WANTS], io())).toBe(0)
    expect(JSON.parse(String(calls[0].init.body)).clientId).toBe(rec.clientId)
    expect(lines.join("\n")).toContain(`Using this machine's agent key ${rec.clientId}`)
  })

  it("uses the frozen vector key: Drive-side signature checks pass", async () => {
    const secret = exportClientSecret(Uint8Array.from({ length: 32 }, (_, i) => i))
    const s = await agentSigner(secret)
    await new AgentStore(dir, []).save(
      { clientId: "utc_AAAAAAAAAAAbbbbbbbbbbb", label: "Test agent", scopes: [], fingerprint: fingerprint(s.signPublicKey, s.boxPublicKey), createdAt: new Date().toISOString() },
      secret
    )
    expect(await runAgent(["claim", LINK, "--want", "files:f"], io())).toBe(0)
    const body = JSON.parse(String(calls[0].init.body))
    expect(body.signPublicKey).toBe("FefxYmMH7YXYKSids3pdXYT2ZsXR4kXJqe3SOhPMOLo=")
    expect(body.oauthHash).toBe("ab1f79db0fb1c34484f45b7f30cf5690eb845617cffcd0315c3fcae4f8ceb784")
    expect(lines.join("\n")).toContain("3OBH-WXU7-IF37-ZEWY")
  })

  it("explains 404, 410, 429 and 400 in plain words; keeps a new key", async () => {
    for (const [status, text] of [
      [404, /does not know this link/],
      [410, /already used, has expired/],
      [429, /too many tries/],
    ] as const) {
      errs = []
      reply = () => Response.json({ error: "x" }, { status })
      expect(await runAgent(["claim", LINK, ...WANTS], io())).toBe(1)
      expect(errs.join("\n")).toMatch(text)
    }
    errs = []
    reply = () => Response.json({ error: "wallet_not_available", message: "no" }, { status: 400 })
    expect(await runAgent(["claim", LINK, ...WANTS], io())).toBe(1)
    expect(errs.join("\n")).toContain("wallet_not_available")
    expect(await new AgentStore(dir, []).readRecord()).not.toBeNull()
  })

  it("refuses when Drive's fingerprint differs from this machine's", async () => {
    reply = () => Response.json({ id: ID, status: "claimed", fingerprint: "AAAA-AAAA-AAAA-AAAA" }, { status: 202 })
    expect(await runAgent(["claim", LINK, ...WANTS], io())).toBe(1)
    expect(errs.join("\n")).toMatch(/Tell the owner to reject it/)
  })

  it("--wait polls until approved", async () => {
    let n = 0
    const probe = async () => (++n >= 3 ? ("paired" as const) : ("pending" as const))
    expect(await runAgent(["claim", LINK, ...WANTS, "--wait"], io({ probe, sleep: async () => {} }))).toBe(0)
    expect(n).toBe(3)
    expect(lines.join("\n")).toContain("Approved.")
  })

  it("--wait gives up after the deadline", async () => {
    let t = 0
    const r = await runAgent(["claim", LINK, ...WANTS, "--wait"], io({ now: () => (t += 60_000), probe: async () => "pending", sleep: async () => {} }))
    expect(r).toBe(2)
  })

  it("refuses before any network call: no link, two links, no --want, wallet, other host", async () => {
    await expect(runAgent(["claim", ...WANTS], io())).rejects.toThrow(/usage/)
    await expect(runAgent(["claim", LINK, LINK, ...WANTS], io())).rejects.toThrow(/usage/)
    await expect(runAgent(["claim", LINK], io())).rejects.toThrow(/say what the agent needs/)
    await expect(runAgent(["claim", LINK, "--want", "wallet:w"], io())).rejects.toThrow(/wallet/)
    await expect(runAgent(["claim", `https://evil.example/a/${ID}#${SECRET}`, ...WANTS], io())).rejects.toThrow(/this server talks to/)
    expect(calls).toHaveLength(0)
    expect(await new AgentStore(dir, []).readRecord()).toBeNull()
  })

  it("--project is signed into the claim and sent in the body", async () => {
    expect(await runAgent(["claim", LINK, ...WANTS, "--project", "aiteam.space"], io())).toBe(0)
    const body = JSON.parse(String(calls[0].init.body)) as Record<string, unknown>
    expect(body.project).toBe("aiteam.space")
    expect(lines.join("\n")).toContain("Project:     aiteam.space")
    // The signature covers the project: the same body without the line in the message fails.
    const sign = b64(body.signPublicKey as string)
    const bare = claimMessage({
      linkId: ID,
      clientId: body.clientId as string,
      signPublicKey: body.signPublicKey as string,
      boxPublicKey: body.boxPublicKey as string,
      requested: body.requested as RequestedItem[],
    })
    expect(edVerify(new TextEncoder().encode(bare), b64(body.claimSignature as string), sign)).toBe(false)
  })

  it("no project: the body has no project field", async () => {
    expect(await runAgent(["claim", LINK, ...WANTS], io())).toBe(0)
    expect(JSON.parse(String(calls[0].init.body))).not.toHaveProperty("project")
    expect(lines.join("\n")).not.toContain("Project:")
  })

  it("UNTRACE_AGENT_PROJECT is the default; --project wins; empty env means none", async () => {
    expect(await runAgent(["claim", LINK, ...WANTS], io({ env: { UNTRACE_AGENT_PROJECT: "aiteam.space" } }))).toBe(0)
    expect(JSON.parse(String(calls[0].init.body)).project).toBe("aiteam.space")
    // A bad env value is overridden by a good flag.
    expect(await runAgent(["claim", LINK, ...WANTS, "--project=aiteam.space"], io({ env: { UNTRACE_AGENT_PROJECT: "nope.example" } }))).toBe(0)
    expect(JSON.parse(String(calls[1].init.body)).project).toBe("aiteam.space")
    expect(await runAgent(["claim", LINK, ...WANTS], io({ env: { UNTRACE_AGENT_PROJECT: "" } }))).toBe(0)
    expect(JSON.parse(String(calls[2].init.body))).not.toHaveProperty("project")
  })

  it("an unknown project is refused before any network call or key", async () => {
    await expect(runAgent(["claim", LINK, ...WANTS, "--project", "evil.example"], io())).rejects.toThrow(/--project "evil.example" is not a connected project/)
    await expect(runAgent(["claim", LINK, ...WANTS, "--project="], io())).rejects.toThrow(/--project needs a value/)
    await expect(runAgent(["claim", LINK, ...WANTS, "--project"], io())).rejects.toThrow(/--project needs a value/)
    await expect(runAgent(["claim", LINK, ...WANTS], io({ env: { UNTRACE_AGENT_PROJECT: "evil.example" } }))).rejects.toThrow(/UNTRACE_AGENT_PROJECT/)
    expect(calls).toHaveLength(0)
    expect(await new AgentStore(dir, []).readRecord()).toBeNull()
  })

  it("other subcommands still refuse stray arguments", async () => {
    await expect(runAgent(["status", "extra"], io())).rejects.toThrow(/unexpected argument/)
  })
})
