/**
 * Map Untrace SDK errors to actionable MCP tool errors. Every message is redacted before it
 * leaves the server.
 */
import {
  UntraceAbortError,
  UntraceAuthError,
  UntraceConflictError,
  UntraceError,
  UntraceFinalizeUnknownError,
  UntraceIntegrityError,
  UntraceNotFoundError,
  UntraceOwnerImmutableError,
  UntracePaymentRequiredError,
  UntraceRateLimitError,
  UntraceRoleError,
  UntraceScopeError,
  UntraceServerError,
  UntraceTimeoutError,
  UntraceUnavailableError,
  UntraceUnsupportedError,
  UntraceUploadError,
} from "@untracenetwork/sdk"

import { PathRefusedError } from "./paths"
import { configuredSecrets, redact } from "./redact"

/** A refusal raised by this server before any SDK call (bad input, missing confirm, ...). */
export class ToolRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ToolRefusal"
  }
}

export interface ToolErrorInfo {
  /** Short machine-readable code. */
  code: string
  /** What happened and what to do next, written for an agent. */
  message: string
  retryable: boolean
}

const KEY_HELP = "Create a developer key in Untrace Drive under Settings > Developer keys, then set UNTRACE_CLIENT_ID and UNTRACE_CLIENT_SECRET in this server's environment."

export function describeError(err: unknown): ToolErrorInfo {
  const raw = err instanceof Error ? err.message : String(err)
  if (err instanceof ToolRefusal) return { code: "refused", message: raw, retryable: false }
  if (err instanceof PathRefusedError) return { code: "path_refused", message: raw, retryable: false }

  if (err instanceof UntraceFinalizeUnknownError) {
    return {
      code: "finalize_unknown",
      message: `The upload of file ${err.fileId} reached its last step but the outcome is unknown. Do NOT upload again (that could create a second, billed copy). Call untrace_get_file with fileId ${err.fileId} in a minute: found means the upload succeeded, not found means it did not.`,
      retryable: false,
    }
  }
  if (err instanceof UntraceUploadError) {
    return {
      code: "upload_incomplete",
      message: `Some encrypted shards could not be stored (nodes ${err.failedNodes.join(", ")}). The upload was not finalized and nothing was billed. Retry the whole upload later. Detail: ${raw}`,
      retryable: true,
    }
  }
  if (err instanceof UntraceNotFoundError) {
    return {
      code: "not_found",
      message: "Not found (404). Either the file does not exist, or this developer key is not a member of it. Untrace never says which. Ask the file owner to open the file's sharing panel in Drive and add this key as a member (admin, editor or viewer).",
      retryable: false,
    }
  }
  if (err instanceof UntraceOwnerImmutableError) {
    return {
      code: "owner_immutable",
      message: "Refused: the owner of a file can never be added, changed or removed. Only developer keys (utc_...) are members.",
      retryable: false,
    }
  }
  if (err instanceof UntraceConflictError) {
    if (/sign(ed)? in|sharing key/i.test(raw)) {
      return {
        code: "owner_not_ready",
        message: "Conflict (409): the owner of this developer key has not signed in to Untrace Drive yet, so new files cannot be sealed to them. Ask the owner to sign in to Drive once, then retry.",
        retryable: false,
      }
    }
    return { code: "conflict", message: `Conflict (409): ${raw}. If you were adding a member, that key is probably already a member: use untrace_set_member_role instead.`, retryable: false }
  }
  if (err instanceof UntraceAuthError) {
    return { code: "auth", message: `The developer key was rejected (unknown, revoked or wrong secret). ${KEY_HELP}`, retryable: false }
  }
  if (err instanceof UntraceScopeError) {
    const need = err.required ? `"${err.required}"` : "the needed"
    return {
      code: "insufficient_scope",
      message: `This developer key does not have the ${need} scope. Scopes are download, upload, manage-sharing and delete. Create a key with the right scopes in Drive under Settings > Developer keys.`,
      retryable: false,
    }
  }
  if (err instanceof UntraceRoleError) {
    return {
      code: "insufficient_role",
      message: "This developer key's role on that file does not allow this. viewer can download; editor can also rename; admin can also manage members and delete. Ask the owner or an admin to change the key's role.",
      retryable: false,
    }
  }
  if (err instanceof UntracePaymentRequiredError) {
    return { code: "payment_required", message: "The owner's plan or storage quota blocks this upload. Uploads count against the owner's plan. Ask the owner to free space or upgrade.", retryable: false }
  }
  if (err instanceof UntraceRateLimitError) {
    const wait = err.retryAfterSeconds != null ? ` Retry after ${err.retryAfterSeconds} seconds.` : " Retry shortly."
    return { code: "rate_limited", message: `Rate limited (600 requests per minute per key).${wait}`, retryable: true }
  }
  if (err instanceof UntraceTimeoutError) return { code: "timeout", message: `Untrace did not answer in time. Retry. Detail: ${raw}`, retryable: true }
  if (err instanceof UntraceUnavailableError) return { code: "unavailable", message: `Untrace is temporarily unavailable. Retry with backoff. Detail: ${raw}`, retryable: true }
  if (err instanceof UntraceAbortError) return { code: "aborted", message: "The request was cancelled.", retryable: false }
  if (err instanceof UntraceIntegrityError) return { code: "integrity", message: `A key, signature or shard failed a local check, so nothing was trusted. Detail: ${raw}`, retryable: false }
  if (err instanceof UntraceUnsupportedError) return { code: "unsupported", message: `Not supported: ${raw}`, retryable: false }
  if (err instanceof UntraceServerError) return { code: "server_error", message: `Untrace returned a server error. Detail: ${raw}`, retryable: false }
  if (err instanceof UntraceError) {
    if (err.code === "invalid_request" && /UNTRACE_CLIENT|client secret/i.test(raw)) {
      return { code: "not_configured", message: `${raw.replace(/ or pass client(Id|Secret)/, "")}. ${KEY_HELP}`, retryable: false }
    }
    return { code: String(err.code || "error"), message: raw, retryable: err.retryable }
  }
  const fsCode = (err as NodeJS.ErrnoException | undefined)?.code
  if (fsCode === "ENOENT") return { code: "file_missing", message: `No such local file or folder: ${raw}`, retryable: false }
  if (fsCode === "EEXIST") return { code: "exists", message: "The target file already exists. Pass overwrite: true to replace it.", retryable: false }
  if (fsCode === "EACCES" || fsCode === "EPERM") return { code: "fs_permission", message: `Permission denied on the local filesystem: ${raw}`, retryable: false }
  return { code: "error", message: raw, retryable: false }
}

/** An MCP tool error result, redacted. */
export function toolError(err: unknown) {
  const info = describeError(err)
  const secrets = configuredSecrets()
  const text = redact(`${info.code}: ${info.message}${info.retryable ? " (retryable)" : ""}`, secrets)
  return { isError: true as const, content: [{ type: "text" as const, text }] }
}
