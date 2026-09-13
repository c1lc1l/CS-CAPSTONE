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
import { getElectronApi } from "../ipc/useElectron";

export type ProposeResult =
  | {
      autoExecuted: true;
      tier: RiskTier;
      result: { ok: boolean; message: string };
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
  return (await getElectronApi().agent.propose({
    action,
    requesterId,
    requesterRole,
    evidence,
  })) as ProposeResult;
}

export async function listPending(): Promise<ApprovalRequest[]> {
  const list = await getElectronApi().agent.listPending();
  return list as ApprovalRequest[];
}

export async function listHistory(limit = 50): Promise<ApprovalRequest[]> {
  const list = await getElectronApi().agent.listHistory(limit);
  return list as ApprovalRequest[];
}

export async function approveRequest(
  id: string,
  approverUserId: string,
  comment?: string,
): Promise<{ request: ApprovalRequest; result: { ok: boolean; message: string } }> {
  const res = await getElectronApi().agent.approve({
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
  const req = await getElectronApi().agent.reject({
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
  const req = await getElectronApi().agent.requestInfo({
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
  return await getElectronApi().audit.log(args);
}
