/**
 * Where `untrace-mcp agent init` keeps the agent's key (docs/AGENT-PAIRING.md).
 *
 *   OS keychain when one is usable: macOS Keychain (`security`), Linux Secret Service
 *   (`secret-tool`). The secret is written through stdin, never put on a command line.
 *   Otherwise a file `agent.secret`, mode 0600, in a 0700 config dir. Reading refuses a file
 *   or dir that group or others can read, or that another user owns.
 *
 * The public record (`agent.json`: client id, label, scopes, fingerprint, where the secret is)
 * sits next to it. It holds no secret.
 *
 * Config dir: UNTRACE_MCP_CONFIG_DIR, else $XDG_CONFIG_HOME/untrace-mcp, else
 * ~/Library/Application Support/untrace-mcp (macOS), %APPDATA%\untrace-mcp (Windows),
 * ~/.config/untrace-mcp. UNTRACE_MCP_KEYCHAIN=0 forces the file store.
 */
import { execFile } from "node:child_process"
import { chmod, lstat, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

export const KEYCHAIN_SERVICE = "untrace-mcp"
const RECORD = "agent.json"
const SECRET_FILE = "agent.secret"

export interface AgentRecord {
  version: 1
  clientId: string
  label: string
  scopes: string[]
  fingerprint: string
  storage: "keychain" | "file"
  createdAt: string
}

export interface Keychain {
  readonly name: string
  available(): Promise<boolean>
  set(account: string, secret: string): Promise<void>
  get(account: string): Promise<string | null>
  delete(account: string): Promise<void>
}

type Run = (cmd: string, args: string[], input?: string) => Promise<{ code: number; stdout: string }>

const run: Run = (cmd, args, input) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: 10_000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : 127) : 0
      resolve({ code, stdout: String(stdout ?? "") })
    })
    child.stdin?.on("error", () => {})
    if (input !== undefined) child.stdin?.end(input)
    else child.stdin?.end()
  })

/** `security -i` reads commands from stdin, so the secret never appears in argv or `ps`. */
export function macKeychain(exec: Run = run): Keychain {
  const q = (s: string) => `"${s.replace(/(["\\])/g, "\\$1")}"`
  return {
    name: "macOS Keychain",
    available: async () => process.platform === "darwin" && (await exec("security", ["help"])).code !== 127,
    async set(account, secret) {
      const cmd = `add-generic-password -U -a ${q(account)} -s ${KEYCHAIN_SERVICE} -l ${q(`untrace-mcp ${account}`)} -w ${q(secret)}\n`
      const r = await exec("security", ["-i"], cmd)
      if (r.code !== 0) throw new Error("could not write to the macOS Keychain")
    },
    async get(account) {
      const r = await exec("security", ["find-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE, "-w"])
      return r.code === 0 ? r.stdout.trim() || null : null
    },
    async delete(account) {
      await exec("security", ["delete-generic-password", "-a", account, "-s", KEYCHAIN_SERVICE])
    },
  }
}

/** libsecret's `secret-tool store` reads the secret from stdin. Needs a running Secret Service. */
export function secretTool(exec: Run = run): Keychain {
  const attrs = (account: string) => ["service", KEYCHAIN_SERVICE, "account", account]
  return {
    name: "Secret Service (secret-tool)",
    async available() {
      if (process.platform !== "linux" || !process.env.DBUS_SESSION_BUS_ADDRESS) return false
      // A lookup that finds nothing exits 1; 127 means no binary; anything else means no service.
      const r = await exec("secret-tool", ["lookup", "service", KEYCHAIN_SERVICE, "account", "untrace-mcp-probe"])
      return r.code === 0 || r.code === 1
    },
    async set(account, secret) {
      const r = await exec("secret-tool", ["store", `--label=untrace-mcp ${account}`, ...attrs(account)], secret)
      if (r.code !== 0) throw new Error("could not write to the Secret Service")
    },
    async get(account) {
      const r = await exec("secret-tool", ["lookup", ...attrs(account)])
      return r.code === 0 ? r.stdout.trim() || null : null
    },
    async delete(account) {
      await exec("secret-tool", ["clear", ...attrs(account)])
    },
  }
}

export function configDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform, home = homedir()): string {
  if (env.UNTRACE_MCP_CONFIG_DIR) return env.UNTRACE_MCP_CONFIG_DIR
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "untrace-mcp")
  if (platform === "darwin") return join(home, "Library", "Application Support", "untrace-mcp")
  if (platform === "win32") return join(env.APPDATA || join(home, "AppData", "Roaming"), "untrace-mcp")
  return join(home, ".config", "untrace-mcp")
}

const POSIX = process.platform !== "win32"

/** Refuse anything group/world accessible or owned by someone else (POSIX only). */
async function assertPrivate(path: string, what: string): Promise<void> {
  if (!POSIX) return
  const s = await lstat(path)
  if (s.isSymbolicLink()) throw new Error(`refusing ${what} ${path}: it is a symlink`)
  if (typeof process.getuid === "function" && s.uid !== process.getuid()) throw new Error(`refusing ${what} ${path}: owned by another user`)
  if (s.mode & 0o077) {
    throw new Error(`refusing ${what} ${path}: mode ${(s.mode & 0o777).toString(8)} lets other users read it. Run: chmod ${what === "directory" ? "700" : "600"} ${path}`)
  }
}

export class AgentStore {
  constructor(
    readonly dir: string = configDir(),
    private readonly keychains: Keychain[] = process.env.UNTRACE_MCP_KEYCHAIN === "0" ? [] : [macKeychain(), secretTool()]
  ) {}

  private async ensureDir(): Promise<void> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 })
    if (POSIX) await chmod(this.dir, 0o700)
    await assertPrivate(this.dir, "directory")
  }

  /** Atomic 0600 write (O_EXCL temp file, then rename). */
  private async writePrivate(name: string, text: string): Promise<void> {
    const tmp = join(this.dir, `.${name}.${process.pid}.tmp`)
    await rm(tmp, { force: true })
    const fh = await open(tmp, "wx", 0o600)
    try {
      await fh.writeFile(text, "utf8")
      await fh.sync()
    } finally {
      await fh.close()
    }
    await rename(tmp, join(this.dir, name))
  }

  async readRecord(): Promise<AgentRecord | null> {
    const path = join(this.dir, RECORD)
    try {
      await stat(path)
    } catch {
      return null
    }
    const rec = JSON.parse(await readFile(path, "utf8")) as AgentRecord
    if (rec.version !== 1 || typeof rec.clientId !== "string") throw new Error(`${path} is not an untrace-mcp agent record`)
    return rec
  }

  /** Save a new key. Returns where the secret went. */
  async save(rec: Omit<AgentRecord, "storage" | "version">, secret: string): Promise<AgentRecord> {
    await this.ensureDir()
    let storage: AgentRecord["storage"] = "file"
    for (const k of this.keychains) {
      if (!(await k.available())) continue
      try {
        await k.set(rec.clientId, secret)
        if ((await k.get(rec.clientId)) === secret) {
          storage = "keychain"
          break
        }
      } catch {
        // fall through to the next store
      }
    }
    if (storage === "file") await this.writePrivate(SECRET_FILE, `${secret}\n`)
    const full: AgentRecord = { version: 1, ...rec, storage }
    await this.writePrivate(RECORD, `${JSON.stringify(full, null, 2)}\n`)
    return full
  }

  async readSecret(rec: AgentRecord): Promise<string> {
    if (rec.storage === "keychain") {
      for (const k of this.keychains) {
        if (!(await k.available())) continue
        const s = await k.get(rec.clientId)
        if (s) return s
      }
      throw new Error("the agent key is in the OS keychain, but the keychain is locked or unavailable")
    }
    await assertPrivate(this.dir, "directory")
    const path = join(this.dir, SECRET_FILE)
    await assertPrivate(path, "file")
    return (await readFile(path, "utf8")).trim()
  }

  /** Remove the key and its record (agent init --force). */
  async remove(rec: AgentRecord): Promise<void> {
    if (rec.storage === "keychain") for (const k of this.keychains) if (await k.available()) await k.delete(rec.clientId)
    await rm(join(this.dir, SECRET_FILE), { force: true })
    await rm(join(this.dir, RECORD), { force: true })
  }
}
