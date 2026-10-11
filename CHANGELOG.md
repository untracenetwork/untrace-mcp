# Changelog

## 2.0.0 (unreleased)

Built on `@untracenetwork/sdk` ^2.0.0 (Drive API v1: OAuth client credentials, files encrypted on
the developer's machine).

- New tools: `untrace_list` (folders and files), `untrace_share` (offer a file or folder to a
  username; the person accepts with their own key), `untrace_list_keys`, `untrace_attach_key`,
  `untrace_change_key`, `untrace_remove_key` (key entries on files and folders, role `none` to
  block), `untrace_whoami`.
- Removed: `untrace_list_files` (use `untrace_list`) and the per-file member tools
  `untrace_list_members`, `untrace_add_member`, `untrace_set_member_role`, `untrace_remove_member`
  (use the key tools).
- `untrace_upload_file` also takes inline `content`; `untrace_download_file` returns the file
  inline when no `path` is given. Upload limit is 16 MB (Drive API v1).
- New Streamable HTTP transport with a built-in OAuth 2.1 authorization server (authorization
  code + PKCE), so the server works as a Claude custom connector and a ChatGPT app:
  `untrace-mcp http`, `untrace-mcp new-connector-secret`.
- Folders, key entries and sharing are `planned` in Drive API v1: until a Drive serves them,
  `untrace_list` falls back to the flat file list and the other tools answer `planned`.
- Licence is now Apache-2.0.

## 1.0.0 (not published)

- First version: an MCP stdio server on `@untracenetwork/sdk` ^1.0.0.
