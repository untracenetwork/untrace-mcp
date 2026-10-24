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
 *
 * Own vault first, shared only on request (review of PR #5):
 * - `set` writes only into this key's own `/.untrace/secrets/<name>` (made when missing). It
 *   never writes into a shared folder unless the caller passes `shared: true` or the folder `id`.
 * - `get`, `share` and `unshare` read this key's own vault. A shared secret answers only when
 *   the caller asks for it (`shared: true` or `id`), and the answer says `shared: true`. A folder
 *   that merely looks like a secret can therefore never answer for a name the user has not set.
 * - `list` shows the own vault; shared secrets only with `includeShared: true`, marked shared.
 *
 * Same owner, where it is enforced: Drive API v1 never tells a reader who owns a folder, so this
 * client cannot check it on a read. Drive checks it on every write that matters here:
 * - attaching a key (`untrace_secret_share`): Drive attaches only keys held by the caller's own
 *   owner (untrace-drive lib/cloud/multikey/entries.ts addEntry, `foreign_key_attach` -> 404);
 * - writing a version (`set` with `shared: true`): Drive uploads only into a folder of the key's
 *   own owner (untrace-drive lib/cloud/public-api/folder-access.ts canCreateInFolder -> 403).
 * Both answers become a plain refusal here. A folder of another owner can only reach this key
 * through a share offer this key itself accepted, and it never answers unless asked for.
 */
import type { EntryRole, FileSummary, Folder, GrantRole, KeyEntry } from "@untracenetwork/sdk"

import { UntraceFolderAccessError, UntraceNotFoundError } from "@untracenetwork/sdk"

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

export interface SecretTarget {
  /** Use a secret shared with this key instead of this key's own vault. */
  shared?: boolean
  /** The shared secret's folder id (from untrace_secret_list with includeShared). Implies shared. */
  id?: string
}

const wantsShared = (t: SecretTarget | undefined) => Boolean(t && (t.shared === true || typeof t.id === "string"))

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
   * Folders shared with this key that look like a secret: a top-level folder of this key's list
   * (it holds an entry on it directly) with a valid secret name and a secret file inside. Never
   * used unless the caller asks for shared secrets.
   *
   * Cost: one files.list per candidate top-level folder (N+1 calls). Fine for v0; a vault API in
   * Drive would replace it.
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

  /** A secret in this key's own vault, or null. Never looks at shared folders. */
  async findOwn(name: string, root?: Folder | null): Promise<Folder | null> {
    const r = root === undefined ? await this.secretsRoot(false) : root
    if (!r) return null
    return (await allFolders(this.c, r.folderId)).filter((f) => f.name === name).sort(oldestFirst)[0] ?? null
  }

  /** A secret shared with this key, asked for by name (and folder id when given). */
  async findShared(name: string, id?: string): Promise<Folder> {
    const root = await this.secretsRoot(false)
    const hits = (await this.sharedFolders(root?.folderId ?? null)).filter((f) => f.name === name && (id === undefined || f.folderId === id))
    if (hits.length === 0) {
      throw new ToolRefusal(
        `Refused: no secret named ${name}${id ? ` with id ${id}` : ""} is shared with this key. untrace_secret_list with includeShared: true shows the shared ones.`
      )
    }
    if (hits.length > 1) throw new ToolRefusal(`Refused: more than one shared secret is named ${name}. Pass its id from untrace_secret_list with includeShared: true.`)
    return hits[0]!
  }

  /** Own vault by default; a shared secret only when `target` asks for one. */
  async resolve(name: string, target?: SecretTarget): Promise<SecretFolder> {
    if (wantsShared(target)) return { folder: await this.findShared(name, target!.id), shared: true }
    const own = await this.findOwn(name)
    if (!own) {
      throw new ToolRefusal(
        `Refused: no secret named ${name} in this key's vault. untrace_secret_list shows the names. If another key of the same owner shared it with this key, call again with shared: true.`
      )
    }
    return { folder: own, shared: false }
  }

  async set(
    name: string,
    value: string,
    target?: SecretTarget
  ): Promise<{ name: string; id: string; version: number; createdAt: string; shared: boolean }> {
    rememberSecretValue(value)
    let folder: Folder
    let shared = false
    if (wantsShared(target)) {
      folder = await this.findShared(name, target!.id)
      shared = true
      if (folder.role === "viewer") throw new ToolRefusal(`Refused: this key is a viewer of the shared secret ${name}, so it cannot set a new version. Nothing was stored.`)
    } else {
      // Own vault only. A shared folder with the same name is never written to by default.
      const root = (await this.secretsRoot(true))!
      folder = (await this.findOwn(name, root)) ?? (await this.c.folders.create({ name, parentId: root.folderId }))
    }
    const versions = await versionsIn(this.c, folder.folderId)
    const version = (versions[0]?.version ?? 0) + 1
    let createdAt: string
    try {
      const r = await this.c.files.upload({ folderId: folder.folderId, data: new TextEncoder().encode(value), name: `v${version}`, mime: SECRET_MIME })
      createdAt = r.file.createdAt
    } catch (err) {
      // Drive uploads only into a folder of this key's own owner (folder-access.ts).
      if (shared && err instanceof UntraceFolderAccessError) {
        throw new ToolRefusal(
          `Refused: Untrace stores a new version only in a shared secret that belongs to this key's own owner, where this key is editor or admin. ${name} (${folder.folderId}) does not qualify. Nothing was stored.`
        )
      }
      throw err
    }
    return { name, id: folder.folderId, version, createdAt, shared }
  }

  async get(name: string, target?: SecretTarget): Promise<{ name: string; value: string; id: string; version: number; createdAt: string; shared: boolean }> {
    const { folder, shared } = await this.resolve(name, target)
    const latest = (await versionsIn(this.c, folder.folderId))[0]
    if (!latest) throw new ToolRefusal(`Refused: the secret ${name} has no value yet. Set it with untrace_secret_set.`)
    const r = await this.c.files.download(latest.fileId)
    const value = new TextDecoder().decode(r.bytes)
    rememberSecretValue(value)
    return { name, value, id: folder.folderId, version: latest.version, createdAt: latest.createdAt, shared }
  }

  async list(opts: { includeShared?: boolean } = {}): Promise<
    Array<{ name: string; id: string; role: string; version: number; updatedAt: string | null; createdAt: string; shared: boolean }>
  > {
    const root = await this.secretsRoot(false)
    const own = root ? await allFolders(this.c, root.folderId) : []
    const shared = opts.includeShared ? await this.sharedFolders(root?.folderId ?? null) : []
    const out = []
    const seenOwn = new Set<string>()
    for (const [folder, isShared] of [...own.sort(oldestFirst).map((f) => [f, false] as const), ...shared.map((f) => [f, true] as const)]) {
      try {
        validateSecretName(folder.name)
      } catch {
        continue
      }
      if (!isShared) {
        if (seenOwn.has(folder.name)) continue
        seenOwn.add(folder.name)
      }
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
    return out.sort((a, b) => a.name.localeCompare(b.name) || Number(a.shared) - Number(b.shared))
  }

  async share(name: string, clientId: string, publicKey: string, role: GrantRole, target?: SecretTarget): Promise<{ name: string; id: string; entry: KeyEntry }> {
    const { folder } = await this.resolve(name, target)
    const ref = { type: "folder" as const, id: folder.folderId }
    const scopes = role === "viewer" ? (["download"] as const) : role === "editor" ? (["download", "upload"] as const) : (["download", "upload", "manage-sharing"] as const)
    const current = (await this.c.keys.list(ref)).find((e) => e.keyType === "client" && e.keyId === clientId)
    if (current) {
      const entry = await this.c.keys.change(ref, current.entryId, { role: role as EntryRole, scopes: [...scopes] })
      return { name, id: folder.folderId, entry }
    }
    try {
      const entry = await this.c.keys.attach(ref, { keyType: "client", keyId: clientId, role, scopes: [...scopes], publicKey })
      return { name, id: folder.folderId, entry }
    } catch (err) {
      // Same owner is enforced by Drive: it attaches only keys held by the caller's own owner
      // (untrace-drive lib/cloud/multikey/entries.ts, foreign_key_attach -> 404). This key can
      // already manage the folder (keys.list above answered), so a 404 here means that.
      if (err instanceof UntraceNotFoundError) {
        throw new ToolRefusal(
          `Refused: Untrace shares a secret only with another developer key of this key's own owner, and ${clientId} is not one (or it was revoked). To give a secret to a person or another account, use Untrace Drive.`
        )
      }
      throw err
    }
  }

  async unshare(
    name: string,
    clientId: string,
    target?: SecretTarget
  ): Promise<{ name: string; id: string; clientId: string; removed: true; versionEntriesRemoved: number }> {
    const { folder } = await this.resolve(name, target)
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
