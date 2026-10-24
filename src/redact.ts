/**
 * Secret redaction for everything this server returns or logs. Secrets are read from the
 * environment only and must never appear in a tool result, an error or a log line.
 *
 * Values stored with the untrace_secret_* tools are remembered here (in memory, for the life of
 * the process) as soon as this server sees them, so every later result, error and log line
 * redacts them too. The one exception is the `value` field that untrace_secret_get returns on
 * purpose (see redactExcept).
 */

import { CLIENT_SECRET_PREFIX } from "@untracenetwork/sdk"

const SECRET_RE = new RegExp(`${CLIENT_SECRET_PREFIX}[A-Za-z0-9_\\-+/=]*`, "g")
const BEARER_RE = /(bearer\s+)[A-Za-z0-9._\-+/=]+/gi
const BASIC_RE = /(basic\s+)[A-Za-z0-9+/=]+/gi
const FIELD_RE =
  /("?(?:accessToken|access_token|refresh_token|token|signature|wrappedKey|sealedKey|clientSecret|client_secret)"?\s*[:=]\s*"?)[A-Za-z0-9._\-+/=%]{8,}/gi

/** Shortest value redacted literally. Shorter strings would match ordinary words. */
export const MIN_REDACT_LENGTH = 8

/** Stored secret values this process has seen. Bounded, oldest dropped first. */
const remembered = new Set<string>()
const MAX_REMEMBERED = 1000

/**
 * Remember a stored secret value so every later output redacts it, in its plain and its
 * JSON-escaped form (how it appears inside a JSON result). Values under 8 characters are too
 * short to redact literally without hiding ordinary words.
 */
export function rememberSecretValue(value: string): void {
  if (typeof value !== "string" || value.length < MIN_REDACT_LENGTH) return
  for (const v of new Set([value, JSON.stringify(value).slice(1, -1)])) {
    remembered.delete(v)
    remembered.add(v)
  }
  while (remembered.size > MAX_REMEMBERED) {
    const oldest = remembered.values().next().value
    if (oldest === undefined) break
    remembered.delete(oldest)
  }
}

/** Forget every remembered secret value (tests). */
export function forgetSecretValues(): void {
  remembered.clear()
}

export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
  // Longest first, so a value that contains another one is redacted whole.
  const list = [...new Set(secrets.filter((s): s is string => typeof s === "string" && s.length >= MIN_REDACT_LENGTH))].sort((a, b) => b.length - a.length)
  for (const s of list) {
    // Redact the literal value too (also covers a secret pasted without its prefix).
    out = out.split(s).join("[redacted]")
  }
  out = out.replace(SECRET_RE, `${CLIENT_SECRET_PREFIX}[redacted]`)
  out = out.replace(BEARER_RE, "$1[redacted]")
  out = out.replace(BASIC_RE, "$1[redacted]")
  out = out.replace(FIELD_RE, "$1[redacted]")
  return out
}

/**
 * Serialise `data` with everything redacted except the string at `data[field]`, which is put
 * back verbatim. Used only by untrace_secret_get, whose job is to return that one value.
 */
export function redactExcept(data: Record<string, unknown>, field: string, secrets: readonly (string | undefined)[]): string {
  const marker = `@@untrace-keep-${field}@@`
  const keep = data[field]
  const text = redact(JSON.stringify({ ...data, [field]: marker }, null, 2), secrets)
  return text.replace(JSON.stringify(marker), () => JSON.stringify(keep))
}

/** The secret values currently configured or remembered, for literal redaction. */
export function configuredSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  const s = env.UNTRACE_CLIENT_SECRET?.trim()
  if (s) out.push(s, s.startsWith(CLIENT_SECRET_PREFIX) ? s.slice(CLIENT_SECRET_PREFIX.length) : s)
  const c = env.UNTRACE_MCP_OAUTH_CLIENT_SECRET?.trim()
  if (c) out.push(c)
  const k = env.UNTRACE_SHARE_SECRET_KEY?.trim()
  if (k) out.push(k)
  out.push(...remembered)
  return out
}
