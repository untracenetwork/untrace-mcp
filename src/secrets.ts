/**
 * Secrets v0: API keys and other small values kept in Untrace Drive, so they never have to be
 * pasted into a chat.
 *
 * There is no separate secrets backend. A secret is a tiny encrypted file in Drive, made and
 * opened by the SDK exactly like any other file:
 *
 *   /.untrace/secrets/<name>/v1, v2, ...
 *
 * - `/.untrace` is a reserved top-level folder of the key owner's Drive (Drive hides it).
 * - Each secret is its own folder under `/.untrace/secrets`, named by the full secret name.
 *   Sharing a secret attaches another key to THAT folder, so every new version written into it
 *   reaches the same keys without sharing again.
 * - Each value is one file `v<N>` (mime application/vnd.untrace.secret). Setting a secret again
 *   adds the next version; reading returns the newest one. Old versions stay in the folder so
 *   nothing is lost, and the owner can purge them in Drive.
 *
 * A key that was given a secret by another key of the same owner holds an entry on the secret's
 * folder only, so that folder shows up in its own top-level list. Those are recognised by the
 * secret file inside them.
 */
import type { EntryRole, FileSummary, Folder, GrantRole, KeyEntry } from "@untracenetwork/sdk"

import { ToolRefusal } from "./errors"
import { rememberSecretValue } from "./redact"
import type { UntraceLike } from "./server"

export const VAULT_FOLDER = ".untrace"
export const SECRETS_FOLDER = "secrets"
export const SECRET_MIME = "application/vnd.untrace.secret"
/** Largest secret value, in UTF-8 bytes. Secrets are API keys and tokens, not files. */
export const MAX_SECRET_BYTES = 64 * 1024
export const MAX_SECRET_NAME = 128

const SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/
const VERSION_RE = /^v([1-9][0-9]{0,8})$/

/**
 * Check a secret name and return it unchanged. A name is one or more segments joined by `/`
 * (for example `stripe/live_key`): letters, digits, `.`, `_` and `-`, no empty segment, no `.`
 * or `..`, no leading or trailing `/`, at most 128 characters. Names are case sensitive.
 */
export function validateSecretName(name: unknown): string {
  if (typeof name !== "string" || name.length === 0) throw new ToolRefusal("Refused: a secret name is required.")
  if (name.length > MAX_SECRET_NAME) throw new ToolRefusal(`Refused: a secret name is at most ${MAX_SECRET_NAME} characters.`)
  const segments = name.split("/")
  if (segments.length > 8) throw new ToolRefusal("Refused: a secret name has at most 8 parts separated by /.")
  for (const s of segments) {
    if (s === "") throw new ToolRefusal("Refused: a secret name cannot start or end with / or contain //.")
    if (s === "." || s === "..") throw new ToolRefusal("Refused: a secret name cannot contain . or .. as a part.")
    if (!SEGMENT_RE.test(s)) throw new ToolRefusal("Refused: a secret name uses only letters, digits, . _ - and / between parts.")
  }
  return name
}

export interface SecretVersion {
  fileId: string
  version: number
  createdAt: string
}

export interface SecretFolder {
  folder: Folder
  /** True when this key reaches the secret through a share, not through its own vault. */
  shared: boolean
}

const versionOf = (f: Pick<FileSummary, "name" | "mime">): number | null => {
  if (f.mime !== SECRET_MIME) return null
  const m = VERSION_RE.exec(f.name)
  return m ? Number(m[1]) : null
}

/** Every page of folders at one level. */
async function allFolders(c: UntraceLike, parentId: string | null): Promise<Folder[]> {
  const out: Folder[] = []
  let cursor: string | null = null
  for (let i = 0; i < 100; i++) {
    const r = await c.folders.list({ parentId, cursor, limit: 200 })
    out.push(...r.folders)
    if (!r.nextCursor) break
    cursor = r.nextCursor
  }
  return out
}

/** Every page of files directly in one folder. */
async function allFiles(c: UntraceLike, folderId: string): Promise<FileSummary[]> {
  const out: FileSummary[] = []
  let cursor: string | null = null
  for (let i = 0; i < 100; i++) {
    const r = await c.files.list({ folderId, cursor, limit: 200 })
    out.push(...r.files)
    if (!r.nextCursor) break
    cursor = r.nextCursor
  }
  return out
}

const oldestFirst = (a: Folder, b: Folder) => a.createdAt.localeCompare(b.createdAt) || a.folderId.localeCompare(b.folderId)

/** The versions of one secret folder, newest first. */
export async function versionsIn(c: UntraceLike, folderId: string): Promise<SecretVersion[]> {
  const out: SecretVersion[] = []
  for (const f of await allFiles(c, folderId)) {
    const v = versionOf(f)
    if (v !== null) out.push({ fileId: f.fileId, version: v, createdAt: f.createdAt })
  }
  return out.sort((a, b) => b.version - a.version || b.createdAt.localeCompare(a.createdAt))
}

export class Vault {
  constructor(private readonly c: UntraceLike) {}

  /** The `/.untrace/secrets` folder of this key's vault; made when `create` is true. */
  async secretsRoot(create: boolean): Promise<Folder | null> {
    const top = (await allFolders(this.c, null)).filter((f) => f.parentId === null && f.name === VAULT_FOLDER).sort(oldestFirst)
    let vault = top[0] ?? null
    if (!vault) {
      if (!create) return null
      vault = await this.c.folders.create({ name: VAULT_FOLDER, parentId: null })
    }
    const inner = (await allFolders(this.c, vault.folderId)).filter((f) => f.name === SECRETS_FOLDER).sort(oldestFirst)
    if (inner[0]) return inner[0]
    if (!create) return null
    return this.c.folders.create({ name: SECRETS_FOLDER, parentId: vault.folderId })
  }

  /**
   * Secret folders shared with this key by another key. Such a folder sits in the other key's
   * vault, and this key holds an entry on it directly, so it shows up in this key's top-level
   * list. It is recognised by its name and the secret file inside it.
   */
  async sharedFolders(ownRootId: string | null): Promise<Folder[]> {
    const out: Folder[] = []
    for (const f of await allFolders(this.c, null)) {
      if (ownRootId !== null && (f.parentId === ownRootId || f.folderId === ownRootId)) continue
      if (f.name === VAULT_FOLDER && f.parentId === null) continue
      try {
        validateSecretName(f.name)
      } catch {
        continue
      }
      if ((await versionsIn(this.c, f.folderId)).length > 0) out.push(f)
    }
    return out.sort(oldestFirst)
  }

  /** Find a secret by name: this key's own vault first, then secrets shared with it. */
  async find(name: string): Promise<SecretFolder | null> {
    const root = await this.secretsRoot(false)
    if (root) {
      const own = (await allFolders(this.c, root.folderId)).filter((f) => f.name === name).sort(oldestFirst)
      if (own[0]) return { folder: own[0], shared: false }
    }
    const shared = (await this.sharedFolders(root?.folderId ?? null)).filter((f) => f.name === name)
    return shared[0] ? { folder: shared[0], shared: true } : null
  }

  async require(name: string): Promise<SecretFolder> {
    const s = await this.find(name)
    if (!s) throw new ToolRefusal(`Refused: no secret named ${name} that this key can reach. untrace_secret_list shows the names.`)
    return s
  }

  async set(name: string, value: string): Promise<{ name: string; id: string; version: number; createdAt: string; shared: boolean }> {
    rememberSecretValue(value)
    const existing = await this.find(name)
    let folder: Folder
    let shared = false
    if (existing) {
      folder = existing.folder
      shared = existing.shared
    } else {
      const root = (await this.secretsRoot(true))!
      folder = await this.c.folders.create({ name, parentId: root.folderId })
    }
    const versions = await versionsIn(this.c, folder.folderId)
    const version = (versions[0]?.version ?? 0) + 1
    const r = await this.c.files.upload({ folderId: folder.folderId, data: new TextEncoder().encode(value), name: `v${version}`, mime: SECRET_MIME })
    return { name, id: folder.folderId, version, createdAt: r.file.createdAt, shared }
  }

  async get(name: string): Promise<{ name: string; value: string; id: string; version: number; createdAt: string }> {
    const { folder } = await this.require(name)
    const latest = (await versionsIn(this.c, folder.folderId))[0]
    if (!latest) throw new ToolRefusal(`Refused: the secret ${name} has no value yet. Set it with untrace_secret_set.`)
    const r = await this.c.files.download(latest.fileId)
    const value = new TextDecoder().decode(r.bytes)
    rememberSecretValue(value)
    return { name, value, id: folder.folderId, version: latest.version, createdAt: latest.createdAt }
  }

  async list(): Promise<Array<{ name: string; id: string; role: string; version: number; updatedAt: string | null; createdAt: string; shared: boolean }>> {
    const root = await this.secretsRoot(false)
    const own = root ? await allFolders(this.c, root.folderId) : []
    const shared = await this.sharedFolders(root?.folderId ?? null)
    const out = []
    const seen = new Set<string>()
    for (const [folder, isShared] of [...own.map((f) => [f, false] as const), ...shared.map((f) => [f, true] as const)]) {
      if (seen.has(folder.name)) continue
      try {
        validateSecretName(folder.name)
      } catch {
        continue
      }
      seen.add(folder.name)
      const latest = (await versionsIn(this.c, folder.folderId))[0]
      out.push({
        name: folder.name,
        id: folder.folderId,
        role: folder.role,
        version: latest?.version ?? 0,
        updatedAt: latest?.createdAt ?? null,
        createdAt: folder.createdAt,
        shared: isShared,
      })
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  async share(name: string, clientId: string, publicKey: string, role: GrantRole): Promise<{ name: string; id: string; entry: KeyEntry }> {
    const { folder } = await this.require(name)
    const ref = { type: "folder" as const, id: folder.folderId }
    const scopes = role === "viewer" ? (["download"] as const) : role === "editor" ? (["download", "upload"] as const) : (["download", "upload", "manage-sharing"] as const)
    const current = (await this.c.keys.list(ref)).find((e) => e.keyType === "client" && e.keyId === clientId)
    if (current) {
      const entry = await this.c.keys.change(ref, current.entryId, { role: role as EntryRole, scopes: [...scopes] })
      return { name, id: folder.folderId, entry }
    }
    const entry = await this.c.keys.attach(ref, { keyType: "client", keyId: clientId, role, scopes: [...scopes], publicKey })
    return { name, id: folder.folderId, entry }
  }

  async unshare(name: string, clientId: string): Promise<{ name: string; id: string; clientId: string; removed: true; versionEntriesRemoved: number }> {
    const { folder } = await this.require(name)
    const ref = { type: "folder" as const, id: folder.folderId }
    const current = (await this.c.keys.list(ref)).find((e) => e.keyType === "client" && e.keyId === clientId)
    if (!current) throw new ToolRefusal(`Refused: the secret ${name} is not shared with ${clientId}.`)
    if (current.role === "owner") throw new ToolRefusal("Refused: the owner's access can never be removed.")
    await this.c.keys.remove(ref, current.entryId)
    // A key that set versions itself also holds an entry on each version it uploaded. Remove
    // those too where this key can manage them (best effort: a version this key uploaded
    // itself carries no entry for the other key).
    let versionEntriesRemoved = 0
    for (const v of await versionsIn(this.c, folder.folderId)) {
      const fileRef = { type: "file" as const, id: v.fileId }
      try {
        for (const e of await this.c.keys.list(fileRef)) {
          if (e.keyType === "client" && e.keyId === clientId && e.role !== "owner") {
            await this.c.keys.remove(fileRef, e.entryId)
            versionEntriesRemoved++
          }
        }
      } catch {
        // Not manageable from this key: nothing of the other key's to remove there.
      }
    }
    return { name, id: folder.folderId, clientId, removed: true, versionEntriesRemoved }
  }
}
