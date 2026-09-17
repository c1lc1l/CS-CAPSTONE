/**
 * agentic/approvalQueue.ts
 *
 * Renderer-side wrapper around the agent IPC namespace. Re-exports as
 * a more ergonomic API and handles type narrowing so callers can
 * pattern-match on `autoExecuted` without casting.
 *
 * The queue itself lives in main.ts (electron-store backed). This file
 * is the renderer's only entry point — components MUST NOT touch
 * window.electronAPI.agent.* directly. Goes through here.
 */

import type { AgentAction, ApprovalRequest, RiskTier } from "./types";
import type { ElectronRole, ElectronActorRole } from "../../types/electron";

const electronAPI = (typeof window !== "undefined" ? window.electronAPI : undefined);

if (!electronAPI) {
  // Renderer is rendering outside Electron (browser dev mode). The
  // useElectron hook supplies stubs; we accept undefined here and
  // let calls fail loudly so misuse is obvious during dev.
}

export type ProposeResult =
  | {
      autoExecuted: true;
      tier: RiskTier;
      result: { ok: boolean; message: string; evidence?: Record<string, unknown> };
    }
  | {
      autoExecuted: false;
      tier: "medium" | "high";
      request: ApprovalRequest;
    };

export async function proposeAction(
  action: AgentAction,
  requesterId: string,
  requesterRole: ElectronRole,
  evidence?: ApprovalRequest["evidence"],
): Promise<ProposeResult> {
  const res = (await window.electronAPI.agent.propose({
    action,
    requesterId,
    requesterRole,
    evidence,
  })) as ProposeResult;

  if (!res.autoExecuted) {
    try {
      window.electronAPI.tray.notify(
        `Approval needed (${res.tier.toUpperCase()})`,
        `${action.type} requested by ${requesterId} — review in Approvals Queue.`,
      );
    } catch {
      /* tray is best-effort; never block the proposal on it */
    }
  }

  return res;
}

export async function listPending(): Promise<ApprovalRequest[]> {
  const list = await window.electronAPI.agent.listPending();
  return list as ApprovalRequest[];
}

export async function listHistory(limit = 50): Promise<ApprovalRequest[]> {
  const list = await window.electronAPI.agent.listHistory(limit);
  return list as ApprovalRequest[];
}

export async function approveRequest(
  id: string,
  approverUserId: string,
  comment?: string,
): Promise<{ request: ApprovalRequest; result: { ok: boolean; message: string } }> {
  const res = await window.electronAPI.agent.approve({
    id,
    approverUserId,
    comment,
  });
  return res as {
    request: ApprovalRequest;
    result: { ok: boolean; message: string };
  };
}

export async function rejectRequest(
  id: string,
  approverUserId: string,
  comment?: string,
): Promise<ApprovalRequest> {
  const req = await window.electronAPI.agent.reject({
    id,
    approverUserId,
    comment,
  });
  return req as ApprovalRequest;
}

export async function requestInfo(
  id: string,
  byUserId: string,
  text: string,
): Promise<ApprovalRequest> {
  const req = await window.electronAPI.agent.requestInfo({
    id,
    byUserId,
    text,
  });
  return req as ApprovalRequest;
}

/**
 * Convenience: write an audit row from the renderer. The main side is
 * the source of truth; this is just the easiest way to trace renderer
 * events (chat_request, chat_response, request_refused, ...).
 */
export async function logAudit(args: {
  eventType: string;
  detail: string;
  actorUserId: string;
  actorRole: ElectronActorRole;
  approvalId?: string;
  approverUserId?: string;
  riskTier?: RiskTier;
  confidenceScore?: number;
  eventDescription?: string;
  threatLevel?: RiskTier;
}) {
  return await window.electronAPI.audit.log(args);
}
