import { useState, useEffect, useCallback, type ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  Shield,
  User,
  LayoutGrid,
  Activity,
  FileText,
  Bot,
  Inbox,
} from "lucide-react";
import { NotificationsMenu } from "../providers/NotificationProvider";
import { AdminCommandCenter, SystemHealthWidget } from "./AdminCommandCenter";
import { AdminLabProvider } from "../context/AdminLabContext";
import { LabMonitoringPanel } from "./LabMonitoringPanel";
import { AuditTrailsPanel } from "./AuditTrailsPanel";
import { ProductivityAssistant } from "./agentic/ProductivityAssistant";
import { ApprovalsQueue } from "./agentic/ApprovalsQueue";
import { PythonServiceBadge } from "./PythonServiceBadge";
import { useElectron } from "../ipc/useElectron";
import { findDemoUser } from "../auth/demoUsers";
import { listPending } from "../agentic/approvalQueue";

const MONO = "'Share Tech Mono', monospace";
const GROTESK = "'Exo 2', sans-serif";
const BRAND = "'Orbitron', sans-serif";

type NavItem = {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: number;
};

const navItems = (
  pending: number,
): NavItem[] => [
  { id: "command-center", label: "COMMAND", icon: <LayoutGrid size={20} /> },
  { id: "lab-monitoring", label: "MONITORING", icon: <Activity size={20} /> },
  { id: "audit-trails", label: "AUDIT", icon: <FileText size={20} /> },
  { id: "assistant", label: "ASSISTANT", icon: <Bot size={20} /> },
  {
    id: "approvals",
    label: "APPROVALS",
    icon: <Inbox size={20} />,
    badge: pending > 0 ? pending : undefined,
  },
];

function AdminContent({
  active,
  adminId,
  onApprovalsChange,
  pendingCount,
}: {
  active: string;
  adminId: string;
  onApprovalsChange?: () => void;
  pendingCount: number;
}) {
  switch (active) {
    case "assistant":
      return (
        <div className="h-full min-h-0 p-4 box-border">
          <ProductivityAssistant role="admin" userId={adminId} height="100%" />
        </div>
      );
    case "approvals":
      return (
        <div className="h-full min-h-0 p-4 box-border">
          <ApprovalsQueue currentAdminId={adminId} onChange={onApprovalsChange} />
        </div>
      );
    case "lab-monitoring":
      return <LabMonitoringPanel />;
    case "audit-trails":
      return <AuditTrailsPanel />;
    case "command-center":
    default:
      return <AdminCommandCenter pendingCount={pendingCount} />;
  }
}

export function Dashboard() {
  const navigate = useNavigate();
  const api = useElectron();
  const [activeNav, setActiveNav] = useState("command-center");
  const [now, setNow] = useState(new Date());
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [adminId, setAdminId] = useState("");
  const [adminDisplayName, setAdminDisplayName] = useState("System Administrator");
  const [pendingCount, setPendingCount] = useState(0);
  const handleHealthResult = useCallback((_ok: boolean | null) => {
    // Right-pane health widget is informational only in this shell.
  }, []);
  const refreshPending = useCallback(async () => {
    try {
      const p = await listPending();
      setPendingCount(p.length);
    } catch {
      setPendingCount(0);
    }
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    (async () => {
      const s = await api.session.get();
      if (s?.userId) {
        setAdminId(s.userId);
        const u = findDemoUser(s.userId);
        setAdminDisplayName(u?.displayName ?? s.userId);
      }
      await refreshPending();
    })();
  }, [api, refreshPending]);

  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const dateStr = now
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })
    .toUpperCase();

  const items = navItems(pendingCount);
  const activeLabel = items.find((n) => n.id === activeNav)?.label ?? "DASHBOARD";

  const handleLogout = async () => {
    await api.session.clear();
    navigate("/");
  };

  return (
    <AdminLabProvider>
    <div className="runa-admin-screen flex flex-col h-full min-h-0" style={{ background: "rgba(255,255,255,0.12)", fontFamily: GROTESK }}>
      <header
        className="relative z-[100] flex items-center justify-between px-5 h-14 border-b border-[#1a2640] shrink-0"
        style={{ background: "rgba(255,255,255,0.58)" }}
      >
        <div className="flex items-center gap-5">
          <span className="text-[#7eb5f5]" style={{ fontSize: "16px", fontFamily: BRAND, letterSpacing: "0.12em" }}>
            RUNA
          </span>
          <div className="flex items-center gap-2 px-3 py-1 rounded-sm border border-[#cbd5f0] bg-white/50">
            <Shield size={11} className="text-[#4a6fa5]" />
            <span className="tracking-widest uppercase text-[#4a6fa5]" style={{ fontSize: "9px", fontFamily: MONO }}>
              Admin Session
            </span>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <PythonServiceBadge />
          <div
            className="relative flex items-center gap-2 border border-[#dbe7ff]/60 rounded-xl px-3 py-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
            style={{ background: "rgba(255, 255, 255, 0.54)" }}
          >
            <div>
              <div className="text-[#52638f] tracking-widest uppercase" style={{ fontSize: "8px", fontFamily: MONO }}>
                Admin ID
              </div>
              <div className="text-[#17233d]" style={{ fontSize: "11px", fontFamily: MONO }}>
                {adminId || "—"}
              </div>
            </div>
            <button
              className="w-8 h-8 rounded-full bg-[#4169e1] flex items-center justify-center hover:bg-[#3156b8] transition-all duration-200 ease-out hover:shadow-lg hover:translate-y-[-1px]"
              onClick={() => setShowUserMenu((v) => !v)}
              title="Admin menu"
            >
              <User size={16} className="text-white" />
            </button>

            {showUserMenu && (
              <div
                className="absolute top-full right-0 mt-2 rounded-xl border border-[#dfeaff]/60 overflow-hidden z-[10001] shadow-xl"
                style={{ background: "rgba(255,255,255,0.92)", minWidth: "160px" }}
              >
                <div className="px-4 py-3 border-b border-[#dfeaff]/60">
                  <p className="text-[#17233d]" style={{ fontSize: "11px" }}>{adminDisplayName}</p>
                  <p className="text-[#52638f]" style={{ fontSize: "9px", fontFamily: MONO }}>{adminId}</p>
                </div>
                <button
                  className="w-full flex items-center gap-2 px-4 py-3 text-left text-[#c2415e] hover:bg-[#eef2ff] transition-colors"
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

      <div className="flex flex-1 min-h-0 overflow-hidden">
        <aside
          className="flex flex-col items-center pt-4 pb-3 gap-1 border-r border-white/60 shrink-0"
          style={{ width: "88px", background: "rgba(255,255,255,0.42)" }}
        >
          {items.map((item) => {
            const isActive = activeNav === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setActiveNav(item.id)}
                className="relative flex flex-col items-center gap-1.5 py-3.5 w-full transition-all"
                style={{
                  background: isActive ? "rgba(224,231,255,0.82)" : "transparent",
                  borderLeft: isActive ? "2px solid #4169e1" : "2px solid transparent",
                  color: isActive ? "#3156b8" : "#304b86",
                }}
                title={item.label}
              >
                {item.icon}
                {item.badge !== undefined && item.badge > 0 && (
                  <span
                    className="absolute top-2 right-2 min-w-[14px] h-[14px] px-0.5 rounded-full flex items-center justify-center text-white"
                    style={{ fontSize: "8px", fontFamily: MONO, background: "#e05c6a" }}
                  >
                    {item.badge > 9 ? "9+" : item.badge}
                  </span>
                )}
                <span className="tracking-widest font-semibold" style={{ fontSize: "8px", fontFamily: MONO }}>
                  {item.label}
                </span>
              </button>
            );
          })}
        </aside>

        <main className="flex-1 min-h-0 relative overflow-hidden flex flex-col">
          <div className="flex flex-1 min-h-0 overflow-y-auto">
            <div className="flex-1 min-h-0">
              <AdminContent
                active={activeNav}
                adminId={adminId || "admin@runa.edu.ph"}
                onApprovalsChange={refreshPending}
                pendingCount={pendingCount}
              />
            </div>

            <aside
              className="flex flex-col border-l border-[#1a2640] shrink-0 py-5 px-4 gap-6 overflow-y-auto min-h-0"
              style={{ width: "300px", background: "rgba(255,255,255,0.46)" }}
            >
              <SystemHealthWidget
                onHealthResult={handleHealthResult}
                liveStudentCount={0}
                enabled={activeNav === "command-center"}
              />

              <div className="h-[1px] bg-[#1a2640]" />

              <div>
                <span className="block text-[#4a6080] tracking-widest uppercase mb-3" style={{ fontSize: "8px", fontFamily: MONO }}>
                  Active View
                </span>
                <div
                  className="flex items-center gap-2 px-3 py-2 rounded-md border border-[#2a3a55]"
                    style={{ background: "rgba(224,231,255,0.72)" }}
                >
                  <div className="w-2 h-2 rounded-full bg-[#3a6fff]" />
                  <span className="text-[#7eb5f5] tracking-widest uppercase" style={{ fontSize: "10px", fontFamily: MONO }}>
                    {activeLabel}
                  </span>
                </div>
              </div>

              <div className="h-[1px] bg-[#1a2640]" />

              <div>
                <span className="block text-[#4a6080] tracking-widest uppercase mb-3" style={{ fontSize: "8px", fontFamily: MONO }}>
                  Privilege Level
                </span>
                <div className="flex items-center gap-2">
                  <Shield size={13} className="text-[#4a6fa5]" />
                  <span className="text-[#c5d5ea]" style={{ fontSize: "11px", fontFamily: MONO }}>SUPER ADMIN</span>
                </div>
                <p className="text-[#2a3a55] mt-1" style={{ fontSize: "9px", fontFamily: MONO }}>
                  Full system privileges
                </p>
              </div>

            </aside>
          </div>
        </main>
      </div>

      <footer
        className="flex items-center justify-between px-5 h-11 border-t border-[#1a2640] shrink-0"
        style={{ background: "rgba(255,255,255,0.58)" }}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div
            className="hidden sm:flex items-center gap-2 px-2.5 py-1 rounded-md border shrink-0"
            style={{ background: "rgba(224,231,255,0.72)", borderColor: "rgba(99,102,241,0.18)" }}
          >
            <Shield size={11} className="text-[#4ac77e]" />
            <span className="text-[#4ac77e] tracking-widest uppercase" style={{ fontSize: "8px", fontFamily: MONO }}>
              System Protection Active
            </span>
          </div>
          <span className="text-[#4a6080] tracking-widest uppercase" style={{ fontSize: "9px", fontFamily: MONO }}>
            Use left rail for navigation
          </span>
        </div>

        <div className="flex items-center gap-4">
          <span className="text-[#2a3a55]" style={{ fontSize: "9px", fontFamily: MONO }}>
            Governed automation: MEDIUM/HIGH actions require HITL approval
          </span>
          <div className="flex items-center gap-1.5 text-[#4a6080]" style={{ fontSize: "10px", fontFamily: MONO }}>
            <Shield size={11} />
            <span className="tracking-widest uppercase">ADMIN</span>
          </div>
          <div className="text-[#4a6080] text-right tabular-nums" style={{ fontSize: "10px", fontFamily: MONO }}>
            <div>{timeStr}</div>
            <div style={{ fontSize: "9px" }}>{dateStr}</div>
          </div>
        </div>
      </footer>
    </div>
    </AdminLabProvider>
  );
}
