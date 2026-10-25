# Agent pairing: a developer key generated on the agent's machine

`untrace-mcp agent init` creates this agent's Untrace developer key on the machine the agent runs
on. The secret never leaves that machine: the owner approves a pairing code in Untrace Drive, and
Drive only ever receives public keys and signatures.

## Use

```bash
npx -y @untracenetwork/mcp agent init --label "Release agent" --scopes download,upload
```

It prints a pairing code (`utp1_...`), a fingerprint like `3OBH-WXU7-IF37-ZEWY` and the expiry
(15 minutes; `--ttl <minutes>`, at most 1440). In Untrace Drive open
**Settings > Developer keys > Pair an agent**, paste the code, check that the fingerprint matches
the terminal, untick any permission you do not want to grant, and approve. Then give the agent
access to specific files or folders as for any developer key.

```bash
npx -y @untracenetwork/mcp agent status     # fingerprint, where the key is stored, approved or not
npx -y @untracenetwork/mcp agent code       # a fresh pairing code for the same key
npx -y @untracenetwork/mcp                  # serves MCP with this key
```

When `UNTRACE_CLIENT_ID` and `UNTRACE_CLIENT_SECRET` are both unset, `untrace-mcp` (stdio and
`http`) uses the agent key from this machine. An explicit environment key always wins.

## Where the key is stored

1. The OS keychain when one is usable: the macOS Keychain (`security`), or the Secret Service on
   Linux (`secret-tool`, needs a desktop session bus). The secret is passed on stdin, never on a
   command line.
2. Otherwise `agent.secret` in the config dir, created with mode 0600 in a 0700 directory.
   `untrace-mcp` refuses to read it if group or others can read the file or the directory, if it
   is a symlink, or if another user owns it.

Config dir: `UNTRACE_MCP_CONFIG_DIR`, else `$XDG_CONFIG_HOME/untrace-mcp`, else
`~/Library/Application Support/untrace-mcp` (macOS), `%APPDATA%\untrace-mcp` (Windows),
`~/.config/untrace-mcp`. `UNTRACE_MCP_KEYCHAIN=0` forces the file. `agent.json` next to it holds
the public record (client id, label, scopes, fingerprint, storage); no secret.

`agent init --force` replaces the key. The old key stops working on this machine; revoke it in
Drive.

## Pairing code v1

Defined in Untrace Drive's developer key contract (`docs/api/developer-keys.md` section 3a) and
implemented in `src/agent/pairing.ts`. Text `utp1_` + base64url (no padding) of, big endian:

| Offset | Bytes | Field |
|---|---|---|
| 0 | 1 | version `0x01` |
| 1 | 22 | client id body (the 22 base58 characters after `utc_`) |
| 23 | 32 | sign public key (Ed25519) |
| 55 | 32 | box public key (X25519) |
| 87 | 32 | SHA-256 of the 32 decoded bytes of the OAuth `client_secret` |
| 119 | 16 | random nonce |
| 135 | 4 | expiry, unix seconds |
| 139 | 1 | scopes: bit0 download, bit1 upload, bit2 manage-sharing, bit3 delete |
| 140 | 1 | label length L (UTF-8 bytes) |
| 141 | L | label |
| 141+L | 64 | key signature over `untrace:client-key:v1:<clientId>:<base64 box key>` |
| 205+L | 64 | pairing signature over `untrace:agent-pair:v1:` followed by bytes 0 to 205+L |

Fingerprint: the first 10 bytes of SHA-512(`untrace:agent-fp:v1:` + sign key + box key) in base32,
four groups of four. `test/agent.test.ts` and Drive's `tests/unit/agent-pairing` assert the same
test vector, so the two sides cannot drift.

## How the key authenticates

The key is an ordinary developer key: the secret is the usual client secret string around 32 random bytes, and the
box key and the OAuth `client_secret` are derived from it by the SDK (`deriveClientKeys`). Drive
stores the hash of that OAuth value at pairing time, exactly as when a browser creates a key, so
the SDK's normal client credentials grant works unchanged. No SDK change is needed.

The one piece the SDK does not export is the Ed25519 sign key (it authenticates with the OAuth
value), and pairing needs it to sign the code. `src/agent/keys.ts` derives it with `node:crypto`
using the contract's key derivation label. It is the only file in this repo allowed to call a crypto
primitive (`scripts/check-public.mjs`). If the SDK later exports `deriveClientSignKey`, this file
should switch to it.
