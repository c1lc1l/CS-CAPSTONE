/**
 * agentic/sessionFeatures.ts
 *
 * Rolls a student's audit rows up into the session record the behavioural
 * anomaly model scores (ml/behavioral/features.py). The sidecar derives the
 * rate features from this record, so only raw counts and timings are built
 * here.
 *
 * Every count maps to an event type RUNA actually emits:
 *   heartbeats         presence_heartbeat
 *   blocked URLs       url_blocked, browser_policy_enforcement
 *   USB activity       usb_inserted, usb_auto_scan_complete, usb_auto_scan_threat
 *   app launches       lab_app_launch
 *   chat requests      chat_request
 *   tool invocations   tool_invoked
 *   file operations    runa_files_*, and runa_* vault actions
 *
 * Known gap: audit rows carry no workstation identifier, so
 * distinct_workstations is always 1 and the credential-sharing signal the
 * model was trained on cannot be observed from this data.
 */

export interface SessionAuditRow {
  createdAt: number;
  eventType: string;
  actorUserId: string;
  detail?: string;
}

export interface SessionRecord {
  session_duration_min: number;
  heartbeat_count: number;
  heartbeat_gap_mean_min: number;
  heartbeat_gap_max_min: number;
  start_hour: number;
  day_of_week: number;
  distinct_domains: number;
  blocked_url_count: number;
  usb_insert_count: number;
  app_launch_count: number;
  chat_request_count: number;
  tool_invoke_count: number;
  file_op_count: number;
  distinct_workstations: number;
  is_guest_account: boolean;
}

const SESSION_START_EVENTS = new Set(["login", "guest_access_login"]);
const BLOCKED_EVENTS = new Set(["url_blocked", "browser_policy_enforcement"]);
const USB_EVENTS = new Set(["usb_inserted", "usb_auto_scan_complete", "usb_auto_scan_threat"]);
const DOMAIN_EVENTS = new Set(["url_blocked", "url_flagged", "browser_policy_enforcement"]);

function parseDetail(detail?: string): Record<string, unknown> {
  if (!detail) return {};
  try {
    const parsed = JSON.parse(detail);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function isFileOp(row: SessionAuditRow): boolean {
  if (row.eventType.startsWith("runa_files_")) return true;
  if (row.eventType === "action_executed" || row.eventType === "action_proposed") {
    const d = parseDetail(row.detail);
    return typeof d.actionType === "string" && d.actionType.startsWith("runa_");
  }
  return false;
}

/**
 * Builds the session record for one student from their rows in the current
 * session - everything since their most recent login, or the whole window
 * if the login row has aged out of it.
 */
export function buildSessionRecord(
  allRows: SessionAuditRow[],
  userId: string,
  now: number = Date.now(),
): SessionRecord | null {
  const rows = allRows
    .filter((r) => r.actorUserId === userId && typeof r.createdAt === "number")
    .sort((a, b) => a.createdAt - b.createdAt);
  if (rows.length === 0) return null;

  let startIdx = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (SESSION_START_EVENTS.has(rows[i].eventType)) {
      startIdx = i;
      break;
    }
  }
  const session = rows.slice(startIdx);
  const start = session[0].createdAt;

  const heartbeats = session.filter((r) => r.eventType === "presence_heartbeat").map((r) => r.createdAt);
  const gapsMin: number[] = [];
  for (let i = 1; i < heartbeats.length; i++) {
    gapsMin.push((heartbeats[i] - heartbeats[i - 1]) / 60_000);
  }

  const domains = new Set<string>();
  for (const r of session) {
    if (!DOMAIN_EVENTS.has(r.eventType)) continue;
    const d = parseDetail(r.detail);
    const host = d.domain ?? d.host ?? d.url;
    if (typeof host === "string" && host) domains.add(host.toLowerCase());
  }

  const count = (pred: (r: SessionAuditRow) => boolean) => session.filter(pred).length;
  const started = new Date(start);

  return {
    session_duration_min: Math.max(0, (now - start) / 60_000),
    heartbeat_count: heartbeats.length,
    heartbeat_gap_mean_min: gapsMin.length ? gapsMin.reduce((a, b) => a + b, 0) / gapsMin.length : 0,
    heartbeat_gap_max_min: gapsMin.length ? Math.max(...gapsMin) : 0,
    start_hour: started.getHours(),
    // Python's weekday(): Monday = 0. JS getDay(): Sunday = 0.
    day_of_week: (started.getDay() + 6) % 7,
    distinct_domains: domains.size,
    blocked_url_count: count((r) => BLOCKED_EVENTS.has(r.eventType)),
    usb_insert_count: count((r) => USB_EVENTS.has(r.eventType)),
    app_launch_count: count((r) => r.eventType === "lab_app_launch"),
    chat_request_count: count((r) => r.eventType === "chat_request"),
    tool_invoke_count: count((r) => r.eventType === "tool_invoked"),
    file_op_count: count(isFileOp),
    distinct_workstations: 1,
    is_guest_account: userId.startsWith("guest-"),
  };
}
