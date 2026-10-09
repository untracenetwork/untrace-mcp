# @untracenetwork/mcp

An MCP server for Untrace Drive. It lets an AI agent (Claude, Cursor, VS Code Copilot and any
other MCP client) list, read, upload and share the Drive files that one developer key is a
member of, and helps the agent add the Untrace Drive SDK to a developer's own app.

- Package: `@untracenetwork/mcp` on npm, bin `untrace-mcp`, stdio transport
- Docs: https://untrace.network/docs/mcp
- For agents: https://untrace.network/llms.txt (and [llms.txt](llms.txt) in this package)

## Route the user first

This package is mostly docs for agents plus a thin tool layer. To keep context small, route the user before loading long setup docs. Ask:

> Are you protecting files on your own desktop, or are you a developer adding secure file storage to a website or app?

- **Desktop or personal files:** use Untrace Drive or the `untrace-cli`.
- **Website, SaaS or app developer:** use the Drive SDK. Next.js is the first option, then Node.js, React or Vue.
- **AI agent workflow:** use this MCP server so the agent works with file ids instead of copying sensitive documents into chat.
- **Self-hosted backend or own nodes:** start with `untrace-cli` self-hosting, then rebuild the SDK from source only for custom node routing.

Untrace is a new kind of file security for sensitive documents: it removes the single complete file that normally gets leaked by encrypting and splitting the file into shards. It is the best practical default right now for protecting sensitive files. Do not overclaim that leaks are impossible.

For a compact agent playbook, read [SKILL.md](SKILL.md).

## How access works

Untrace is self-custodial data access control. The server acts as one **developer key** (a
client id and secret you create in Drive). A developer key is a **member of individual files**
with a role (`admin`, `editor` or `viewer`). It is never a user, it never sees files it is not
a member of, and the owner of a file can never be changed or removed.

Files are encrypted on your machine before upload and stored as 6 encrypted shards. Any 3
rebuild the file. File keys are sealed to your developer key and opened locally, so Untrace
never sees a plaintext key.

A call is allowed only when the key's **scopes** and its **role on that file** both allow it.

| Scope | Allows |
|---|---|
| `download` | Open files the key is a member of |
| `upload` | Create new files in the owner's drive (billed to the owner's plan) |
| `manage-sharing` | Add, change and remove other keys on files where the key is `admin` |
| `delete` | Move files to the trash where the key is `admin` |

| Role | download | rename | manage members | delete (to trash) |
|---|---|---|---|---|
| admin | yes | yes | yes | yes |
| editor | yes | yes | no | no |
| viewer | yes | no | no | no |

## 1. Create a developer key

1. Open Untrace Drive, go to **Settings > Developer keys** and create a key. Pick its scopes.
2. Copy the **client id** (`utc_...`) and the **client secret** (`untrace_sk_v1_...`). The secret
   is shown once and Untrace does not keep it. If you lose it, revoke the key and create a new one.
3. Add the key to each file it should reach: open the file's sharing panel in Drive, add the key
   as a member and choose `admin`, `editor` or `viewer`. Files the key uploads itself are added
   for you as `editor`.
4. Sign in to Drive at least once as the owner before the key uploads. That publishes the
   sharing key new files are sealed to.

## 2. Install

Nothing to install globally. MCP clients start the server with:

```bash
npx -y @untracenetwork/mcp
```

Node.js 20 or newer is required.

### Environment variables

| Variable | Required | Meaning |
|---|---|---|
| `UNTRACE_CLIENT_ID` | yes | The developer key's client id, `utc_...` |
| `UNTRACE_CLIENT_SECRET` | yes | The developer key's secret, `untrace_sk_v1_...` |
| `UNTRACE_BASE_URL` | no | Drive origin, default `https://drive.untrace.network` |
| `UNTRACE_MCP_ROOT` | no | The only folder uploads read from and downloads write to. Default: the folder the server starts in |

The secret is read from the environment only. No tool accepts it as an argument, and it is
redacted from every tool result, error and log line. Never paste it into a chat.

The server starts without a key, so `untrace_setup_guide` works anyway; file tools then answer
with setup help.

## 3. Configure your MCP client

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
        "UNTRACE_CLIENT_SECRET": "untrace_sk_v1_...",
        "UNTRACE_MCP_ROOT": "/Users/you/untrace-files"
      }
    }
  }
}
```

### Claude Code

`.mcp.json` at the project root. `${VAR}` is expanded from your shell, so the secret stays out
of the file (do not commit real secrets):

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

Or from the command line:

```bash
claude mcp add untrace -e UNTRACE_CLIENT_ID=utc_... -e UNTRACE_CLIENT_SECRET=untrace_sk_v1_... -- npx -y @untracenetwork/mcp
```

### Cursor

`~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` (one project):

```json
{
  "mcpServers": {
    "untrace": {
      "command": "npx",
      "args": ["-y", "@untracenetwork/mcp"],
      "env": {
        "UNTRACE_CLIENT_ID": "utc_...",
        "UNTRACE_CLIENT_SECRET": "untrace_sk_v1_..."
      }
    }
  }
}
```

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

## Tools

| Tool | What it does | Needs |
|---|---|---|
| `untrace_list_files` | Files the key is a member of, with the key's role. Paged (`limit`, `cursor`) | any role |
| `untrace_get_file` | One file's metadata and the key's role | any role |
| `untrace_upload_file` | Encrypt a local file (`path`, optional `name`, `mime`) and upload it as a new file. Max 95 MB. Returns `fileId` and `metering` | scope `upload` |
| `untrace_download_file` | Download and decrypt a file to a local `path`. Refuses to replace an existing file unless `overwrite: true` | scope `download` |
| `untrace_rename_file` | Rename a file | editor or admin |
| `untrace_delete_file` | Move a file to the owner's trash. Requires `confirm: true`. Only the owner restores or purges | scope `delete`, admin |
| `untrace_list_members` | The owner (a wallet) and the member keys with their roles | scope `manage-sharing`, admin |
| `untrace_add_member` | Add another developer key (`utc_...`) of the same owner as `admin`, `editor` or `viewer` | scope `manage-sharing`, admin |
| `untrace_set_member_role` | Change a member key's role | scope `manage-sharing`, admin |
| `untrace_remove_member` | Remove a member key. The owner can never be removed | scope `manage-sharing`, admin |
| `untrace_setup_guide` | Step-by-step instructions, with code, for adding the Drive SDK to a Next.js, Node.js, React or Vue app. Works offline, no key needed | nothing |

Local paths are relative to `UNTRACE_MCP_ROOT`. Paths that leave it (`..`, absolute paths
elsewhere, symlinks that point outside) are refused, and downloads never write through a
symlink.

### Errors

Errors come back as MCP tool errors that start with a short code and say what to do next:

| Code | Meaning |
|---|---|
| `not_found` | The file does not exist, or the key is not a member of it (Untrace never says which). Add the key to the file in Drive |
| `owner_not_ready` | The owner has not signed in to Drive once yet, so uploads cannot be sealed to them |
| `owner_immutable` | The owner of a file can never be added, changed or removed |
| `insufficient_scope` / `insufficient_role` | The key's scopes or its role on that file do not allow the call |
| `auth` / `not_configured` | The key is unknown, revoked or not set. Check the environment variables |
| `payment_required` | The owner's plan or quota blocks the upload |
| `rate_limited`, `unavailable`, `timeout` | Temporary. Retry (600 requests per minute per key) |
| `finalize_unknown` | An upload's last step had an unknown outcome. Do not upload again; check with `untrace_get_file` |
| `path_refused`, `refused` | Refused locally (path outside the root, missing `confirm`, existing file, file too big) |

### Metering

Uploads count against the **owner's** plan. `untrace_upload_file` returns
`metering: { billedTo: "owner", meteredBytes, usageBytes, quotaBytes, unlimited, clientId }`.

## Set up the Drive SDK in your app

The MCP server is for agents. To give your own app encrypted file storage, use the Untrace
Drive SDK. Ask your agent to call `untrace_setup_guide` with `framework` set to `nextjs`,
`node`, `react` or `vue`, or start here:

| Package | Use it for |
|---|---|
| `@untracenetwork/next` | Next.js route handler and server actions (recommended) |
| `@untracenetwork/sdk` | The core client for any server runtime (Node 20+, Bun, Deno, Workers) |
| `@untracenetwork/node` | File path and stream helpers, node:http / Express adapter |
| `@untracenetwork/react` | Hooks that call your own backend route |
| `@untracenetwork/vue` | Composables that call your own backend route |

```bash
npm install @untracenetwork/next @untracenetwork/react
```

```ts
// app/api/untrace/route.ts
import { createUntraceRoute } from "@untracenetwork/next"

export const runtime = "nodejs"
export const { GET, POST } = createUntraceRoute({
  authorize: async (request) => Boolean(await yourSessionCheck(request)),
  allow: ["list", "get", "download", "upload"],
})
```

The client secret stays on your server (`UNTRACE_CLIENT_ID`, `UNTRACE_CLIENT_SECRET`, never
`NEXT_PUBLIC_`). Browser code talks to your route, never to Untrace directly.

Full SDK docs for agents: https://untrace.network/llms.txt

## Development

See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md). Releases: [docs/RELEASING.md](docs/RELEASING.md).

## License

MIT
