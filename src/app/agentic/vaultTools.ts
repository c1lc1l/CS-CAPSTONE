/**
 * agentic/vaultTools.ts
 *
 * Provider function-calling schemas for the Runa_Folder vault operations,
 * plus the mapping from a model-selected tool back into a governed
 * AgentAction.
 *
 * The model may only SELECT one of these tools. It never executes them:
 * the selection is converted to an AgentAction and routed through
 * proposeAction() → classifyAction() → HITL queue or bounded execution,
 * exactly like a hand-typed request. High-risk containment actions
 * (lock_cluster, wipe_terminal, terminate_session, force_logout) are
 * deliberately absent from this list and remain unreachable by inference.
 */

import type { ActionType } from "./types";

export interface VaultToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

/** Sentinel for the read-only listing, which has no governed ActionType. */
export const VAULT_LIST_TOOL = "runa_list_files";

export const VAULT_TOOL_SPECS = [
  {
    type: "function",
    function: {
      name: "runa_create_folder",
      description:
        "Create a folder inside the student's Runa_Folder vault. Use when the student asks to make, create, or set up a folder or directory.",
      parameters: {
        type: "object",
        properties: {
          relativePath: {
            type: "string",
            description:
              "Folder path relative to the vault root, e.g. 'LabWork' or 'LabWork/week3'. Never an absolute path.",
          },
        },
        required: ["relativePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "runa_write_file",
      description:
        "Create or overwrite a UTF-8 text file inside the Runa_Folder vault. Use when the student asks to save, write, or put text into a file.",
      parameters: {
        type: "object",
        properties: {
          relativePath: {
            type: "string",
            description: "File path relative to the vault root, e.g. 'notes.txt' or 'LabWork/notes.md'.",
          },
          content: { type: "string", description: "Full text content to write into the file." },
        },
        required: ["relativePath", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "runa_read_file",
      description:
        "Read a UTF-8 text file from the Runa_Folder vault and return its contents. Use when the student asks to open, read, or show a file.",
      parameters: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "File path relative to the vault root." },
        },
        required: ["relativePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "runa_move_within_vault",
      description:
        "Move or rename a file within the Runa_Folder vault. Use when the student asks to move, rename, or reorganize a file.",
      parameters: {
        type: "object",
        properties: {
          fromRelative: { type: "string", description: "Current file path relative to the vault root." },
          toRelative: { type: "string", description: "Destination path relative to the vault root." },
        },
        required: ["fromRelative", "toRelative"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "runa_delete_within_vault",
      description:
        "Delete a single file from the Runa_Folder vault. This is a MEDIUM-risk action and will be queued for lab staff approval rather than performed immediately.",
      parameters: {
        type: "object",
        properties: {
          relativePath: { type: "string", description: "File path relative to the vault root." },
        },
        required: ["relativePath"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: VAULT_LIST_TOOL,
      description:
        "List the contents of the Runa_Folder vault root. Use when the student asks what files they have.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
] as const;

const TOOL_TO_ACTION: Readonly<Record<string, ActionType>> = {
  runa_create_folder: "runa_create_folder",
  runa_write_file: "runa_write_file",
  runa_read_file: "runa_read_file",
  runa_move_within_vault: "runa_move_within_vault",
  runa_delete_within_vault: "runa_delete_within_vault",
};

function asPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 200 ? trimmed : null;
}

export interface ResolvedVaultTool {
  actionType: ActionType;
  payload: Record<string, unknown>;
  summary: string;
}

/**
 * Validate a model-selected tool call and convert it to action inputs.
 * Returns null for unknown tools or malformed arguments, so a bad
 * selection degrades to a normal chat reply instead of a broken action.
 */
export function resolveVaultToolCall(call: VaultToolCall): ResolvedVaultTool | null {
  const actionType = TOOL_TO_ACTION[call.name];
  if (!actionType) return null;
  const args = call.arguments ?? {};

  if (actionType === "runa_move_within_vault") {
    const fromRelative = asPath(args.fromRelative);
    const toRelative = asPath(args.toRelative);
    if (!fromRelative || !toRelative) return null;
    return {
      actionType,
      payload: { fromRelative, toRelative },
      summary: `Moving "${fromRelative}" to "${toRelative}" under Runa_Folder.`,
    };
  }

  const relativePath = asPath(args.relativePath);
  if (!relativePath) return null;

  if (actionType === "runa_write_file") {
    const content = typeof args.content === "string" ? args.content : "";
    return {
      actionType,
      payload: { relativePath, content },
      summary: `Writing "${relativePath}" under Runa_Folder.`,
    };
  }

  const verb =
    actionType === "runa_create_folder"
      ? "Creating folder"
      : actionType === "runa_read_file"
        ? "Reading"
        : "Deleting";
  return {
    actionType,
    payload: { relativePath },
    summary:
      actionType === "runa_delete_within_vault"
        ? `Deleting "${relativePath}" is a MEDIUM-risk action — queued for lab staff review before it happens.`
        : `${verb} "${relativePath}" under Runa_Folder.`,
  };
}
