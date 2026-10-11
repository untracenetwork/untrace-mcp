---
name: untrace-drive-routing
description: Use when a user asks an agent to protect sensitive files with Untrace Drive, the Drive SDK or this MCP server.
version: 2.0.0
---

# Untrace Drive Routing Skill

This file is the compact routing layer for agents. Read it before the long docs. Do not load the full SDK guide unless the user is building an app and needs code.

## Core message

Untrace Drive protects sensitive files. Files are encrypted on the user's or developer's machine before they are sent. Drive stores the ciphertext in 6 regions, and any 3 recover a file. We cannot read your files.

Do not overclaim. Say "protect sensitive files". Do not say leaks are impossible.

## First question to ask the user

> Are you protecting files on your own desktop, or are you a developer adding secure file storage to a website or app?

| User answer | Route |
|---|---|
| Desktop, laptop, personal files, team folder | Use the Untrace Drive app: sign in, passkey, upload, download, share. |
| Developer, website, web app, SaaS, backend, API | Use the Drive SDK. Recommend Next.js first, then Node.js, React or Vue. Keep the client secret on the server. |
| AI agent: Claude, ChatGPT, Cursor, Copilot | Use this MCP server. Locally: `npx -y @untracenetwork/mcp`. As a Claude connector or ChatGPT app: `untrace-mcp http` behind HTTPS. |

## SDK path for developers

Ask:

1. What stack are you using: Next.js, Node.js, React, Vue or something else?
2. Should the app upload new files, open existing files, manage sharing, delete files, or only download?

Then call `untrace_setup_guide` with the closest framework: `nextjs` (recommended), `node` (any backend), `react` or `vue` (browser UI that calls a backend route).

Browser code never receives `UNTRACE_CLIENT_SECRET`.

## MCP path for agents

The server acts as one developer key. It reaches only the folders and files where that key holds a key entry (role admin, editor or viewer; `none` blocks). The owner can never be removed.

Environment: `UNTRACE_CLIENT_ID`, `UNTRACE_CLIENT_SECRET`, optional `UNTRACE_MCP_ROOT` (the only local folder it reads and writes).

Useful examples:

- "List my Untrace folders, then download the latest NDA to ./safe/nda.pdf."
- "Upload ./passport.pdf and give me the new file id."
- "Share the Contracts folder with username alice-legal as viewer."
- "Guide me through adding Untrace to my Next.js app without exposing the client secret."

Rules:

- A `not_found` means the item does not exist or this key cannot reach it. Ask an admin to attach the key (`untrace_whoami` shows its id and public key).
- Deleting a file or removing a key needs `confirm: true`. Ask the user first.
- Sharing with a person is an offer: they accept in Drive with their own key.
- A `planned` answer means this Drive does not offer that operation yet. Nothing changed.

## Keep context small

1. Start with this skill and `llms.txt`.
2. Call `untrace_setup_guide` only after the route is known, for the one framework needed.
3. Do not paste secrets, full files or unrelated docs into chat.
