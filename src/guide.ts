/**
 * untrace_setup_guide: step-by-step instructions for wiring the Untrace Drive SDK into an app.
 * The content comes from the installed @untracenetwork/sdk README, embedded at build time
 * (scripts/embed-guide.mjs), so it works offline and matches the SDK version in use.
 */
import { SDK_GUIDE } from "./generated/guide"

export const FRAMEWORKS = ["nextjs", "node", "react", "vue"] as const
export type Framework = (typeof FRAMEWORKS)[number]

const INSTALL: Record<Framework, string> = {
  nextjs: "npm install @untracenetwork/next @untracenetwork/react",
  node: "npm install @untracenetwork/sdk",
  react: "npm install @untracenetwork/react   # plus a backend route: @untracenetwork/next or createUntraceHandler from @untracenetwork/sdk/backend",
  vue: "npm install @untracenetwork/vue   # plus a backend route: createUntraceHandler from @untracenetwork/sdk/backend",
}

const FRAMEWORK_SECTIONS: Record<Framework, readonly (keyof typeof SDK_GUIDE)[]> = {
  nextjs: ["core", "next", "browser"],
  node: ["core"],
  react: ["core", "next", "browser"],
  vue: ["core", "browser"],
}

const HEADINGS: Partial<Record<keyof typeof SDK_GUIDE, string>> = {
  core: "Core client (any server runtime)",
  next: "Next.js",
  browser: "React and Vue",
}

const TITLES: Record<Framework, string> = { nextjs: "Next.js", node: "Node.js", react: "React", vue: "Vue" }

export function setupGuide(framework: Framework, includeReference = true): string {
  const parts: string[] = []
  parts.push(`# Set up the Untrace Drive SDK in a ${TITLES[framework]} app`)
  parts.push(
    [
      "Route the user first: desktop or personal files use the Untrace Drive app; website and app developers use the Drive SDK; AI agents use @untracenetwork/mcp.",
      "Files are encrypted on the developer's server before they are sent. Drive stores the ciphertext in 6 regions, and any 3 recover it. We cannot read your files. Do not claim leaks are impossible.",
      "A developer key reaches only the folders and files where it holds a key entry, with a role (admin, editor or viewer) and scopes. The owner can never be removed.",
      "",
      "Questions to ask before coding:",
      "1. What stack is the app: Next.js, Node.js, React, Vue or something else?",
      "2. Should it upload new files, open existing files, manage sharing, delete files, or only download?",
      "",
      "Steps:",
      "1. Create a developer key in Untrace Drive: Settings > Developer keys. Pick its scopes (download, upload, manage-sharing, delete). Copy the client id (utc_...) and the client secret (shown once).",
      "2. Put them in the app's SERVER environment only: UNTRACE_CLIENT_ID and UNTRACE_CLIENT_SECRET. Never in browser code, never NEXT_PUBLIC_.",
      "3. The account that owns the key needs an active plan, and signs in to Drive once before the key uploads.",
      `4. Install: \`${INSTALL[framework]}\``,
      "5. Wire it up as shown below.",
    ].join("\n")
  )
  parts.push(`## Create a key in Drive\n\n${SDK_GUIDE.createKey}`)
  for (const key of FRAMEWORK_SECTIONS[framework]) parts.push(`## ${HEADINGS[key]}\n\n${SDK_GUIDE[key]}`)
  if (includeReference) {
    parts.push(`## Scopes and roles\n\n${SDK_GUIDE.scopes}`)
    parts.push(`## Errors\n\n${SDK_GUIDE.errors}`)
    parts.push(`## Security notes\n\n${SDK_GUIDE.security}`)
  }
  parts.push(
    "## More\n\nDocs for agents: https://untrace.network/llms.txt\nMCP server docs: https://untrace.network/docs/mcp\nPackages on npm: @untracenetwork/sdk, @untracenetwork/next, @untracenetwork/react, @untracenetwork/vue"
  )
  return parts.join("\n\n")
}
