/**
 * electron.d.ts
 *
 * Adds `window.electronAPI` typings so the renderer gets IntelliSense.
 */

export type ElectronRole = "student" | "admin";

export type ElectronActorRole = ElectronRole | "system" | "agent";

export type ElectronRiskTier = "low" | "medium" | "high";

/** User-added launcher (.exe / .lnk); list starts empty until students or IT add entries. */
export interface ElectronLabShortcut {
  id: string;
  label: string;
  targetPath: string;
}

export type ElectronActionScope = "self" | "session" | "lab" | "system";

export type ElectronActionType =
  | "chat_response"
  | "audit_query"
  | "view_policy"
  | "health_check"
  | "recommend_action"
  | "draft_policy"
  | "mark_notification"
  | "runa_delete_within_vault"
  | "runa_create_folder"
  | "runa_write_file"
  | "runa_move_within_vault"
  | "runa_read_file"
  | "student_hitl_escalation"
  | "wipe_terminal"
  | "lock_cluster"
  | "terminate_session"
  | "quarantine_usb"
  | "force_logout"
  | "enforce_blocklist";

export interface ElectronAgentAction {
  type: ElectronActionType;
  scope: ElectronActionScope;
  reversible: boolean;
  payload: Record<string, unknown>;
  confidence?: number;
  reasoning: string;
}

export interface ElectronApprovalEvidence {
  scanResult?: unknown;
  aiConfidence?: number;
  sourceAlert?: string;
}

export type ElectronApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "info_requested";

export interface ElectronApprovalDecision {
  decidedAt: number;
  decidedByUserId: string;
  comment?: string;
}

export interface ElectronApprovalComment {
  at: number;
  byUserId: string;
  text: string;
}

export interface ElectronApprovalRequest {
  id: string;
  createdAt: number;
  requesterId: string;
  requesterRole: ElectronRole;
  action: ElectronAgentAction;
  riskTier: ElectronRiskTier;
  evidence?: ElectronApprovalEvidence;
  status: ElectronApprovalStatus;
  decision?: ElectronApprovalDecision;
  comments?: ElectronApprovalComment[];
}

export interface ElectronAuditRow {
  id: number;
  createdAt: number;
  eventType: string;
  eventDescription?: string;
  threatLevel?: ElectronRiskTier;
  actorUserId: string;
  actorRole: ElectronActorRole;
  detail: string;
  approvalId?: string;
  approverUserId?: string;
  riskTier?: ElectronRiskTier;
  confidenceScore?: number;
}

/** Row from `lab_attendance_sessions` (Lambda returns camelCase). */
export interface ElectronAttendanceSessionRow {
  id: string | number;
  studentEmail?: string;
  comlabId?: string;
  comlabLabel?: string;
  workstationLabel?: string;
  professorName?: string;
  timeIn?: string;
  timeOut?: string | null;
  lastSeenAt?: string | null;
}

export type ElectronProposeResult =
  | {
      autoExecuted: true;
      tier: ElectronRiskTier;
      result: { ok: boolean; message: string };
    }
  | {
      autoExecuted: false;
      tier: "medium" | "high";
      request: ElectronApprovalRequest;
    };

interface ElectronSession {
  userId: string;
  role: ElectronRole;
  token: string;
  persistent: boolean;
  expiresAt: number;
}

export interface ElectronSettings {
  kioskMode: boolean;
  theme: "dark" | "light";
  notifications: boolean;
}

export interface PythonResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

interface ElectronAPI {
  session: {
    get(): Promise<ElectronSession | null>;
    set(payload: ElectronSession): Promise<boolean>;
    clear(): Promise<boolean>;
  };
  settings: {
    get(): Promise<ElectronSettings>;
    set(partial: Partial<ElectronSettings>): Promise<ElectronSettings>;
  };
  window: {
    minimize(): void;
    maximize(): void;
    close(): void;
  };
  python: {
    call<T = unknown>(
      endpoint: string,
      payload?: unknown,
      options?: { method?: "GET" | "POST"; timeoutMs?: number },
    ): Promise<PythonResult<T>>;
  };
  dialog: {
    openFile(filters?: { name: string; extensions: string[] }[]): Promise<string | null>;
  };
  lab: {
    getShortcuts(): Promise<ElectronLabShortcut[]>;
    addShortcut(payload: {
      label: string;
      targetPath: string;
    }): Promise<
      | { ok: true; shortcuts: ElectronLabShortcut[]; item: ElectronLabShortcut }
      | { ok: false; shortcuts: ElectronLabShortcut[]; error: string }
    >;
    updateShortcut(payload: {
      id: string;
      label: string;
      targetPath: string;
    }): Promise<
      | { ok: true; shortcuts: ElectronLabShortcut[]; item: ElectronLabShortcut }
      | { ok: false; shortcuts: ElectronLabShortcut[]; error: string }
    >;
    removeShortcut(id: string): Promise<
      | { ok: true; shortcuts: ElectronLabShortcut[] }
      | { ok: false; shortcuts: ElectronLabShortcut[]; error: string }
    >;
    launch(id: string): Promise<{ ok: boolean; error?: string }>;
  };
  runaFiles: {
    getVaultRoot(): Promise<{ ok: boolean; path: string | null; error?: string }>;
    getSessionWorkspaceRelative(): Promise<{
      ok: boolean;
      relative: string | null;
      error?: string;
    }>;
    createFolder(relativePath: string): Promise<{ ok: boolean; error?: string; absolute?: string }>;
    writeTextFile(
      relativePath: string,
      content: string,
    ): Promise<{ ok: boolean; error?: string; absolute?: string }>;
    readTextFile(
      relativePath: string,
    ): Promise<{ ok: boolean; error?: string; content?: string; byteLength?: number; absolute?: string }>;
    listDir(relativePath: string): Promise<{ ok: boolean; entries: string[]; error?: string }>;
  };
  telemetry: {
    record(event: string, meta?: Record<string, unknown>): Promise<boolean>;
  };
  tray: {
    notify(title: string, body: string): void;
  };
  app: {
    version(): Promise<string>;
    platform(): Promise<string>;
  };
  audit: {
    log(args: {
      eventType: string;
      detail: string;
      actorUserId: string;
      actorRole: ElectronActorRole;
      approvalId?: string;
      approverUserId?: string;
      riskTier?: ElectronRiskTier;
      confidenceScore?: number;
    }): Promise<boolean>;
    list(limit?: number): Promise<ElectronAuditRow[]>;
  };
  labStation: {
    get(): Promise<{ comlabId: string; workstationLabel: string }>;
    set(payload: { comlabId: string; workstationLabel: string }): Promise<{
      comlabId: string;
      workstationLabel: string;
    }>;
  };
  attendance: {
    checkIn(payload: {
      studentEmail: string;
      comlabId: string;
      comlabLabel: string;
      workstationLabel: string;
      professorName: string;
    }): Promise<boolean>;
    checkOut(payload: { studentEmail: string; comlabId: string }): Promise<boolean>;
    list(comlabId: string, limit?: number): Promise<ElectronAttendanceSessionRow[]>;
  };
  agent: {
    propose(args: {
      action: ElectronAgentAction;
      requesterId: string;
      requesterRole: ElectronRole;
      evidence?: ElectronApprovalEvidence;
    }): Promise<ElectronProposeResult>;
    listPending(): Promise<ElectronApprovalRequest[]>;
    listHistory(limit?: number): Promise<ElectronApprovalRequest[]>;
    approve(args: {
      id: string;
      approverUserId: string;
      comment?: string;
    }): Promise<{ request: ElectronApprovalRequest; result: { ok: boolean; message: string } }>;
    reject(args: {
      id: string;
      approverUserId: string;
      comment?: string;
    }): Promise<ElectronApprovalRequest>;
    requestInfo(args: {
      id: string;
      byUserId: string;
      text: string;
    }): Promise<ElectronApprovalRequest>;
  };
  security: {
    listBlockedDomains(): Promise<string[]>;
    checkUrl(url: string): Promise<{
      ok: boolean;
      blocked: boolean;
      domain: string;
      reason: "policy_blocked" | "allowed" | "invalid_url";
    }>;
  };
  on(channel: string, listener: (...args: unknown[]) => void): void;
  off(channel: string, listener: (...args: unknown[]) => void): void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export {};
