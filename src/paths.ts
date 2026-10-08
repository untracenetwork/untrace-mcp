/**
 * Filesystem sandbox. Uploads read from and downloads write to paths inside one allowlisted
 * root (UNTRACE_MCP_ROOT, default: the working directory the server was started in).
 * Relative paths resolve against the root. `..`, absolute paths outside the root and symlinks
 * that lead outside it are refused.
 */
import { lstat, realpath } from "node:fs/promises"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

export class PathRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "PathRefusedError"
  }
}

function inside(root: string, p: string): boolean {
  const rel = relative(root, p)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== "..")
}

/** Resolve the real path of `p`, or of its deepest existing ancestor plus the missing tail. */
async function realish(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err
    const parent = dirname(p)
    if (parent === p) return p
    return resolve(await realish(parent), relative(parent, p))
  }
}

export async function resolveRoot(root: string): Promise<string> {
  try {
    return await realpath(resolve(root))
  } catch {
    throw new PathRefusedError(`UNTRACE_MCP_ROOT (${root}) does not exist. Set it to an existing directory.`)
  }
}

/**
 * Resolve a user-supplied path inside `root` (already a real path). Throws PathRefusedError
 * when the path, or anything it links through, leaves the root.
 */
export async function resolveInsideRoot(root: string, userPath: string): Promise<string> {
  if (typeof userPath !== "string" || !userPath.trim()) throw new PathRefusedError("A path is required.")
  if (userPath.includes("\u0000")) throw new PathRefusedError("The path contains a NUL byte.")
  const abs = resolve(root, userPath)
  const hint = `Paths must stay inside ${root} (UNTRACE_MCP_ROOT). Use a path relative to that folder.`
  if (!inside(root, abs)) throw new PathRefusedError(`Refused: ${userPath} is outside the allowed folder. ${hint}`)
  const real = await realish(abs)
  if (!inside(root, real)) throw new PathRefusedError(`Refused: ${userPath} leads outside the allowed folder through a symlink. ${hint}`)
  return abs
}

/** True when `p` exists and is a symlink (never written through). */
export async function isSymlink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink()
  } catch {
    return false
  }
}
