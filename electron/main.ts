import {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  shell,
  dialog,
} from "electron";
import path from "path";
import { spawn, execFileSync, ChildProcess } from "child_process";
import { randomUUID, createHash } from "crypto";
const Store = require("electron-store");
import fsSync from "fs";
import {
  ensureVaultExists,
  resolveUnderVault,
  sessionRelativeFolder,
  MAX_TEXT_FILE_BYTES,
} from "./runaFiles";
import { createStudentRuntimeEnforcement } from "./enforcement/studentRuntimeEnforcement";
import { sealRow, verifyAuditChain } from "./auditChain";

function loadRootEnvFile(): void {
  const candidates = [
    // Portable-mode first: .env beside the running executable
    path.join(path.dirname(process.execPath), ".env"),
    // Packaged resources fallback
    path.join(process.resourcesPath, ".env"),
    // Dev-mode and workspace fallbacks
    path.join(process.cwd(), ".env"),
    path.join(app.getAppPath(), ".env"),
    path.join(path.dirname(app.getAppPath()), ".env"),
  ];
  const envPath = candidates.find((p) => fsSync.existsSync(p));
  if (!envPath) return;
  try {
    const raw = fsSync.readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx <= 0) continue;
      const key = trimmed.slice(0, idx).trim();
      const value = trimmed.slice(idx + 1).trim().replace(/^"(.*)"$/, "$1");
      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
    console.log(`[main] Loaded environment variables from ${envPath}`);
  } catch (e) {
    console.warn("[main] Failed loading root .env:", e);
  }
}

loadRootEnvFile();

// ─────────────────────────────────────────────
//  Types (mirror src/app/agentic/types.ts — main stays self-contained)
// ─────────────────────────────────────────────
type RiskTier = "low" | "medium" | "high";
type Role = "student" | "admin";
type ActorRole = "student" | "admin" | "system" | "agent";

type ActionType =
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

interface AgentAction {
  type: ActionType;
  scope: "self" | "session" | "lab" | "system";
  reversible: boolean;
  payload: Record<string, unknown>;
  confidence?: number;
  reasoning: string;
}

type ApprovalStatus = "pending" | "approved" | "rejected" | "info_requested";

/**
 * Where an approved action runs. Approval happens on the admin's machine, but
 * containment and student vault actions must take effect on the student's
 * machine, so they are handed off through the shared approvals queue.
 */
type DispatchTarget =
  | { kind: "user"; userId: string }
  | { kind: "lab"; comlabId: string };

interface DispatchExecution {
  userId: string;
  workstation: string;
  at: number;
  ok: boolean;
  message: string;
}

interface ApprovalDispatch {
  target: DispatchTarget;
  dispatchedAt: number;
  executions?: DispatchExecution[];
}

interface ApprovalDecision {
  decidedAt: number;
  decidedByUserId: string;
  comment?: string;
  dispatch?: ApprovalDispatch;
}

interface ApprovalComment {
  at: number;
  byUserId: string;
  text: string;
}

interface ApprovalEvidence {
  scanResult?: unknown;
  aiConfidence?: number;
  sourceAlert?: string;
}

interface ApprovalRequest {
  id: string;
  createdAt: number;
  requesterId: string;
  requesterRole: Role;
  action: AgentAction;
  riskTier: RiskTier;
  evidence?: ApprovalEvidence;
  status: ApprovalStatus;
  decision?: ApprovalDecision;
  comments?: ApprovalComment[];
}

type ExecutionStatus = "executed" | "rejected" | "hard_failed" | "simulated" | "dispatched";

interface ActionExecutionResult {
  ok: boolean;
  status: ExecutionStatus;
  message: string;
  evidence?: Record<string, unknown>;
}

interface AuditRow {
  id: number;
  createdAt: number;
  eventType: string;
  /** Short human-readable line for operators (mirrors DB `event_description`). */
  eventDescription?: string;
  /** Canonical threat level for this row (mirrors DB `threat_level`). */
  threatLevel?: RiskTier;
  actorUserId: string;
  actorRole: ActorRole;
  detail: string;
  approvalId?: string;
  approverUserId?: string;
  riskTier?: RiskTier;
  confidenceScore?: number;
  /** SHA-256 of the preceding row's rowHash. GENESIS_HASH for the first row. */
  prevHash?: string;
  /** SHA-256 over this row's canonical content plus prevHash. */
  rowHash?: string;
}

/** User-added OS shortcuts (.exe / .lnk); not pre-seeded by app defaults. */
interface LabShortcutRow {
  id: string;
  label: string;
  targetPath: string;
}

interface LabStationProfile {
  comlabId: string;
  workstationLabel: string;
}

interface StoreSchema {
  session: {
    userId: string;
    role: Role;
    token: string;
    persistent: boolean;
    expiresAt: number;
  } | null;
  /** This machine's comlab + PC label (student attendance / institutional reporting). */
  labStationProfile: LabStationProfile;
  settings: {
    kioskMode: boolean;
    theme: "dark" | "light";
    notifications: boolean;
  };
  /** Dynamic list of lab / IDE shortcuts (add via UI). */
  labShortcuts: LabShortcutRow[];
  auditLog: AuditRow[];
  approvalsQueue: ApprovalRequest[];
  blockedDomains: string[];
  quarantinedUsbEvents: Array<{
    at: number;
    device: string;
    reason: string;
    approvalId?: string;
  }>;
  /** Offline-first attendance cache. `synced` is local bookkeeping, stripped before returning to renderer. */
  attendanceSessions: AttendanceSessionRow[];
  /** Approval ids this machine has already executed from the shared queue, so none runs twice. */
  executedDispatchIds: string[];
}

interface AttendanceSessionRow {
  id: string;
  studentEmail: string;
  comlabId: string;
  comlabLabel: string;
  workstationLabel: string;
  professorName: string;
  timeIn: string;
  timeOut: string | null;
  lastSeenAt: string | null;
  synced: boolean;
}

// ─────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────
const IS_DEV = process.env.NODE_ENV === "development";
const PYTHON_PORT = 5001;
const VITE_DEV_SERVER_URL = "http://localhost:5173";
/** Prefer loopback IPv4 — avoids Windows resolving `localhost` to ::1 while Flask binds 127.0.0.1. */
const PYTHON_BASE_URL = `http://127.0.0.1:${PYTHON_PORT}`;

// Optional brand icon. If the asset is missing we silently fall back
// to Electron's default icon and skip the system tray (acceptable per
// sprint/decision-tree.md §8 — tray is a Day-1 nice-to-have).
// __dirname after compile is dist-electron/electron/, so we walk up
// two levels to reach the repo root before descending into src/.
const ICON_PATH = path.join(__dirname, "..", "..", "src", "imports", "image.png");
const HAS_ICON = fsSync.existsSync(ICON_PATH);

// ─────────────────────────────────────────────
//  Persistent store (electron-store)
// ─────────────────────────────────────────────
const store = new Store({
  defaults: {
    session: null,
    labStationProfile: { comlabId: "08", workstationLabel: "PC-01" } satisfies LabStationProfile,
    settings: {
      kioskMode: false,
      theme: "dark",
      notifications: true,
    },
    labShortcuts: [] as LabShortcutRow[],
    auditLog: [] as AuditRow[],
    approvalsQueue: [] as ApprovalRequest[],
    blockedDomains: [] as string[],
    quarantinedUsbEvents: [] as Array<{
      at: number;
      device: string;
      reason: string;
      approvalId?: string;
    }>,
    attendanceSessions: [] as AttendanceSessionRow[],
    executedDispatchIds: [] as string[],
  },
});

function normalizeDomain(input: string): string {
  const raw = String(input || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
    return new URL(withScheme).hostname.replace(/^www\./, "");
  } catch {
    return raw.replace(/^www\./, "").split("/")[0];
  }
}

function readLabShortcuts(): LabShortcutRow[] {
  const raw = store.get("labShortcuts") as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (r): r is LabShortcutRow =>
      Boolean(r) &&
      typeof (r as LabShortcutRow).id === "string" &&
      typeof (r as LabShortcutRow).label === "string" &&
      typeof (r as LabShortcutRow).targetPath === "string",
  );
}

/** One-time migration from legacy `labAppShortcuts` record → `labShortcuts` list. */
function migrateLabShortcuts(): void {
  let rows = readLabShortcuts();
  const bag = store.store as Record<string, unknown>;
  const legacy = bag.labAppShortcuts as Record<string, string> | undefined;
  if (
    rows.length === 0 &&
    legacy &&
    typeof legacy === "object" &&
    Object.keys(legacy).length > 0
  ) {
    const labels: Record<string, string> = {
      vscode: "VS Code",
      intellij: "IntelliJ IDEA",
      netbeans: "NetBeans",
      blender: "Blender",
      inkscape: "Inkscape",
      chrome: "Google Chrome",
      terminal: "Terminal",
      explorer: "File Explorer",
    };
    rows = Object.entries(legacy).map(([key, targetPath]) => ({
      id: randomUUID(),
      label: labels[key] ?? key,
      targetPath: String(targetPath).trim(),
    }));
    store.set("labShortcuts", rows);
  }
  if (!Array.isArray(store.get("labShortcuts"))) {
    store.set("labShortcuts", rows);
  }
  if ("labAppShortcuts" in bag) {
    (store as unknown as { delete: (key: string) => void }).delete("labAppShortcuts");
  }
}

/** Rolling in-app audit row cap. Export / archive for thesis retention policy as needed. */
const AUDIT_LIMIT = 500;
const QUEUE_LIMIT = 100;
const CONFIDENCE_THRESHOLD = 0.7;
const CLOUD_ENDPOINTS = {
  // Demo cloud migration: set your deployed Lambda Function URLs here.
  approvals: "https://xvmsr6zgkb7p44xjv6frcktxoi0yunah.lambda-url.ap-southeast-1.on.aws/",
  audit: "https://zypg5u4vstffgujnvbp4yxtaly0hoill.lambda-url.ap-southeast-1.on.aws/",
  policy: "https://ayjccryrs24b7ckhiol3b7mrlm0xobcp.lambda-url.ap-southeast-1.on.aws/",
} as const;

const CLOUD_TIMEOUT_MS = 15_000;

const COMLAB_STATION_IDS = ["08", "09", "10", "11", "12"] as const;

async function cloudCall<T>(
  url: string,
  body: Record<string, unknown>,
  method: "POST" | "GET" = "POST",
): Promise<T> {
  if (!url || url.includes("REPLACE_")) {
    throw new Error("Cloud endpoint URL is not configured in electron/main.ts.");
  }
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), CLOUD_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method,
      headers: { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let parsed: unknown = {};
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error(`Cloud endpoint returned non-JSON response (${res.status}).`);
      }
    }
    if (!res.ok) {
      const msg = typeof parsed === "object" && parsed && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return parsed as T;
  } finally {
    clearTimeout(t);
  }
}

async function attendanceCheckOutCloud(studentEmail: string, comlabId: string): Promise<void> {
  const data = await cloudCall<{ ok?: boolean; error?: string }>(CLOUD_ENDPOINTS.audit, {
    op: "attendance_check_out",
    studentEmail,
    comlabId,
  });
  if (data && "ok" in data && data.ok === false) {
    throw new Error(data.error ?? "attendance_check_out failed");
  }
}

async function attendanceListCloud(comlabId: string, limit: number): Promise<unknown[]> {
  const data = await cloudCall<{ ok?: boolean; rows?: unknown[] }>(CLOUD_ENDPOINTS.audit, {
    op: "attendance_list",
    comlabId,
    limit,
  });
  return Array.isArray(data.rows) ? data.rows : [];
}

const ATTENDANCE_LIMIT = 500;

function getLocalAttendance(): AttendanceSessionRow[] {
  const v = store.get("attendanceSessions") as AttendanceSessionRow[] | undefined;
  return Array.isArray(v) ? v : [];
}

function setLocalAttendance(rows: AttendanceSessionRow[]): void {
  store.set("attendanceSessions", rows.slice(-ATTENDANCE_LIMIT));
}

function attendanceDedupeKey(row: { studentEmail?: string; comlabId?: string; timeIn?: string | null }): string {
  return `${row.studentEmail ?? ""}\0${row.comlabId ?? ""}\0${row.timeIn ?? ""}`;
}

/** Closes the most recent open local session for a student in a lab, if any. Returns its id. */
function closeLocalOpenAttendanceSession(studentEmail: string, comlabId: string): string | null {
  const nowIso = new Date().toISOString();
  const rows = getLocalAttendance();
  let matchedId: string | null = null;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].studentEmail === studentEmail && rows[i].comlabId === comlabId && !rows[i].timeOut) {
      matchedId = rows[i].id;
      break;
    }
  }
  if (matchedId) {
    setLocalAttendance(
      getLocalAttendance().map((r) =>
        r.id === matchedId ? { ...r, timeOut: nowIso, lastSeenAt: nowIso, synced: false } : r,
      ),
    );
  }
  return matchedId;
}

/**
 * Best-effort push of session records recorded while offline. Stops at the
 * first failure in a pass (cloud is likely still down) rather than retrying
 * every row — the next opportunistic call picks up where this left off.
 */
async function flushPendingAttendance(): Promise<void> {
  const pending = getLocalAttendance()
    .filter((r) => !r.synced)
    .sort((a, b) => a.timeIn.localeCompare(b.timeIn));
  for (const row of pending) {
    try {
      await cloudCall(CLOUD_ENDPOINTS.audit, {
        op: "attendance_check_in",
        studentEmail: row.studentEmail,
        comlabId: row.comlabId,
        comlabLabel: row.comlabLabel,
        workstationLabel: row.workstationLabel,
        professorName: row.professorName,
        timeIn: row.timeIn,
      });
      if (row.timeOut) {
        await cloudCall(CLOUD_ENDPOINTS.audit, {
          op: "attendance_check_out",
          studentEmail: row.studentEmail,
          comlabId: row.comlabId,
        });
      }
      setLocalAttendance(getLocalAttendance().map((r) => (r.id === row.id ? { ...r, synced: true } : r)));
    } catch (e) {
      console.warn("[main] flushPendingAttendance: still offline, will retry later:", e);
      break;
    }
  }
}

function getLabStationProfile(): LabStationProfile {
  const raw = store.get("labStationProfile") as LabStationProfile | undefined;
  if (raw && COMLAB_STATION_IDS.includes(raw.comlabId as (typeof COMLAB_STATION_IDS)[number])) {
    return {
      comlabId: raw.comlabId,
      workstationLabel: String(raw.workstationLabel ?? "PC-01").slice(0, 64),
    };
  }
  return { comlabId: "08", workstationLabel: "PC-01" };
}

const RISK_RULES: Readonly<Record<ActionType, RiskTier>> = {
  chat_response: "low",
  audit_query: "low",
  view_policy: "low",
  health_check: "low",
  recommend_action: "medium",
  draft_policy: "medium",
  mark_notification: "medium",
  runa_delete_within_vault: "medium",
  runa_create_folder: "low",
  runa_write_file: "low",
  runa_move_within_vault: "low",
  runa_read_file: "low",
  student_hitl_escalation: "high",
  wipe_terminal: "high",
  lock_cluster: "high",
  terminate_session: "high",
  quarantine_usb: "high",
  force_logout: "high",
  enforce_blocklist: "high",
};

function classifyAction(action: AgentAction): RiskTier {
  const base: RiskTier = RISK_RULES[action.type] ?? "high";
  if (action.confidence !== undefined && action.confidence < CONFIDENCE_THRESHOLD) {
    if (base === "low") return "medium";
    return "high";
  }
  return base;
}

function getAuditRows(): AuditRow[] {
  const v = store.get("auditLog") as AuditRow[] | undefined;
  return Array.isArray(v) ? v : [];
}

function setAuditRows(rows: AuditRow[]): void {
  store.set("auditLog", rows.slice(-AUDIT_LIMIT));
}

function getQueue(): ApprovalRequest[] {
  const v = store.get("approvalsQueue") as ApprovalRequest[] | undefined;
  return Array.isArray(v) ? v : [];
}

function setQueue(rows: ApprovalRequest[]): void {
  store.set("approvalsQueue", rows.slice(-QUEUE_LIMIT));
}

function fromIsoMaybe(v: string | null | undefined, fallback = Date.now()): number {
  if (!v) return fallback;
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeAuditCreatedAtMs(createdAt: unknown): number {
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) return createdAt;
  if (typeof createdAt === "string") return fromIsoMaybe(createdAt);
  return Date.now();
}

/** Collapse duplicate rows when the same event exists locally and in Supabase (second-level bucket). */
function auditStreamDedupeKey(row: AuditRow): string {
  const tSec = Math.floor(normalizeAuditCreatedAtMs(row.createdAt) / 1000);
  const detailHead = (row.detail ?? "").slice(0, 96);
  return `${row.eventType}\0${row.actorUserId}\0${tSec}\0${detailHead}`;
}

function normalizeAuditRowTimestamps(row: AuditRow): AuditRow {
  return {
    ...row,
    createdAt: normalizeAuditCreatedAtMs(row.createdAt),
  };
}

/**
 * Supabase list can be empty or lag behind while `logEvent` has already appended to electron-store.
 * Never replace local-only history with an empty remote response.
 */
function mergeAuditStreams(remote: AuditRow[], local: AuditRow[]): AuditRow[] {
  const merged = new Map<string, AuditRow>();
  for (const r of remote.map(normalizeAuditRowTimestamps)) {
    merged.set(auditStreamDedupeKey(r), r);
  }
  for (const r of local.map(normalizeAuditRowTimestamps)) {
    const k = auditStreamDedupeKey(r);
    if (!merged.has(k)) merged.set(k, r);
  }
  return Array.from(merged.values()).sort(
    (a, b) => normalizeAuditCreatedAtMs(b.createdAt) - normalizeAuditCreatedAtMs(a.createdAt),
  );
}

async function listApprovalsRemote(): Promise<ApprovalRequest[]> {
  try {
    const response = await cloudCall<{ ok?: boolean; rows?: unknown[] }>(
      CLOUD_ENDPOINTS.approvals,
      { op: "list", limit: QUEUE_LIMIT },
    );
    const incoming = Array.isArray(response.rows) ? response.rows : [];
    const rows = incoming.map((row) => {
      const r = row as Record<string, unknown>;
      const requesterRole: Role = r.requesterRole === "admin" ? "admin" : "student";
      return {
      id: String(r.id ?? ""),
      createdAt: typeof r.createdAt === "number" ? r.createdAt : fromIsoMaybe(String(r.createdAt ?? "")),
      requesterId: String(r.requesterId ?? ""),
      requesterRole,
      action: r.action as AgentAction,
      riskTier: (r.riskTier ?? "high") as RiskTier,
      evidence: (r.evidence ?? undefined) as ApprovalEvidence | undefined,
      status: (r.status ?? "pending") as ApprovalStatus,
      decision: (r.decision ?? undefined) as ApprovalDecision | undefined,
      comments: (r.comments ?? undefined) as ApprovalComment[] | undefined,
      };
    });
    return rows.sort((a, b) => b.createdAt - a.createdAt);
  } catch (e) {
    console.error("[main] Cloud listApprovals failed:", e);
    throw new Error(`Cloud approvals unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function upsertApprovalsRemote(rows: ApprovalRequest[]): Promise<void> {
  try {
    await cloudCall(
      CLOUD_ENDPOINTS.approvals,
      { op: "upsert", rows: rows.slice(-QUEUE_LIMIT) },
    );
  } catch (e) {
    console.error("[main] Cloud upsertApprovals failed:", e);
    throw new Error(`Cloud approvals write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function readQueueShared(): Promise<ApprovalRequest[]> {
  try {
    const remote = await listApprovalsRemote();
    setQueue(remote);
    return remote;
  } catch (e) {
    console.warn("[main] readQueueShared: cloud unavailable — using local cache:", e);
    return getQueue();
  }
}

async function writeQueueShared(rows: ApprovalRequest[]): Promise<void> {
  setQueue(rows);
  try {
    await upsertApprovalsRemote(rows);
  } catch (e) {
    console.warn("[main] writeQueueShared: cloud sync failed — local state retained:", e);
  }
}

function nextAuditId(): number {
  const rows = getAuditRows();
  const max = rows.reduce((m, r) => Math.max(m, r.id), 0);
  return max + 1;
}

function logEvent(row: Omit<AuditRow, "id" | "createdAt"> & { id?: number; createdAt?: number }): AuditRow {
  const threatLevel: RiskTier = row.threatLevel ?? row.riskTier ?? "low";
  const eventDescription =
    row.eventDescription?.trim() ||
    row.eventType.replace(/_/g, " ");
  const full: AuditRow = {
    id: row.id ?? nextAuditId(),
    createdAt: row.createdAt ?? Date.now(),
    eventType: row.eventType,
    eventDescription,
    threatLevel,
    actorUserId: row.actorUserId,
    actorRole: row.actorRole,
    detail: row.detail,
    approvalId: row.approvalId,
    approverUserId: row.approverUserId,
    riskTier: row.riskTier ?? threatLevel,
    confidenceScore: row.confidenceScore,
  };

  // Link this row to the current tail before persisting, so the chain is
  // sealed at write time rather than reconstructed later.
  const existing = getAuditRows();
  sealRow(full, existing[existing.length - 1]);

  setAuditRows([...existing, full]);
  void insertAuditRemote(full);
  return full;
}

async function listAuditRemote(limit = 200): Promise<AuditRow[]> {
  try {
    const response = await cloudCall<{ ok?: boolean; rows?: unknown[] }>(
      CLOUD_ENDPOINTS.audit,
      { op: "list", limit },
    );
    const incoming = Array.isArray(response.rows) ? response.rows : [];
    return incoming.map((row, idx) => {
      const r = row as Record<string, unknown>;
      const createdRaw = r.createdAt ?? r.created_at;
      return {
        id: Number(r.id ?? idx + 1),
        createdAt:
          typeof createdRaw === "number"
            ? createdRaw
            : fromIsoMaybe(String(createdRaw ?? "")),
        eventType: String(r.eventType ?? r.event_type ?? "unknown"),
        eventDescription:
          typeof r.eventDescription === "string"
            ? r.eventDescription
            : typeof r.event_description === "string"
              ? r.event_description
              : undefined,
        threatLevel: (r.threatLevel ?? r.threat_level) as RiskTier | undefined,
        actorUserId: String(r.actorUserId ?? r.actor_user_id ?? "unknown"),
        actorRole: (r.actorRole ?? r.actor_role ?? "system") as ActorRole,
        detail: String(r.detail ?? ""),
        approvalId: (r.approvalId ?? r.approval_id) as string | undefined,
        approverUserId: (r.approverUserId ?? r.approver_user_id) as string | undefined,
        riskTier: (r.riskTier ?? r.risk_tier) as RiskTier | undefined,
        confidenceScore:
          typeof r.confidenceScore === "number"
            ? r.confidenceScore
            : typeof r.confidence_score === "number"
              ? r.confidence_score
              : undefined,
      };
    });
  } catch (e) {
    console.error("[main] Cloud listAudit failed:", e);
    throw new Error(`Cloud audit unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function insertAuditRemote(row: AuditRow): Promise<void> {
  try {
    await cloudCall(CLOUD_ENDPOINTS.audit, { op: "insert", row });
  } catch (e) {
    console.error("[main] Cloud insertAudit failed:", e);
    throw new Error(`Cloud audit write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function listBlockedDomainsRemote(): Promise<string[]> {
  try {
    const response = await cloudCall<{ ok?: boolean; domains?: unknown[] }>(
      CLOUD_ENDPOINTS.policy,
      { op: "list_blocked_domains" },
    );
    const incoming = Array.isArray(response.domains) ? response.domains : [];
    return Array.from(
      new Set(
        incoming
          .map((row) => normalizeDomain(String(row)))
          .filter(Boolean),
      ),
    );
  } catch (e) {
    console.error("[main] Cloud listBlockedDomains failed:", e);
    throw new Error(`Cloud policy unavailable: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function upsertBlockedDomainRemote(domain: string): Promise<void> {
  try {
    await cloudCall(CLOUD_ENDPOINTS.policy, { op: "upsert_blocked_domain", domain });
  } catch (e) {
    console.error("[main] Cloud upsertBlockedDomain failed:", e);
    throw new Error(`Cloud policy write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function readBlockedDomainsShared(): Promise<string[]> {
  try {
    const remote = await listBlockedDomainsRemote();
    store.set("blockedDomains", remote);
    return remote;
  } catch (e) {
    console.warn("[main] readBlockedDomainsShared: cloud unavailable — using local cache:", e);
    const cached = store.get("blockedDomains") as string[] | undefined;
    return Array.isArray(cached) ? cached : [];
  }
}

function findRequest(id: string): ApprovalRequest | undefined {
  return getQueue().find((r) => r.id === id);
}

// ── Approved-action dispatch ────────────────────────────────────────────
// An approval is decided on the admin's machine, but most approved actions
// are meant for a student's machine: the student's own vault request, or
// containment of a lab. Executing those where the approval was clicked would
// lock, sign out, or delete on the admin's machine instead. They are marked
// for dispatch and picked up by the target machine from the shared queue.

const DISPATCH_POLL_MS = 8_000;
/** A dispatched action older than this is stale and never executed. */
const DISPATCH_MAX_AGE_MS = 15 * 60_000;
const EXECUTED_DISPATCH_LIMIT = 500;
const CONTAINMENT_ACTIONS: ReadonlySet<ActionType> = new Set([
  "lock_cluster",
  "terminate_session",
  "force_logout",
  "wipe_terminal",
]);

/** When the current RUNA session began on this machine; containment dispatched before it is ignored. */
let sessionStartedAt = Date.now();

function dispatchTargetFor(req: ApprovalRequest): DispatchTarget | null {
  const { type, payload } = req.action;
  if (type.startsWith("runa_") && req.requesterRole === "student") {
    return { kind: "user", userId: req.requesterId };
  }
  if (CONTAINMENT_ACTIONS.has(type)) {
    const targetUserId = typeof payload?.targetUserId === "string" ? payload.targetUserId.trim() : "";
    if (targetUserId) return { kind: "user", userId: targetUserId };
    const labId = String(payload?.labId ?? "08").trim() || "08";
    return { kind: "lab", comlabId: labId };
  }
  return null;
}

function describeDispatchTarget(target: DispatchTarget): string {
  return target.kind === "user" ? `${target.userId}'s workstation` : `student workstations in COMLAB ${target.comlabId}`;
}

function getExecutedDispatchIds(): string[] {
  const v = store.get("executedDispatchIds") as string[] | undefined;
  return Array.isArray(v) ? v : [];
}

function markDispatchExecuted(id: string): void {
  store.set("executedDispatchIds", [...getExecutedDispatchIds(), id].slice(-EXECUTED_DISPATCH_LIMIT));
}

let dispatchPollBusy = false;

/**
 * Runs on student machines: executes approved actions dispatched to this
 * student or this machine's lab. Each approval id is recorded locally before
 * execution, so a lock or sign-out can never fire twice on one machine.
 */
async function pollDispatchedActions(): Promise<void> {
  const session = store.get("session");
  if (!session || session.role !== "student" || dispatchPollBusy) return;
  dispatchPollBusy = true;
  try {
    let queue: ApprovalRequest[];
    try {
      queue = await listApprovalsRemote();
    } catch {
      return; // offline: dispatched actions wait until the cloud is reachable
    }
    const station = getLabStationProfile();
    const executed = new Set(getExecutedDispatchIds());
    const now = Date.now();

    for (const req of queue.sort((a, b) => a.createdAt - b.createdAt)) {
      const dispatch = req.decision?.dispatch;
      if (req.status !== "approved" || !dispatch || executed.has(req.id)) continue;
      if (now - dispatch.dispatchedAt > DISPATCH_MAX_AGE_MS) continue;
      const { target } = dispatch;
      const isMine =
        target.kind === "user" ? target.userId === session.userId : target.comlabId === station.comlabId;
      if (!isMine) continue;
      // Containment approved before this student signed in is not theirs to receive.
      if (CONTAINMENT_ACTIONS.has(req.action.type) && dispatch.dispatchedAt < sessionStartedAt) continue;

      markDispatchExecuted(req.id);
      const approvedBy = req.decision?.decidedByUserId ?? "unknown";
      const result = await executeAction({
        ...req.action,
        payload: { ...req.action.payload, approvalId: req.id, approvedBy },
      });
      logEvent({
        eventType: result.ok ? "action_executed" : "action_hard_failed",
        detail: JSON.stringify({
          approvalId: req.id,
          actionType: req.action.type,
          message: result.message,
          status: result.status,
          executedOn: station.workstationLabel,
          comlabId: station.comlabId,
          evidence: result.evidence ?? null,
        }),
        actorUserId: session.userId,
        actorRole: "student",
        approvalId: req.id,
        approverUserId: approvedBy,
        riskTier: req.riskTier,
      });

      const execution: DispatchExecution = {
        userId: session.userId,
        workstation: station.workstationLabel,
        at: Date.now(),
        ok: result.ok,
        message: result.message,
      };
      const updated: ApprovalRequest = {
        ...req,
        decision: {
          ...(req.decision as ApprovalDecision),
          dispatch: { ...dispatch, executions: [...(dispatch.executions ?? []), execution] },
        },
      };
      // Only this row is written back, so a stale copy of other rows never overwrites them.
      void upsertApprovalsRemote([updated]).catch(() => {});

      // A sign-out ends the session this loop was acting for.
      if (!store.get("session")) break;
    }
  } finally {
    dispatchPollBusy = false;
  }
}

async function executeAction(action: AgentAction): Promise<ActionExecutionResult> {
  console.log("[main] executeAction", action.type, JSON.stringify(action.payload));

  if (action.type === "runa_create_folder") {
    const rel = String(action.payload.relativePath ?? "").trim();
    const resolved = resolveUnderVault(app, rel);
    if (!resolved.ok) return { ok: false, status: "hard_failed", message: resolved.error };
    try {
      fsSync.mkdirSync(resolved.absolute, { recursive: true });
      return { ok: true, status: "executed", message: `Created folder under Runa_Folder: ${rel || "."}` };
    } catch (e) {
      return { ok: false, status: "hard_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  if (action.type === "runa_write_file") {
    const rel = String(action.payload.relativePath ?? "").trim();
    const content = String(action.payload.content ?? "");
    const buf = Buffer.from(content, "utf8");
    if (buf.length > MAX_TEXT_FILE_BYTES) {
      return {
        ok: false,
        status: "hard_failed",
        message: `File exceeds maximum size (${MAX_TEXT_FILE_BYTES} bytes).`,
      };
    }
    const resolved = resolveUnderVault(app, rel);
    if (!resolved.ok) return { ok: false, status: "hard_failed", message: resolved.error };
    try {
      fsSync.mkdirSync(path.dirname(resolved.absolute), { recursive: true });
      fsSync.writeFileSync(resolved.absolute, buf, { encoding: "utf8" });
      return { ok: true, status: "executed", message: `Wrote file under Runa_Folder: ${rel}` };
    } catch (e) {
      return { ok: false, status: "hard_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  if (action.type === "runa_move_within_vault") {
    const fromRel = String(action.payload.fromRelative ?? "").trim();
    const toRel = String(action.payload.toRelative ?? "").trim();
    const a = resolveUnderVault(app, fromRel);
    const b = resolveUnderVault(app, toRel);
    if (!a.ok) return { ok: false, status: "hard_failed", message: a.error };
    if (!b.ok) return { ok: false, status: "hard_failed", message: b.error };
    try {
      fsSync.mkdirSync(path.dirname(b.absolute), { recursive: true });
      fsSync.renameSync(a.absolute, b.absolute);
      return { ok: true, status: "executed", message: `Moved within Runa_Folder: ${fromRel} → ${toRel}` };
    } catch (e) {
      return { ok: false, status: "hard_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  if (action.type === "runa_read_file") {
    const rel = String(action.payload.relativePath ?? "").trim();
    if (!rel) {
      return { ok: false, status: "hard_failed", message: "relativePath is required." };
    }
    const resolved = resolveUnderVault(app, rel);
    if (!resolved.ok) return { ok: false, status: "hard_failed", message: resolved.error };
    try {
      const st = fsSync.statSync(resolved.absolute);
      if (st.isDirectory()) {
        return { ok: false, status: "hard_failed", message: "Path is a directory, not a file." };
      }
      if (st.size > MAX_TEXT_FILE_BYTES) {
        return {
          ok: false,
          status: "hard_failed",
          message: `File exceeds maximum size (${MAX_TEXT_FILE_BYTES} bytes).`,
        };
      }
      const text = fsSync.readFileSync(resolved.absolute, { encoding: "utf8" });
      return {
        ok: true,
        status: "executed",
        message: `Read ${st.size} byte(s) from Runa_Folder: ${rel}`,
        evidence: { relativePath: rel, content: text, byteLength: st.size },
      };
    } catch (e) {
      return { ok: false, status: "hard_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  if (action.type === "runa_delete_within_vault") {
    const rel = String(action.payload.relativePath ?? "").trim();
    if (!rel) {
      return { ok: false, status: "hard_failed", message: "relativePath is required." };
    }
    const resolved = resolveUnderVault(app, rel);
    if (!resolved.ok) return { ok: false, status: "hard_failed", message: resolved.error };
    try {
      const st = fsSync.statSync(resolved.absolute);
      if (st.isDirectory()) {
        return {
          ok: false,
          status: "hard_failed",
          message: "Refusing to delete directories — only single files under Runa_Folder.",
        };
      }
      fsSync.unlinkSync(resolved.absolute);
      return {
        ok: true,
        status: "executed",
        message: `Deleted file under Runa_Folder: ${rel}`,
        evidence: { relativePath: rel },
      };
    } catch (e) {
      return { ok: false, status: "hard_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  if (action.type === "student_hitl_escalation") {
    return {
      ok: true,
      status: "executed",
      message:
        "Request recorded. Lab staff will follow up — Runa cannot send email, submit coursework, or change policies autonomously.",
    };
  }

  if (action.type === "enforce_blocklist") {
    const candidate = String(action.payload.domain ?? action.payload.url ?? "").trim();
    const domain = normalizeDomain(candidate);
    if (!domain) {
      return {
        ok: false,
        status: "hard_failed",
        message: "Cannot enforce blocklist: missing valid domain/url.",
      };
    }
    const current = store.get("blockedDomains") as string[] | undefined;
    const list = Array.isArray(current) ? current : [];
    if (!list.includes(domain)) {
      store.set("blockedDomains", [...list, domain]);
    }
    void upsertBlockedDomainRemote(domain);
    return {
      ok: true,
      status: "executed",
      message: `Blocklist enforced for domain: ${domain}`,
      evidence: { domain },
    };
  }

  if (action.type === "quarantine_usb") {
    const device = String(action.payload.device ?? action.payload.product ?? "Unknown USB device");
    const reason = String(action.payload.reason ?? action.payload.threat ?? "policy_review");
    const approvalId = typeof action.payload.approvalId === "string" ? action.payload.approvalId : undefined;
    const current = store.get("quarantinedUsbEvents") as
      | Array<{ at: number; device: string; reason: string; approvalId?: string }>
      | undefined;
    const rows = Array.isArray(current) ? current : [];
    store.set("quarantinedUsbEvents", [
      ...rows,
      {
        at: Date.now(),
        device,
        reason,
        approvalId,
      },
    ]);
    return {
      ok: true,
      status: "executed",
      message: `USB quarantined: ${device}`,
      evidence: { device, reason, approvalId: approvalId ?? null },
    };
  }

  if (action.type === "lock_cluster") {
    if (process.platform !== "win32") {
      return {
        ok: false,
        status: "hard_failed",
        message: "lock_cluster requires Windows (LockWorkStation is a Win32 API).",
      };
    }
    try {
      execFileSync("rundll32.exe", ["user32.dll,LockWorkStation"]);
      return { ok: true, status: "executed", message: "Workstation locked (Win32 LockWorkStation)." };
    } catch (e) {
      return { ok: false, status: "hard_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  if (action.type === "terminate_session" || action.type === "force_logout") {
    const prev = store.get("session");
    if (prev?.role === "student") {
      const station = getLabStationProfile();
      closeLocalOpenAttendanceSession(prev.userId, station.comlabId);
      try {
        await attendanceCheckOutCloud(prev.userId, station.comlabId);
      } catch (e) {
        console.warn("[main] executeAction terminate_session: attendance sync failed, retained locally:", e);
      }
    }
    store.set("session", null);
    syncStudentRuntimeEnforcement();
    mainWindow?.webContents.send("session:force-logout");
    return {
      ok: true,
      status: "executed",
      message: prev
        ? `RUNA session terminated for ${prev.userId}; returned to login.`
        : "No active RUNA session on this terminal; nothing to terminate.",
    };
  }

  if (action.type === "wipe_terminal") {
    try {
      const root = ensureVaultExists(app);
      const entries = fsSync.readdirSync(root);
      for (const entry of entries) {
        fsSync.rmSync(path.join(root, entry), { recursive: true, force: true });
      }
      return {
        ok: true,
        status: "executed",
        message: `Wiped RUNA-managed vault on this terminal (${entries.length} item(s) removed under Runa_Folder).`,
        evidence: { itemsRemoved: entries.length },
      };
    } catch (e) {
      return { ok: false, status: "hard_failed", message: e instanceof Error ? e.message : String(e) };
    }
  }

  return { ok: true, status: "simulated", message: `Simulated non-sensitive action: ${action.type}` };
}

// ─────────────────────────────────────────────
//  Globals
// ─────────────────────────────────────────────
let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let pythonProcess: ChildProcess | null = null;
let stopStudentEnforcement: (() => void) | null = null;

function syncStudentRuntimeEnforcement(): void {
  if (stopStudentEnforcement) {
    stopStudentEnforcement();
    stopStudentEnforcement = null;
  }
  const session = store.get("session");
  if (!session || session.role !== "student") return;

  const ctl = createStudentRuntimeEnforcement({
    pythonPort: PYTHON_PORT,
    pollIntervalMs: 15_000,
    getSession: () => store.get("session"),
    getBlockedDomains: async () => {
      try {
        return await readBlockedDomainsShared();
      } catch {
        const local = store.get("blockedDomains") as string[] | undefined;
        return Array.isArray(local) ? local : [];
      }
    },
    logStructured: (row) => {
      logEvent({
        eventType: row.eventType,
        eventDescription: row.eventDescription,
        threatLevel: row.threatLevel,
        detail: row.detail,
        actorUserId: row.actorUserId,
        actorRole: row.actorRole,
        riskTier: row.riskTier ?? row.threatLevel,
      });
    },
    notifyTray: (title, body) => {
      if (!tray) return;
      try {
        tray.displayBalloon({ title, content: body });
      } catch {
        /* optional */
      }
    },
  });
  stopStudentEnforcement = ctl.stop;
}

// ─────────────────────────────────────────────
//  Python microservice launcher
// ─────────────────────────────────────────────
function startPythonService(): void {
  try {
    const isPacked = app.isPackaged;
    // Directory build (python-service/service/service.exe) is preferred: a
    // one-file build self-extracts on every launch. The legacy one-file path
    // is kept as a fallback for older packages.
    const serviceDirExe = path.join(process.resourcesPath, "python-service", "service", "service.exe");
    const legacyServiceExe = path.join(process.resourcesPath, "python-service", "service.exe");
    const serviceExe = fsSync.existsSync(serviceDirExe) ? serviceDirExe : legacyServiceExe;
    const packedScriptPath = path.join(process.resourcesPath, "python-service", "service.py");
    // Compiled main lives in dist-electron/electron/ — repo root is two levels up.
    const scriptPath = path.join(__dirname, "..", "..", "python-service", "service.py");

    let cmd: string;
    let args: string[];

    if (isPacked) {
      if (fsSync.existsSync(serviceExe)) {
        cmd = serviceExe;
        args = [];
      } else if (fsSync.existsSync(packedScriptPath)) {
        const pythonExe = process.env.PCU_PYTHON_EXE || (process.platform === "win32" ? "python" : "python3");
        cmd = pythonExe;
        args = [packedScriptPath];
        console.warn(
          `[main] Packaged service.exe missing at ${serviceExe}; falling back to script mode (${packedScriptPath}).`,
        );
      } else {
        console.warn(
          `[main] Packaged Python sidecar missing. Expected ${serviceExe} or ${packedScriptPath} — sidecar disabled.`,
        );
        return;
      }
    } else if (!fsSync.existsSync(scriptPath)) {
      console.warn(`[main] Python service script not found at ${scriptPath} — sidecar disabled.`);
      return;
    } else {
      cmd = process.env.PCU_PYTHON_EXE || (process.platform === "win32" ? "python" : "python3");
      args = [scriptPath];
    }

    console.log(`[main] Starting Python service: ${cmd} ${args.join(" ")}`);

    pythonProcess = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        AI_PROVIDER: process.env.AI_PROVIDER ?? "groq",
        GROQ_MODEL: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
        AWS_REGION: process.env.AWS_REGION ?? "ap-southeast-1",
        FLASK_PORT: process.env.FLASK_PORT ?? String(PYTHON_PORT),
      },
      windowsHide: true,
    });

    pythonProcess.on("error", (err) => {
      console.error("[main] Python sidecar failed to start:", err.message);
      pythonProcess = null;
    });

    pythonProcess.stdout?.on("data", (d) =>
      console.log("[python]", d.toString().trim()),
    );
    pythonProcess.stderr?.on("data", (d) =>
      console.error("[python:err]", d.toString().trim()),
    );
    pythonProcess.on("exit", (code) =>
      console.warn(`[main] Python service exited with code ${code}`),
    );
  } catch (e) {
    console.error("[main] startPythonService:", e);
  }
}

function stopPythonService(): void {
  if (pythonProcess && !pythonProcess.killed) {
    pythonProcess.kill();
    pythonProcess = null;
  }
}

// ─────────────────────────────────────────────
//  Main window factory
// ─────────────────────────────────────────────
function createMainWindow(): BrowserWindow {
  const settings = store.get("settings");

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1280,
    minHeight: 800,
    title: "PCU Lab Portal",
    backgroundColor: "#0d1320",
    // Hide the default frame so we can use a custom titlebar
    frame: false,
    titleBarStyle: "hidden",
    kiosk: settings.kioskMode,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    ...(HAS_ICON ? { icon: ICON_PATH } : {}),
  });

  // Load the app
  if (IS_DEV) {
    win.loadURL(VITE_DEV_SERVER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    // dist-electron output lives in dist-electron/electron/, while renderer build is in dist/
    win.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
  }

  // Intercept navigation – prevent leaving the app in kiosk mode
  win.webContents.on("will-navigate", (event, url) => {
    const allowed = IS_DEV
      ? url.startsWith(VITE_DEV_SERVER_URL)
      : url.startsWith("file://");
    if (!allowed) {
      event.preventDefault();
      shell.openExternal(url); // Open external links in the OS browser
    }
  });

  win.on("closed", () => {
    mainWindow = null;
  });

  return win;
}

// ─────────────────────────────────────────────
//  System tray
// ─────────────────────────────────────────────
function createTray(): Tray | null {
  if (!HAS_ICON) {
    console.warn(
      `[main] Tray icon not found at ${ICON_PATH} — skipping tray creation. ` +
      `Add a 16x16 PNG to enable the tray (see sprint/daily-checklist.md Day 4).`
    );
    return null;
  }
  const icon = nativeImage.createFromPath(ICON_PATH).resize({ width: 16, height: 16 });
  const t = new Tray(icon);

  const menu = Menu.buildFromTemplate([
    { label: "PCU Lab Portal", enabled: false },
    { type: "separator" },
    {
      label: "Show Window",
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      },
    },
    {
      label: "Settings",
      click: () => {
        mainWindow?.webContents.send("navigate", "/settings");
        mainWindow?.show();
      },
    },
    { type: "separator" },
    {
      label: "Quit",
      click: () => app.quit(),
    },
  ]);

  t.setToolTip("PCU Lab Portal");
  t.setContextMenu(menu);
  t.on("double-click", () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  return t;
}

// ─────────────────────────────────────────────
//  IPC handlers
// ─────────────────────────────────────────────
function registerIpcHandlers(): void {
  migrateLabShortcuts();

  // ── Session management ──────────────────────
  ipcMain.handle("session:get", () => store.get("session"));

  ipcMain.handle("session:set", (_event, session: StoreSchema["session"]) => {
    store.set("session", session);
    sessionStartedAt = Date.now();
    syncStudentRuntimeEnforcement();
    return true;
  });

  ipcMain.handle("session:clear", async () => {
    const prev = store.get("session");
    if (prev?.role === "student") {
      const station = getLabStationProfile();
      try {
        await attendanceCheckOutCloud(prev.userId, station.comlabId);
      } catch (e) {
        console.warn("[main] Attendance check-out skipped or failed:", e);
      }
    }
    store.set("session", null);
    syncStudentRuntimeEnforcement();
    return true;
  });

  ipcMain.handle("labStation:get", () => getLabStationProfile());

  ipcMain.handle("labStation:set", (_e, profile: LabStationProfile) => {
    const cid = String(profile?.comlabId ?? "08").trim();
    const ws = String(profile?.workstationLabel ?? "PC-01").trim().slice(0, 64);
    if (!COMLAB_STATION_IDS.includes(cid as (typeof COMLAB_STATION_IDS)[number])) {
      throw new Error("Invalid comlabId (use 08–12).");
    }
    if (!ws) {
      throw new Error("workstationLabel required.");
    }
    store.set("labStationProfile", { comlabId: cid, workstationLabel: ws });
    return getLabStationProfile();
  });

  ipcMain.handle(
    "attendance:checkIn",
    async (
      _e,
      payload: {
        studentEmail: string;
        comlabId: string;
        comlabLabel: string;
        workstationLabel: string;
        professorName: string;
      },
    ) => {
      const nowIso = new Date().toISOString();
      const local: AttendanceSessionRow = {
        id: randomUUID(),
        studentEmail: payload.studentEmail,
        comlabId: payload.comlabId,
        comlabLabel: payload.comlabLabel ?? "",
        workstationLabel: payload.workstationLabel ?? "",
        professorName: payload.professorName ?? "",
        timeIn: nowIso,
        timeOut: null,
        lastSeenAt: nowIso,
        synced: false,
      };
      setLocalAttendance([...getLocalAttendance(), local]);
      try {
        await cloudCall(CLOUD_ENDPOINTS.audit, {
          op: "attendance_check_in",
          studentEmail: local.studentEmail,
          comlabId: local.comlabId,
          comlabLabel: local.comlabLabel,
          workstationLabel: local.workstationLabel,
          professorName: local.professorName,
          timeIn: local.timeIn,
        });
        setLocalAttendance(getLocalAttendance().map((r) => (r.id === local.id ? { ...r, synced: true } : r)));
      } catch (e) {
        console.warn("[main] attendance:checkIn: offline — recorded locally, will sync later:", e);
      }
      return true;
    },
  );

  ipcMain.handle(
    "attendance:checkOut",
    async (_e, payload: { studentEmail: string; comlabId: string }) => {
      const matchedId = closeLocalOpenAttendanceSession(payload.studentEmail, payload.comlabId);
      try {
        await attendanceCheckOutCloud(payload.studentEmail, payload.comlabId);
        if (matchedId) {
          setLocalAttendance(getLocalAttendance().map((r) => (r.id === matchedId ? { ...r, synced: true } : r)));
        }
      } catch (e) {
        console.warn("[main] attendance:checkOut: offline — recorded locally, will sync later:", e);
      }
      return true;
    },
  );

  ipcMain.handle("attendance:list", async (_e, comlabId: string, limit = 500) => {
    const cid = String(comlabId || "08").trim();
    const cap = Math.min(1000, Math.max(1, limit));
    let remoteRows: AttendanceSessionRow[] = [];
    let cloudOk = false;
    try {
      remoteRows = (await attendanceListCloud(cid, cap)) as AttendanceSessionRow[];
      cloudOk = true;
    } catch (e) {
      console.warn("[main] attendance:list: cloud unavailable — using local cache:", e);
    }
    if (cloudOk) {
      void flushPendingAttendance();
    }
    const localRows = getLocalAttendance().filter((r) => r.comlabId === cid);
    const merged = new Map<string, AttendanceSessionRow>();
    for (const r of remoteRows) merged.set(attendanceDedupeKey(r), { ...r, synced: true });
    for (const r of localRows) {
      const key = attendanceDedupeKey(r);
      if (!merged.has(key)) merged.set(key, r);
    }
    return Array.from(merged.values())
      .sort((a, b) => (b.timeIn ?? "").localeCompare(a.timeIn ?? ""))
      .slice(0, cap)
      .map(({ synced: _synced, ...rest }) => rest);
  });

  // ── Settings ────────────────────────────────
  ipcMain.handle("settings:get", () => store.get("settings"));

  ipcMain.handle(
    "settings:set",
    (_event, partial: Partial<StoreSchema["settings"]>) => {
      const current = store.get("settings");
      const updated = { ...current, ...partial };
      store.set("settings", updated);

      // Apply kiosk mode at runtime
      if ("kioskMode" in partial) {
        mainWindow?.setKiosk(partial.kioskMode!);
      }
      return updated;
    }
  );

  // ── Window controls ─────────────────────────
  ipcMain.handle("window:minimize", () => mainWindow?.minimize());
  ipcMain.handle("window:maximize", () => {
    if (mainWindow?.isMaximized()) mainWindow.unmaximize();
    else mainWindow?.maximize();
  });
  ipcMain.handle("window:close", () => mainWindow?.close());

  // ── Python microservice proxy ────────────────
  ipcMain.handle(
    "python:call",
    async (
      _event,
      endpoint: string,
      payload?: unknown,
      options?: { method?: "GET" | "POST"; timeoutMs?: number },
    ) => {
      const { default: axios } = await import("axios");
      const method = options?.method ?? "POST";
      const timeoutMs = options?.timeoutMs ?? 15_000;
      const url = `${PYTHON_BASE_URL}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`;
      try {
        const res =
          method === "GET"
            ? await axios.get(url, { timeout: timeoutMs })
            : await axios.post(url, payload ?? {}, {
                timeout: timeoutMs,
                headers: { "Content-Type": "application/json" },
              });
        return { ok: true, data: res.data };
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Python service error";
        return { ok: false, error: message };
      }
    },
  );

  // ── File dialog ─────────────────────────────
  ipcMain.handle("dialog:openFile", async (_event, filters) => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      properties: ["openFile"],
      filters: filters ?? [{ name: "All Files", extensions: ["*"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  // ── Student lab shortcuts (dynamic list — add/remove in UI) ─────────────────
  ipcMain.handle("lab:get-shortcuts", () => [...readLabShortcuts()]);

  ipcMain.handle(
    "lab:add-shortcut",
    (_event, payload: { label: string; targetPath: string }) => {
      const session = store.get("session");
      const settings = store.get("settings");
      const list = readLabShortcuts();

      if (settings.kioskMode && session?.role === "student") {
        logEvent({
          eventType: "lab_shortcut_edit_denied",
          detail: JSON.stringify({ reason: "kiosk_student_readonly", op: "add" }),
          actorUserId: session?.userId ?? "unknown",
          actorRole: "student",
          riskTier: "low",
        });
        return {
          ok: false as const,
          shortcuts: list,
          error:
            "Kiosk mode: shortcuts are managed by IT. Contact lab tech to add or change applications.",
        };
      }

      const label = String(payload?.label ?? "").trim().slice(0, 80);
      const targetPath = String(payload?.targetPath ?? "").trim();
      if (!label || !targetPath) {
        return {
          ok: false as const,
          shortcuts: list,
          error: "Enter a display name and choose an executable or shortcut file.",
        };
      }

      const item: LabShortcutRow = { id: randomUUID(), label, targetPath };
      const next = [...list, item];
      store.set("labShortcuts", next);
      logEvent({
        eventType: "lab_shortcut_added",
        detail: JSON.stringify({ id: item.id, label: item.label }),
        actorUserId: session?.userId ?? "system",
        actorRole: session?.role ?? "system",
        riskTier: "low",
      });
      return { ok: true as const, shortcuts: next, item };
    },
  );

  ipcMain.handle(
    "lab:update-shortcut",
    (_event, payload: { id: string; label: string; targetPath: string }) => {
      const session = store.get("session");
      const settings = store.get("settings");
      const list = readLabShortcuts();

      if (settings.kioskMode && session?.role === "student") {
        logEvent({
          eventType: "lab_shortcut_edit_denied",
          detail: JSON.stringify({ id: payload.id, reason: "kiosk_student_readonly", op: "update" }),
          actorUserId: session?.userId ?? "unknown",
          actorRole: "student",
          riskTier: "low",
        });
        return {
          ok: false as const,
          shortcuts: list,
          error:
            "Kiosk mode: shortcuts are managed by IT. Contact lab tech to change applications.",
        };
      }

      const id = String(payload?.id ?? "").trim();
      const idx = list.findIndex((r) => r.id === id);
      if (idx === -1) {
        return {
          ok: false as const,
          shortcuts: list,
          error: "Shortcut not found.",
        };
      }

      const label = String(payload?.label ?? "").trim().slice(0, 80);
      const targetPath = String(payload?.targetPath ?? "").trim();
      if (!label || !targetPath) {
        return {
          ok: false as const,
          shortcuts: list,
          error: "Display name and target path are required.",
        };
      }

      const next = [...list];
      next[idx] = { ...list[idx], label, targetPath };
      store.set("labShortcuts", next);
      logEvent({
        eventType: "lab_shortcut_updated",
        detail: JSON.stringify({ id, label }),
        actorUserId: session?.userId ?? "system",
        actorRole: session?.role ?? "system",
        riskTier: "low",
      });
      return { ok: true as const, shortcuts: next, item: next[idx] };
    },
  );

  ipcMain.handle("lab:remove-shortcut", (_event, id: string) => {
    const session = store.get("session");
    const settings = store.get("settings");
    const list = readLabShortcuts();

    if (settings.kioskMode && session?.role === "student") {
      logEvent({
        eventType: "lab_shortcut_edit_denied",
        detail: JSON.stringify({ id, reason: "kiosk_student_readonly", op: "remove" }),
        actorUserId: session?.userId ?? "unknown",
        actorRole: "student",
        riskTier: "low",
      });
      return {
        ok: false as const,
        shortcuts: list,
        error:
          "Kiosk mode: shortcuts are managed by IT. Contact lab tech to remove an entry.",
      };
    }

    const next = list.filter((r) => r.id !== id);
    store.set("labShortcuts", next);
    logEvent({
      eventType: "lab_shortcut_removed",
      detail: JSON.stringify({ id }),
      actorUserId: session?.userId ?? "system",
      actorRole: session?.role ?? "system",
      riskTier: "low",
    });
    return { ok: true as const, shortcuts: next };
  });

  ipcMain.handle("lab:launch", async (_event, id: string) => {
    const session = store.get("session");
    const row = readLabShortcuts().find((r) => r.id === id);
    const p = row?.targetPath?.trim();
    if (!p) {
      logEvent({
        eventType: "lab_app_launch",
        detail: JSON.stringify({ id, ok: false, reason: "not_found" }),
        actorUserId: session?.userId ?? "unknown",
        actorRole: session?.role ?? "system",
        riskTier: "low",
      });
      return {
        ok: false,
        error:
          "That shortcut is missing. Add it from the side panel (Add shortcut), or ask lab tech in kiosk labs.",
      };
    }
    try {
      const err = await shell.openPath(p);
      logEvent({
        eventType: "lab_app_launch",
        detail: JSON.stringify({ id, label: row?.label, ok: !err, pathTail: p.slice(-64) }),
        actorUserId: session?.userId ?? "unknown",
        actorRole: session?.role ?? "system",
        riskTier: "low",
      });
      if (err) return { ok: false, error: err };
      return { ok: true as const };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent({
        eventType: "lab_app_launch",
        detail: JSON.stringify({ id, ok: false, error: msg }),
        actorUserId: session?.userId ?? "unknown",
        actorRole: session?.role ?? "system",
        riskTier: "low",
      });
      return { ok: false, error: msg };
    }
  });

  // ── Runa_Folder vault (student-safe automation root) ───────────────────────
  ipcMain.handle("runaFiles:getVaultRoot", () => {
    try {
      const root = ensureVaultExists(app);
      return { ok: true as const, path: root };
    } catch (e) {
      return {
        ok: false as const,
        error: e instanceof Error ? e.message : String(e),
        path: null as string | null,
      };
    }
  });

  ipcMain.handle("runaFiles:getSessionWorkspaceRelative", () => {
    const session = store.get("session");
    if (!session?.userId) {
      return { ok: false as const, error: "Not signed in.", relative: null as string | null };
    }
    return {
      ok: true as const,
      relative: sessionRelativeFolder(session.userId),
    };
  });

  ipcMain.handle("runaFiles:createFolder", (_e, relativePath: string) => {
    const session = store.get("session");
    if (!session?.userId) {
      return { ok: false as const, error: "Not signed in." };
    }
    const resolved = resolveUnderVault(app, relativePath);
    if (!resolved.ok) {
      return { ok: false as const, error: resolved.error };
    }
    try {
      fsSync.mkdirSync(resolved.absolute, { recursive: true });
      logEvent({
        eventType: "runa_files_mkdir",
        detail: JSON.stringify({ relativePath }),
        actorUserId: session.userId,
        actorRole: session.role,
        riskTier: "low",
      });
      return { ok: true as const, absolute: resolved.absolute };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent({
        eventType: "runa_files_error",
        detail: JSON.stringify({ op: "mkdir", relativePath, error: msg }),
        actorUserId: session.userId,
        actorRole: session.role,
        riskTier: "low",
      });
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle("runaFiles:writeTextFile", (_e, relativePath: string, content: string) => {
    const session = store.get("session");
    if (!session?.userId) {
      return { ok: false as const, error: "Not signed in." };
    }
    const buf = Buffer.from(String(content ?? ""), "utf8");
    if (buf.length > MAX_TEXT_FILE_BYTES) {
      return { ok: false as const, error: `File too large (max ${MAX_TEXT_FILE_BYTES} bytes).` };
    }
    const resolved = resolveUnderVault(app, relativePath);
    if (!resolved.ok) {
      return { ok: false as const, error: resolved.error };
    }
    try {
      fsSync.mkdirSync(path.dirname(resolved.absolute), { recursive: true });
      fsSync.writeFileSync(resolved.absolute, buf, { encoding: "utf8" });
      logEvent({
        eventType: "runa_files_write",
        detail: JSON.stringify({ relativePath, bytes: buf.length }),
        actorUserId: session.userId,
        actorRole: session.role,
        riskTier: "low",
      });
      return { ok: true as const, absolute: resolved.absolute };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent({
        eventType: "runa_files_error",
        detail: JSON.stringify({ op: "write", relativePath, error: msg }),
        actorUserId: session.userId,
        actorRole: session.role,
        riskTier: "low",
      });
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle("runaFiles:readTextFile", (_e, relativePath: string) => {
    const session = store.get("session");
    if (!session?.userId) {
      return { ok: false as const, error: "Not signed in." };
    }
    const rel = String(relativePath ?? "").trim();
    if (!rel) {
      return { ok: false as const, error: "relativePath is required." };
    }
    const resolved = resolveUnderVault(app, rel);
    if (!resolved.ok) {
      return { ok: false as const, error: resolved.error };
    }
    try {
      const st = fsSync.statSync(resolved.absolute);
      if (st.isDirectory()) {
        return { ok: false as const, error: "Path is a directory, not a file." };
      }
      if (st.size > MAX_TEXT_FILE_BYTES) {
        return { ok: false as const, error: `File too large (max ${MAX_TEXT_FILE_BYTES} bytes).` };
      }
      const text = fsSync.readFileSync(resolved.absolute, { encoding: "utf8" });
      logEvent({
        eventType: "runa_files_read",
        detail: JSON.stringify({ relativePath: rel, bytes: st.size }),
        actorUserId: session.userId,
        actorRole: session.role,
        riskTier: "low",
      });
      return {
        ok: true as const,
        absolute: resolved.absolute,
        content: text,
        byteLength: st.size,
      };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logEvent({
        eventType: "runa_files_error",
        detail: JSON.stringify({ op: "read", relativePath: rel, error: msg }),
        actorUserId: session.userId,
        actorRole: session.role,
        riskTier: "low",
      });
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle("runaFiles:listDir", (_e, relativePath: string) => {
    const session = store.get("session");
    if (!session?.userId) {
      return { ok: false as const, error: "Not signed in.", entries: [] as string[] };
    }
    const resolved = resolveUnderVault(app, relativePath);
    if (!resolved.ok) {
      return { ok: false as const, error: resolved.error, entries: [] as string[] };
    }
    try {
      const names = fsSync.readdirSync(resolved.absolute);
      logEvent({
        eventType: "runa_files_list",
        detail: JSON.stringify({ relativePath, count: names.length }),
        actorUserId: session.userId,
        actorRole: session.role,
        riskTier: "low",
      });
      return { ok: true as const, entries: names };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false as const, error: msg, entries: [] as string[] };
    }
  });

  ipcMain.handle(
    "telemetry:record",
    (_e, event: string, meta?: Record<string, unknown>) => {
      const session = store.get("session");
      logEvent({
        eventType: "feature_usage",
        detail: JSON.stringify({ event, meta: meta ?? {} }),
        actorUserId: session?.userId ?? "anonymous",
        actorRole: session?.role ?? "system",
        riskTier: "low",
      });
      return true;
    },
  );

  // ── Notifications ───────────────────────────
  ipcMain.handle("tray:notify", (_event, title: string, body: string) => {
    if (!tray) return;
    try {
      tray.displayBalloon({ title, content: body });
    } catch {
      /* optional tray balloon */
    }
  });

  // ── Audit log (electron-store) ──────────────
  ipcMain.handle(
    "audit:log",
    (
      _e,
      args: {
        eventType: string;
        detail: string;
        actorUserId: string;
        actorRole: ActorRole;
        approvalId?: string;
        approverUserId?: string;
        riskTier?: RiskTier;
        confidenceScore?: number;
        eventDescription?: string;
        threatLevel?: RiskTier;
      },
    ) => {
      logEvent({
        eventType: args.eventType,
        detail: args.detail,
        actorUserId: args.actorUserId,
        actorRole: args.actorRole,
        approvalId: args.approvalId,
        approverUserId: args.approverUserId,
        riskTier: args.riskTier,
        confidenceScore: args.confidenceScore,
        eventDescription: args.eventDescription,
        threatLevel: args.threatLevel,
      });
      return true;
    },
  );

  ipcMain.handle("audit:list", async (_e, limit = 200) => {
    const cap = Math.min(AUDIT_LIMIT, Math.max(limit, 250));
    let remoteRows: AuditRow[] = [];
    try {
      remoteRows = await listAuditRemote(cap);
    } catch (e) {
      console.warn("[main] audit:list: remote audit unavailable — merging local only:", e);
    }
    const localRows = getAuditRows();
    const merged = mergeAuditStreams(remoteRows, localRows);
    setAuditRows(merged.slice(0, AUDIT_LIMIT));
    return merged.slice(0, limit);
  });

  // ── Agent / HITL queue ───────────────────────
  ipcMain.handle(
    "agent:propose",
    async (
      _e,
      args: {
        action: AgentAction;
        requesterId: string;
        requesterRole: Role;
        evidence?: ApprovalEvidence;
      },
    ) => {
      const { action, requesterId, requesterRole, evidence } = args;
      const tier = classifyAction(action);

      if (tier === "high" || tier === "medium") {
        const request: ApprovalRequest = {
          id: randomUUID(),
          createdAt: Date.now(),
          requesterId,
          requesterRole,
          action,
          riskTier: tier,
          evidence,
          status: "pending",
        };
        const queue = await readQueueShared();
        await writeQueueShared([...queue, request]);
        logEvent({
          eventType: "action_proposed",
          detail: JSON.stringify({ approvalId: request.id, actionType: action.type }),
          actorUserId: requesterId,
          actorRole: requesterRole,
          approvalId: request.id,
          riskTier: tier,
          confidenceScore: action.confidence,
        });
        return { autoExecuted: false, tier, request };
      }

      const result = await executeAction(action);
      logEvent({
        eventType: result.ok ? "action_executed" : "action_hard_failed",
        detail: JSON.stringify({
          actionType: action.type,
          message: result.message,
          status: result.status,
          evidence: result.evidence ?? null,
        }),
        actorUserId: requesterId,
        actorRole: requesterRole,
        riskTier: tier,
        confidenceScore: action.confidence,
      });
      return { autoExecuted: true as const, tier, result };
    },
  );

  ipcMain.handle("agent:list-pending", async () =>
    (await readQueueShared()).filter((r) => r.status === "pending"),
  );

  ipcMain.handle("agent:list-history", async (_e, limit = 50) =>
    (await readQueueShared())
      .filter((r) => r.status !== "pending")
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, limit),
  );

  ipcMain.handle(
    "agent:approve",
    async (
      _e,
      args: { id: string; approverUserId: string; comment?: string },
    ) => {
      const q = await readQueueShared();
      const idx = q.findIndex((r) => r.id === args.id && r.status === "pending");
      if (idx === -1) throw new Error("Approval request not found or not pending");

      const req = q[idx];
      const isSelfApproval = req.requesterId === args.approverUserId;
      const mustSeparateApprover = req.requesterRole === "student";
      if (isSelfApproval && mustSeparateApprover) {
        throw new Error("Approver must be different from requester for HITL integrity.");
      }

      const target = dispatchTargetFor(req);
      const decided: ApprovalDecision = {
        decidedAt: Date.now(),
        decidedByUserId: args.approverUserId,
        comment: args.comment,
        ...(target ? { dispatch: { target, dispatchedAt: Date.now() } } : {}),
      };
      const updated: ApprovalRequest = {
        ...req,
        status: "approved",
        decision: decided,
      };
      const next = [...q];
      next[idx] = updated;
      await writeQueueShared(next);

      logEvent({
        eventType: "action_approved",
        detail: JSON.stringify({ approvalId: req.id, actionType: req.action.type }),
        actorUserId: args.approverUserId,
        actorRole: "admin",
        approvalId: req.id,
        approverUserId: args.approverUserId,
        riskTier: req.riskTier,
      });

      if (target) {
        const message = `Approved. Sent to ${describeDispatchTarget(target)}; it runs there within about ${Math.round(DISPATCH_POLL_MS / 1000)} seconds while that student is signed in and online.`;
        logEvent({
          eventType: "action_dispatched",
          detail: JSON.stringify({ approvalId: req.id, actionType: req.action.type, target }),
          actorUserId: args.approverUserId,
          actorRole: "admin",
          approvalId: req.id,
          approverUserId: args.approverUserId,
          riskTier: req.riskTier,
        });
        return {
          request: updated,
          result: { ok: true, status: "dispatched" as const, message },
        };
      }

      const approvedAction: AgentAction = {
        ...req.action,
        payload: {
          ...req.action.payload,
          approvalId: req.id,
          approvedBy: args.approverUserId,
        },
      };
      const result = await executeAction(approvedAction);
      logEvent({
        eventType: result.ok ? "action_executed" : "action_hard_failed",
        detail: JSON.stringify({
          approvalId: req.id,
          message: result.message,
          status: result.status,
          evidence: result.evidence ?? null,
        }),
        actorUserId: args.approverUserId,
        actorRole: "admin",
        approvalId: req.id,
        approverUserId: args.approverUserId,
        riskTier: req.riskTier,
      });

      return { request: updated, result };
    },
  );

  // ── Security policy helpers ───────────────────
  ipcMain.handle("security:list-blocked-domains", async () => readBlockedDomainsShared());

  ipcMain.handle("audit:verify-integrity", () => {
    const report = verifyAuditChain(getAuditRows());
    // The verification itself is an auditable act: record who checked and what
    // the result was, so integrity checks are part of the trail they inspect.
    const session = store.get("session");
    logEvent({
      eventType: report.ok ? "audit_integrity_verified" : "audit_integrity_failed",
      detail: JSON.stringify({
        rowsChecked: report.rowsChecked,
        brokenRowId: report.brokenRowId,
        reason: report.reason,
      }),
      actorUserId: session?.userId ?? "system",
      actorRole: session?.role ?? "system",
      riskTier: report.ok ? "low" : "high",
    });
    return report;
  });

  ipcMain.handle("security:list-quarantined-usb", () => {
    const v = store.get("quarantinedUsbEvents") as
      | Array<{ at: number; device: string; reason: string; approvalId?: string }>
      | undefined;
    return Array.isArray(v) ? [...v].sort((a, b) => b.at - a.at) : [];
  });

  ipcMain.handle("security:check-url", async (_e, rawUrl: string) => {
    const domain = normalizeDomain(rawUrl);
    if (!domain) {
      return { ok: false, blocked: false, domain: "", reason: "invalid_url" as const };
    }
    const blockedDomains = await readBlockedDomainsShared();
    const blocked = blockedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
    return {
      ok: true,
      blocked,
      domain,
      reason: blocked ? ("policy_blocked" as const) : ("allowed" as const),
    };
  });

  ipcMain.handle(
    "agent:reject",
    async (
      _e,
      args: { id: string; approverUserId: string; comment?: string },
    ) => {
      const q = await readQueueShared();
      const idx = q.findIndex((r) => r.id === args.id && r.status === "pending");
      if (idx === -1) throw new Error("Approval request not found or not pending");

      const req = q[idx];
      const updated: ApprovalRequest = {
        ...req,
        status: "rejected",
        decision: {
          decidedAt: Date.now(),
          decidedByUserId: args.approverUserId,
          comment: args.comment,
        },
      };
      const next = [...q];
      next[idx] = updated;
      await writeQueueShared(next);

      logEvent({
        eventType: "action_rejected",
        detail: JSON.stringify({ approvalId: req.id }),
        actorUserId: args.approverUserId,
        actorRole: "admin",
        approvalId: req.id,
        approverUserId: args.approverUserId,
        riskTier: "high",
      });

      return updated;
    },
  );

  ipcMain.handle(
    "agent:request-info",
    async (_e, args: { id: string; byUserId: string; text: string }) => {
      const q = await readQueueShared();
      const idx = q.findIndex((r) => r.id === args.id && r.status === "pending");
      if (idx === -1) throw new Error("Approval request not found or not pending");

      const req = q[idx];
      const comments = [...(req.comments ?? [])];
      comments.push({ at: Date.now(), byUserId: args.byUserId, text: args.text });
      const updated: ApprovalRequest = {
        ...req,
        status: "info_requested",
        comments,
      };
      const next = [...q];
      next[idx] = updated;
      await writeQueueShared(next);

      logEvent({
        eventType: "action_info_requested",
        detail: args.text.slice(0, 500),
        actorUserId: args.byUserId,
        actorRole: "admin",
        approvalId: req.id,
        approverUserId: args.byUserId,
        riskTier: "high",
      });

      return updated;
    },
  );

  // ── App info ────────────────────────────────
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:platform", () => process.platform);
}

// ─────────────────────────────────────────────
//  App lifecycle
// ─────────────────────────────────────────────
app.whenReady().then(() => {
  registerIpcHandlers();
  try {
    ensureVaultExists(app);
  } catch (e) {
    console.error("[main] Runa_Folder vault init:", e);
  }
  startPythonService();
  mainWindow = createMainWindow();
  tray = createTray();
  syncStudentRuntimeEnforcement();
  setInterval(() => void pollDispatchedActions(), DISPATCH_POLL_MS);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  // On macOS keep the process alive; on Windows/Linux quit
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  try {
    const session = store.get("session") as StoreSchema["session"];
    if (session?.role === "student" && session.userId) {
      const profile = getLabStationProfile();
      closeLocalOpenAttendanceSession(session.userId, profile.comlabId);
      // Best-effort; don't block app quit on a network round trip.
      void attendanceCheckOutCloud(session.userId, profile.comlabId).catch(() => {});
    }
  } catch (e) {
    console.warn("[main] before-quit: attendance checkout failed:", e);
  }
  if (stopStudentEnforcement) {
    stopStudentEnforcement();
    stopStudentEnforcement = null;
  }
  stopPythonService();
});

// Prevent multiple app instances
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
