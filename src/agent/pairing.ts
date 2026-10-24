/**
 * Pairing code v1, the agent side. Drive parses it in lib/cloud/crypto/agent-pairing.ts and
 * documents it in docs/api/developer-keys.md §3a. Both repos test the same vector.
 *
 * Text: `utp1_` + base64url (no padding) of, big endian:
 *   0     1   version 0x01
 *   1     22  client id body (the 22 base58 chars after "utc_")
 *   23    32  sign public key (Ed25519)
 *   55    32  box public key (X25519)
 *   87    32  oauth hash (raw SHA-256 bytes)
 *   119   16  nonce
 *   135   4   expiresAt, uint32 unix seconds
 *   139   1   scopes bitmask: bit0 download, bit1 upload, bit2 manage-sharing, bit3 delete
 *   140   1   label length L (UTF-8 bytes)
 *   141   L   label
 *   141+L 64  key signature over "untrace:client-key:v1:" + clientId + ":" + base64(box)
 *   205+L 64  pair signature over "untrace:agent-pair:v1:" || bytes[0 .. 205+L)
 *
 * Public material only. Signing goes through ./keys (the agent's signer).
 */
import { keySignMessage, type AgentSigner } from "./keys"

export const PAIRING_CODE_PREFIX = "utp1_"
export const PAIR_SIGN_PREFIX = "untrace:agent-pair:v1:"
export const PAIRING_SCOPES = ["download", "upload", "manage-sharing", "delete"] as const
export type PairingScope = (typeof PAIRING_SCOPES)[number]
/** Default code lifetime. Drive refuses any code living longer than 24 h. */
export const PAIRING_TTL_SECONDS = 15 * 60
export const LABEL_MAX = 64

const CLIENT_ID_RE = /^utc_[1-9A-HJ-NP-Za-km-z]{22}$/
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/

export function validLabel(label: string): boolean {
  return label.length > 0 && label.length <= LABEL_MAX && label === label.trim() && !CONTROL_RE.test(label)
}

export function parseScopeList(text: string): PairingScope[] {
  const want = text.split(",").map((s) => s.trim()).filter(Boolean)
  if (want.length === 0) throw new Error("--scopes needs at least one of: " + PAIRING_SCOPES.join(", "))
  for (const s of want) {
    if (!(PAIRING_SCOPES as readonly string[]).includes(s)) throw new Error(`unknown scope ${s}. Use: ${PAIRING_SCOPES.join(", ")}`)
  }
  return PAIRING_SCOPES.filter((s) => want.includes(s))
}

export interface PairingInput {
  clientId: string
  label: string
  scopes: readonly PairingScope[]
  nonce: Uint8Array
  expiresAt: number
}

export function encodePairingCode(input: PairingInput, signer: AgentSigner): string {
  if (!CLIENT_ID_RE.test(input.clientId)) throw new Error("pairing: bad client id")
  if (!validLabel(input.label)) throw new Error(`pairing: the label must be 1 to ${LABEL_MAX} characters, no control characters`)
  if (input.nonce.length !== 16) throw new Error("pairing: the nonce must be 16 bytes")
  if (!Number.isInteger(input.expiresAt) || input.expiresAt < 0 || input.expiresAt > 0xffffffff) throw new Error("pairing: bad expiry")
  if (!/^[0-9a-f]{64}$/.test(signer.oauthHash)) throw new Error("pairing: bad oauth hash")
  let mask = 0
  for (const s of input.scopes) mask |= 1 << PAIRING_SCOPES.indexOf(s)
  if (mask === 0) throw new Error("pairing: at least one scope")

  const label = Buffer.from(input.label, "utf8")
  const head = Buffer.alloc(141)
  head[0] = 0x01
  head.write(input.clientId.slice(4), 1, "ascii")
  head.set(signer.signPublicKey, 23)
  head.set(signer.boxPublicKey, 55)
  head.set(Buffer.from(signer.oauthHash, "hex"), 87)
  head.set(input.nonce, 119)
  head.writeUInt32BE(input.expiresAt, 135)
  head[139] = mask
  head[140] = label.length
  const keySig = signer.sign(keySignMessage(input.clientId, signer.boxPublicKey))
  const body = Buffer.concat([head, label, keySig])
  const pairSig = signer.sign(Buffer.concat([Buffer.from(PAIR_SIGN_PREFIX, "utf8"), body]))
  return PAIRING_CODE_PREFIX + Buffer.concat([body, pairSig]).toString("base64url")
}
