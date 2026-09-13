import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router";
import {
  Shield,
  Monitor,
  User,
  Sparkles,
  AppWindow,
  Plus,
  Trash2,
  Pencil,
} from "lucide-react";
import { NotificationsMenu } from "../providers/NotificationProvider";
import { useNotificationContext } from "../providers/NotificationProvider";
import { ProductivityAssistant } from "./agentic/ProductivityAssistant";
import { StudentRpaSidePanel } from "./student/rpaSidePanel/StudentRpaSidePanel";
import { useElectron } from "../ipc/useElectron";
import { findDemoUser } from "../auth/demoUsers";
import { COMLAB_DEFINITIONS } from "../data/comlabs";
import type { ElectronLabShortcut } from "../../types/electron";

const MONO = "'Share Tech Mono', monospace";
const GROTESK = "'Exo 2', sans-serif";
const BRAND = "'Orbitron', sans-serif";

const SHORTCUT_PICK_FILTERS = [
  { name: "Program or shortcut", extensions: ["exe", "lnk"] },
  { name: "All files", extensions: ["*"] },
];

/** Suggested display names only — user still picks the real .exe / .lnk on disk. */
const SHORTCUT_NAME_SUGGESTIONS = [
  "VS Code",
  "IntelliJ IDEA",
  "NetBeans",
  "Google Chrome",
  "Terminal",
  "File Explorer",
  "Blender",
  "Inkscape",
] as const;

const STUDENT_TOUR_STORAGE_KEY = "runa.studentTour.v1";

function pathTail(p: string, max = 40): string {
  const t = p.trim();
  if (t.length <= max) return t;
  return `…${t.slice(-(max - 1))}`;
}

/** Remaining time until Runa login session expiry (wall clock `nowMs`). */
function formatSessionRemaining(expiresAt: number | null, nowMs: number): string {
  if (expiresAt == null || expiresAt <= nowMs) return "—";
  const mins = Math.ceil((expiresAt - nowMs) / 60_000);
  if (mins <= 0) return "—";
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}h ${m}m`;
}

export function StudentDashboard() {
  const navigate = useNavigate();
  const api = useElectron();
  const { pushToast } = useNotificationContext();
  const [secondsUsed, setSecondsUsed] = useState(0);
  const [studentId, setStudentId] = useState("");
  const [studentDisplayName, setStudentDisplayName] = useState("Student");
  const [now, setNow] = useState(new Date());
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [kioskMode, setKioskMode] = useState<boolean | null>(null);
  /** Kiosk / locked-down labs: only IT may change the shortcut list. */
  const canEditShortcuts = kioskMode !== true;
  const [shortcutsList, setShortcutsList] = useState<ElectronLabShortcut[]>([]);
  const [sessionExpiresAt, setSessionExpiresAt] = useState<number | null>(null);
  const [showStudentTour, setShowStudentTour] = useState(false);
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftPath, setDraftPath] = useState("");
  const [shortcutMenu, setShortcutMenu] = useState<{
    x: number;
    y: number;
    entry: ElectronLabShortcut;
  } | null>(null);
  const shortcutMenuRef = useRef<HTMLDivElement>(null);
  const [editTarget, setEditTarget] = useState<ElectronLabShortcut | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [editPath, setEditPath] = useState("");
  const [showCreateShortcutModal, setShowCreateShortcutModal] = useState(false);
  const [siteCheckInput, setSiteCheckInput] = useState("");
  const [siteCheckBusy, setSiteCheckBusy] = useState(false);
  const [siteCheckResult, setSiteCheckResult] = useState<{
    level: "allowed" | "blocked" | "warn";
    text: string;
  } | null>(null);
  const [labComlabId, setLabComlabId] = useState("08");
  const [labPcLabel, setLabPcLabel] = useState("PC-01");

  const refreshShortcuts = useCallback(async () => {
    const list = await api.lab.getShortcuts();
    setShortcutsList(Array.isArray(list) ? list : []);
  }, [api]);

  useEffect(() => {
    const timer = setInterval(() => {
      setSecondsUsed((x) => x + 1);
      setNow(new Date());
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await api.session.get();
      if (!cancelled && s?.userId) {
        setStudentId(s.userId);
        setSessionExpiresAt(typeof s.expiresAt === "number" ? s.expiresAt : null);
        const u = findDemoUser(s.userId);
        setStudentDisplayName(u?.displayName ?? s.userId);
      }
      try {
        const settings = await api.settings.get();
        if (!cancelled) setKioskMode(settings?.kioskMode ?? false);
      } catch {
        if (!cancelled) setKioskMode(false);
      }
      const vr = await api.runaFiles.getVaultRoot();
      if (!cancelled && vr.ok && vr.path) setVaultPath(vr.path);
      try {
        const st = await api.labStation.get();
        if (!cancelled) {
          setLabComlabId(String(st.comlabId || "08").trim());
          setLabPcLabel(String(st.workstationLabel || "PC-01").trim());
        }
      } catch {
        /* ignore */
      }
      if (!cancelled) await refreshShortcuts();
    })();
    return () => {
      cancelled = true;
    };
  }, [api, refreshShortcuts]);

  useEffect(() => {
    if (!editTarget) {
      setEditLabel("");
      setEditPath("");
      return;
    }
    setEditLabel(editTarget.label);
    setEditPath(editTarget.targetPath);
  }, [editTarget]);

  useEffect(() => {
    if (!shortcutMenu) return;
    const onDocMouseDown = (ev: MouseEvent) => {
      if (shortcutMenuRef.current?.contains(ev.target as Node)) return;
      setShortcutMenu(null);
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setShortcutMenu(null);
    };
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [shortcutMenu]);

  useEffect(() => {
    if (!editTarget) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setEditTarget(null);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editTarget]);

  useEffect(() => {
    if (!showCreateShortcutModal) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") setShowCreateShortcutModal(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showCreateShortcutModal]);

  useEffect(() => {
    try {
      if (!localStorage.getItem(STUDENT_TOUR_STORAGE_KEY)) {
        setShowStudentTour(true);
      }
    } catch {
      /* private mode */
    }
  }, []);

  const dismissStudentTour = () => {
    try {
      localStorage.setItem(STUDENT_TOUR_STORAGE_KEY, "1");
    } catch {
      /* ignore */
    }
    setShowStudentTour(false);
    void api.telemetry.record("student_tour_dismissed", {});
  };

  const handleLogout = async () => {
    await api.session.clear();
    navigate("/");
  };

  const saveLabStation = async () => {
    const ws = labPcLabel.trim() || "PC-01";
    try {
      const saved = await api.labStation.set({ comlabId: labComlabId, workstationLabel: ws });
      setLabComlabId(saved.comlabId);
      setLabPcLabel(saved.workstationLabel);
      pushToast("Comlab / PC saved for attendance logs", "success");
      void api.telemetry.record("lab_station_profile_saved", {
        comlabId: saved.comlabId,
        workstationLabel: saved.workstationLabel,
      });
    } catch (e) {
      pushToast(e instanceof Error ? e.message : "Could not save workstation", "error");
    }
  };

  const runSiteCheck = async () => {
    const raw = siteCheckInput.trim();
    if (!raw || siteCheckBusy) return;
    setSiteCheckBusy(true);
    try {
      const policy = await api.security.checkUrl(raw);
      if (policy.ok && policy.blocked) {
        const msg = `Blocked by lab policy: ${policy.domain}`;
        setSiteCheckResult({ level: "blocked", text: msg });
        pushToast(msg, "warn");
        return;
      }

      const analyzed = await api.python.call<{ suspicious?: boolean; score?: number }>(
        "/analyze-url",
        { url: raw },
        { method: "POST", timeoutMs: 15_000 },
      );
      if (!analyzed.ok || !analyzed.data) {
        const msg = `Could not check URL right now${analyzed.error ? ` (${analyzed.error})` : ""}.`;
        setSiteCheckResult({ level: "warn", text: msg });
        pushToast(msg, "error");
        return;
      }
      if (analyzed.data.suspicious) {
        const msg = "Suspicious URL detected. This request may be escalated to admin for blocklist enforcement.";
        setSiteCheckResult({ level: "warn", text: msg });
        pushToast("Suspicious URL detected", "warn");
      } else {
        const msg = "URL allowed by current policy and analyzer checks.";
        setSiteCheckResult({ level: "allowed", text: msg });
        pushToast("URL allowed", "success");
      }
    } finally {
      setSiteCheckBusy(false);
    }
  };

  const pickTargetFile = async () => {
    const picked = await api.dialog.openFile(SHORTCUT_PICK_FILTERS);
    if (!picked) return;
    setDraftPath(picked);
    setDraftLabel((prev) => {
      if (prev.trim()) return prev;
      const base =
        picked
          .split(/[/\\]/)
          .pop()
          ?.replace(/\.(exe|lnk)$/i, "") ?? "Application";
      return base.slice(0, 80);
    });
  };

  const addShortcut = async () => {
    const targetPath = draftPath.trim();
    if (!targetPath) {
      pushToast("Choose an application or .lnk file first.", "warn");
      return;
    }
    const label = draftLabel.trim() || "Shortcut";
    const res = await api.lab.addShortcut({ label, targetPath });
    setShortcutsList(res.shortcuts);
    if (res.ok) {
      pushToast(`Added “${label}”`, "success");
      setDraftPath("");
      setDraftLabel("");
      setShowCreateShortcutModal(false);
      void api.telemetry.record("lab_shortcut_added_ui", { id: res.item.id });
    } else {
      pushToast(res.error, "error");
    }
  };

  const removeShortcut = async (id: string) => {
    const res = await api.lab.removeShortcut(id);
    setShortcutsList(res.shortcuts);
    if (res.ok) {
      pushToast("Shortcut removed", "info");
      void api.telemetry.record("lab_shortcut_removed", { id });
    } else {
      pushToast(res.error, "error");
    }
  };

  const openShortcutContextMenu = (e: React.MouseEvent, entry: ElectronLabShortcut) => {
    e.preventDefault();
    e.stopPropagation();
    if (!canEditShortcuts) return;
    const menuW = 168;
    const menuH = 92;
    const pad = 8;
    const x = Math.min(e.clientX, window.innerWidth - menuW - pad);
    const y = Math.min(e.clientY, window.innerHeight - menuH - pad);
    setShortcutMenu({ x, y, entry });
  };

  const pickEditPath = async () => {
    const picked = await api.dialog.openFile(SHORTCUT_PICK_FILTERS);
    if (picked) setEditPath(picked);
  };

  const saveEditShortcut = async () => {
    if (!editTarget) return;
    const label = editLabel.trim();
    const targetPath = editPath.trim();
    if (!label || !targetPath) {
      pushToast("Name and target path are required.", "warn");
      return;
    }
    const res = await api.lab.updateShortcut({
      id: editTarget.id,
      label,
      targetPath,
    });
    setShortcutsList(res.shortcuts);
    if (res.ok) {
      pushToast("Shortcut updated", "success");
      setEditTarget(null);
      void api.telemetry.record("lab_shortcut_updated_ui", { id: editTarget.id });
    } else {
      pushToast(res.error, "error");
    }
  };

  const launchApp = async (entry: ElectronLabShortcut) => {
    const r = await api.lab.launch(entry.id);
    void api.telemetry.record("lab_launch", { id: entry.id, ok: r.ok });
    if (r.ok) {
      pushToast(`Opening ${entry.label}…`, "info");
    } else {
      pushToast(
        `${r.error ?? "Could not launch"}. If this persists, contact lab tech.`,
        "error",
      );
    }
  };

  const formatTime = (secs: number) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  };

  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const dateStr = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }).toUpperCase();
  const sessionRemainingLabel = formatSessionRemaining(sessionExpiresAt, now.getTime());

  return (
    <div
      className="runa-reference-theme runa-student-screen flex flex-col h-full min-h-0"
      style={{
        background: "linear-gradient(135deg, #4169e1 0%, #7594ea 43%, #eef1fb 100%)",
        fontFamily: GROTESK,
      }}
    >
      <header
        className="runa-student-header flex items-center justify-between px-5 h-14 border-b border-[#dfeaff]/60 shrink-0 backdrop-blur-xl"
        style={{ background: "rgba(255, 255, 255, 0.72)", boxShadow: "0 12px 30px rgba(45, 72, 155, 0.12)" }}
      >
        <div className="flex items-center gap-5 min-w-0">
          <span className="text-[#7eb5f5] shrink-0" style={{ fontSize: "16px", fontFamily: BRAND, letterSpacing: "0.12em" }}>
            RUNA
          </span>
          <span className="text-[#4a6080] shrink-0" style={{ fontSize: "10px", fontFamily: MONO }}>·</span>
          <span className="text-[#c5d5ea] truncate" style={{ fontSize: "10px", fontFamily: MONO, letterSpacing: "0.12em" }}>
            LAB SESSION
          </span>
          <div className="flex items-center gap-2 px-3 py-1 rounded-full border border-[#8ab0ff24] shrink-0" style={{ background: "rgba(110, 143, 214, 0.12)" }}>
            <Shield size={11} className="text-[#4a6fa5]" />
            <span className="tracking-widest uppercase text-[#4a6fa5]" style={{ fontSize: "9px", fontFamily: MONO }}>
              Student
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4 shrink-0">
          <div className="runa-student-elapsed-time text-right px-3 py-1.5" style={{ background: "transparent" }}>
            <div className="text-[#4a6080] tracking-widest uppercase" style={{ fontSize: "8px", fontFamily: MONO }}>
              Elapsed Time
            </div>
            <div className="text-[#c5d5ea] tabular-nums" style={{ fontSize: "20px", fontFamily: MONO, lineHeight: 1.1 }}>
              {formatTime(secondsUsed)}
            </div>
          </div>

          <div
            className="relative flex items-center gap-2 border border-[#dbe7ff]/60 rounded-xl px-3 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
            style={{ background: "rgba(255, 255, 255, 0.54)" }}
          >
            <div>
              <div className="text-[#4a6080] tracking-widest uppercase" style={{ fontSize: "8px", fontFamily: MONO }}>
                Terminal ID
              </div>
              <div className="text-[#c5d5ea]" style={{ fontSize: "11px", fontFamily: MONO }}>
                {studentId || "—"}
              </div>
            </div>
            <button
              type="button"
              className="w-8 h-8 rounded-full bg-[#3a5a9a] flex items-center justify-center hover:bg-[#4a6ab5] transition-all duration-200 ease-out hover:shadow-lg hover:translate-y-[-1px]"
              onClick={() => setShowUserMenu((v) => !v)}
              title="User menu"
            >
              <User size={16} className="text-white" />
            </button>
            {showUserMenu && (
              <div
                className="absolute top-full right-0 mt-2 rounded-xl border border-[#dfeaff]/60 overflow-hidden z-[var(--z-popover)] shadow-xl"
                style={{ background: "rgba(255,255,255,0.9)", minWidth: "160px" }}
              >
                <div className="px-4 py-3 border-b border-[#dfeaff]/60">
                  <p className="text-[#17233d]" style={{ fontSize: "11px" }}>{studentDisplayName}</p>
                  <p className="text-[#52638f]" style={{ fontSize: "9px", fontFamily: MONO }}>{studentId}</p>
                </div>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-4 py-3 text-left text-[#e05c6a] hover:bg-[#1e2e48] transition-colors"
                  style={{ fontSize: "11px", fontFamily: MONO }}
                  onClick={handleLogout}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                    <polyline points="16 17 21 12 16 7" />
                    <line x1="21" y1="12" x2="9" y2="12" />
                  </svg>
                  Logout
                </button>
              </div>
            )}
          </div>

          <NotificationsMenu />
        </div>
      </header>

      <div className="h-[1px] bg-[#1a2640]" />

      <div className="flex flex-1 min-h-0 min-w-0 overflow-x-auto overflow-y-hidden">
        <aside
          className="runa-student-rail flex flex-col items-stretch border-r border-[#dfeaff]/60 shrink-0 min-h-0 backdrop-blur-xl"
          style={{ width: "76px", background: "rgba(255, 255, 255, 0.48)" }}
        >
          <div className="flex flex-col items-center justify-center gap-2 px-1 pt-4 pb-3 border-b border-[#dfeaff]/20 w-full shrink-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-2xl border border-[#ffffff]/70 bg-white/70 text-[#4169e1] shadow-[0_10px_24px_rgba(67,106,190,0.18)]">
              <Sparkles size={18} />
            </div>
            <span className="text-[#526b9f] text-center leading-tight font-semibold" style={{ fontSize: "8px", fontFamily: MONO, letterSpacing: "0.08em" }}>
              RUNA AGENT
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center gap-2 py-2 px-0">
            {shortcutsList.length === 0 && (
              <div className="px-1 text-center text-[#5d7298] leading-relaxed" style={{ fontSize: "7px", fontFamily: MONO }}>
                {canEditShortcuts ? "Tap + below to add" : "No launchers"}
              </div>
            )}
            {shortcutsList.map((sc) => (
              <button
                key={sc.id}
                type="button"
                title={`${sc.label} — click to launch · right-click for menu`}
                onClick={() => void launchApp(sc)}
                onContextMenu={(e) => openShortcutContextMenu(e, sc)}
                className="flex flex-col items-center gap-1 py-2.5 w-full transition-all duration-200 ease-out rounded-xl hover:bg-[#162035] hover:shadow-[0_8px_20px_rgba(58,90,154,0.16)] text-[#7eb5f5]"
              >
                <AppWindow size={20} className="opacity-90" />
                <span
                  className="text-center px-0.5 line-clamp-2 leading-tight"
                  style={{ fontSize: "6px", fontFamily: MONO }}
                >
                  {sc.label}
                </span>
              </button>
            ))}
          </div>
          {canEditShortcuts && (
            <div className="shrink-0 border-t border-[#dfeaff]/20 p-2 flex justify-center">
              <button
                type="button"
                title="Create shortcut"
                onClick={() => {
                  setDraftLabel("");
                  setDraftPath("");
                  setShowCreateShortcutModal(true);
                }}
                className="w-11 h-11 rounded-full flex items-center justify-center border border-[#ffffff]/75 text-[#4169e1] hover:bg-white/85 transition-all duration-200 ease-out shadow-[0_12px_24px_rgba(52,88,177,0.22)] hover:translate-y-[-1px]"
                style={{ background: "rgba(255, 255, 255, 0.72)" }}
              >
                <Plus size={22} strokeWidth={2} />
              </button>
            </div>
          )}
        </aside>

        <main className="runa-student-main flex-1 min-h-0 min-w-0 flex flex-col overflow-hidden relative">
          <div className="shrink-0 px-4 pt-4 pb-2">
            <div
              className="rounded-2xl border px-4 py-3.5 shadow-[0_12px_24px_rgba(45,72,155,0.10)]"
              style={{ background: "rgba(255, 255, 255, 0.62)", borderColor: "rgba(99, 102, 241, 0.18)" }}
            >
              <div className="flex items-center gap-2 mb-2">
                <Shield size={12} className="text-[#e8821a]" />
                <span className="text-[#c5d5ea]" style={{ fontSize: "10px", fontFamily: MONO }}>
                  Website policy check (student feedback)
                </span>
              </div>
              <div className="flex gap-2">
                <input
                  value={siteCheckInput}
                  onChange={(e) => setSiteCheckInput(e.target.value)}
                  placeholder="Try URL e.g. example.com"
                  className="flex-1 rounded-xl px-3 py-2.5 border outline-none transition-all duration-200 ease-out placeholder:text-[#7d8cab] placeholder:italic"
                  style={{
                    background: "rgba(15, 26, 42, 0.96)",
                    borderColor: "rgba(130, 153, 214, 0.28)",
                    color: "#c5d5ea",
                    boxShadow: "0 0 0 1px rgba(122, 143, 214, 0.15), inset 0 1px 0 rgba(255,255,255,0.04)",
                    fontSize: "11px",
                    fontFamily: MONO,
                  }}
                  onFocus={(e) => {
                    e.currentTarget.style.borderColor = "rgba(102, 142, 255, 0.7)";
                    e.currentTarget.style.boxShadow = "0 0 0 3px rgba(90, 126, 255, 0.18), inset 0 1px 0 rgba(255,255,255,0.04)";
                  }}
                  onBlur={(e) => {
                    e.currentTarget.style.borderColor = "rgba(130, 153, 214, 0.28)";
                    e.currentTarget.style.boxShadow = "0 0 0 1px rgba(122, 143, 214, 0.15), inset 0 1px 0 rgba(255,255,255,0.04)";
                  }}
                />
                <button
                  type="button"
                  onClick={() => void runSiteCheck()}
                  disabled={siteCheckBusy || !siteCheckInput.trim()}
                  className="px-3 py-2 rounded-xl tracking-widest uppercase transition-all duration-200 ease-out disabled:cursor-not-allowed disabled:shadow-none hover:translate-y-[-1px] hover:shadow-lg"
                  style={{
                    background: siteCheckBusy || !siteCheckInput.trim() ? "#d5def1" : "linear-gradient(180deg, #5b7fe3 0%, #4169e1 100%)",
                    color: siteCheckBusy || !siteCheckInput.trim() ? "#526b9f" : "#ffffff",
                    boxShadow: siteCheckBusy || !siteCheckInput.trim() ? "none" : "0 8px 20px rgba(58, 90, 154, 0.28)",
                    fontSize: "10px",
                    fontFamily: MONO,
                  }}
                >
                  CHECK
                </button>
              </div>
              {siteCheckResult && (
                <p
                  className="mt-1.5"
                  style={{
                    fontSize: "10px",
                    fontFamily: MONO,
                    color:
                      siteCheckResult.level === "blocked"
                        ? "#e05c6a"
                        : siteCheckResult.level === "allowed"
                          ? "#4ac77e"
                          : "#e8a83a",
                  }}
                >
                  {siteCheckResult.text}
                </p>
              )}
            </div>
            <div
              className="rounded-2xl border px-4 py-3.5 mt-2 shadow-[0_12px_24px_rgba(45,72,155,0.10)]"
              style={{ background: "rgba(255, 255, 255, 0.62)", borderColor: "rgba(99, 102, 241, 0.18)" }}
            >
              <div className="flex items-center gap-2 mb-2">
                <Monitor size={12} className="text-[#3a6fff]" />
                <span className="text-[#c5d5ea]" style={{ fontSize: "10px", fontFamily: MONO }}>
                  This workstation (attendance)
                </span>
              </div>
              <div className="flex flex-wrap gap-2 items-end">
                <label className="flex flex-col gap-0.5 min-w-[100px]">
                  <span className="text-[#4a6080] uppercase" style={{ fontSize: "7px", fontFamily: MONO }}>
                    Comlab
                  </span>
                  <select
                    value={labComlabId}
                    onChange={(e) => setLabComlabId(e.target.value)}
                    className="rounded-xl px-2 py-2 border outline-none transition-all duration-200 ease-out"
                    style={{
                      background: "rgba(15, 26, 42, 0.96)",
                      borderColor: "rgba(130, 153, 214, 0.28)",
                      color: "#c5d5ea",
                      boxShadow: "0 0 0 1px rgba(122, 143, 214, 0.15), inset 0 1px 0 rgba(255,255,255,0.04)",
                      fontSize: "11px",
                      fontFamily: MONO,
                    }}
                  >
                    {COMLAB_DEFINITIONS.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-0.5 min-w-[120px] flex-1">
                  <span className="text-[#4a6080] uppercase" style={{ fontSize: "7px", fontFamily: MONO }}>
                    PC label
                  </span>
                  <input
                    value={labPcLabel}
                    onChange={(e) => setLabPcLabel(e.target.value)}
                    placeholder="e.g. PC-01"
                    className="rounded-xl px-2 py-2 border outline-none w-full max-w-[200px] transition-all duration-200 ease-out placeholder:text-[#7d8cab] placeholder:italic"
                    style={{
                      background: "rgba(15, 26, 42, 0.96)",
                      borderColor: "rgba(130, 153, 214, 0.28)",
                      color: "#c5d5ea",
                      boxShadow: "0 0 0 1px rgba(122, 143, 214, 0.15), inset 0 1px 0 rgba(255,255,255,0.04)",
                      fontSize: "11px",
                      fontFamily: MONO,
                    }}
                    onFocus={(e) => {
                      e.currentTarget.style.borderColor = "rgba(102, 142, 255, 0.7)";
                      e.currentTarget.style.boxShadow = "0 0 0 3px rgba(90, 126, 255, 0.18), inset 0 1px 0 rgba(255,255,255,0.04)";
                    }}
                    onBlur={(e) => {
                      e.currentTarget.style.borderColor = "rgba(130, 153, 214, 0.28)";
                      e.currentTarget.style.boxShadow = "0 0 0 1px rgba(122, 143, 214, 0.15), inset 0 1px 0 rgba(255,255,255,0.04)";
                    }}
                  />
                </label>
                <button
                  type="button"
                  onClick={() => void saveLabStation()}
                  className="px-3 py-2 rounded-xl transition-all duration-200 ease-out hover:translate-y-[-1px] hover:shadow-lg"
                  style={{ background: "linear-gradient(180deg, #5b7fe3 0%, #4169e1 100%)", color: "#ffffff", boxShadow: "0 8px 20px rgba(58, 90, 154, 0.22)", fontSize: "10px", fontFamily: MONO }}
                >
                  Save
                </button>
              </div>
              <p className="text-[#4a6080] mt-1.5" style={{ fontSize: "9px", fontFamily: MONO, lineHeight: 1.55 }}>
                Professor on record comes from the selected comlab schedule. Log in again to open a new attendance row
                after changing comlab.
              </p>
            </div>
          </div>
          <div className="flex-1 min-h-0 p-4 pt-2 box-border flex flex-col">
            <ProductivityAssistant
              role="student"
              userId={studentId || "student@runa.edu.ph"}
              sessionExpiresAt={sessionExpiresAt}
              vaultDisplayPath={vaultPath}
              height="100%"
            />
          </div>
        </main>

        <StudentRpaSidePanel
          studentId={studentId}
          sessionRemainingLabel={sessionRemainingLabel}
          vaultPathTail={vaultPath ? pathTail(vaultPath, 56) : null}
          vaultPathFull={vaultPath}
          kioskMode={kioskMode}
          canEditShortcuts={canEditShortcuts}
        />
      </div>

      <footer
        className="flex items-center justify-between px-5 h-11 border-t border-[#dfeaff]/40 shrink-0 backdrop-blur-xl"
        style={{ background: "rgba(255, 255, 255, 0.45)" }}
      >
        <div className="flex items-center gap-3 min-w-0 text-[#4a6080]" style={{ fontSize: "9px", fontFamily: MONO }}>
          <Monitor size={12} className="shrink-0" />
          <span className="truncate">
            {canEditShortcuts ? (
              <>
                Use <strong className="text-[#7eb5f5]">+</strong> on the rail to add launchers — Runa opens real Windows apps.
              </>
            ) : (
              <>Runa opens real Windows apps from the rail.{kioskMode ? " Kiosk: list is IT-managed." : ""}</>
            )}
          </span>
        </div>

        <div className="flex items-center gap-4 min-w-0 shrink-0">
          <span className="text-[#2a3a55] hidden md:inline" style={{ fontSize: "9px", fontFamily: MONO }}>
            Privacy-minimized audit trail active
          </span>
          <div
            className="runa-student-status-badge px-2.5 py-1 rounded-full border shrink-0 shadow-[inset_0_1px_0_rgba(255,255,255,0.3)]"
            style={{
              background: kioskMode ? "rgba(255, 237, 213, 0.72)" : "rgba(255, 255, 255, 0.58)",
              borderColor: kioskMode ? "rgba(232, 130, 26, 0.4)" : "rgba(99, 102, 241, 0.2)",
            }}
          >
            <span
              className="tracking-widest uppercase"
              style={{
                fontSize: "8px",
                fontFamily: MONO,
                color: kioskMode ? "#c2410c" : "#4169e1",
              }}
            >
              {kioskMode === null ? "…" : kioskMode ? "KIOSK MODE ACTIVE" : "LAB SESSION ACTIVE"}
            </span>
          </div>
          <div className="flex items-center gap-1.5 text-[#52638f] rounded-full border border-[#ffffff]/60 bg-white/55 px-2.5 py-1" style={{ fontSize: "10px", fontFamily: MONO }}>
            <Monitor size={11} />
            <span className="tracking-widest uppercase">
              COMLAB {labComlabId} · {labPcLabel}
            </span>
          </div>
          <div className="text-[#4a6080] text-right tabular-nums" style={{ fontSize: "10px", fontFamily: MONO }}>
            <div>{timeStr}</div>
            <div style={{ fontSize: "9px" }}>{dateStr}</div>
          </div>
        </div>
      </footer>

      {showCreateShortcutModal && canEditShortcuts && (
        <div
          className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center px-4"
          style={{ background: "rgba(38, 55, 126, 0.3)", backdropFilter: "blur(10px)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="create-shortcut-title"
          onClick={() => setShowCreateShortcutModal(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border p-5 shadow-xl"
            style={{ background: "rgba(255,255,255,0.9)", borderColor: "rgba(255,255,255,0.78)", boxShadow: "0 24px 70px rgba(46,65,133,0.24)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="create-shortcut-title" className="text-[#17233d] mb-4" style={{ fontSize: "15px", fontFamily: BRAND }}>
              Create shortcut
            </h2>
            <div className="flex flex-wrap gap-1 mb-3">
              {SHORTCUT_NAME_SUGGESTIONS.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setDraftLabel(name)}
                  className="px-2 py-1 rounded-lg border border-[#cbd5f0] bg-[#f4f6ff] text-[#52638f] hover:text-[#4169e1] hover:border-[#8ea7e8] transition-colors"
                  style={{ fontSize: "8px", fontFamily: MONO }}
                >
                  {name}
                </button>
              ))}
            </div>
            <label className="block mb-3">
              <span className="text-[#52638f] uppercase tracking-wider" style={{ fontSize: "8px", fontFamily: MONO }}>
                Display name
              </span>
              <input
                type="text"
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                placeholder="e.g. VS Code"
                className="mt-1 w-full rounded-lg px-2 py-2 text-[#17233d] border bg-[#f7f8fd] border-[#cbd5f0] outline-none focus:border-[#7b96e8] focus:ring-2 focus:ring-[#4169e1]/15"
                style={{ fontSize: "12px", fontFamily: MONO }}
                maxLength={80}
              />
            </label>
            <div className="mb-4">
                <span className="text-[#52638f] uppercase tracking-wider" style={{ fontSize: "8px", fontFamily: MONO }}>
                Target
              </span>
              <p className="text-[#66718a] mt-1 break-all" style={{ fontSize: "10px", fontFamily: MONO }} title={draftPath || undefined}>
                {draftPath ? pathTail(draftPath, 56) : "—"}
              </p>
              <button
                type="button"
                onClick={() => void pickTargetFile()}
                className="mt-2 px-2.5 py-1.5 rounded-lg border border-[#cbd5f0] bg-[#f4f6ff] text-[#4169e1] hover:bg-[#e8edff] transition-colors"
                style={{ fontSize: "10px", fontFamily: MONO }}
              >
                Choose .exe / .lnk…
              </button>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowCreateShortcutModal(false)}
                className="px-3 py-2 rounded-lg border border-[#cbd5f0] bg-white/60 text-[#52638f] hover:bg-[#eef2ff]"
                style={{ fontSize: "11px", fontFamily: MONO }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void addShortcut()}
                className="inline-flex items-center gap-1 px-3 py-2 rounded-lg border border-[#4169e1] bg-[#4169e1] text-white hover:bg-[#3558c7] shadow-[0_8px_18px_rgba(65,105,225,0.2)]"
                style={{ fontSize: "11px", fontFamily: MONO }}
              >
                <Plus size={14} /> Add
              </button>
            </div>
          </div>
        </div>
      )}

      {shortcutMenu && canEditShortcuts && (
        <div
          ref={shortcutMenuRef}
          className="fixed z-[10001] w-[168px] rounded-md border py-1 shadow-xl"
          style={{ left: shortcutMenu.x, top: shortcutMenu.y, background: "rgba(255,255,255,0.92)", borderColor: "rgba(99,102,241,0.18)" }}
          role="menu"
          aria-label="Shortcut actions"
        >
          <button
            type="button"
            role="menuitem"
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-[#c5d5ea] hover:bg-[#1e2e48] transition-colors"
            style={{ fontSize: "12px", fontFamily: MONO }}
            onClick={() => {
              setEditTarget(shortcutMenu.entry);
              setShortcutMenu(null);
            }}
          >
            <Pencil size={14} className="text-[#7eb5f5] shrink-0" />
            Edit…
          </button>
          <button
            type="button"
            role="menuitem"
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-[#e05c6a] hover:bg-[#1e2e48] transition-colors"
            style={{ fontSize: "12px", fontFamily: MONO }}
            onClick={() => {
              void removeShortcut(shortcutMenu.entry.id);
              setShortcutMenu(null);
            }}
          >
            <Trash2 size={14} className="shrink-0" />
            Remove
          </button>
        </div>
      )}

      {editTarget && (
        <div
          className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center px-4"
          style={{ background: "rgba(5, 10, 20, 0.82)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="edit-shortcut-title"
          onClick={() => setEditTarget(null)}
        >
          <div
            className="w-full max-w-sm rounded-lg border p-5 shadow-xl"
            style={{ background: "#111d30", borderColor: "#2a3a55" }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2 id="edit-shortcut-title" className="text-[#c5d5ea] mb-4" style={{ fontSize: "15px", fontFamily: BRAND }}>
              Edit shortcut
            </h2>
            <label className="block mb-3">
              <span className="text-[#4a6080] uppercase tracking-wider" style={{ fontSize: "8px", fontFamily: MONO }}>
                Display name
              </span>
              <input
                type="text"
                value={editLabel}
                onChange={(e) => setEditLabel(e.target.value)}
                className="mt-1 w-full rounded-sm px-2 py-1.5 text-[#c5d5ea] border bg-[#0f1a2a] border-[#1e2e48] outline-none"
                style={{ fontSize: "12px", fontFamily: MONO }}
                maxLength={80}
              />
            </label>
            <div className="mb-4">
              <span className="text-[#4a6080] uppercase tracking-wider" style={{ fontSize: "8px", fontFamily: MONO }}>
                Target
              </span>
              <p className="text-[#4a6080] mt-1 break-all" style={{ fontSize: "10px", fontFamily: MONO }} title={editPath}>
                {editPath ? pathTail(editPath, 56) : "—"}
              </p>
              <button
                type="button"
                onClick={() => void pickEditPath()}
                className="mt-2 px-2 py-1 rounded border border-[#2a3a55] text-[#7eb5f5] hover:bg-[#1e2e48] transition-colors"
                style={{ fontSize: "10px", fontFamily: MONO }}
              >
                Choose .exe / .lnk…
              </button>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setEditTarget(null)}
                className="px-3 py-2 rounded-sm border border-[#2a3a55] text-[#4a6080] hover:bg-[#1e2e48]"
                style={{ fontSize: "11px", fontFamily: MONO }}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void saveEditShortcut()}
                className="px-3 py-2 rounded-sm border border-[#3a6fff55] text-[#7eb5f5] hover:bg-[#1e3055]"
                style={{ fontSize: "11px", fontFamily: MONO }}
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {showStudentTour && (
        <div
          className="fixed inset-0 z-[var(--z-modal)] flex items-center justify-center px-6"
          style={{ background: "rgba(5, 10, 20, 0.82)" }}
          role="dialog"
          aria-modal="true"
          aria-labelledby="runa-tour-title"
        >
          <div
            className="max-w-md w-full rounded-lg border p-6 shadow-xl"
            style={{ background: "rgba(255,255,255,0.82)", borderColor: "rgba(99,102,241,0.18)" }}
          >
            <h2 id="runa-tour-title" className="text-[#c5d5ea] mb-3" style={{ fontSize: "16px", fontFamily: BRAND }}>
              Welcome to Runa (student)
            </h2>
            <ul className="text-[#8aa0c0] space-y-2 mb-5" style={{ fontSize: "12px", lineHeight: 1.5 }}>
              <li>
                <strong className="text-[#7eb5f5]">Shortcuts:</strong> tap the <strong className="text-[#7eb5f5]">+</strong>{" "}
                button at the bottom of the left rail, then pick a display name and the real{" "}
                <code className="text-[#4a6080]">.exe</code> or <code className="text-[#4a6080]">.lnk</code>.
              </li>
              <li>
                <strong className="text-[#7eb5f5]">Runa_Folder</strong> sits next to the Runa program when installed, or under
                app data in development — that is where safe file automation runs.
              </li>
              <li>
                <strong className="text-[#7eb5f5]">Kiosk labs:</strong> IT locks the list; ask lab tech to change it.
              </li>
              <li>
                <strong className="text-[#7eb5f5]">Offline AI:</strong> try again when the network is back, or ask lab tech.
              </li>
              <li>
                <strong className="text-[#7eb5f5]">Right panel:</strong> human-in-the-loop queue, your automation audit
                trace, workflow starters, and risk policy — bounded RPA for the lab.
              </li>
            </ul>
            <button
              type="button"
              onClick={dismissStudentTour}
              className="w-full py-2.5 rounded-sm tracking-widest uppercase text-[#c5d5ea] border transition-colors hover:opacity-95"
              style={{ background: "#3a5a9a", borderColor: "#4a6ab5", fontSize: "11px", fontFamily: MONO }}
            >
              Got it
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
