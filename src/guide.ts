/**
 * untrace_setup_guide: step-by-step instructions for wiring the Untrace Drive SDK into an app.
 * The content comes from the @untracenetwork/sdk README, embedded at build time
 * (scripts/embed-guide.mjs), so it works offline and matches SDK 1.0.0.
 */
import { SDK_GUIDE } from "./generated/guide"

export const FRAMEWORKS = ["nextjs", "node", "react", "vue"] as const
export type Framework = (typeof FRAMEWORKS)[number]

const INSTALL: Record<Framework, string> = {
  nextjs: "npm install @untracenetwork/next @untracenetwork/react",
  node: "npm install @untracenetwork/sdk @untracenetwork/node",
  react: "npm install @untracenetwork/react   # plus a backend route: @untracenetwork/next, @untracenetwork/node or @untracenetwork/sdk/backend",
  vue: "npm install @untracenetwork/vue   # plus a backend route: @untracenetwork/node or @untracenetwork/sdk/backend",
}

const FRAMEWORK_SECTIONS: Record<Framework, readonly (keyof typeof SDK_GUIDE)[]> = {
  nextjs: ["next"],
  node: ["node"],
  react: ["next", "browser"],
  vue: ["node", "browser"],
}

const TITLES: Record<Framework, string> = { nextjs: "Next.js", node: "Node.js", react: "React", vue: "Vue" }

export function setupGuide(framework: Framework, includeReference = true): string {
  const parts: string[] = []
  parts.push(`# Set up the Untrace Drive SDK in a ${TITLES[framework]} app`)
  parts.push(
    [
      "Golden rule: data access is self-custodial and granted per file. A developer key is a member of a FILE (admin, editor or viewer), never a user. The owner of a file can never be removed.",
      "Files are encrypted before they leave your server and stored as 6 encrypted shards. Any 3 rebuild the file.",
      "",
      "Steps:",
      "1. Create a developer key in Untrace Drive: Settings > Developer keys. Pick its scopes (download, upload, manage-sharing, delete). Copy the client id (utc_...) and the client secret (untrace_sk_v1_..., shown once).",
      "2. Put them in the app's SERVER environment only: UNTRACE_CLIENT_ID and UNTRACE_CLIENT_SECRET. Never in browser code, never NEXT_PUBLIC_.",
      "3. Add the key as a member of each file it should reach (the file's sharing panel in Drive). Files the key uploads itself are added for you.",
      "4. The owner signs in to Drive once before the key uploads.",
      `5. Install: \`${INSTALL[framework]}\``,
      "6. Wire it up as shown below.",
    ].join("\n")
  )
  parts.push(`## Create a key in Drive\n\n${SDK_GUIDE.createKey}`)
  for (const key of FRAMEWORK_SECTIONS[framework]) {
    const heading = key === "next" ? "Next.js quick start" : key === "node" ? "Node.js" : "React and Vue"
    parts.push(`## ${heading}\n\n${SDK_GUIDE[key]}`)
  }
  if (includeReference) {
    parts.push(`## Scopes and roles\n\n${SDK_GUIDE.scopes}`)
    parts.push(`## Metering\n\n${SDK_GUIDE.metering}`)
    parts.push(`## Errors\n\n${SDK_GUIDE.errors}`)
  }
  parts.push(
    "## More\n\nFull docs for agents: https://untrace.network/llms.txt\nMCP server docs: https://untrace.network/docs/mcp\nPackages on npm: @untracenetwork/sdk, @untracenetwork/next, @untracenetwork/node, @untracenetwork/react, @untracenetwork/vue"
  )
  return parts.join("\n\n")
}
