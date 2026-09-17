/**
 * agentic/types.ts
 *
 * Type definitions for the bounded agentic core. Source of truth for
 * what an "action" is, how risk is tiered, what tools exist, and what
 * the Approvals Queue stores.
 *
 * Keep this file pure data (no logic). Risk classification lives in
 * riskClassifier.ts; tool whitelists in toolRegistry.ts; queue ops
 * in approvalQueue.ts.
 *
 * Cross-reference: sprint/agentic-architecture.md §2-§5.
 */

import type { ElectronRole } from "../../types/electron";

export type RiskTier = "low" | "medium" | "high";

/**
 * Every state-mutating or state-reading thing the agent (or assistant)
 * can do is enumerated here. Adding a new action requires:
 *   1. Add the literal to ActionType.
 *   2. Add the rule to RISK_RULES in riskClassifier.ts.
 *   3. Implement the handler in main.ts executeAction() dispatcher.
 * That triple is intentional — surface area is bounded by design.
 */
export type ActionType =
  // LOW
  | "chat_response"
  | "audit_query"
  | "view_policy"
  | "health_check"
  | "runa_create_folder"
  | "runa_write_file"
  | "runa_move_within_vault"
  | "runa_read_file"
  // MEDIUM
  | "recommend_action"
  | "draft_policy"
  | "mark_notification"
  | "runa_delete_within_vault"
  // HIGH
  | "student_hitl_escalation"
  | "wipe_terminal"
  | "lock_cluster"
  | "terminate_session"
  | "quarantine_usb"
  | "force_logout"
  | "enforce_blocklist";

export type AgentRole = ElectronRole;

/** Scope of the action's blast radius. Used by the risk classifier. */
export type ActionScope = "self" | "session" | "lab" | "system";

export interface AgentAction {
  type: ActionType;
  scope: ActionScope;
  reversible: boolean;
  payload: Record<string, unknown>;
  /** 0..1 for AI-driven actions; undefined for deterministic ones. */
  confidence?: number;
  /** Human-readable trace shown in the queue and audit log. */
  reasoning: string;
}

export interface ApprovalDecision {
  decidedAt: number;
  decidedByUserId: string;
  comment?: string;
}

export interface ApprovalComment {
  at: number;
  byUserId: string;
  text: string;
}

export interface ApprovalEvidence {
  scanResult?: unknown;
  aiConfidence?: number;
  sourceAlert?: string;
}

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "info_requested";

export interface ApprovalRequest {
  id: string;
  createdAt: number;
  requesterId: string;
  requesterRole: AgentRole;
  action: AgentAction;
  /** Queue now stores MEDIUM and HIGH for mandatory HITL. */
  riskTier: RiskTier;
  evidence?: ApprovalEvidence;
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  comments?: ApprovalComment[];
}

export interface ToolDefinition {
  id: string;
  label: string;
  riskTier: RiskTier;
  description: string;
  /** Hint embedded in the system prompt to bias the LLM. */
  systemPromptHint: string;
}

export interface AgentContext {
  role: AgentRole;
  userId: string;
  availableTools: ToolDefinition[];
  systemPrompt: string;
}

/**
 * Audit row schema (renderer-side mirror). Keep additive — never
 * remove or rename a field without a migration plan.
 *
 * Cross-reference: sprint/agentic-architecture.md §6.
 */
export interface AuditRow {
  id: number;
  createdAt: number;
  eventType: string;
  actorUserId: string;
  actorRole: "student" | "admin" | "system" | "agent";
  detail: string;

  // HITL fields (optional; populated for agentic events)
  approvalId?: string;
  approverUserId?: string;
  riskTier?: RiskTier;
  confidenceScore?: number;

  // Integrity fields (Phase 2 stub for now)
  prevHash?: string;
  rowHash?: string;
}
