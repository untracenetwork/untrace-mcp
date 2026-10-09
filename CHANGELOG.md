# Changelog

## 1.0.0 (unreleased)

- First release of `@untracenetwork/mcp`: an MCP stdio server on top of `@untracenetwork/sdk` ^1.0.0.
- Tools: untrace_list_files, untrace_get_file, untrace_upload_file, untrace_download_file,
  untrace_rename_file, untrace_delete_file, untrace_list_members, untrace_add_member,
  untrace_set_member_role, untrace_remove_member, untrace_setup_guide.
- Credentials from the environment only, redacted from all output. Local file access limited to
  UNTRACE_MCP_ROOT. Delete needs confirm: true; downloads never overwrite without overwrite: true.
