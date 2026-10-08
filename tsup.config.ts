import { defineConfig } from "tsup"

export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: { entry: "src/index.ts" },
  clean: true,
  sourcemap: false,
  target: "node20",
  platform: "node",
  // Runtime dependencies stay external; the shebang in src/cli.ts is preserved.
  external: [/^@untracenetwork\//, /^@modelcontextprotocol\//, "zod"],
})
