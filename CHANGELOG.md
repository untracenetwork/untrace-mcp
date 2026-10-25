# Changelog

## Unreleased

- Connected project: `agent claim --project aiteam.space` (or `UNTRACE_AGENT_PROJECT`, the flag
  wins) names the project the agent works for. It is sent as `project` and signed into the claim as
  a `project:` line, the same as Drive. Only `aiteam.space` is accepted; anything else is refused
  before any request. Without a project the request and the signed message are unchanged.
- Secrets v0: `untrace_secret_set`, `untrace_secret_get`, `untrace_secret_list`,
  `untrace_secret_share`, `untrace_secret_unshare`. A secret is a small encrypted file in a reserved
  `.untrace/secrets/<name>` folder of the owner's Drive, made and opened by the SDK like any file,
  with per-secret key entries. Set never returns the value, list returns names only, and a value
  this server has seen is redacted from every other result, error and log line.
- Secrets: own vault first. `set` writes only into this key's own `/.untrace/secrets/<name>`;
  `get`, `share` and `unshare` read only the own vault, and `list` adds shared secrets only with
  `includeShared: true`. A shared secret is used only with `shared: true` (or its `id`) and is marked
  `shared: true`; Untrace refuses a write into another owner's folder and a share with another
  account's key, both mapped to a plain refusal. `untrace_secret_unshare` needs `confirm: true`.

## 2.0.0 (unreleased)

- `untrace-mcp agent claim <link> --want ...`: claim a one-time agent link from Drive (Settings >
  Developer > Give your agent access). Public keys and signatures only; the link works once.

Built on `@untracenetwork/sdk` ^2.0.0 (Drive API v1: OAuth client credentials, files encrypted on
the developer's machine).

- New tools: `untrace_list` (folders and files), folders (`untrace_create_folder`,
  `untrace_get_folder`, `untrace_rename_folder`, `untrace_move_folder`, `untrace_trash_folder`),
  `untrace_move_file`, sharing (`untrace_share` offers a file or folder to a username,
  `untrace_list_incoming_shares`, `untrace_accept_share`; the person accepts with their own key),
  key entries (`untrace_list_keys`, `untrace_attach_key`, `untrace_change_key`,
  `untrace_remove_key`; key types `passkey` and `client`, role `none` to block), `untrace_whoami`.
- `untrace_upload_file` needs `folderId`: a folder the key was added to as editor or admin. The key
  becomes an editor of the new file. A folder it was not added to answers
  `folder_access_required`.
- Removed: `untrace_list_files` (use `untrace_list`) and the per-file member tools
  `untrace_list_members`, `untrace_add_member`, `untrace_set_member_role`, `untrace_remove_member`
  (use the key tools).
- `untrace_upload_file` also takes inline `content`; `untrace_download_file` returns the file
  inline when no `path` is given. Upload limit is 16 MB (Drive API v1).
- New Streamable HTTP transport with a built-in OAuth 2.1 authorization server (authorization
  code + PKCE), so the server works as a Claude custom connector and a ChatGPT app:
  `untrace-mcp http`, `untrace-mcp new-connector-secret`.
- Folders, key entries and sharing are live in Drive API v1. The MCP server does no
  cryptography: the SDK makes folder keys, opens key paths and seals keys on this machine.
- Licence is now Apache-2.0.

## 1.0.0 (not published)

- First version: an MCP stdio server on `@untracenetwork/sdk` ^1.0.0.
