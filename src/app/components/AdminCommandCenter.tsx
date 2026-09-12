import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bot,
  Download,
  FileText,
  Inbox,
  RefreshCw,
  Shield,
  ShieldAlert,
  Usb,
  Users,
} from "lucide-react";
import { animate } from "motion";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { COMLAB_IDS, buildMonitoringPcs, getComlab, type ComlabId } from "../data/comlabs";
import { PRESENCE_LIVE_WINDOW_MS as PRESENCE_WINDOW_MS } from "../constants/presence";
import { useAdminLab } from "../context/AdminLabContext";
import { useElectron } from "../ipc/useElectron";
import { useNotificationContext } from "../providers/NotificationProvider";
import { ADMIN_COMMAND_PANEL_CLASS, ADMIN_COMMAND_PANEL_STYLE, ADMIN_FONT_MONO, ADMIN_FONT_SANS } from "./admin/adminUiTokens";

const MONO = ADMIN_FONT_MONO;
const GROTESK = ADMIN_FONT_SANS;
const AI_HEALTH_TTL_MS = 120_000;

type ServiceStatus = "online" | "unknown" | "offline";
interface CommandAuditRow {
  id: number;
  createdAt: number;
  eventType: string;
  eventDescription?: string;
  threatLevel?: string;
  actorUserId: string;
  actorRole?: string;
  detail?: string;
}
let aiHealthCache: { at: number; status: ServiceStatus } | null = null;

function formatAgo(minutes: number): string {
  if (minutes < 0.5) return "just now";
  if (minutes < 1) return "under 1 min ago";
  return `${Math.round(minutes)} min ago`;
}

function DashboardKPICard({
  label,
  value,
  delta,
  icon: Icon,
  color,
  animKey,
}: {
  label: string;
  value: number;
  delta: number;
  icon: typeof Users;
  color: string;
  animKey: number;
}) {
  const [display, setDisplay] = useState(0);

  useEffect(() => {
    const controls = animate(0, value, {
      duration: 1.2,
      ease: [0.16, 1, 0.3, 1],
      onUpdate: (v) => setDisplay(Math.round(v)),
    });
    return () => controls.stop();
  }, [value, animKey]);

  const up = delta > 0;
  const flat = delta === 0;

  return (
    <div
      className={`${ADMIN_COMMAND_PANEL_CLASS} p-5 flex flex-col gap-3 min-h-0`}
      style={ADMIN_COMMAND_PANEL_STYLE}
    >
      <div className="flex items-start justify-between gap-2">
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: `${color}22` }}
        >
          <Icon size={18} style={{ color }} />
        </div>
        {!flat && (
          <span
            className="tabular-nums shrink-0"
            style={{
              fontSize: "10px",
              fontFamily: MONO,
              color: up ? "#4ac77e" : "#e05c6a",
            }}
          >
            {up ? "▲" : "▼"} {Math.abs(delta)}%
          </span>
        )}
      </div>
      <div className="text-[#c5d5ea] tabular-nums" style={{ fontSize: "28px", fontFamily: MONO, lineHeight: 1 }}>
        {display}
      </div>
      <p className="text-[#4a6080] mt-auto" style={{ fontSize: "11px", fontFamily: GROTESK }}>
        {label}
      </p>
    </div>
  );
}

function statusPillStyle(status: ServiceStatus): { bg: string; fg: string; label: string } {
  if (status === "online") return { bg: "#4ac77e22", fg: "#4ac77e", label: "ONLINE" };
  if (status === "unknown") return { bg: "#e8821a22", fg: "#e8821a", label: "UNKNOWN" };
  return { bg: "#e05c6a22", fg: "#e05c6a", label: "OFFLINE" };
}

export function SystemHealthWidget({
  onHealthResult,
  liveStudentCount,
  enabled = true,
}: {
  onHealthResult: (ok: boolean | null) => void;
  liveStudentCount: number;
  enabled?: boolean;
}) {
  const api = useElectron();
  const [rows, setRows] = useState<
    Array<{ name: string; status: ServiceStatus; icon: typeof Shield }>
  >([
    { name: "Security Service", status: "unknown", icon: Shield },
    { name: "AI Service", status: "unknown", icon: Bot },
    { name: "Audit Backend", status: "unknown", icon: FileText },
    { name: "Policy Backend", status: "unknown", icon: Usb },
    { name: "Student Sessions", status: "unknown", icon: Users },
  ]);

  const fetchHealth = useCallback(async () => {
    const next: Array<{ name: string; status: ServiceStatus; icon: typeof Shield }> = [
      { name: "Security Service", status: "unknown", icon: Shield },
      { name: "AI Service", status: "unknown", icon: Bot },
      { name: "Audit Backend", status: "unknown", icon: FileText },
      { name: "Policy Backend", status: "unknown", icon: Usb },
      { name: "Student Sessions", status: "unknown", icon: Users },
    ];
    let securityOnline = false;
    try {
      const r = await api.python.call<{ status?: string }>("/health", undefined, {
        method: "GET",
        timeoutMs: 4000,
      });
      const ok = !!(r.ok && r.data && (r.data as { status?: string }).status === "ok");
      onHealthResult(ok);
      next[0] = { ...next[0], status: ok ? "online" : "offline" };
      securityOnline = ok;
    } catch {
      onHealthResult(null);
      next[0] = { ...next[0], status: "offline" };
    }
    const cached = aiHealthCache;
    if (!securityOnline) {
      next[1] = { ...next[1], status: "offline" };
      aiHealthCache = { at: Date.now(), status: "offline" };
    } else if (cached && Date.now() - cached.at < AI_HEALTH_TTL_MS) {
      next[1] = { ...next[1], status: cached.status };
    } else {
      try {
        const ai = await api.python.call<{ ok?: boolean; response?: string; error?: string }>(
          "/ai-task",
          {
            prompt: "health-check",
            system: "Return one short token.",
            role: "admin",
            maxTokens: 8,
            temperature: 0,
          },
          { method: "POST", timeoutMs: 8000 },
        );
        const aiStatus: ServiceStatus = ai.ok ? "online" : "offline";
        next[1] = { ...next[1], status: aiStatus };
        aiHealthCache = { at: Date.now(), status: aiStatus };
      } catch {
        next[1] = { ...next[1], status: "offline" };
        aiHealthCache = { at: Date.now(), status: "offline" };
      }
    }
    try {
      await api.audit.list(1);
      next[2] = { ...next[2], status: "online" };
    } catch {
      next[2] = { ...next[2], status: "offline" };
    }
    try {
      await api.security.listBlockedDomains();
      next[3] = { ...next[3], status: "online" };
    } catch {
      next[3] = { ...next[3], status: "offline" };
    }
    next[4] = { ...next[4], status: liveStudentCount > 0 ? "online" : "unknown" };
    setRows(next);
  }, [api, liveStudentCount, onHealthResult]);

  useEffect(() => {
    if (!enabled) return;
    void fetchHealth();
    const id = window.setInterval(() => void fetchHealth(), 30_000);
    return () => window.clearInterval(id);
  }, [enabled, fetchHealth]);

  return (
    <div
      className={`${ADMIN_COMMAND_PANEL_CLASS} p-5 h-full flex flex-col gap-3 min-h-0`}
      style={ADMIN_COMMAND_PANEL_STYLE}
    >
      <p className="text-[#c5d5ea]" style={{ fontSize: "13px", fontFamily: GROTESK }}>
        System Health
      </p>
      <div className="space-y-2.5 flex-1">
        {rows.map((s) => {
          const Icon = s.icon;
          const st = statusPillStyle(s.status);
          return (
            <div key={s.name} className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2 min-w-0">
                <Icon size={14} className="text-[#7eb5f5] shrink-0" />
                <span className="text-[#c5d5ea] leading-tight" style={{ fontSize: "11px", fontFamily: MONO }}>
                  {s.name}
                </span>
              </div>
              <span
                className="px-2 py-0.5 rounded-full shrink-0 flex items-center gap-1.5"
                style={{ background: st.bg, color: st.fg, fontSize: "8px", fontFamily: MONO }}
              >
                {s.status === "online" && (
                  <span className="w-1.5 h-1.5 rounded-full bg-[#4ac77e] motion-safe:animate-pulse" />
                )}
                {st.label}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

type FeedType = "login" | "scan" | "threat" | "lock";

function feedDot(type: FeedType): string {
  if (type === "login") return "#3a6fff";
  if (type === "scan") return "#4ac77e";
  if (type === "threat") return "#e05c6a";
  return "#e8821a";
}

function LiveAuditFeed({
  items,
}: {
  items: Array<{ id: string; type: FeedType; station: string; user: string; msg: string; agoMin: number }>;
}) {
  return (
    <div
      className={`${ADMIN_COMMAND_PANEL_CLASS} p-5 h-full flex flex-col gap-3 min-h-0`}
      style={ADMIN_COMMAND_PANEL_STYLE}
    >
      <p className="text-[#c5d5ea]" style={{ fontSize: "13px", fontFamily: GROTESK }}>
        Live Audit Feed
      </p>
      <div className="space-y-3 flex-1 overflow-y-auto min-h-0">
        {items.map((e) => (
          <div key={e.id} className="flex gap-3 items-start">
            <span className="w-2 h-2 rounded-full mt-1 shrink-0" style={{ background: feedDot(e.type) }} />
            <div className="min-w-0 flex-1">
              <p className="text-[#c5d5ea]" style={{ fontSize: "11px" }}>
                {e.msg}
              </p>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1">
                <span className="text-[#2a3a55]" style={{ fontSize: "9px", fontFamily: MONO }}>
                  {formatAgo(e.agoMin)}
                </span>
                <span className="text-[#4a6080]" style={{ fontSize: "9px", fontFamily: MONO }}>
                  {e.station}
                </span>
                <span className="text-[#7eb5f5]" style={{ fontSize: "9px", fontFamily: MONO }}>
                  {e.user}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
function eventToFeedType(eventType: string): FeedType {
  if (eventType.includes("threat") || eventType.includes("blocked") || eventType.includes("hard_failed")) return "threat";
  if (eventType.includes("scan")) return "scan";
  if (eventType.includes("lock") || eventType.includes("terminate")) return "lock";
  return "login";
}

function extractStation(detail?: string): string {
  if (!detail) return "—";
  try {
    const parsed = JSON.parse(detail) as Record<string, unknown>;
    const station = parsed.station ?? parsed.pc ?? parsed.device;
    return typeof station === "string" ? station : "—";
  } catch {
    return "—";
  }
}

function describeAuditEvent(row: CommandAuditRow): string {
  if (row.eventDescription?.trim()) return row.eventDescription.trim();
  const event = row.eventType;
  const actor = row.actorUserId || "system";
  if (event === "presence_heartbeat") return `${actor} reported active session`;
  if (event.includes("url_blocked")) return `${actor} blocked URL by policy`;
  if (event.includes("usb_inserted")) return `${actor} inserted USB device`;
  if (event.includes("usb_scan_complete")) return `${actor} completed USB scan`;
  if (event.includes("quarantine_usb")) return `${actor} requested USB quarantine`;
  if (event.includes("containment_requested")) return `${actor} requested session containment`;
  if (event.includes("approved")) return `Approval decision recorded by ${actor}`;
  if (event.includes("rejected")) return `Request rejected by ${actor}`;
  if (event.includes("hard_failed")) return `Action hard-failed and was logged`;
  if (event.includes("blocked") || event.includes("threat")) return `Security threat event recorded`;
  return event.replaceAll("_", " ");
}

export function AdminCommandCenter({
  pendingCount,
}: {
  pendingCount: number;
}) {
  const { labId, setLabId } = useAdminLab();
  const { pushToast } = useNotificationContext();
  const electron = useElectron();
  const [lastRefreshed, setLastRefreshed] = useState(() => new Date());
  const [kpiAnimKey, setKpiAnimKey] = useState(0);
  const [auditRows, setAuditRows] = useState<CommandAuditRow[]>([]);

  const handleRefresh = useCallback(() => {
    setKpiAnimKey((k) => k + 1);
    setLastRefreshed(new Date());
  }, []);

  useEffect(() => {
    let alive = true;
    const loadAudit = async () => {
      try {
        const rows = (await electron.audit.list(200)) as CommandAuditRow[];
        if (!alive) return;
        setAuditRows(rows.sort((a, b) => b.createdAt - a.createdAt));
      } catch {
        if (alive) setAuditRows([]);
      }
    };
    void loadAudit();
    const t = window.setInterval(() => void loadAudit(), 15_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [electron]);

  const liveStudentCount = useMemo(() => {
    const cutoff = Date.now() - PRESENCE_WINDOW_MS;
    const ids = new Set(
      auditRows
        .filter(
          (r) =>
            r.eventType === "presence_heartbeat" &&
            r.actorRole === "student" &&
            typeof r.createdAt === "number" &&
            r.createdAt >= cutoff,
        )
        .map((r) => r.actorUserId)
        .filter(Boolean),
    );
    return ids.size;
  }, [auditRows]);

  const occupancyData = useMemo(
    () =>
      COMLAB_IDS.map((id) => {
        const def = getComlab(id);
        const capacity = buildMonitoringPcs(def).length;
        const occupied = id === labId ? Math.min(liveStudentCount, capacity) : 0;
        return { lab: def.label, occupied, capacity };
      }),
    [labId, liveStudentCount],
  );

  const liveFeedItems = useMemo(
    () =>
      auditRows.slice(0, 8).map((row) => ({
        id: String(row.id),
        type: eventToFeedType(row.eventType),
        station: extractStation(row.detail),
        user: row.actorUserId || "SYSTEM",
        msg: describeAuditEvent(row),
        agoMin: Math.max(0, (Date.now() - row.createdAt) / 60000),
      })),
    [auditRows],
  );

  const kpiRows = useMemo(
    () =>
      [
        {
          label: "Pending HITL",
          value: pendingCount,
          delta: 0,
          icon: Inbox,
          color: "#e8821a",
        },
        {
          label: "Critical Events (15m)",
          value: auditRows.filter(
            (r) =>
              r.createdAt >= Date.now() - 15 * 60 * 1000 &&
              (r.eventType.includes("hard_failed") || r.eventType.includes("blocked") || r.eventType.includes("threat")),
          ).length,
          delta: 0,
          icon: ShieldAlert,
          color: "#e05c6a",
        },
        {
          label: "Active Sessions (90s)",
          value: liveStudentCount,
          delta: 0,
          icon: Users,
          color: "#3a6fff",
        },
      ] as const,
    [auditRows, liveStudentCount, pendingCount],
  );

  const riskData = useMemo(() => {
    const riskWindowStart = Date.now() - 60 * 60 * 1000;
    let low = 0;
    let medium = 0;
    let high = 0;
    for (const row of auditRows) {
      if (row.createdAt < riskWindowStart) continue;
      if (row.eventType.includes("hard_failed") || row.eventType.includes("blocked") || row.eventType.includes("threat")) {
        high += 1;
      } else if (
        row.eventType.includes("approved") ||
        row.eventType.includes("proposed") ||
        row.eventType.includes("requested")
      ) {
        medium += 1;
      } else {
        low += 1;
      }
    }
    return [
      { name: "High", value: high, fill: "#e05c6a" },
      { name: "Medium", value: medium, fill: "#e8821a" },
      { name: "Low", value: low, fill: "#4ac77e" },
    ];
  }, [auditRows]);
  const auditEventsLastHour = useMemo(
    () => auditRows.filter((r) => r.createdAt >= Date.now() - 60 * 60 * 1000).length,
    [auditRows],
  );
  const latestCriticalAt = useMemo(() => {
    const row = auditRows.find(
      (r) =>
        r.eventType.includes("hard_failed") ||
        r.eventType.includes("blocked") ||
        r.eventType.includes("threat"),
    );
    return row?.createdAt ?? null;
  }, [auditRows]);
  const recentCriticalRows = useMemo(
    () =>
      auditRows
        .filter(
          (r) => r.eventType.includes("hard_failed") || r.eventType.includes("blocked") || r.eventType.includes("threat"),
        )
        .slice(0, 5),
    [auditRows],
  );
  const recommendedActions = useMemo(() => {
    const actions: string[] = [];
    if (pendingCount > 0) actions.push(`Review ${pendingCount} pending HITL request(s) immediately.`);
    if (riskData[0].value > 0) actions.push("Inspect high-risk events and run containment decision flow.");
    if (liveStudentCount === 0) actions.push("Verify student endpoints are visible from heartbeat stream.");
    if (actions.length === 0) actions.push("No immediate intervention required. Continue monitoring.");
    return actions.slice(0, 3);
  }, [liveStudentCount, pendingCount, riskData]);

  return (
    <div className="runa-admin-view h-full overflow-y-auto" style={{ background: "rgba(255,255,255,0.24)", fontFamily: GROTESK }}>
      <div className="px-6 pt-5 pb-4 border-b border-white/60" style={{ background: "rgba(255,255,255,0.38)" }}>
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="flex flex-wrap items-center gap-3 lg:gap-4 min-w-0">
            <span className="tracking-widest uppercase shrink-0" style={{ fontSize: "12px", fontFamily: MONO, color: "#3156b8" }}>
              RUNA COMMAND CENTER
            </span>
            <select
              value={labId}
              onChange={(e) => setLabId(e.target.value as ComlabId)}
              className="rounded-md border px-2 py-1 outline-none"
              style={{
                background: "rgba(247,248,253,0.92)",
                borderColor: "rgba(99,102,241,0.2)",
                color: "#17233d",
                fontSize: "10px",
                fontFamily: MONO,
              }}
              aria-label="Focus lab"
            >
              {COMLAB_IDS.map((id) => (
                <option key={id} value={id}>
                  {getComlab(id).label}
                </option>
              ))}
            </select>
            <span className="text-[#4a6080] hidden sm:inline" style={{ fontSize: "10px", fontFamily: MONO }}>
              last refreshed: {lastRefreshed.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              title="Refresh health"
              onClick={handleRefresh}
              className="w-9 h-9 rounded-md border border-[#cbd5f0] flex items-center justify-center text-[#4169e1] bg-white/50 hover:bg-white/80 transition-colors"
            >
              <RefreshCw size={16} />
            </button>
            <button
              type="button"
              title="Export log"
              onClick={() => {
                const csv = [
                  ["id", "time", "event", "actor", "station"],
                  ...auditRows.map((r) => [
                    String(r.id),
                    new Date(r.createdAt).toISOString(),
                    r.eventType,
                    r.actorUserId,
                    extractStation(r.detail),
                  ]),
                ]
                  .map((row) => row.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(","))
                  .join("\n");
                const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `runa-command-audit-${Date.now()}.csv`;
                a.click();
                URL.revokeObjectURL(url);
                pushToast("Audit export generated.", "success");
              }}
              className="w-9 h-9 rounded-md border border-[#cbd5f0] flex items-center justify-center text-[#4169e1] bg-white/50 hover:bg-white/80 transition-colors"
            >
              <Download size={16} />
            </button>
          </div>
        </div>

      </div>

      <div className="p-6">
        <div className="mb-4 grid grid-cols-1 md:grid-cols-3 gap-3">
          <div
            className={`${ADMIN_COMMAND_PANEL_CLASS} px-4 py-3`}
            style={ADMIN_COMMAND_PANEL_STYLE}
          >
            <p className="text-[#4a6080] uppercase" style={{ fontSize: "8px", fontFamily: MONO }}>
              Focus Lab
            </p>
            <p className="text-[#c5d5ea]" style={{ fontSize: "12px", fontFamily: MONO }}>
              {getComlab(labId).label}
            </p>
          </div>
          <div
            className={`${ADMIN_COMMAND_PANEL_CLASS} px-4 py-3`}
            style={ADMIN_COMMAND_PANEL_STYLE}
          >
            <p className="text-[#4a6080] uppercase" style={{ fontSize: "8px", fontFamily: MONO }}>
              Audit Events (1h)
            </p>
            <p className="text-[#c5d5ea] tabular-nums" style={{ fontSize: "12px", fontFamily: MONO }}>
              {auditEventsLastHour}
            </p>
          </div>
          <div
            className={`${ADMIN_COMMAND_PANEL_CLASS} px-4 py-3`}
            style={ADMIN_COMMAND_PANEL_STYLE}
          >
            <p className="text-[#4a6080] uppercase" style={{ fontSize: "8px", fontFamily: MONO }}>
              Latest Critical Event
            </p>
            <p className="text-[#c5d5ea] tabular-nums" style={{ fontSize: "12px", fontFamily: MONO }}>
              {latestCriticalAt
                ? new Date(latestCriticalAt).toLocaleTimeString("en-GB", {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                : "none"}
            </p>
          </div>
        </div>

        <div className="grid gap-4 grid-cols-1 xl:grid-cols-12">
          {/* Row 1 — KPI strip */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 xl:col-span-12">
            {kpiRows.map((k) => (
              <DashboardKPICard key={k.label} {...k} animKey={kpiAnimKey} />
            ))}
          </div>

          {/* Row 2 left — occupancy */}
          <div
            className="rounded-[10px] p-5 border min-h-[280px] flex flex-col xl:col-span-7"
            style={{ background: "rgba(255,255,255,0.66)", borderColor: "rgba(99,102,241,0.16)", boxShadow: "0 10px 26px rgba(45,72,155,0.1)" }}
          >
            <p className="text-[#c5d5ea] mb-2" style={{ fontSize: "13px" }}>
              Lab Occupancy (current window)
            </p>
            <div className="flex-1 min-h-[180px]">
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={occupancyData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,102,241,0.14)" vertical={false} />
                  <XAxis dataKey="lab" tick={{ fill: "#52638f", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fill: "#52638f", fontSize: 11 }} axisLine={false} tickLine={false} />
                  <Tooltip
                    cursor={{ fill: "rgba(58,111,255,0.06)" }}
                    content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      const row = payload[0].payload as { lab: string; occupied: number; capacity: number };
                      return (
                        <div
                          className="rounded-md border px-2.5 py-1.5"
                          style={{ background: "rgba(255,255,255,0.96)", borderColor: "rgba(99,102,241,0.18)", fontSize: 11 }}
                        >
                          <div style={{ color: "#17233d" }}>{label}</div>
                          <div style={{ color: "#4169e1", fontFamily: MONO }}>
                            {row.occupied}/{row.capacity} seats
                          </div>
                        </div>
                      );
                    }}
                  />
                  <Bar dataKey="occupied" fill="#3a6fff" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="capacity" fill="rgba(65,105,225,0.15)" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Row 2 right — risk mix + operator actions */}
          <div
            className="rounded-[10px] p-5 border flex flex-col min-h-[280px] xl:col-span-5"
            style={{ background: "rgba(255,255,255,0.66)", borderColor: "rgba(99,102,241,0.16)", boxShadow: "0 10px 26px rgba(45,72,155,0.1)" }}
          >
            <p className="text-[#c5d5ea] mb-2" style={{ fontSize: "13px" }}>
              Risk & Operator Actions (60m)
            </p>
            <div className="space-y-3 mb-4">
              {riskData.map((d) => {
                const total = Math.max(1, riskData.reduce((sum, row) => sum + row.value, 0));
                const width = (d.value / total) * 100;
                return (
                  <div key={d.name}>
                    <div className="flex items-center justify-between mb-1">
                      <span style={{ color: "#3f568d", fontSize: "11px", fontFamily: MONO, fontWeight: 600 }}>{d.name}</span>
                      <span style={{ color: d.fill, fontSize: "10px", fontFamily: MONO }}>{d.value}</span>
                    </div>
                    <div className="h-2 rounded-full overflow-hidden" style={{ background: "rgba(65,105,225,0.15)" }}>
                      <div className="h-full rounded-full" style={{ width: `${width}%`, background: d.fill }} />
                    </div>
                  </div>
                );
              })}
            </div>
            <div className="rounded-md border p-3 space-y-2" style={{ borderColor: "rgba(99,102,241,0.18)", background: "rgba(247,248,253,0.72)" }}>
              <p className="text-[#4169e1]" style={{ fontSize: "10px", fontFamily: MONO }}>
                Recommended next actions
              </p>
              {recommendedActions.map((line) => (
                <div key={line} className="flex items-start gap-2">
                  <span className="mt-1 w-1.5 h-1.5 rounded-full bg-[#7eb5f5] shrink-0" />
                  <span className="text-[#243052]" style={{ fontSize: "11px" }}>
                    {line}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Row 3 — audit stream and critical incidents */}
          <div className="min-h-[260px] xl:col-span-8">
            <LiveAuditFeed items={liveFeedItems} />
          </div>
          <div
            className="rounded-[10px] p-5 border min-h-[260px] xl:col-span-4"
            style={{ background: "rgba(255,255,255,0.66)", borderColor: "rgba(99,102,241,0.16)", boxShadow: "0 10px 26px rgba(45,72,155,0.1)" }}
          >
            <p className="text-[#c5d5ea] mb-3" style={{ fontSize: "13px" }}>
              Recent Critical Incidents
            </p>
            <div className="space-y-3">
              {recentCriticalRows.length === 0 ? (
                <p className="text-[#4a6080]" style={{ fontSize: "10px", fontFamily: MONO }}>
                  No high-risk incidents in the current stream.
                </p>
              ) : (
                recentCriticalRows.map((row) => (
                  <div key={row.id} className="rounded-md border p-2.5" style={{ borderColor: "rgba(99,102,241,0.18)", background: "rgba(247,248,253,0.72)" }}>
                    <p className="text-[#e05c6a]" style={{ fontSize: "10px", fontFamily: MONO }}>
                      {row.eventType.replaceAll("_", " ")}
                    </p>
                    <p className="text-[#4a6080]" style={{ fontSize: "9px", fontFamily: MONO }}>
                      {new Date(row.createdAt).toLocaleTimeString("en-GB", {
                        hour: "2-digit",
                        minute: "2-digit",
                        second: "2-digit",
                      })}{" "}
                      · {row.actorUserId || "system"}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}
