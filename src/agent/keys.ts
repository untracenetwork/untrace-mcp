/**
 * Agent key material for `untrace-mcp agent init` (docs/AGENT-PAIRING.md).
 *
 * This is the ONE file in the MCP server that touches key material, and only to
 * create a developer key on the agent's own machine and prove possession of it
 * at pairing time. It is allow-listed by name in scripts/check-public.mjs.
 *
 * Derivation is the developer key contract (Drive docs/api/developer-keys.md §2):
 *   secret     32 random bytes, generated here, never sent anywhere
 *   sign key   Ed25519 from HKDF-SHA256(secret, salt "", info "untrace:client-key:sign:v1")
 *   box key    X25519, and the OAuth client_secret: taken from the SDK's deriveClientKeys,
 *              so they match what the SDK uses at run time byte for byte
 *
 * The SDK does not export the sign key (it authenticates with the OAuth value), so the
 * Ed25519 half is derived here with node:crypto. Proposed SDK change that would let this file
 * go: export `deriveClientSignKey(secret)` and `signClientKeyProof(...)` from @untracenetwork/sdk.
 */
import { createHash, createPrivateKey, createPublicKey, hkdfSync, randomBytes, sign, type KeyObject } from "node:crypto"

import { CLIENT_SECRET_PREFIX, deriveClientKeys, exportClientSecret, parseClientSecret } from "@untracenetwork/sdk"

export const CLIENT_SIGN_INFO = "untrace:client-key:sign:v1"
export const CLIENT_KEY_SIGN_PREFIX = "untrace:client-key:v1:"
export const FINGERPRINT_PREFIX = "untrace:agent-fp:v1:"

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz"
// RFC 8410 PKCS#8 header for a raw 32-byte Ed25519 seed.
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex")

export interface AgentPublicKeys {
  signPublicKey: Uint8Array
  boxPublicKey: Uint8Array
  /** Hex SHA-256 of the 32 decoded bytes of the OAuth client_secret (what Drive stores). */
  oauthHash: string
}

export interface AgentSigner extends AgentPublicKeys {
  /** Ed25519 detached signature by the agent's sign key. */
  sign(message: Uint8Array): Uint8Array
}

export function newSecret(): string {
  const raw = new Uint8Array(randomBytes(32))
  try {
    return exportClientSecret(raw)
  } finally {
    raw.fill(0)
  }
}

/** `utc_` + 22 base58 characters, uniform (rejection sampling). */
export function newClientId(): string {
  let out = "utc_"
  while (out.length < 26) {
    for (const b of randomBytes(32)) if (b < 232 && out.length < 26) out += B58[b % 58]
  }
  return out
}

export function isClientSecret(text: string): boolean {
  try {
    return text.startsWith(CLIENT_SECRET_PREFIX) && parseClientSecret(text).length === 32
  } catch {
    return false
  }
}

function signKey(raw: Uint8Array): KeyObject {
  const seed = Buffer.from(hkdfSync("sha256", raw, new Uint8Array(0), CLIENT_SIGN_INFO, 32))
  try {
    return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" })
  } finally {
    seed.fill(0)
  }
}

/** Everything pairing needs from a secret. The raw secret is wiped before returning. */
export async function agentSigner(secret: string): Promise<AgentSigner> {
  const raw = parseClientSecret(secret)
  try {
    const priv = signKey(raw)
    const jwk = createPublicKey(priv).export({ format: "jwk" }) as { x: string }
    const ck = await deriveClientKeys(raw)
    ck.boxSecretKey.fill(0)
    const oauthHash = createHash("sha256").update(Buffer.from(ck.oauthSecret, "base64url")).digest("hex")
    return {
      signPublicKey: new Uint8Array(Buffer.from(jwk.x, "base64url")),
      boxPublicKey: ck.boxPublicKey,
      oauthHash,
      sign: (message) => new Uint8Array(sign(null, message, priv)),
    }
  } finally {
    raw.fill(0)
  }
}

/** Drive §3: the key signature covers clientId and the standard base64 box key. */
export function keySignMessage(clientId: string, boxPublicKey: Uint8Array): Uint8Array {
  return new TextEncoder().encode(`${CLIENT_KEY_SIGN_PREFIX}${clientId}:${Buffer.from(boxPublicKey).toString("base64")}`)
}

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"

/** `ABCD-EFGH-IJKL-MNOP`: 80 bits of SHA-512 over both public keys. Same as Drive. */
export function fingerprint(signPublicKey: Uint8Array, boxPublicKey: Uint8Array): string {
  const h = createHash("sha512").update(FINGERPRINT_PREFIX).update(signPublicKey).update(boxPublicKey).digest().subarray(0, 10)
  let bits = 0
  let value = 0
  let out = ""
  for (const b of h) {
    value = ((value << 8) | b) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  return out.match(/.{4}/g)!.join("-")
}

export function randomNonce(): Uint8Array {
  return new Uint8Array(randomBytes(16))
}
