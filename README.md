# @untracenetwork/mcp

An MCP server for Untrace Drive. It lets an AI agent (Claude, ChatGPT, Cursor, VS Code Copilot
and any other MCP client) list, upload, download and share the Drive folders and files that one
developer key can reach, and helps the agent add the Untrace Drive SDK to a developer's own app.

- Package: `@untracenetwork/mcp` on npm, bin `untrace-mcp`
- Transports: stdio (local clients) and Streamable HTTP with OAuth (Claude custom connector, ChatGPT app)
- Docs: https://untrace.network/docs/mcp
- For agents: https://untrace.network/llms.txt (and [llms.txt](llms.txt) and [SKILL.md](SKILL.md) in this package)

## Route the user first

Ask:

> Are you protecting files on your own desktop, or are you a developer adding secure file storage to a website or app?

- **Desktop or personal files:** use the Untrace Drive app.
- **Website, SaaS or app developer:** use the Drive SDK. Next.js is the first option, then Node.js, React or Vue.
- **AI agent workflow:** use this MCP server, so the agent works with file ids instead of copying sensitive documents into chat.

Files are encrypted on the machine that runs this server before they are sent. Drive stores the
ciphertext in 6 regions, and any 3 recover a file. We cannot read your files. Do not claim that
leaks are impossible.

## How access works

The server acts as one **developer key**: a client id (`utc_...`) and a client secret you create
in Drive. Every file lives in a folder. Folders and files hold **key entries**. Each entry is a
key a person holds (an account passkey or a developer key) with a **role** and **scopes**. The key this server runs as reaches
only the folders and files where it holds an entry, directly or through a parent folder. Access is
resolved from the top folder down and the nearest entry wins, so a block (`none`) on a subfolder
beats a grant on its parent. The owner can never be removed or demoted. A file the key cannot
reach answers `not_found`, exactly like a file that does not exist.

A call is allowed only when the key's **scopes** and its **role** there both allow it.

| Scope | Allows |
|---|---|
| `download` | Open files the key can reach |
| `upload` | Create folders, and new files in a folder the key was added to as `editor` or `admin` (billed to the owner's plan) |
| `manage-sharing` | Share, and attach, change and remove keys where the key is `admin` |
| `delete` | Move files and folders to the trash where the key is `admin` |

| Role | download | add files, rename | manage keys, share | delete (to trash) |
|---|---|---|---|---|
| admin | yes | yes | yes | yes |
| editor | yes | yes | no | no |
| viewer | yes | no | no | no |
| none | no (an explicit block) | no | no | no |

**Sharing with a person** works by username: `untrace_share` offers a file or folder with a role,
and the person accepts, which attaches their **own** key (in Drive, or with
`untrace_accept_share` on a server that holds their sharing key). Nobody can attach a key in
someone else's name. File and folder keys are opened on the machine running this server and
sealed to the recipient's published sharing key after its signature is checked, so Untrace never
sees them.

## 1. Create a developer key

1. Open Untrace Drive, go to **Settings > Developer keys** and create a key. Pick its scopes.
2. Copy the **client id** (`utc_...`) and the **client secret**. The secret is shown once and
   Untrace does not keep it. If you lose it, revoke the key and create a new one.
3. The account that owns the key needs an active plan (otherwise Drive answers `payment_required`),
   and signs in to Drive once before the key uploads.
4. Give the key access: in Drive, add it to the folders it should reach, with a role. A key
   uploads only into a folder it was added to as `editor` or `admin`, or into a folder it made
   itself with `untrace_create_folder`. It becomes an editor of every file it uploads.
   `untrace_whoami` shows the key's client id and public key, which an admin can also pass to
   `untrace_attach_key`.

## 2. Environment variables

| Variable | Mode | Meaning |
|---|---|---|
| `UNTRACE_CLIENT_ID` | all | The developer key's client id, `utc_...` |
| `UNTRACE_CLIENT_SECRET` | all | The developer key's client secret |
| `UNTRACE_BASE_URL` | all | Optional. Drive origin, default `https://drive.untrace.network` |
| `UNTRACE_MCP_ROOT` | all | The only local folder uploads read from and downloads write to. stdio default: the folder the server starts in. HTTP default: local paths off |
| `UNTRACE_SHARE_SECRET_KEY` | all | Optional. The account's sharing secret key (32 bytes, base64), only to accept shares with `untrace_accept_share`. Leave it unset to accept shares in Drive. It is a secret: treat it like the client secret |
| `UNTRACE_MCP_MAX_INLINE_BYTES` | all | Optional. Largest download returned inline in a tool result. Default 4 MiB |
| `UNTRACE_MCP_PUBLIC_URL` | http | The public HTTPS origin of the server, for example `https://mcp.example.com` |
| `UNTRACE_MCP_OAUTH_CLIENT_SECRET` | http | The OAuth client secret you give Claude or ChatGPT. 32+ random characters, made with `untrace-mcp new-connector-secret` |
| `PORT`, `HOST` | http | Listen address. Default port `8787` on the loopback interface |
| `UNTRACE_MCP_REDIRECT_URIS` | http | Optional. Extra allowed OAuth redirect URIs, comma separated |
| `UNTRACE_MCP_ALLOW_LOOPBACK_REDIRECTS` | http | Optional. `1` allows `http://localhost` redirects, for local testing only |

The client secret is read from the environment only. No tool accepts a secret as an argument, and
secrets are redacted from every tool result, error and log line. Never paste one into a chat.

The stdio server starts without a key, so `untrace_setup_guide` works anyway; file tools then
answer with setup help. Node.js 20 or newer is required.

## 3. Local clients (stdio)

MCP clients start the server with `npx -y @untracenetwork/mcp`.

### Claude Desktop

`claude_desktop_config.json` (Settings > Developer > Edit Config):

```json
{
  "mcpServers": {
    "untrace": {
      "command": "npx",
      "args": ["-y", "@untracenetwork/mcp"],
      "env": {
        "UNTRACE_CLIENT_ID": "utc_...",
        "UNTRACE_CLIENT_SECRET": "<client secret>",
        "UNTRACE_MCP_ROOT": "/Users/you/untrace-files"
      }
    }
  }
}
```

### Claude Code

`.mcp.json` at the project root. `${VAR}` is expanded from your shell, so the secret stays out of
the file (do not commit real secrets):

```json
{
  "mcpServers": {
    "untrace": {
      "command": "npx",
      "args": ["-y", "@untracenetwork/mcp"],
      "env": {
        "UNTRACE_CLIENT_ID": "${UNTRACE_CLIENT_ID}",
        "UNTRACE_CLIENT_SECRET": "${UNTRACE_CLIENT_SECRET}"
      }
    }
  }
}
```

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project), same shape as Claude
Desktop above.

### VS Code

`.vscode/mcp.json`. The `inputs` block prompts for the secret once and stores it securely:

```json
{
  "inputs": [
    { "type": "promptString", "id": "untrace-secret", "description": "Untrace client secret", "password": true }
  ],
  "servers": {
    "untrace": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@untracenetwork/mcp"],
      "env": {
        "UNTRACE_CLIENT_ID": "utc_...",
        "UNTRACE_CLIENT_SECRET": "${input:untrace-secret}"
      }
    }
  }
}
```

## 4. Remote server (Streamable HTTP + OAuth)

Claude custom connectors and ChatGPT apps reach MCP servers over HTTPS. `untrace-mcp http` serves
Streamable HTTP at `<public url>/mcp` and is its own small OAuth 2.1 authorization server for
exactly one client: the developer key it runs as.

- OAuth client id: your `UNTRACE_CLIENT_ID`.
- OAuth client secret: `UNTRACE_MCP_OAUTH_CLIENT_SECRET`, a separate random value. It only opens
  this server and never works against Drive, so the developer key secret stays on your server. To
  cut off every connector, rotate it and restart.
- Authorization code with PKCE (S256), `client_secret_basic` or `client_secret_post`, the `iss`
  parameter on every redirect, `resource` checked, refresh tokens rotated on use, access tokens
  valid 1 hour. Discovery at `/.well-known/oauth-protected-resource/mcp` and
  `/.well-known/oauth-authorization-server`. No dynamic client registration: you enter the client
  id and secret in the connector settings.
- Redirects go only to Claude's and ChatGPT's callback URLs (plus `UNTRACE_MCP_REDIRECT_URIS`).
- Tokens live in memory. A restart signs connectors out; they reconnect on their own.
- Anyone who has the connector secret acts as this developer key. Give the key only the scopes
  and folders the connector needs.
- Local paths are off by default on the HTTP server: uploads take `content`, downloads come back
  inline. Run one process (tokens are not shared across replicas).

### Run it

```bash
export UNTRACE_CLIENT_ID=utc_...
export UNTRACE_CLIENT_SECRET=...                        # from your secret store
export UNTRACE_MCP_PUBLIC_URL=https://mcp.example.com
export UNTRACE_MCP_OAUTH_CLIENT_SECRET="$(npx -y @untracenetwork/mcp new-connector-secret)"
npx -y @untracenetwork/mcp http                         # listens on localhost, port 8787
```

Put it behind a TLS reverse proxy (Caddy, nginx, a tunnel) that forwards
`https://mcp.example.com` to `http://localhost:8787` and keeps the `Host` header. Check
`https://mcp.example.com/healthz`.

### Claude custom connector

1. In Claude, open **Settings > Connectors**, choose **Add custom connector**.
2. Name: `Untrace Drive`. URL: `https://mcp.example.com/mcp`.
3. Open **Advanced settings** and enter the OAuth client id (`utc_...`) and the OAuth client
   secret (`UNTRACE_MCP_OAUTH_CLIENT_SECRET`).
4. Click **Add**, then **Connect**. The connection completes without a login page.

On Team and Enterprise plans an owner adds the connector for the organisation first. Claude's
callback URL (`https://claude.ai/api/mcp/auth_callback`) is allowed by default.

### ChatGPT app

1. In ChatGPT, turn on **Developer mode** (Settings > Apps > Advanced settings).
2. **Create app**: name `Untrace Drive`, MCP server URL `https://mcp.example.com/mcp`,
   authentication **OAuth**.
3. In the OAuth settings enter the client id (`utc_...`) and the client secret
   (`UNTRACE_MCP_OAUTH_CLIENT_SECRET`). The authorization and token URLs are discovered from the
   server.
4. Save, then connect. ChatGPT's callback URLs
   (`https://chatgpt.com/connector_platform_oauth_redirect` and
   `https://chatgpt.com/connector/oauth/...`) are allowed by default. If ChatGPT shows you a
   different callback URL, add it to `UNTRACE_MCP_REDIRECT_URIS`.

### Test it locally

```bash
UNTRACE_MCP_PUBLIC_URL=http://localhost:8787 UNTRACE_MCP_ALLOW_LOOPBACK_REDIRECTS=1 \
  npx -y @untracenetwork/mcp http
npx @modelcontextprotocol/inspector   # connect to http://localhost:8787/mcp with the client id and secret
```

## Tools

| Tool | What it does | Needs |
|---|---|---|
| `untrace_list` | Subfolders and files of one folder (`folderId`), or the top-level folders and every file the key reaches. Paged (`cursor` for files, `folderCursor` for folders) | any role |
| `untrace_get_file` | One file's metadata, folder and the key's role | any role |
| `untrace_upload_file` | Encrypt and upload a new file into `folderId` (required: a folder the key was added to), from a local `path` or from `content` (text or base64) with a `name`. Max 16 MB. The key becomes an editor of the new file. Returns the file and `metering` | scope `upload`, editor or admin on the folder |
| `untrace_download_file` | Download and decrypt a file to a local `path` (never replaces a file unless `overwrite: true`), or inline without `path` (text, image or base64) | scope `download` |
| `untrace_rename_file` | Rename a file | editor or admin |
| `untrace_move_file` | Move a file into another folder. Its key is re-sealed to the target folder on this machine | admin on the file and the target |
| `untrace_delete_file` | Move a file to the owner's trash. Requires `confirm: true`. Only the owner restores or purges | scope `delete`, admin |
| `untrace_create_folder` | Create a folder at the top level (the key becomes its admin) or inside `parentId` | scope `upload`, editor or admin on the parent |
| `untrace_get_folder` | One folder's name, parent, the key's role and its public key | any role |
| `untrace_rename_folder` | Rename a folder | editor or admin |
| `untrace_move_folder` | Move a folder under another one. Never inside itself | admin on the folder, editor or admin on the target |
| `untrace_trash_folder` | Move a folder and everything in it to the owner's trash. Requires `confirm: true` | scope `delete`, admin |
| `untrace_share` | Offer a file or folder to an Untrace `username` with a role. They accept with their own key | scope `manage-sharing`, admin |
| `untrace_list_incoming_shares` | Pending shares other users offered to the account that owns the key | nothing |
| `untrace_accept_share` | Accept a pending share by attaching this key. Needs `UNTRACE_SHARE_SECRET_KEY`; otherwise accept in Drive | nothing |
| `untrace_list_keys` | The key entries on a file or folder: type (`passkey` or `client`), key id, role, scopes | scope `manage-sharing`, admin |
| `untrace_attach_key` | Attach a key the account holds (`keyType` `client` or `passkey`) to a file or folder with a role and scopes, or block it with role `none` | scope `manage-sharing`, admin |
| `untrace_change_key` | Change an entry's role or scopes. Never the owner | scope `manage-sharing`, admin |
| `untrace_remove_key` | Remove an entry. Requires `confirm: true`. Never the owner | scope `manage-sharing`, admin |
| `untrace_whoami` | This key's client id, Drive, scopes and public key. Never the secret | nothing |
| `untrace_setup_guide` | Step-by-step instructions, with code, for adding the Drive SDK to a Next.js, Node.js, React or Vue app. Works offline, no key needed | nothing |

Local paths are relative to `UNTRACE_MCP_ROOT`. Paths that leave it (`..`, absolute paths
elsewhere, symlinks that point outside) are refused, and downloads never write through a symlink.

### Errors

Errors come back as MCP tool errors that start with a short code and say what to do next:

| Code | Meaning |
|---|---|
| `not_found` | It does not exist, or this key cannot reach it (Untrace never says which). Ask an admin to attach the key |
| `folder_access_required` | The key was not added to this folder (as `editor` or `admin`), so it cannot upload there. Pick another folder, create one, or ask an admin to add the key |
| `conflict` | For example a folder moved inside itself, or a key that is already attached |
| `owner_not_ready` | The owner has not signed in to Drive once yet, so uploads cannot be sealed to them |
| `owner_immutable` | The owner can never be removed, demoted or changed |
| `insufficient_scope` / `insufficient_role` | The key's scopes or its role there do not allow the call |
| `auth` / `not_configured` | The key is unknown, revoked or not set. Check the environment variables |
| `payment_required` | The owner's plan does not allow it (no active plan, or storage full) |
| `too_large` | Over the upload size limit |
| `integrity` | A key, a signature or the encrypted content failed a check on this machine. Nothing was trusted |
| `rate_limited`, `unavailable`, `timeout` | Temporary. Retry |
| `path_refused`, `refused` | Refused locally (path outside the root, missing `confirm`, existing file, file too big) |

### Metering

Uploads count against the **owner's** plan. `untrace_upload_file` returns
`metering: { billedTo: "owner", meteredBytes, usageBytes, quotaBytes }` (`quotaBytes` `-1` means unlimited).

## Set up the Drive SDK in your app

The MCP server is for agents. To give your own app encrypted file storage, use the Untrace Drive
SDK. Ask your agent to call `untrace_setup_guide` with `framework` set to `nextjs`, `node`, `react`
or `vue`, or start here:

| Package | Use it for |
|---|---|
| `@untracenetwork/next` | Next.js route handler (recommended) |
| `@untracenetwork/sdk` | The core client for any server runtime (Node 20+, Bun, Deno, Workers) |
| `@untracenetwork/react` | Hooks that call your own backend route |
| `@untracenetwork/vue` | Composables that call your own backend route |

```bash
npm install @untracenetwork/next @untracenetwork/react
```

The client secret stays on your server (`UNTRACE_CLIENT_ID`, `UNTRACE_CLIENT_SECRET`, never
`NEXT_PUBLIC_`). Browser code talks to your route, never to Untrace directly.

Full SDK docs for agents: https://untrace.network/llms.txt

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Releases: [docs/RELEASING.md](docs/RELEASING.md).

## License

Apache-2.0
