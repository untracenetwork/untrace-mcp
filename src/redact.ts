/**
 * Secret redaction for everything this server returns or logs. Secrets are read from the
 * environment only and must never appear in a tool result, an error or a log line.
 */

import { CLIENT_SECRET_PREFIX } from "@untracenetwork/sdk"

const SECRET_RE = new RegExp(`${CLIENT_SECRET_PREFIX}[A-Za-z0-9_\\-+/=]*`, "g")
const BEARER_RE = /(bearer\s+)[A-Za-z0-9._\-+/=]+/gi
const BASIC_RE = /(basic\s+)[A-Za-z0-9+/=]+/gi
const FIELD_RE =
  /("?(?:accessToken|access_token|refresh_token|token|signature|wrappedKey|sealedKey|clientSecret|client_secret)"?\s*[:=]\s*"?)[A-Za-z0-9._\-+/=%]{8,}/gi

export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
  for (const s of secrets) {
    // Redact the literal value too (also covers a secret pasted without its prefix).
    if (s && s.length >= 8) out = out.split(s).join("[redacted]")
  }
  out = out.replace(SECRET_RE, `${CLIENT_SECRET_PREFIX}[redacted]`)
  out = out.replace(BEARER_RE, "$1[redacted]")
  out = out.replace(BASIC_RE, "$1[redacted]")
  out = out.replace(FIELD_RE, "$1[redacted]")
  return out
}

/** The secret values currently configured, for literal redaction. */
export function configuredSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = []
  const s = env.UNTRACE_CLIENT_SECRET?.trim()
  if (s) out.push(s, s.startsWith(CLIENT_SECRET_PREFIX) ? s.slice(CLIENT_SECRET_PREFIX.length) : s)
  const c = env.UNTRACE_MCP_OAUTH_CLIENT_SECRET?.trim()
  if (c) out.push(c)
  const k = env.UNTRACE_SHARE_SECRET_KEY?.trim()
  if (k) out.push(k)
  return out
}
