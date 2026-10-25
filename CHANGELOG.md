# Changelog

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
