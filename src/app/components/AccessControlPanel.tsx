import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Lock, Power, Shield, AlertTriangle, Activity, ChevronRight, X, FileSearch } from "lucide-react";
import { toast } from "sonner";
import { useElectron } from "../ipc/useElectron";
import { logAudit, proposeAction } from "../agentic/approvalQueue";
import { useAdminLab } from "../context/AdminLabContext";
import { buildAccessNodes, COMLAB_DEFINITIONS, getComlab } from "../data/comlabs";
import { PRESENCE_LIVE_WINDOW_MS as PRESENCE_WINDOW_MS } from "../constants/presence";
import { ADMIN_FONT_MONO, ADMIN_FONT_SANS, ADMIN_HEADER_TITLE_SIZE, ADMIN_PANEL_CLASS, ADMIN_PANEL_STYLE } from "./admin/adminUiTokens";

const MONO = ADMIN_FONT_MONO;
const GROTESK = ADMIN_FONT_SANS;

type NodeStatus = "normal" | "alert" | "offline" | "blocked" | "scanning";

const NODE_STYLE: Record<NodeStatus, { bg: string; border: string; dot: string }> = {
  normal:   { bg: "#162035", border: "#2a3a6a", dot: "#3a6fff" },
  alert:    { bg: "#3a1020", border: "#e05c6a", dot: "#e05c6a" },
  offline:  { bg: "#0d1320", border: "#1a2235", dot: "#2a3a55" },
  blocked:  { bg: "#2a1810", border: "#e8821a", dot: "#e8821a" },
  scanning: { bg: "#101e30", border: "#4ac77e", dot: "#4ac77e" },
};

interface AccessAuditRow {
  id: number;
  createdAt: number;
  eventType: string;
  actorUserId?: string;
  actorRole?: string;
}

interface AccessLogLine {
  time: string;
  msg: string;
  level: "info" | "warn" | "success";
}

const levelStyle: Record<string, { color: string; prefix: string }> = {
  info:    { color: "#4a6fa5", prefix: "INFO" },
  warn:    { color: "#e8821a", prefix: "WARN" },
  success: { color: "#4ac77e", prefix: "OK  " },
};

export function AccessControlPanel() {
  const api = useElectron();
  const { labId, setLabId } = useAdminLab();
  const [liveStudentIds, setLiveStudentIds] = useState<string[]>([]);
  const [hasRecentSecurityAlert, setHasRecentSecurityAlert] = useState(false);
  const nodes = useMemo(() => {
    const base = buildAccessNodes(getComlab(labId));
    const liveCount = Math.min(liveStudentIds.length, base.length);
    const mapped = base.map((n, i) => {
      if (i < liveCount) return { ...n, status: "normal" as const };
      return { ...n, status: "offline" as const };
    });
    if (hasRecentSecurityAlert && mapped.length > 0) {
      mapped[0] = { ...mapped[0], status: "alert" as const };
    }
    return mapped;
  }, [hasRecentSecurityAlert, labId, liveStudentIds]);
  const sessionNodes = useMemo(
    () => nodes.filter((n) => n.status === "normal" || n.status === "scanning").length,
    [nodes],
  );
  const [lockConfirm, setLockConfirm] = useState(false);
  const [terminateConfirm, setTerminateConfirm] = useState(false);
  const [locked, setLocked] = useState(false);
  const [terminated, setTerminated] = useState(false);
  const [logs, setLogs] = useState<AccessLogLine[]>([]);
  const [auditCount, setAuditCount] = useState(0);
  const [actorId, setActorId] = useState("");
  const [fileScanBusy, setFileScanBusy] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.session.get().then((s) => {
      if (s?.userId) setActorId(s.userId);
    });
  }, [api]);

  const latestWarnLog = useMemo(() => logs.find((l) => l.level === "warn") ?? null, [logs]);

  const runFileScan = useCallback(async () => {
    const filePath = await api.dialog.openFile();
    if (!filePath) return;
    setFileScanBusy(true);
    const uid = actorId || "admin";
    try {
      const res = await api.python.call<{
        ok?: boolean;
        clean?: boolean;
        threat?: string | null;
        sha256?: string;
        engine?: string;
        error?: string;
      }>("/scan-file", { path: filePath }, { method: "POST", timeoutMs: 120_000 });

      if (!res.ok || res.data === undefined || res.data === null) {
        toast.error("Scan failed", { description: res.error ?? "Unknown error" });
        return;
      }

      const d = res.data as {
        ok?: boolean;
        clean?: boolean;
        threat?: string | null;
        sha256?: string;
        engine?: string;
        error?: string;
      };

      if (d.ok === false) {
        toast.error("Scan rejected", { description: d.error ?? "Bad response" });
        return;
      }

      await logAudit({
        eventType: "file_scan",
        detail: JSON.stringify({
          path: filePath,
          clean: d.clean,
          threat: d.threat,
          sha256: d.sha256,
          engine: d.engine,
        }),
        actorUserId: uid,
        actorRole: "admin",
        riskTier: d.clean ? "low" : "high",
      });

      if (d.clean) {
        toast.success("File scan clean", {
          description: d.sha256
            ? `${d.sha256.slice(0, 20)}… (${d.engine ?? "?"})`
            : String(d.engine ?? "clean"),
        });
      } else {
        toast.error("Threat detected", { description: d.threat ?? "Flagged" });
        await proposeAction(
          {
            type: "quarantine_usb",
            scope: "lab",
            reversible: true,
            payload: { source: "file_scan", path: filePath, threat: d.threat, sha256: d.sha256 },
            confidence: 0.95,
            reasoning: `File scan flagged (${d.threat ?? "unknown"}) for path: ${filePath}`,
          },
          uid,
          "admin",
          { scanResult: d, sourceAlert: d.threat ?? "file_scan" },
        );
        api.tray.notify("RUNA Security", `Threat scan: ${d.threat ?? "flagged"} — queued for HITL.`);
      }
    } catch (e) {
      toast.error("Scan error", { description: e instanceof Error ? e.message : String(e) });
    } finally {
      setFileScanBusy(false);
    }
  }, [api, actorId]);

  useEffect(() => {
    let alive = true;
    const loadAuditLogs = async () => {
      try {
        const rows = (await api.audit.list(120)) as AccessAuditRow[];
        if (!alive) return;
        const ordered = [...rows].sort((a, b) => b.createdAt - a.createdAt);
        setAuditCount(ordered.length);
        const cutoff = Date.now() - PRESENCE_WINDOW_MS;
        const liveStudents = new Set(
          ordered
            .filter(
              (r) =>
                r.eventType === "presence_heartbeat" &&
                r.actorRole === "student" &&
                typeof r.createdAt === "number" &&
                r.createdAt >= cutoff,
            )
            .map((r) => r.actorUserId ?? "")
            .filter(Boolean),
        );
        setLiveStudentIds(Array.from(liveStudents));
        setHasRecentSecurityAlert(
          ordered.some(
            (r) =>
              (r.eventType.includes("hard_failed") ||
                r.eventType.includes("blocked") ||
                r.eventType.includes("threat")) &&
              typeof r.createdAt === "number" &&
              r.createdAt >= cutoff,
          ),
        );
        const nextLogs: AccessLogLine[] = ordered.slice(0, 20).map((row) => {
          const level: AccessLogLine["level"] =
            row.eventType.includes("hard_failed") || row.eventType.includes("blocked")
              ? "warn"
              : row.eventType.includes("approved") || row.eventType.includes("executed")
                ? "success"
                : "info";
          return {
            time: new Date(row.createdAt).toLocaleTimeString("en-GB", {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            }),
            msg: row.eventType.replaceAll("_", " "),
            level,
          };
        });
        setLogs(nextLogs);
      } catch {
        if (!alive) return;
        setLogs([]);
        setAuditCount(0);
      }
    };
    void loadAuditLogs();
    const t = setInterval(() => void loadAuditLogs(), 15_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api]);

  return (
    <div className="runa-admin-view h-full overflow-y-auto" style={{ background: "#0d1320", fontFamily: GROTESK }}>
      {/* Header */}
      <div className="px-7 pt-5 pb-4 border-b border-[#1a2640]" style={{ background: "#0f1828" }}>
        <div className="flex items-center gap-3 mb-1">
          <div className="w-2 h-2 rounded-full bg-[#3a6fff] animate-pulse" />
          <span className="text-[#4a6080] tracking-widest uppercase" style={{ fontSize: "8px", fontFamily: MONO }}>
            Security Protocol: Active
          </span>
        </div>
        <h1 className="text-[#c5d5ea]" style={{ fontSize: ADMIN_HEADER_TITLE_SIZE, letterSpacing: "1.5px" }}>
          ACCESS GOVERNANCE
        </h1>
        <div className="flex items-center gap-6 mt-2">
          {COMLAB_DEFINITIONS.map((lab) => (
            <button
              key={lab.id}
              type="button"
              onClick={() => setLabId(lab.id)}
              className="transition-colors"
              style={{
                color: labId === lab.id ? "#7eb5f5" : "#2a3a55",
                fontSize: "10px",
                fontFamily: MONO,
                borderBottom: labId === lab.id ? "1px solid #3a6fff" : "1px solid transparent",
                paddingBottom: "2px",
                background: labId === lab.id ? "#162035" : "transparent",
                border: labId === lab.id ? "1px solid rgba(58,111,255,0.35)" : "1px solid transparent",
                borderRadius: "4px",
                padding: "4px 8px",
              }}
            >
              {lab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="p-6 grid gap-5" style={{ gridTemplateColumns: "1fr 280px" }}>
        {/* Left: Node Matrix */}
        <div className="space-y-5">
          <div className={`${ADMIN_PANEL_CLASS} p-5`} style={ADMIN_PANEL_STYLE}>
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <Activity size={14} className="text-[#3a6fff]" />
                <span className="text-[#c5d5ea]" style={{ fontSize: "13px" }}>
                  {getComlab(labId).label} — Node Matrix
                </span>
              </div>
              <div className="flex items-center gap-4">
                {(["normal","alert","blocked","offline"] as NodeStatus[]).map((s) => (
                  <div key={s} className="flex items-center gap-1.5">
                    <div className="w-2 h-2 rounded-full" style={{ background: NODE_STYLE[s].dot }} />
                    <span className="text-[#4a6080] capitalize" style={{ fontSize: "8px", fontFamily: MONO }}>{s}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(8, 1fr)" }}>
              {nodes.map((node) => {
                const sty = NODE_STYLE[node.status];
                return (
                  <div
                    key={`${labId}-${node.id}`}
                    className="rounded-lg p-2 flex flex-col items-center gap-1.5 cursor-pointer hover:brightness-125 transition-all group"
                    style={{ background: sty.bg, border: `1px solid ${sty.border}` }}
                    title={`${node.label} · ${node.status.toUpperCase()}`}
                  >
                    {/* Node icon */}
                    <div className="relative">
                      <div
                        className="w-5 h-5 rounded-sm flex items-center justify-center"
                        style={{ background: sty.border + "30" }}
                      >
                        {node.status === "alert" && <AlertTriangle size={10} style={{ color: sty.dot }} />}
                        {node.status === "blocked" && <Lock size={10} style={{ color: sty.dot }} />}
                        {node.status === "scanning" && <Activity size={10} style={{ color: sty.dot }} />}
                        {(node.status === "normal" || node.status === "offline") && (
                          <div className="w-2 h-2 rounded-full" style={{ background: sty.dot }} />
                        )}
                      </div>
                    </div>
                    <span style={{ color: sty.dot, fontSize: "8px", fontFamily: MONO }}>{node.id}</span>
                    <span style={{ color: "#2a3a55", fontSize: "8px", fontFamily: MONO }}>{node.label.slice(0, 8)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Session Integrity */}
          <div className={`${ADMIN_PANEL_CLASS} p-5`} style={ADMIN_PANEL_STYLE}>
            <div className="flex items-center gap-2 mb-5">
              <Shield size={13} className="text-[#3a6fff]" />
              <span className="text-[#c5d5ea]" style={{ fontSize: "13px" }}>Session Integrity</span>
            </div>
            <div className="grid grid-cols-3 gap-5">
              <div>
                <p className="text-[#4a6080] tracking-widest uppercase mb-2" style={{ fontSize: "8px", fontFamily: MONO }}>Active Nodes</p>
                <div className="flex items-end gap-2">
                  <span className="text-[#c5d5ea]" style={{ fontSize: "36px", fontFamily: MONO, lineHeight: 1 }}>{sessionNodes}</span>
                  <span className="text-[#2a3a55] mb-1" style={{ fontSize: "14px", fontFamily: MONO }}>/{nodes.length}</span>
                </div>
                <div className="mt-3 h-1 rounded-full overflow-hidden" style={{ background: "#1a2640" }}>
                  <div className="h-full rounded-full" style={{ width: `${(sessionNodes / 30) * 100}%`, background: "#3a6fff" }} />
                </div>
              </div>
              <div>
                <p className="text-[#4a6080] tracking-widest uppercase mb-2" style={{ fontSize: "8px", fontFamily: MONO }}>Access Hits</p>
                <span className="text-[#c5d5ea]" style={{ fontSize: "36px", fontFamily: MONO, lineHeight: 1 }}>
                  {auditCount}
                </span>
              </div>
              <div>
                <p className="text-[#4a6080] tracking-widest uppercase mb-2" style={{ fontSize: "8px", fontFamily: MONO }}>Alert Nodes</p>
                <span className="text-[#c5d5ea]" style={{ fontSize: "36px", fontFamily: MONO, lineHeight: 1 }}>
                  {nodes.filter((n) => n.status === "alert").length}
                </span>
              </div>
            </div>

            {/* Real-time logs */}
            <div className="mt-5">
              <p className="text-[#4a6080] tracking-widest uppercase mb-3" style={{ fontSize: "8px", fontFamily: MONO }}>Real-Time Logs</p>
              <div
                ref={logRef}
                className="space-y-1 overflow-y-auto pr-1"
                style={{ maxHeight: "140px" }}
              >
                {logs.map((log, i) => (
                  <div key={i} className="flex items-start gap-2">
                    <span style={{ color: "#2a3a55", fontSize: "9px", fontFamily: MONO, flexShrink: 0 }}>{log.time}</span>
                    <span style={{ color: levelStyle[log.level].color, fontSize: "9px", fontFamily: MONO, flexShrink: 0 }}>
                      [{levelStyle[log.level].prefix}]
                    </span>
                    <span style={{ color: "#6a7a90", fontSize: "9px", fontFamily: MONO }}>{log.msg}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Right: Command Override + Security */}
        <div className="space-y-4">
          {/* Command Override */}
          <div className="rounded-xl p-5 border" style={{ background: "#111d30", borderColor: "#1e2e48" }}>
            <div className="flex items-center gap-2 mb-1">
              <div className="w-1.5 h-1.5 rounded-full bg-[#e05c6a]" />
              <span className="text-[#e05c6a]" style={{ fontSize: "11px", fontFamily: MONO }}>GOVERNED ACTIONS</span>
            </div>
            <div className="h-[1px] bg-[#1a2640] mb-4" />

            {/* Contain active sessions */}
            <div
              className="p-4 rounded-lg mb-3 cursor-pointer hover:brightness-110 transition-all border"
              style={{ background: "#162035", borderColor: locked ? "#4ac77e" : "#2a3a55" }}
              onClick={() => setLockConfirm(true)}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[#c5d5ea]" style={{ fontSize: "12px" }}>Contain Active Sessions</span>
                <Lock size={14} style={{ color: locked ? "#4ac77e" : "#4a6080" }} />
              </div>
              <p className="text-[#4a6080]" style={{ fontSize: "9px", fontFamily: MONO }}>
                {locked
                  ? "Containment lock active for live sessions"
                  : `Temporarily lock active sessions in ${getComlab(labId).label} (HITL for MEDIUM/HIGH)`}
              </p>
              {locked && (
                <p className="text-[#4ac77e] mt-1" style={{ fontSize: "8px", fontFamily: MONO }}>● ACTIVE</p>
              )}
            </div>

            {/* Force sign-out active sessions */}
            <div
              className="p-4 rounded-lg cursor-pointer hover:brightness-110 transition-all border"
              style={{
                background: terminated ? "#1a0d0d" : "#1a0d18",
                borderColor: terminated ? "#4a6080" : "#e05c6a50",
              }}
              onClick={() => setTerminateConfirm(true)}
            >
              <div className="flex items-center justify-between mb-1">
                <span style={{ color: terminated ? "#4a6080" : "#e05c6a", fontSize: "12px" }}>
                  Force Sign-out Active Sessions
                </span>
                <Power size={14} style={{ color: terminated ? "#4a6080" : "#e05c6a" }} />
              </div>
              <p className="text-[#4a6080]" style={{ fontSize: "9px", fontFamily: MONO }}>
                {terminated
                  ? "Live sessions signed out"
                  : "Immediately sign out currently active student sessions (hard-fail if safeguards block execution)"}
              </p>
            </div>

            <div
              className={`p-4 rounded-lg mb-3 border transition-all ${fileScanBusy ? "opacity-50 pointer-events-none" : "cursor-pointer hover:brightness-110"}`}
              style={{ background: "#101e30", borderColor: "#3a6fff50" }}
              onClick={() => void runFileScan()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void runFileScan();
                }
              }}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[#c5d5ea]" style={{ fontSize: "12px" }}>
                  Run file scan
                </span>
                <FileSearch size={14} className="text-[#7eb5f5]" />
              </div>
              <p className="text-[#4a6080]" style={{ fontSize: "9px", fontFamily: MONO }}>
                ClamAV sidecar scan. Threat findings create governed `quarantine_usb` proposals for HITL.
              </p>
            </div>

            <div className="h-[1px] bg-[#1a2640] my-4" />

            {/* Security notification */}
            <div>
              <p className="text-[#4a6080] tracking-widest uppercase mb-2" style={{ fontSize: "8px", fontFamily: MONO }}>
                Security Notifications
              </p>
              <p className="text-[#2a3a55]" style={{ fontSize: "9px", fontFamily: MONO }}>
                {latestWarnLog
                  ? `Latest warning: ${latestWarnLog.msg}`
                  : "No active security warnings in the current presence window."}
              </p>
            </div>
          </div>

          {/* Node quick stats */}
          <div className="rounded-xl p-5 border" style={{ background: "#111d30", borderColor: "#1e2e48" }}>
            <p className="text-[#4a6080] tracking-widest uppercase mb-4" style={{ fontSize: "8px", fontFamily: MONO }}>
              Node Health Summary
            </p>
            {([
              { label: "Normal", count: nodes.filter(n => n.status === "normal").length, color: "#3a6fff" },
              { label: "Alert", count: nodes.filter(n => n.status === "alert").length, color: "#e05c6a" },
              { label: "Blocked", count: nodes.filter(n => n.status === "blocked").length, color: "#e8821a" },
              { label: "Offline", count: nodes.filter(n => n.status === "offline").length, color: "#2a3a55" },
              { label: "Scanning", count: nodes.filter(n => n.status === "scanning").length, color: "#4ac77e" },
            ]).map((row) => (
              <div key={row.label} className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <div className="w-2 h-2 rounded-full" style={{ background: row.color }} />
                  <span className="text-[#c5d5ea]" style={{ fontSize: "11px" }}>{row.label}</span>
                </div>
                <div className="flex items-center gap-3 flex-1 ml-4">
                  <div className="flex-1 h-1 rounded-full overflow-hidden" style={{ background: "#1a2640" }}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${(row.count / nodes.length) * 100}%`, background: row.color }}
                    />
                  </div>
                  <span style={{ color: row.color, fontSize: "10px", fontFamily: MONO, width: "20px", textAlign: "right" }}>
                    {row.count}
                  </span>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl p-5 border" style={{ background: "#111d30", borderColor: "#1e2e48" }}>
            <p className="text-[#4a6080] tracking-widest uppercase mb-2" style={{ fontSize: "8px", fontFamily: MONO }}>
              Governance Notes
            </p>
            <p className="text-[#4a6080]" style={{ fontSize: "9px", fontFamily: MONO }}>
              RUNA applies app-context controls only. MEDIUM and HIGH actions are routed through HITL approval.
              Execution outcomes are logged to the shared audit stream for cross-device traceability.
            </p>
          </div>
        </div>
      </div>

      {/* Containment confirm modal */}
      {lockConfirm && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div className="rounded-xl p-6 border shadow-2xl" style={{ background: "#111d30", borderColor: "#2a3a55", width: "340px" }}>
            <div className="flex items-center gap-2 mb-3">
              <Lock size={16} className="text-[#4a6fa5]" />
              <span className="text-[#c5d5ea]" style={{ fontSize: "14px" }}>Confirm Session Containment</span>
            </div>
            <p className="text-[#4a6080] mb-5" style={{ fontSize: "11px", fontFamily: MONO }}>
              {`This will lock currently active student sessions in ${getComlab(labId).label}. Use only for active containment.`}
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  void (async () => {
                    const uid = actorId || "admin";
                    const proposal = await proposeAction(
                      {
                        type: "lock_cluster",
                        scope: "lab",
                        reversible: true,
                        payload: { labId },
                        confidence: 0.88,
                        reasoning: `Lock cluster requested for ${getComlab(labId).label}.`,
                      },
                      uid,
                      "admin",
                    );
                    if (proposal.autoExecuted && proposal.result.ok) {
                      setLocked(true);
                      toast.success("Cluster lock executed", { description: proposal.result.message });
                    } else if (proposal.autoExecuted) {
                      toast.error("Cluster lock hard-failed", { description: proposal.result.message });
                    } else {
                      toast("Cluster lock queued for HITL", {
                        description: `Approval: ${proposal.request.id.slice(0, 8)}… (${proposal.tier})`,
                      });
                    }
                    setLockConfirm(false);
                  })();
                }}
                className="flex-1 py-2 rounded-md text-white transition-colors"
                style={{ background: "#3a6fff", fontSize: "11px", fontFamily: MONO }}
              >
                APPLY CONTAINMENT
              </button>
              <button
                onClick={() => setLockConfirm(false)}
                className="flex-1 py-2 rounded-md border transition-colors"
                style={{ borderColor: "#2a3a55", color: "#4a6080", fontSize: "11px", fontFamily: MONO }}
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Force sign-out confirm modal */}
      {terminateConfirm && (
        <div className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center" style={{ background: "rgba(0,0,0,0.7)" }}>
          <div className="rounded-xl p-6 border shadow-2xl" style={{ background: "#1a0d18", borderColor: "#e05c6a50", width: "340px" }}>
            <div className="flex items-center gap-2 mb-3">
              <Power size={16} className="text-[#e05c6a]" />
              <span className="text-[#e05c6a]" style={{ fontSize: "14px" }}>Force Sign-out Active Sessions?</span>
            </div>
            <p className="text-[#a07080] mb-5" style={{ fontSize: "11px", fontFamily: MONO }}>
              This signs out {sessionNodes} active sessions in the selected lab. Use after containment review.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => {
                  void (async () => {
                    const uid = actorId || "admin";
                    const proposal = await proposeAction(
                      {
                        type: "terminate_session",
                        scope: "lab",
                        reversible: false,
                        payload: { labId, sessionNodes },
                        confidence: 0.9,
                        reasoning: `Terminate sessions requested for ${getComlab(labId).label}.`,
                      },
                      uid,
                      "admin",
                    );
                    if (proposal.autoExecuted && proposal.result.ok) {
                      setTerminated(true);
                      toast.success("Termination executed", { description: proposal.result.message });
                    } else if (proposal.autoExecuted) {
                      toast.error("Termination hard-failed", { description: proposal.result.message });
                    } else {
                      toast("Terminate queued for HITL", {
                        description: `Approval: ${proposal.request.id.slice(0, 8)}… (${proposal.tier})`,
                      });
                    }
                    setTerminateConfirm(false);
                  })();
                }}
                className="flex-1 py-2 rounded-md text-white transition-colors"
                style={{ background: "#e05c6a", fontSize: "11px", fontFamily: MONO }}
              >
                FORCE SIGN-OUT
              </button>
              <button
                onClick={() => setTerminateConfirm(false)}
                className="flex-1 py-2 rounded-md border transition-colors"
                style={{ borderColor: "#2a3a55", color: "#4a6080", fontSize: "11px", fontFamily: MONO }}
              >
                CANCEL
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
