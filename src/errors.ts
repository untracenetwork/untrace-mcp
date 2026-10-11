/**
 * Map Untrace SDK errors to actionable MCP tool errors. Every message is redacted before it
 * leaves the server.
 */
import {
  UntraceAbortError,
  UntraceAuthError,
  UntraceConflictError,
  UntraceError,
  UntraceIntegrityError,
  UntraceNotFoundError,
  UntracePaymentRequiredError,
  UntracePlannedError,
  UntraceRateLimitError,
  UntraceRoleError,
  UntraceScopeError,
  UntraceServerError,
  UntraceTimeoutError,
  UntraceTooLargeError,
  UntraceUnavailableError,
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

const KEY_HELP =
  "Create a developer key in Untrace Drive under Settings > Developer keys, then set UNTRACE_CLIENT_ID and UNTRACE_CLIENT_SECRET in this server's environment."

export function describeError(err: unknown): ToolErrorInfo {
  const raw = err instanceof Error ? err.message : String(err)
  if (err instanceof ToolRefusal) return { code: "refused", message: raw, retryable: false }
  if (err instanceof PathRefusedError) return { code: "path_refused", message: raw, retryable: false }

  if (err instanceof UntracePlannedError) {
    return {
      code: "planned",
      message: `This Drive does not offer ${err.operationId} yet (folders, key entries and sharing by username are being rolled out). Nothing was changed.`,
      retryable: false,
    }
  }
  if (err instanceof UntraceNotFoundError) {
    return {
      code: "not_found",
      message:
        "Not found (404). Either it does not exist, or this developer key cannot reach it. Untrace never says which. Ask an admin of the file or folder to attach this key (untrace_whoami shows its client id and public key).",
      retryable: false,
    }
  }
  if (err instanceof UntraceConflictError) {
    if (err.code === "owner_immutable") {
      return { code: "owner_immutable", message: "Refused: the owner of a file or folder can never be removed, demoted or changed.", retryable: false }
    }
    if (err.code === "unsupported_format") {
      return { code: "unsupported_format", message: "This file was made in the Drive app with a format the API cannot open. Open it in Untrace Drive instead.", retryable: false }
    }
    if (/sign(ed)? in|sharing key/i.test(raw)) {
      return {
        code: "owner_not_ready",
        message: "Conflict (409): the owner of this developer key has not published a sharing key yet. Ask the owner to sign in to Untrace Drive once, then retry.",
        retryable: false,
      }
    }
    return { code: "conflict", message: `Conflict (409): ${raw}. If you were attaching a key, it is probably attached already: use untrace_change_key.`, retryable: false }
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
      message: "This developer key's role here does not allow this. viewer can download; editor can also add and rename; admin can also manage keys and delete. Ask an admin to change the key's role.",
      retryable: false,
    }
  }
  if (err instanceof UntracePaymentRequiredError) {
    return { code: "payment_required", message: "The owner's plan does not allow this (no active plan, or storage is full). Uploads count against the owner's plan. Ask the owner to check their plan.", retryable: false }
  }
  if (err instanceof UntraceTooLargeError) return { code: "too_large", message: "The file is over the upload size limit (16 MB per upload in this version).", retryable: false }
  if (err instanceof UntraceRateLimitError) {
    const wait = err.retryAfterSeconds != null ? ` Retry after ${err.retryAfterSeconds} seconds.` : " Retry shortly."
    return { code: "rate_limited", message: `Rate limited.${wait}`, retryable: true }
  }
  if (err instanceof UntraceTimeoutError) return { code: "timeout", message: `Untrace did not answer in time. Retry. Detail: ${raw}`, retryable: true }
  if (err instanceof UntraceUnavailableError) return { code: "unavailable", message: `Untrace is temporarily unavailable. Retry with backoff. Detail: ${raw}`, retryable: true }
  if (err instanceof UntraceAbortError) return { code: "aborted", message: "The request was cancelled.", retryable: false }
  if (err instanceof UntraceIntegrityError) return { code: "integrity", message: `A key, a signature or the encrypted content failed a check on this machine, so nothing was trusted. Detail: ${raw}`, retryable: false }
  if (err instanceof UntraceServerError) return { code: "server_error", message: `Untrace returned a server error. Detail: ${raw}`, retryable: false }
  if (err instanceof UntraceError) {
    if (err.code === "invalid_request" && /UNTRACE_CLIENT|client ?secret|clientId/i.test(raw)) {
      return { code: "not_configured", message: `${raw}. ${KEY_HELP}`, retryable: false }
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
  const text = redact(`${info.code}: ${info.message}${info.retryable ? " (retryable)" : ""}`, configuredSecrets())
  return { isError: true as const, content: [{ type: "text" as const, text }] }
}
