import { useState, useEffect, useCallback, useMemo } from "react";
import { useElectron } from "../ipc/useElectron";
import { useAdminLab } from "../context/AdminLabContext";
import { COMLAB_DEFINITIONS, getComlab } from "../data/comlabs";
import { ADMIN_FONT_MONO, ADMIN_FONT_SANS, ADMIN_HEADER_TITLE_SIZE, ADMIN_PANEL_CLASS, ADMIN_PANEL_STYLE } from "./admin/adminUiTokens";
import {
  Download,
  Filter,
  CheckCircle,
  AlertTriangle,
  Shield,
  Search,
  FolderLock,
  GitBranch,
  Bot,
} from "lucide-react";
import {
  formatRunaEventSubtitle,
  formatRunaEventTitle,
  runaRowMatchesFilter,
  runaRowMatchesSearch,
  type RunaAuditCategory,
} from "./audit/runaAuditFormat";
import type { ElectronAttendanceSessionRow } from "../../types/electron";

const MONO = ADMIN_FONT_MONO;
const GROTESK = ADMIN_FONT_SANS;

const AUDIT_LAB_KEYS = COMLAB_DEFINITIONS.map((c) => c.auditLogKey);

type SecurityEvent =
  | { type: "scan"; label: string; color: string }
  | { type: "blocked"; label: string; color: string }
  | { type: "monitoring"; label: string; color: string }
  | { type: "identity"; label: string; color: string };

interface StationLog {
  id: string;
  station: string;
  student: string;
  studentId: string;
  inTime: string;
  outTime: string | null;
  /** YYYY-MM-DD for time-out row (may differ from session `date`) */
  outDate?: string | null;
  /** Session calendar date (YYYY-MM-DD) for institutional date filter */
  date: string;
  event: SecurityEvent;
  comlab?: string;
  professor?: string;
}

function mapEventType(eventType: string): SecurityEvent {
  if (
    eventType.includes("blocked") ||
    eventType.includes("hard_failed") ||
    eventType.includes("runa_files_error")
  ) {
    return { type: "blocked", label: "Policy / error", color: "#e05c6a" };
  }
  if (eventType.includes("runa_files")) {
    return { type: "scan", label: "Runa vault", color: "#4ac77e" };
  }
  if (eventType.includes("scan")) return { type: "scan", label: "System Scan", color: "#4ac77e" };
  if (eventType.includes("presence")) return { type: "identity", label: "Presence Heartbeat", color: "#4a6fa5" };
  if (eventType === "login") return { type: "identity", label: "Login", color: "#4ac77e" };
  if (eventType === "logout") return { type: "identity", label: "Logout", color: "#7eb5f5" };
  return { type: "monitoring", label: "Monitoring Event", color: "#4a6fa5" };
}

function mapAttendanceSessionEvent(checkedOut: boolean): SecurityEvent {
  if (!checkedOut) return { type: "scan", label: "In lab", color: "#4ac77e" };
  return { type: "identity", label: "Checked out", color: "#7eb5f5" };
}

function EventBadge({ event }: { event: SecurityEvent }) {
  const icons: Record<string, React.ReactNode> = {
    scan: <CheckCircle size={10} />,
    blocked: <AlertTriangle size={10} />,
    monitoring: <Shield size={10} />,
    identity: <Shield size={10} />,
  };
  if (event.type === "blocked") {
    return (
      <span
        className="flex items-center gap-1 px-2 py-1 rounded"
        style={{ background: event.color + "25", color: event.color, fontSize: "9px", fontFamily: MONO, border: `1px solid ${event.color}50` }}
      >
        {icons[event.type]}
        {event.label.toUpperCase()}
      </span>
    );
  }
  return (
    <div className="flex items-center gap-1.5">
      <div className="w-2 h-2 rounded-full" style={{ background: event.color }} />
      <span style={{ color: "#c5d5ea", fontSize: "10px" }}>{event.label}</span>
    </div>
  );
}

type AuditSurface = "hardware" | "runa";

interface RunaAuditRow {
  id: number;
  createdAt: number;
  eventType: string;
  detail: string;
  actorUserId: string;
  actorRole?: string;
  riskTier?: string;
  approvalId?: string;
  approverUserId?: string;
  confidenceScore?: number;
  eventDescription?: string;
  threatLevel?: string;
}

const RUNA_PAGE_SIZE = 14;

const RUNA_FILTER_CHIPS: { id: RunaAuditCategory; label: string; icon: typeof FolderLock }[] = [
  { id: "all", label: "All", icon: Shield },
  { id: "vault", label: "Vault / files", icon: FolderLock },
  { id: "hitl", label: "HITL / actions", icon: GitBranch },
  { id: "assistant", label: "Assistant", icon: Bot },
];

const INSTITUTIONAL_PAGE_SIZE = 10;

/** RFC 4180–style escaping; BOM helps Excel on Windows recognize UTF-8. */
function escapeCsvCell(value: string | number | null | undefined): string {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildCsv(rows: Array<Array<string | number | null | undefined>>): string {
  const lines = rows.map((r) => r.map(escapeCsvCell).join(","));
  return `\uFEFF${lines.join("\r\n")}`;
}

function triggerCsvDownload(filename: string, csvText: string): void {
  const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function AuditTrailsPanel() {
  const electron = useElectron();
  const { labId, setLabId } = useAdminLab();
  const [surface, setSurface] = useState<AuditSurface>("hardware");
  const [runaRows, setRunaRows] = useState<RunaAuditRow[]>([]);
  const [activeTab, setActiveTab] = useState(COMLAB_DEFINITIONS[0].auditLogKey);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [runaFilter, setRunaFilter] = useState<RunaAuditCategory>("all");
  const [runaSearch, setRunaSearch] = useState("");
  const [runaPage, setRunaPage] = useState(1);
  const [showDateFilter, setShowDateFilter] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [institutionalLogs, setInstitutionalLogs] = useState<StationLog[]>([]);

  const refreshRuna = useCallback(async () => {
    try {
      const rows = await electron.audit.list(200);
      setRunaRows(rows as RunaAuditRow[]);
    } catch {
      setRunaRows([]);
    }
  }, [electron]);

  useEffect(() => {
    if (surface !== "runa") return;
    void refreshRuna();
  }, [surface, refreshRuna]);

  const loadInstitutionalAttendance = useCallback(async () => {
    const def = COMLAB_DEFINITIONS.find((c) => c.auditLogKey === activeTab);
    const comlabId = def?.id ?? "08";
    try {
      const raw = await electron.attendance.list(comlabId, 500);
      const items: { log: StationLog; ms: number }[] = [];
      for (const r of raw as ElectronAttendanceSessionRow[]) {
        const timeIn = String(r.timeIn ?? "");
        const timeOutRaw = r.timeOut;
        const timeOut =
          timeOutRaw != null && String(timeOutRaw).length > 0 ? String(timeOutRaw) : null;
        const ms = Date.parse(timeIn);
        if (!Number.isFinite(ms)) continue;
        const dtIn = new Date(ms);
        const date = dtIn.toISOString().slice(0, 10);
        const inStr = dtIn.toLocaleTimeString("en-GB", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        });
        let outStr: string | null = null;
        let outDate: string | null = null;
        if (timeOut) {
          const mo = Date.parse(timeOut);
          if (Number.isFinite(mo)) {
            const odt = new Date(mo);
            outDate = odt.toISOString().slice(0, 10);
            outStr = odt.toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
          }
        }
        const email = String(r.studentEmail ?? "");
        items.push({
          ms,
          log: {
            id: `att-${r.id}`,
            station: String(r.workstationLabel ?? "—"),
            student: email,
            studentId: email,
            inTime: inStr,
            outTime: outStr,
            outDate,
            date,
            comlab: String(r.comlabLabel ?? def?.label ?? ""),
            professor: String(r.professorName ?? ""),
            event: mapAttendanceSessionEvent(Boolean(timeOut)),
          },
        });
      }
      items.sort((a, b) => b.ms - a.ms);
      setInstitutionalLogs(items.map((x) => x.log));
    } catch {
      setInstitutionalLogs([]);
    }
  }, [electron, activeTab]);

  useEffect(() => {
    if (surface !== "hardware") return;
    void loadInstitutionalAttendance();
  }, [surface, loadInstitutionalAttendance]);

  useEffect(() => {
    setActiveTab(getComlab(labId).auditLogKey);
  }, [labId]);

  const filtered = institutionalLogs.filter((l) => {
    const matchesSearch =
      l.student.toLowerCase().includes(search.toLowerCase()) ||
      l.station.toLowerCase().includes(search.toLowerCase()) ||
      l.studentId.includes(search) ||
      (l.comlab ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (l.professor ?? "").toLowerCase().includes(search.toLowerCase());

    const matchesDate = (() => {
      if (!dateFrom && !dateTo) return true;
      const rowDate = l.date;
      if (!rowDate) return true;
      if (dateFrom && rowDate < dateFrom) return false;
      if (dateTo && rowDate > dateTo) return false;
      return true;
    })();

    return matchesSearch && matchesDate;
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / INSTITUTIONAL_PAGE_SIZE));
  const paged = filtered.slice((page - 1) * INSTITUTIONAL_PAGE_SIZE, page * INSTITUTIONAL_PAGE_SIZE);

  const runaSorted = useMemo(
    () => [...runaRows].sort((a, b) => b.createdAt - a.createdAt),
    [runaRows],
  );

  const runaFiltered = useMemo(
    () =>
      runaSorted.filter(
        (row) => runaRowMatchesFilter(row, runaFilter) && runaRowMatchesSearch(row, runaSearch),
      ),
    [runaSorted, runaFilter, runaSearch],
  );

  const runaTotalPages = Math.max(1, Math.ceil(runaFiltered.length / RUNA_PAGE_SIZE));
  const runaPaged = runaFiltered.slice((runaPage - 1) * RUNA_PAGE_SIZE, runaPage * RUNA_PAGE_SIZE);

  useEffect(() => {
    setRunaPage(1);
  }, [runaFilter, runaSearch]);

  return (
    <div className="runa-admin-view h-full overflow-y-auto" style={{ background: "rgba(255,255,255,0.24)", fontFamily: GROTESK }}>
      <div className="sticky top-0 z-[var(--z-banner)] flex gap-2 px-4 py-2 border-b border-white/60" style={{ background: "rgba(255,255,255,0.42)" }}>
        <button
          type="button"
          onClick={() => setSurface("hardware")}
          className="px-3 py-1.5 rounded border transition-colors"
          style={{
            fontFamily: MONO,
            fontSize: "10px",
            borderColor: surface === "hardware" ? "#4169e1" : "#cbd5f0",
            color: surface === "hardware" ? "#3156b8" : "#6474a2",
            background: surface === "hardware" ? "#e0eaff" : "rgba(255,255,255,0.42)",
          }}
        >
          Institutional attendance
        </button>
        <button
          type="button"
          onClick={() => {
            setSurface("runa");
            setRunaPage(1);
          }}
          className="px-3 py-1.5 rounded border transition-colors"
          style={{
            fontFamily: MONO,
            fontSize: "10px",
            borderColor: surface === "runa" ? "#4169e1" : "#cbd5f0",
            color: surface === "runa" ? "#3156b8" : "#6474a2",
            background: surface === "runa" ? "#e0eaff" : "rgba(255,255,255,0.42)",
          }}
        >
          RUNA agent / HITL log
        </button>
      </div>

      {surface === "runa" ? (
        <div className="p-6 space-y-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="space-y-2 max-w-2xl">
              <p className="text-[#c5d5ea]" style={{ fontSize: "13px", fontFamily: GROTESK }}>
                Governance-focused view: vault operations (Runa_Folder), human-in-the-loop actions, and assistant
                activity. Lab check-in / time-out rows live under{" "}
                <span className="text-[#7eb5f5]">Institutional attendance</span> (separate table), not here.
              </p>
              <div className="flex flex-wrap gap-2">
                {RUNA_FILTER_CHIPS.map(({ id, label, icon: Icon }) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setRunaFilter(id)}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded border transition-colors"
                    style={{
                      fontFamily: MONO,
                      fontSize: "9px",
                      borderColor: runaFilter === id ? "#3a6fff" : "#2a3a55",
                      color: runaFilter === id ? "#c5d5ea" : "#4a6080",
                      background: runaFilter === id ? "#162035" : "transparent",
                    }}
                  >
                    <Icon size={11} className="shrink-0 opacity-80" />
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2 items-stretch sm:items-end shrink-0">
              <div
                className="runa-admin-search-field flex items-center gap-2 px-3 py-1.5 rounded-md w-full sm:w-56"
                style={{ background: "rgba(247,248,253,0.92)", border: "1px solid rgba(99,102,241,0.18)" }}
              >
                <Search size={12} className="text-[#4a6080] shrink-0" />
                <input
                  value={runaSearch}
                  onChange={(e) => setRunaSearch(e.target.value)}
                  placeholder="Search events, paths…"
                  className="bg-transparent outline-none text-[#17233d] placeholder-[#8b96b0] w-full min-w-0"
                  style={{ fontSize: "11px", fontFamily: MONO }}
                />
              </div>
              <button
                type="button"
                onClick={() => void refreshRuna()}
                className="px-3 py-1.5 rounded border text-[#4169e1] bg-white/45 hover:bg-[#eef2ff] transition-colors"
                style={{ fontSize: "10px", fontFamily: MONO, borderColor: "#cbd5f0" }}
              >
                Refresh
              </button>
              <button
                type="button"
                onClick={() => {
                  const stamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "").replace("T", "_");
                  const rows: Array<Array<string | number | null | undefined>> = [
                    [
                      "id",
                      "created_at_iso",
                      "event_type",
                      "summary",
                      "detail_line",
                      "actor_user_id",
                      "actor_role",
                      "risk_tier",
                      "threat_level",
                      "approval_id",
                      "approver_user_id",
                      "confidence",
                      "detail_raw",
                    ],
                    ...runaFiltered.map((row) => {
                      const title = formatRunaEventTitle(row);
                      const subtitle = formatRunaEventSubtitle(row);
                      return [
                        row.id,
                        new Date(row.createdAt).toISOString(),
                        row.eventType,
                        row.approverUserId ? `${title} (by ${row.approverUserId})` : title,
                        subtitle,
                        row.actorUserId,
                        row.actorRole ?? "",
                        row.riskTier ?? "",
                        row.threatLevel ?? "",
                        row.approvalId ?? "",
                        row.approverUserId ?? "",
                        row.confidenceScore ?? "",
                        row.detail,
                      ];
                    }),
                  ];
                  triggerCsvDownload(`runa_audit_${runaFilter}_${stamp}.csv`, buildCsv(rows));
                }}
                disabled={runaFiltered.length === 0}
                className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded border transition-colors bg-white/45 hover:bg-[#eef2ff] disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ borderColor: "#cbd5f0", color: "#4169e1", fontSize: "10px", fontFamily: MONO }}
              >
                <Download size={11} />
                Export CSV ({runaFiltered.length})
              </button>
            </div>
          </div>
          <div className={`${ADMIN_PANEL_CLASS} overflow-hidden`} style={ADMIN_PANEL_STYLE}>
            <div
              className="grid px-4 py-2 border-b border-[#dfe6f7] bg-white/35 text-[#6474a2] uppercase tracking-widest"
              style={{
                fontSize: "8px",
                fontFamily: MONO,
                gridTemplateColumns: "52px 124px minmax(0,1fr) 80px 52px 80px 52px",
              }}
            >
              <span>ID</span>
              <span>Time</span>
              <span>Event</span>
              <span>Actor</span>
              <span>Risk</span>
              <span>Approval</span>
              <span>Conf</span>
            </div>
            {runaRows.length === 0 ? (
              <p className="py-8 text-center text-[#4a6080]" style={{ fontSize: "11px", fontFamily: MONO }}>
                No audit rows yet. Log in, use the assistant, Runa_Folder tools, file scan, or approvals queue.
              </p>
            ) : runaFiltered.length === 0 ? (
              <p className="py-8 text-center text-[#4a6080]" style={{ fontSize: "11px", fontFamily: MONO }}>
                No rows match this filter or search. Try &quot;All&quot; or clear the search box.
              </p>
            ) : (
              runaPaged.map((row) => {
                const title = formatRunaEventTitle(row);
                const subtitle = formatRunaEventSubtitle(row);
                const fullTip = [title, subtitle, row.detail].filter(Boolean).join("\n\n");
                return (
                  <div
                    key={row.id}
                    className="grid px-4 py-2 border-b border-[#1a2640] items-start gap-x-1"
                    style={{
                      gridTemplateColumns: "52px 124px minmax(0,1fr) 80px 52px 80px 52px",
                      fontSize: "10px",
                      fontFamily: MONO,
                    }}
                  >
                    <span className="text-[#7eb5f5]">{row.id}</span>
                    <span className="text-[#4a6080]">
                      {new Date(row.createdAt).toLocaleString("en-GB", {
                        day: "2-digit",
                        month: "short",
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}
                    </span>
                    <div className="min-w-0" title={fullTip.length > 400 ? `${fullTip.slice(0, 400)}…` : fullTip}>
                      <span className="text-[#c5d5ea] block break-words">
                        {title}
                        {row.approverUserId ? (
                          <span className="text-[#4a6080]"> · by {row.approverUserId}</span>
                        ) : null}
                      </span>
                      <span className="text-[#4a6080] block break-all mt-0.5" style={{ fontSize: "9px" }}>
                        {subtitle}
                      </span>
                    </div>
                    <span className="text-[#4a6080] truncate" title={row.actorUserId}>
                      {row.actorUserId}
                    </span>
                    <span className="text-[#a06820]">{row.riskTier ?? row.threatLevel ?? "—"}</span>
                    <span className="text-[#2a3a55] truncate" title={row.approvalId ?? ""}>
                      {row.approvalId ? row.approvalId.slice(0, 8) : "—"}
                    </span>
                    <span className="text-[#2a3a55]">
                      {typeof row.confidenceScore === "number" ? row.confidenceScore.toFixed(2) : "—"}
                    </span>
                  </div>
                );
              })
            )}
            {runaFiltered.length > 0 ? (
              <div className="flex items-center justify-between px-4 py-3 border-t border-[#1a2640]">
                <span style={{ color: "#4a6080", fontSize: "10px", fontFamily: MONO }}>
                  {(runaPage - 1) * RUNA_PAGE_SIZE + 1}–
                  {(runaPage - 1) * RUNA_PAGE_SIZE + runaPaged.length} of {runaFiltered.length} (page {runaPage} /
                  {runaTotalPages})
                </span>
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setRunaPage((p) => Math.max(1, p - 1))}
                    disabled={runaPage === 1}
                    style={{
                      color: runaPage === 1 ? "#2a3a55" : "#7eb5f5",
                      fontSize: 10,
                      fontFamily: MONO,
                      background: "none",
                      border: "none",
                      cursor: runaPage === 1 ? "not-allowed" : "pointer",
                      padding: "0 4px",
                    }}
                  >
                    PREV
                  </button>
                  <button
                    type="button"
                    onClick={() => setRunaPage((p) => Math.min(runaTotalPages, p + 1))}
                    disabled={runaPage === runaTotalPages}
                    style={{
                      color: runaPage === runaTotalPages ? "#2a3a55" : "#7eb5f5",
                      fontSize: 10,
                      fontFamily: MONO,
                      background: "none",
                      border: "none",
                      cursor: runaPage === runaTotalPages ? "not-allowed" : "pointer",
                      padding: "0 4px",
                    }}
                  >
                    NEXT
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
      <>
      {/* Header */}
      <div className="px-7 pt-5 pb-4 border-b border-white/60" style={{ background: "rgba(255,255,255,0.38)" }}>
        <div className="flex items-start justify-between">
          <div>
            <p className="text-[#4a6080] tracking-widest uppercase mb-2" style={{ fontSize: "8px", fontFamily: MONO }}>
              Institutional Resource Monitor
            </p>
            <h1 className="text-[#c5d5ea]" style={{ fontSize: ADMIN_HEADER_TITLE_SIZE, lineHeight: 1.15 }}>
              Laboratory Attendance &amp;<br />Security Log
            </h1>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex items-center gap-6 mt-5">
          {AUDIT_LAB_KEYS.map((lab) => (
            <button
              key={lab}
              type="button"
              onClick={() => {
                setActiveTab(lab);
                setPage(1);
                const d = COMLAB_DEFINITIONS.find((c) => c.auditLogKey === lab);
                if (d) setLabId(d.id);
              }}
              className="transition-all pb-1"
              style={{
                color: activeTab === lab ? "#c5d5ea" : "#4a6080",
                fontSize: "12px",
                fontFamily: MONO,
                borderBottom: activeTab === lab ? "2px solid #3a6fff" : "2px solid transparent",
              }}
            >
              {lab}
            </button>
          ))}
          <div className="ml-auto flex items-center gap-3">
            <button
              onClick={() => setShowDateFilter(!showDateFilter)}
              className="flex items-center gap-2 px-3 py-1.5 rounded-md border transition-colors hover:bg-[#1e2e48]"
              style={{ borderColor: "#2a3a55", color: "#7eb5f5" }}
            >
              <Filter size={12} />
              <span style={{ fontSize: "10px", fontFamily: MONO }}>FILTER BY DATE</span>
            </button>
          </div>
        </div>
      </div>

      {/* Date Filter Panel */}
      {showDateFilter && (
        <div className="px-7 py-4 border-b border-white/60" style={{ background: "rgba(255,255,255,0.46)" }}>
          <div className="flex items-center gap-4">
            <div>
              <label className="block text-[#4a6080] tracking-widest uppercase mb-2" style={{ fontSize: "8px", fontFamily: MONO }}>
                FROM DATE
              </label>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="px-3 py-1.5 rounded-md border bg-transparent text-[#c5d5ea]"
                style={{ borderColor: "#2a3a55", fontSize: "11px", fontFamily: MONO }}
              />
            </div>
            <div>
              <label className="block text-[#4a6080] tracking-widest uppercase mb-2" style={{ fontSize: "8px", fontFamily: MONO }}>
                TO DATE
              </label>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="px-3 py-1.5 rounded-md border bg-transparent text-[#c5d5ea]"
                style={{ borderColor: "#2a3a55", fontSize: "11px", fontFamily: MONO }}
              />
            </div>
            <button
              type="button"
              onClick={() => {
                setPage(1);
                setShowDateFilter(false);
              }}
              className="mt-6 px-4 py-1.5 rounded-md border transition-colors hover:bg-[#3a6fff]"
              style={{ borderColor: "#3a6fff", color: "#7eb5f5", fontSize: "10px", fontFamily: MONO }}
            >
              APPLY FILTER
            </button>
            <button
              type="button"
              onClick={() => {
                setDateFrom("");
                setDateTo("");
                setPage(1);
              }}
              className="mt-6 px-4 py-1.5 rounded-md border transition-colors hover:bg-[#1e2e48]"
              style={{ borderColor: "#2a3a55", color: "#c5d5ea", fontSize: "10px", fontFamily: MONO }}
            >
              ALL DATES
            </button>
            <button
              onClick={() => setShowDateFilter(false)}
              className="mt-6 px-4 py-1.5 rounded-md border transition-colors hover:bg-[#1e2e48]"
              style={{ borderColor: "#2a3a55", color: "#4a6080", fontSize: "10px", fontFamily: MONO }}
            >
              CLOSE
            </button>
            <div className="ml-auto mt-6">
              <span className="text-[#4a6080]" style={{ fontSize: "10px", fontFamily: MONO }}>
                {dateFrom || dateTo
                  ? `Selected range: ${dateFrom || "…"} → ${dateTo || "…"}`
                  : "No date restriction (showing all loaded rows)"}
              </span>
            </div>
          </div>
        </div>
      )}

      <div className="p-6">
        <div>
          <div className={`${ADMIN_PANEL_CLASS} overflow-x-auto overflow-y-hidden`} style={ADMIN_PANEL_STYLE}>
            {/* Table header */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between px-5 py-4 border-b border-[#1a2640]">
              <div className="min-w-0 flex-1">
                <span className="text-[#c5d5ea] block" style={{ fontSize: "13px" }}>
                  Station logs: {activeTab.toUpperCase()}
                </span>
                <p className="text-[#4a6080] mt-1 max-w-xl" style={{ fontSize: "10px", fontFamily: MONO }}>
                  Pulled from Supabase <span className="text-[#7eb5f5]">lab_attendance_sessions</span>. Use{" "}
                  <span className="text-[#c5d5ea]">Filter by date</span> only when you want to narrow the range (defaults
                  to all dates).
                </p>
              </div>
              <div className="flex items-center gap-3 shrink-0 flex-wrap justify-end">
                {/* Search */}
                <div
                  className="runa-admin-search-field flex items-center gap-2 px-3 py-1.5 rounded-md"
                  style={{ background: "rgba(247,248,253,0.94)", border: "1px solid rgba(99,102,241,0.2)" }}
                >
                  <Search size={12} className="text-[#4a6080]" />
                  <input
                    value={search}
                    onChange={(e) => {
                      setSearch(e.target.value);
                      setPage(1);
                    }}
                    placeholder="Email, PC, comlab, professor…"
                    className="bg-transparent outline-none text-[#17233d] placeholder-[#8b96b0]"
                    style={{ fontSize: "11px", fontFamily: MONO, width: "min(220px, 38vw)" }}
                  />
                </div>
                <button
                  type="button"
                  onClick={() => void loadInstitutionalAttendance()}
                  className="px-3 py-1.5 rounded-md border transition-colors hover:bg-[#1e2e48]"
                  style={{ borderColor: "#2a3a55", color: "#7eb5f5", fontSize: "10px", fontFamily: MONO }}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const stamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "").replace("T", "_");
                    const rows: Array<Array<string | number | null | undefined>> = [
                      [
                        "Comlab",
                        "PC",
                        "Student email",
                        "Professor",
                        "Date",
                        "Time in",
                        "Time out",
                        "Status",
                      ],
                      ...filtered.map((log) => [
                        log.comlab ?? "",
                        log.station,
                        log.student,
                        log.professor ?? "",
                        log.date,
                        log.inTime,
                        log.outTime ?? "",
                        log.event.label,
                      ]),
                    ];
                    triggerCsvDownload(
                      `${activeTab.replace(/\s+/g, "_")}_attendance_${dateFrom}_${dateTo}_${stamp}.csv`,
                      buildCsv(rows),
                    );
                  }}
                  disabled={filtered.length === 0}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border transition-colors hover:bg-[#1e2e48] disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ borderColor: "#2a3a55", color: "#7eb5f5", fontSize: "10px", fontFamily: MONO }}
                >
                  <Download size={11} />
                  Export CSV ({filtered.length})
                </button>
              </div>
            </div>

            {/* Column headers */}
            <div
              className="grid px-5 py-2 gap-x-2"
              style={{
                gridTemplateColumns:
                  "minmax(72px,0.75fr) minmax(52px,0.55fr) minmax(120px,1.15fr) minmax(96px,1fr) minmax(76px,0.7fr) minmax(76px,0.7fr) minmax(64px,0.65fr)",
                background: "rgba(247,248,253,0.82)",
                borderBottom: "1px solid rgba(99,102,241,0.16)",
              }}
            >
              {["COMLAB", "PC", "EMAIL", "PROFESSOR", "TIME IN", "TIME OUT", "STATUS"].map((col) => (
                <span key={col} className="text-[#4a6080] tracking-widest" style={{ fontSize: "8px", fontFamily: MONO }}>
                  {col}
                </span>
              ))}
            </div>

            {/* Rows */}
            {paged.length === 0 ? (
              <div className="flex items-center justify-center py-12">
                <p className="text-[#4a6080]" style={{ fontSize: "11px", fontFamily: MONO }}>
                  No attendance rows yet.
                </p>
              </div>
            ) : (
              paged.map((log) => (
                <div
                  key={log.id}
                  className="grid items-start gap-x-2 px-5 py-3 border-b border-[#1a2640] hover:bg-[#162035] transition-colors"
                  style={{
                    gridTemplateColumns:
                      "minmax(72px,0.75fr) minmax(52px,0.55fr) minmax(120px,1.15fr) minmax(96px,1fr) minmax(76px,0.7fr) minmax(76px,0.7fr) minmax(64px,0.65fr)",
                  }}
                >
                  <span
                    className="text-[#7eb5f5] leading-tight break-words"
                    style={{ fontSize: "10px", fontFamily: MONO }}
                    title={log.comlab}
                  >
                    {log.comlab ?? "—"}
                  </span>
                  <span style={{ color: "#c5d5ea", fontSize: "10px", fontFamily: MONO }}>{log.station}</span>
                  <span
                    className="text-[#c5d5ea] break-all leading-tight"
                    style={{ fontSize: "10px", fontFamily: MONO }}
                    title={log.student}
                  >
                    {log.student}
                  </span>
                  <span
                    className="text-[#4a6080] leading-tight line-clamp-2"
                    style={{ fontSize: "9px", fontFamily: MONO }}
                    title={log.professor}
                  >
                    {log.professor ?? "—"}
                  </span>
                  <div>
                    <span className="text-[#4a6080] block" style={{ fontSize: "8px", fontFamily: MONO }}>
                      {log.date}
                    </span>
                    <span className="text-[#c5d5ea]" style={{ fontSize: "9px", fontFamily: MONO }}>
                      {log.inTime}
                    </span>
                  </div>
                  <div>
                    {log.outTime ? (
                      <>
                        <span className="text-[#4a6080] block" style={{ fontSize: "8px", fontFamily: MONO }}>
                          {log.outDate ?? log.date}
                        </span>
                        <span className="text-[#c5d5ea]" style={{ fontSize: "9px", fontFamily: MONO }}>
                          {log.outTime}
                        </span>
                      </>
                    ) : (
                      <span className="text-[#4a6080]" style={{ fontSize: "9px", fontFamily: MONO }}>
                        —
                      </span>
                    )}
                  </div>
                  <div className="min-w-0">
                    <EventBadge event={log.event} />
                  </div>
                </div>
              ))
            )}

            {/* Pagination */}
            <div className="flex items-center justify-between px-5 py-3">
              <span style={{ color: "#4a6080", fontSize: "10px", fontFamily: MONO }}>
                {filtered.length === 0
                  ? "0 rows"
                  : `${(page - 1) * INSTITUTIONAL_PAGE_SIZE + 1}–${(page - 1) * INSTITUTIONAL_PAGE_SIZE + paged.length} of ${filtered.length}`}
              </span>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  style={{
                    color: page === 1 ? "#2a3a55" : "#7eb5f5",
                    fontSize: 10,
                    fontFamily: MONO,
                    background: "none",
                    border: "none",
                    cursor: page === 1 ? "not-allowed" : "pointer",
                    padding: "0 4px",
                  }}
                >
                  PREV
                </button>
                <span style={{ color: "#4a6080", fontSize: "10px", fontFamily: MONO }}>
                  {page} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  style={{
                    color: page === totalPages ? "#2a3a55" : "#7eb5f5",
                    fontSize: 10,
                    fontFamily: MONO,
                    background: "none",
                    border: "none",
                    cursor: page === totalPages ? "not-allowed" : "pointer",
                    padding: "0 4px",
                  }}
                >
                  NEXT
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>

      </>
      )}
    </div>
  );
}
