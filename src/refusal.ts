/**
 * A refusal raised by this server before any SDK call (bad input, missing confirm, ...).
 *
 * Its own module, with no imports, so the pure parts (templates, the Generate link tool) run in an
 * edge worker without pulling in the SDK error map or the filesystem sandbox. src/errors.ts
 * re-exports it.
 */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolRefusal"
  }
}
