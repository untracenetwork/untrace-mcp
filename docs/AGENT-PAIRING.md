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

## One-time agent link (`agent claim`)

The owner creates a link in Untrace Drive (**Settings > Developer > Give your agent access**):
`https://drive.untrace.network/a/<id>#<secret>`. The secret (128 bits) rides in the URL fragment,
so it is never sent in a request line or logged by a proxy. Drive stores only its SHA-256 and
burns it on the first claim; the link expires after 15 minutes.

```bash
npx -y @untracenetwork/mcp agent claim "<link>" \
  --want files:<folder id>:read_write=Q3 board pack \
  --want vault:<entry id>=OPENAI_API_KEY \
  --want vault:<entry id>:totp=GitHub 2FA \
  --want mail:agent@acme.com \
  [--label "Codex on laptop"] [--runs-on "Codex CLI"] [--project aiteam.space] [--wait]
```

- `--want category:id[:mode][=Name]`. Categories: `files`, `vault` (add `:totp` for a 2FA code,
  which the owner must tick on purpose), `mail`. Modes: `read` (default), `write`, `read_write`.
  Wallet access is not available to agents and is refused here and by Drive.
- The link host must equal `UNTRACE_BASE_URL` (default `https://drive.untrace.network`); http only
  for loopback. A link for another host is refused before any request.
- Uses this machine's agent key, or creates one exactly like `agent init`.
- `--wait` polls (every 5 s, up to 15 minutes) until Drive issues a token for the key.

The request is `POST {origin}/api/agent-links/{id}/claim` with JSON:

| Field | Value |
|---|---|
| `secret` | the 22 base64url characters after `#` |
| `clientId` | `utc_` + 22 base58 |
| `signPublicKey`, `boxPublicKey` | standard base64 |
| `keySignature` | Ed25519 over `untrace:client-key:v1:<clientId>:<base64 box key>` (as in the pairing code) |
| `oauthHash` | hex SHA-256 of the 32 decoded bytes of the OAuth `client_secret` |
| `claimSignature` | Ed25519 over the claim message below |
| `agentName`, `runsOn` | what the owner sees |
| `requested` | `[{ category, resource, mode, name, kind? }]` |
| `project` | only when set: the connected project, e.g. `aiteam.space` |

Claim message (lines joined by `\n`; one `category|resource|mode|kind` line per item, `kind`
empty unless set):

```
untrace:agent-link-claim:v1
link: <id>
client: <clientId>
sign: <base64 sign key>
box: <base64 box key>
requested:
files|folder-q3|read_write|
vault|entry-gh|read|totp
```

Drive answers `202 { id, status: "claimed", fingerprint }`. The command checks that fingerprint
equals its own before telling the user to have the owner approve. `404` = unknown link or wrong
secret, `410` = used, expired or cancelled, `429` = too many tries on this link, `400` = refused
body (`wallet_not_available`, `key_signature`, `claim_signature`, ...). Drive's side:
`app/api/agent-links/[id]/claim/route.ts` and `claimMessage()` in `lib/cloud/agent-links/rules.ts`;
`test/claim.test.ts` pins the same bytes.

### Connected project

An agent that works for a connected project says so with `--project`. Today the only connected
project is `aiteam.space`. The owner sees it in Drive before approving.

```bash
npx -y @untracenetwork/mcp agent claim "<link>" --want files:<folder id>:read_write --project aiteam.space
```

- `UNTRACE_AGENT_PROJECT=aiteam.space` sets the default, so an agent image can set it once.
  `--project` wins over the variable.
- Any other value is refused before a key is made or a request is sent. Drive refuses it too
  (`400 invalid_project`). The list lives in `CONNECTED_PROJECTS` in `src/agent/claim.ts` and
  matches Drive's `lib/cloud/agent-links/projects.ts`.
- The body gets `project`, and the claim message gets one more line, `project: <name>`, after
  `box:` and before `requested:`:

```
untrace:agent-link-claim:v1
link: <id>
client: <clientId>
sign: <base64 sign key>
box: <base64 box key>
project: aiteam.space
requested:
files|folder-q3|read_write|
```

Without a project, neither the field nor the line is there, so the message is the same as before.

