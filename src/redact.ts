/**
 * Secret redaction for everything this server returns. The client secret is read from the
 * environment only and must never appear in a tool result, an error or a log line.
 */

const SECRET_RE = /untrace_sk_v1_[A-Za-z0-9_\-+/=]*/g
const BEARER_RE = /(bearer\s+)[A-Za-z0-9._\-+/=]+/gi
const FIELD_RE = /("?(?:accessToken|access_token|token|signature|wrappedKey|clientSecret)"?\s*[:=]\s*"?)[A-Za-z0-9._\-+/=]{8,}/gi

export function redact(text: string, secrets: readonly (string | undefined)[] = []): string {
  let out = text
  for (const s of secrets) {
    // Redact the literal value too (also covers a secret pasted without its prefix).
    if (s && s.length >= 8) out = out.split(s).join("[redacted]")
  }
  out = out.replace(SECRET_RE, "untrace_sk_v1_[redacted]")
  out = out.replace(BEARER_RE, "$1[redacted]")
  out = out.replace(FIELD_RE, "$1[redacted]")
  return out
}

/** The secret value(s) currently configured, for literal redaction. */
export function configuredSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  const s = env.UNTRACE_CLIENT_SECRET?.trim()
  if (!s) return []
  const body = s.startsWith("untrace_sk_v1_") ? s.slice("untrace_sk_v1_".length) : s
  return [s, body]
}
