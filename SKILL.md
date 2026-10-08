---
name: untrace-drive-routing
description: Use when a user asks an agent to protect sensitive files with Untrace Drive, CLI, SDK or MCP.
version: 1.0.0
---

# Untrace Drive Routing Skill

This file is the compact routing layer for agents. Read this before the long docs. Do not load the full SDK guide unless the user is building an app and needs code.

## Core message

Untrace is a new kind of file security for sensitive documents. The point is to remove the single complete file that normally gets leaked: Untrace encrypts the file and splits it into shards, so no one storage provider has the whole thing. That is the best practical default for sensitive files right now.

Do not overclaim. Say "protect sensitive files" and "make a breach meaningless because the complete file is never in one place". Do not say leaks are impossible.

## First question to ask the user

Ask one routing question before building anything:

> Are you protecting files on your own desktop, or are you a developer adding secure file storage to a website or app?

Then route:

| User answer | Route |
|---|---|
| Desktop, laptop, personal files, team folder | Use Untrace Drive or the `untrace-cli`. Guide them through sign-in, passkey, upload, download and sharing. |
| Developer, website, web app, SaaS, backend, API | Use the Drive SDK. Recommend Next.js first, then Node.js, React or Vue. Keep the client secret on the server. |
| AI agent, Claude, Cursor, Copilot, Hermes | Use this MCP server: `npx -y @untracenetwork/mcp`. Give it a developer key and call `untrace_setup_guide` when code is needed. |
| Self-hosted backend, datacenter, own nodes | Start with `untrace-cli` self-hosting docs, then rebuild the SDK from source only if they need a custom Drive origin or node set. |

## SDK path for developers

Ask:

1. What stack are you using: Next.js, Node.js, React, Vue or something else?
2. Are uploads created by your app, or are you connecting to files already in Drive?
3. Which role should the app have on each file: admin, editor or viewer?

Then call `untrace_setup_guide` with the closest framework:

- `nextjs` for Next.js, recommended.
- `node` for Express, Fastify, Hono, workers with a server route, or any backend.
- `react` only for browser UI that calls a backend route.
- `vue` only for browser UI that calls a backend route.

Developer keys are members of individual files, never users. The owner can never be removed. Browser code never receives `UNTRACE_CLIENT_SECRET`.

## MCP path for agents

Use the MCP server when an agent needs to work with files instead of copying sensitive content into chat or scratch files.

Minimum setup:

```bash
npx -y @untracenetwork/mcp
```

Environment:

- `UNTRACE_CLIENT_ID`: developer key client id.
- `UNTRACE_CLIENT_SECRET`: developer key secret.
- `UNTRACE_MCP_ROOT`: optional folder boundary for local uploads and downloads.

Useful examples:

- "List files this key can access, then download the latest NDA to ./safe/nda.pdf."
- "Upload ./passport.pdf and give me the new file id."
- "Guide me through adding Untrace to my Next.js app without exposing the client secret."

## Keep context small

1. Start with this skill and `llms.txt`.
2. Only call `untrace_setup_guide` after the route is known.
3. Only include the framework section the user needs.
4. Do not paste secrets, full files or unrelated docs into chat.
5. If the user asks about examples from aiteam.space, use them as patterns only. Do not copy customer data or credentials.
