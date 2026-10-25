/**
 * `untrace-mcp agent`: key generation on this machine, the pairing code (same vector as Drive's
 * tests/unit/agent-pairing/fixtures.ts), the 0600 file store and its refusals, the keychain path,
 * status, and the fallback that makes plain `untrace-mcp` use the agent key.
 */
import { mkdtemp, readFile, rm, stat, chmod, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { verify, createPublicKey } from "node:crypto"

import { exportClientSecret, deriveClientKeys, deriveOAuthClientSecret } from "@untracenetwork/sdk"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { agentSigner, fingerprint, isClientSecret, keySignMessage, newClientId, newSecret } from "../src/agent/keys"
import { encodePairingCode, parseScopeList, PAIRING_CODE_PREFIX, validLabel } from "../src/agent/pairing"
import { AgentStore, configDir, macKeychain, secretTool, type Keychain } from "../src/agent/store"
import { defaultLabel, loadAgentCredentials, parseFlags, runAgent, type AgentIo } from "../src/agent/command"
import { redact, configuredSecrets } from "../src/redact"

// Same inputs and expected output as Drive tests/unit/agent-pairing/fixtures.ts (VECTOR).
const VECTOR = {
  secret: exportClientSecret(Uint8Array.from({ length: 32 }, (_, i) => i)),
  clientId: "utc_AAAAAAAAAAAbbbbbbbbbbb",
  nonce: Uint8Array.from({ length: 16 }, (_, i) => 0xa0 + i),
  expiresAt: 2_000_000_000,
  label: "Test agent",
  code:
    "utp1_AUFBQUFBQUFBQUFBYmJiYmJiYmJiYmIV5_FiYwfthdgpKJ2zel1dhPZmxdHiRcmp7dI6E8w4uu3943BUzU1Y90UxDGyXIW0kokOhqcoibrDqD7UgITonqx952w-xw0SE9Ft_MM9WkOuEVhfP_NAxXD_K5PjOt4SgoaKjpKWmp6ipqqusra6vdzWUAAMKVGVzdCBhZ2VudEBd8z7sje-dLiN_d9MUyVNp1LcSXG7EM8wgkhUO7xj1-AB2OWGE6AktHJMSfIDAQuZy91d3eqRFwEuUNmKoBg94ADShQxuDHYoZO__59oT7UnYJDh2uMCFXHVU-R7pA23GqB1hZ3u0IvtbbWzkjKhWlrbQ86Qn-gmeLEVl9rK4I",
  fingerprint: "3OBH-WXU7-IF37-ZEWY",
  signPublicKey: "FefxYmMH7YXYKSids3pdXYT2ZsXR4kXJqe3SOhPMOLo=",
  boxPublicKey: "7f3jcFTNTVj3RTEMbJchbSSiQ6GpyiJusOoPtSAhOic=",
  oauthHash: "ab1f79db0fb1c34484f45b7f30cf5690eb845617cffcd0315c3fcae4f8ceb784",
}

const edVerify = (msg: Uint8Array, sig: Uint8Array, pub: Uint8Array) =>
  verify(null, msg, createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(pub).toString("base64url") }, format: "jwk" }), sig)

describe("pairing code v1 (cross-repo vector)", () => {
  it("derives the same public keys and OAuth hash as Drive", async () => {
    const s = await agentSigner(VECTOR.secret)
    expect(Buffer.from(s.signPublicKey).toString("base64")).toBe(VECTOR.signPublicKey)
    expect(Buffer.from(s.boxPublicKey).toString("base64")).toBe(VECTOR.boxPublicKey)
    expect(s.oauthHash).toBe(VECTOR.oauthHash)
    expect(fingerprint(s.signPublicKey, s.boxPublicKey)).toBe(VECTOR.fingerprint)
  })

  it("encodes the frozen vector byte for byte", async () => {
    const s = await agentSigner(VECTOR.secret)
    const code = encodePairingCode(
      { clientId: VECTOR.clientId, label: VECTOR.label, scopes: ["download", "upload"], nonce: VECTOR.nonce, expiresAt: VECTOR.expiresAt },
      s
    )
    expect(code).toBe(VECTOR.code)
  })

  it("both signatures verify with the sign public key", async () => {
    const s = await agentSigner(VECTOR.secret)
    const b = Buffer.from(VECTOR.code.slice(PAIRING_CODE_PREFIX.length), "base64url")
    const L = b[140]
    const keySig = b.subarray(141 + L, 205 + L)
    const pairSig = b.subarray(205 + L)
    expect(edVerify(keySignMessage(VECTOR.clientId, s.boxPublicKey), keySig, s.signPublicKey)).toBe(true)
    expect(edVerify(Buffer.concat([Buffer.from("untrace:agent-pair:v1:"), b.subarray(0, 205 + L)]), pairSig, s.signPublicKey)).toBe(true)
  })

  it("holds no secret material", async () => {
    const raw = Uint8Array.from({ length: 32 }, (_, i) => i)
    const ck = await deriveClientKeys(raw)
    const bytes = Buffer.from(VECTOR.code.slice(5), "base64url")
    for (const needle of [raw, ck.boxSecretKey, Buffer.from(await deriveOAuthClientSecret(raw), "base64url")]) {
      expect(bytes.indexOf(Buffer.from(needle))).toBe(-1)
    }
  })

  it.each([
    ["client id", { clientId: "utc_x" }],
    ["label", { label: " padded" }],
    ["nonce", { nonce: new Uint8Array(3) }],
    ["expiry", { expiresAt: -1 }],
    ["scopes", { scopes: [] }],
  ])("refuses a bad %s", async (_, over) => {
    const s = await agentSigner(VECTOR.secret)
    const input = { clientId: VECTOR.clientId, label: VECTOR.label, scopes: ["download"] as const, nonce: VECTOR.nonce, expiresAt: 1, ...over }
    expect(() => encodePairingCode(input as never, s)).toThrow(/pairing/)
  })

  it("refuses a malformed oauth hash from a signer", async () => {
    const s = { ...(await agentSigner(VECTOR.secret)), oauthHash: "zz" }
    expect(() => encodePairingCode({ clientId: VECTOR.clientId, label: "x", scopes: ["download"], nonce: VECTOR.nonce, expiresAt: 1 }, s)).toThrow(/oauth/)
  })
})

describe("key helpers", () => {
  it("newSecret is a fresh client secret, newClientId is utc_ + 22 base58", () => {
    const a = newSecret()
    expect(isClientSecret(a)).toBe(true)
    expect(a).not.toBe(newSecret())
    expect(isClientSecret("nope")).toBe(false)
    expect(isClientSecret(exportClientSecret(new Uint8Array(32)).slice(0, 18))).toBe(false)
    expect(newClientId()).toMatch(/^utc_[1-9A-HJ-NP-Za-km-z]{22}$/)
  })
  it("labels and scopes", () => {
    expect(validLabel("Build bot")).toBe(true)
    expect(validLabel("")).toBe(false)
    expect(validLabel("a\u0007b")).toBe(false)
    expect(validLabel("x".repeat(65))).toBe(false)
    expect(parseScopeList("upload, download")).toEqual(["download", "upload"])
    expect(() => parseScopeList("admin")).toThrow(/unknown scope/)
    expect(() => parseScopeList(" , ")).toThrow(/at least one/)
    expect(defaultLabel("ci-box-7")).toBe("Agent on ci-box-7")
    expect(defaultLabel("\u0001")).toBe("Agent on this machine")
    expect(defaultLabel("h".repeat(100)).length).toBeLessThanOrEqual(64)
  })
  it("flags", () => {
    expect(parseFlags(["--label", "A b", "--scopes=upload", "--ttl", "5", "--force", "--offline"])).toEqual({
      label: "A b",
      scopes: "upload",
      ttl: "5",
      force: true,
      offline: true,
      wants: [],
      wait: false,
      positional: [],
    })
    expect(() => parseFlags(["--label"])).toThrow(/needs a value/)
    expect(() => parseFlags(["--nope"])).toThrow(/unknown option/)
  })
})

describe("config dir", () => {
  it("prefers UNTRACE_MCP_CONFIG_DIR, then XDG, then the platform default", () => {
    expect(configDir({ UNTRACE_MCP_CONFIG_DIR: "/x" }, "linux", "/h")).toBe("/x")
    expect(configDir({ XDG_CONFIG_HOME: "/c" }, "linux", "/h")).toBe(join("/c", "untrace-mcp"))
    expect(configDir({}, "darwin", "/h")).toBe(join("/h", "Library", "Application Support", "untrace-mcp"))
    expect(configDir({ APPDATA: "/a" }, "win32", "/h")).toBe(join("/a", "untrace-mcp"))
    expect(configDir({}, "win32", "/h")).toBe(join("/h", "AppData", "Roaming", "untrace-mcp"))
    expect(configDir({}, "linux", "/h")).toBe(join("/h", ".config", "untrace-mcp"))
  })
})

let dir: string
let out: string[]
let err: string[]
const io = (store: AgentStore, probe?: AgentIo["probe"]): AgentIo => ({
  out: (l) => out.push(l),
  err: (l) => err.push(l),
  now: () => 1_900_000_000_000,
  store,
  probe,
})

beforeEach(async () => {
  dir = join(await mkdtemp(join(tmpdir(), "untrace-agent-")), "cfg")
  out = []
  err = []
})
afterEach(async () => {
  await rm(join(dir, ".."), { recursive: true, force: true })
})

const posix = process.platform !== "win32"

describe("agent init with the file store", () => {
  it("creates the key here, 0600 in a 0700 dir, and prints only a pairing code", async () => {
    const store = new AgentStore(dir, [])
    expect(await runAgent(["init", "--label", "Release agent", "--scopes", "download,upload"], io(store))).toBe(0)
    const secret = (await readFile(join(dir, "agent.secret"), "utf8")).trim()
    expect(isClientSecret(secret)).toBe(true)
    if (posix) {
      expect((await stat(dir)).mode & 0o777).toBe(0o700)
      expect((await stat(join(dir, "agent.secret"))).mode & 0o777).toBe(0o600)
      expect((await stat(join(dir, "agent.json"))).mode & 0o777).toBe(0o600)
    }
    const printed = out.join("\n")
    expect(printed).not.toContain(secret)
    expect(printed).not.toContain(secret.slice(14))
    expect(printed).toMatch(/^utp1_[A-Za-z0-9_-]+$/m)
    expect(printed).toContain("Release agent")
    expect(printed).toContain("download, upload")
    expect(printed).toContain("2030-03-17T") // now + 15 min
    const rec = JSON.parse(await readFile(join(dir, "agent.json"), "utf8"))
    expect(rec).toMatchObject({ version: 1, label: "Release agent", scopes: ["download", "upload"], storage: "file" })
    expect(JSON.stringify(rec)).not.toContain(secret.slice(14))
    const s = await agentSigner(secret)
    expect(rec.fingerprint).toBe(fingerprint(s.signPublicKey, s.boxPublicKey))
    expect(printed).toContain(rec.fingerprint)
  })

  it("refuses to overwrite an existing key without --force", async () => {
    const store = new AgentStore(dir, [])
    await runAgent(["init"], io(store))
    const first = JSON.parse(await readFile(join(dir, "agent.json"), "utf8")).clientId
    expect(await runAgent(["init"], io(store))).toBe(1)
    expect(err.join("\n")).toContain("already has an agent key")
    expect(await runAgent(["init", "--force"], io(store))).toBe(0)
    expect(JSON.parse(await readFile(join(dir, "agent.json"), "utf8")).clientId).not.toBe(first)
  })

  it("validates label, scopes and ttl before creating anything", async () => {
    const store = new AgentStore(dir, [])
    await expect(runAgent(["init", "--label", "x".repeat(65)], io(store))).rejects.toThrow(/--label/)
    await expect(runAgent(["init", "--scopes", "root"], io(store))).rejects.toThrow(/unknown scope/)
    await expect(runAgent(["init", "--ttl", "0"], io(store))).rejects.toThrow(/--ttl/)
    await expect(runAgent(["init", "--ttl", "1441"], io(store))).rejects.toThrow(/--ttl/)
    expect(await store.readRecord()).toBeNull()
  })

  it.runIf(posix)("refuses to read a secret file other users can read", async () => {
    const store = new AgentStore(dir, [])
    await runAgent(["init"], io(store))
    await chmod(join(dir, "agent.secret"), 0o644)
    await expect(runAgent(["code"], io(store))).rejects.toThrow(/mode 644 lets other users read it/)
    await chmod(join(dir, "agent.secret"), 0o600)
    await chmod(dir, 0o755)
    await expect(runAgent(["code"], io(store))).rejects.toThrow(/refusing directory/)
  })

  it("agent code prints a fresh code for the same key, with narrowed scopes and ttl", async () => {
    const store = new AgentStore(dir, [])
    await runAgent(["init", "--scopes", "download,upload"], io(store))
    const first = out.find((l) => l.startsWith("utp1_"))
    out = []
    expect(await runAgent(["code", "--scopes", "download", "--ttl", "60"], io(store))).toBe(0)
    const second = out.find((l) => l.startsWith("utp1_"))
    expect(second).toBeDefined()
    expect(second).not.toBe(first) // fresh nonce
    expect(out.join("\n")).toContain("Asks for:    download\n".trim())
    expect(out.join("\n")).toContain("2030-03-17T18:46:40") // now + 60 min
  })

  it("agent code / status without a key explain what to run", async () => {
    const store = new AgentStore(dir, [])
    expect(await runAgent(["code"], io(store))).toBe(1)
    expect(err.join("\n")).toContain("agent init")
    expect(await runAgent(["status"], io(store))).toBe(1)
    expect(out.join("\n")).toContain("agent init")
  })
})

describe("agent status", () => {
  it.each([
    ["paired", 0, "yes, Drive accepts this key"],
    ["pending", 2, "Approve the pairing code"],
    ["unreachable", 2, "could not be reached"],
  ] as const)("%s", async (state, code, text) => {
    const store = new AgentStore(dir, [])
    await runAgent(["init"], io(store))
    out = []
    const seen: string[] = []
    const probe = async (id: string, secret: string) => {
      seen.push(id, secret)
      return state
    }
    expect(await runAgent(["status"], io(store, probe))).toBe(code)
    const rec = await store.readRecord()
    expect(out.join("\n")).toContain(rec!.fingerprint)
    expect(out.join("\n")).toContain(text)
    expect(seen[0]).toBe(rec!.clientId)
    expect(out.join("\n")).not.toContain(seen[1].slice(14))
  })

  it("--offline does not contact Drive", async () => {
    const store = new AgentStore(dir, [])
    await runAgent(["init"], io(store))
    out = []
    expect(await runAgent(["status", "--offline"], io(store, async () => { throw new Error("no network") }))).toBe(0)
    expect(out.join("\n")).toContain("not checked")
  })
})

describe("keychain storage", () => {
  function fakeKeychain(ok = true): Keychain & { items: Map<string, string> } {
    const items = new Map<string, string>()
    return {
      name: "fake",
      items,
      available: async () => ok,
      set: async (a, s) => void items.set(a, s),
      get: async (a) => items.get(a) ?? null,
      delete: async (a) => void items.delete(a),
    }
  }

  it("puts the secret in the keychain and writes no secret file", async () => {
    const kc = fakeKeychain()
    const store = new AgentStore(dir, [kc])
    await runAgent(["init"], io(store))
    const rec = await store.readRecord()
    expect(rec!.storage).toBe("keychain")
    expect(isClientSecret(kc.items.get(rec!.clientId)!)).toBe(true)
    await expect(stat(join(dir, "agent.secret"))).rejects.toThrow()
    expect(await store.readSecret(rec!)).toBe(kc.items.get(rec!.clientId))
    await runAgent(["init", "--force"], io(store))
    expect(kc.items.has(rec!.clientId)).toBe(false)
  })

  it("falls back to the file when the keychain is unavailable or fails", async () => {
    const broken = { ...fakeKeychain(), set: async () => { throw new Error("locked") } }
    const store = new AgentStore(dir, [fakeKeychain(false), broken])
    await runAgent(["init"], io(store))
    expect((await store.readRecord())!.storage).toBe("file")
  })

  it("a keychain record with the keychain gone refuses clearly", async () => {
    const kc = fakeKeychain()
    await runAgent(["init"], io(new AgentStore(dir, [kc])))
    const store = new AgentStore(dir, [fakeKeychain(false)])
    await expect(store.readSecret((await store.readRecord())!)).rejects.toThrow(/keychain is locked or unavailable/)
  })

  it("macOS: the secret goes through stdin, never argv", async () => {
    const calls: Array<{ cmd: string; args: string[]; input?: string }> = []
    const kc = macKeychain(async (cmd, args, input) => {
      calls.push({ cmd, args, input })
      return { code: 0, stdout: "stored-value\n" }
    })
    await kc.set("utc_a", 'sec"ret')
    expect(calls[0].args).toEqual(["-i"])
    expect(calls[0].input).toContain('-w "sec\\"ret"')
    expect(await kc.get("utc_a")).toBe("stored-value")
    await kc.delete("utc_a")
    expect(calls.flatMap((c) => c.args).join(" ")).not.toContain("sec")
    const failing = macKeychain(async () => ({ code: 1, stdout: "" }))
    await expect(failing.set("a", "b")).rejects.toThrow(/Keychain/)
    expect(await failing.get("a")).toBeNull()
  })

  it("Linux Secret Service: stdin for the secret, probe semantics", async () => {
    const calls: Array<{ args: string[]; input?: string }> = []
    let code = 0
    const kc = secretTool(async (_c, args, input) => {
      calls.push({ args, input })
      return { code, stdout: "s3cret\n" }
    })
    await kc.set("utc_a", "s3cret")
    expect(calls[0].input).toBe("s3cret")
    expect(calls[0].args.join(" ")).not.toContain("s3cret")
    expect(await kc.get("utc_a")).toBe("s3cret")
    await kc.delete("utc_a")
    code = 1
    await expect(kc.set("a", "b")).rejects.toThrow(/Secret Service/)
    expect(await kc.get("a")).toBeNull()
  })
})

describe("plain untrace-mcp uses the agent key", () => {
  it("fills UNTRACE_CLIENT_ID/SECRET from the local key when both are unset, and redaction covers it", async () => {
    const store = new AgentStore(dir, [])
    await runAgent(["init"], io(store))
    const env: NodeJS.ProcessEnv = {}
    const id = await loadAgentCredentials(env, store)
    expect(id).toMatch(/^utc_/)
    expect(env.UNTRACE_CLIENT_ID).toBe(id)
    expect(isClientSecret(env.UNTRACE_CLIENT_SECRET!)).toBe(true)
    const body = env.UNTRACE_CLIENT_SECRET!.slice(14)
    expect(redact(`oops ${body}`, configuredSecrets(env))).not.toContain(body)
  })

  it("never overrides an explicit environment key, and does nothing without a local key", async () => {
    const store = new AgentStore(dir, [])
    expect(await loadAgentCredentials({}, store)).toBeNull()
    await runAgent(["init"], io(store))
    const env: NodeJS.ProcessEnv = { UNTRACE_CLIENT_ID: "utc_env" }
    expect(await loadAgentCredentials(env, store)).toBeNull()
    expect(env.UNTRACE_CLIENT_SECRET).toBeUndefined()
  })

  it("refuses a record that is not ours", async () => {
    const store = new AgentStore(dir, [])
    await runAgent(["init"], io(store))
    await writeFile(join(dir, "agent.json"), JSON.stringify({ version: 9 }))
    await expect(store.readRecord()).rejects.toThrow(/not an untrace-mcp agent record/)
  })
})

describe("help and unknown commands", () => {
  it("prints help", async () => {
    const store = new AgentStore(dir, [])
    expect(await runAgent([], io(store))).toBe(1)
    expect(await runAgent(["--help"], io(store))).toBe(0)
    expect(out.join("\n")).toContain("Pair an agent")
    await expect(runAgent(["frob"], io(store))).rejects.toThrow(/unknown agent command/)
  })
})
