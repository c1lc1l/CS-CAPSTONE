import { useState } from "react";
import { useNavigate } from "react-router";
import {
  Shield,
  AtSign,
  Lock,
  KeyRound,
  LogIn,
  GraduationCap,
  ShieldCheck,
  AlertTriangle,
  Eye,
  EyeOff,
} from "lucide-react";
import { authenticate } from "../auth/demoUsers";
import { useElectron } from "../ipc/useElectron";
import { getComlab } from "../data/comlabs";
import type { ElectronRole } from "../../types/electron";

const MONO = "'Share Tech Mono', monospace";
const GROTESK = "'Exo 2', sans-serif";
const BRAND = "'Orbitron', sans-serif";

const SESSION_DURATION_MS = 8 * 60 * 60 * 1000;

type Role = ElectronRole;

export function LoginPage() {
  const navigate = useNavigate();
  const api = useElectron();
  const sessionApi = api.session;
  const [role, setRole] = useState<Role>("student");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [persistent, setPersistent] = useState(false);
  const [loginError, setLoginError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginError(null);
    setSubmitting(true);
    try {
      const user = authenticate(email, password);
      if (!user) {
        setLoginError("Invalid email or password.");
        return;
      }
      if (user.role !== role) {
        setLoginError(
          `This account is a ${user.role === "admin" ? "admin" : "student"} account. Switch the tab above.`,
        );
        return;
      }
      const now = Date.now();
      const expiresAt = persistent ? now + SESSION_DURATION_MS * 365 : now + SESSION_DURATION_MS;
      await sessionApi.set({
        userId: user.email,
        role: user.role,
        token: `demo-${crypto.randomUUID()}`,
        persistent,
        expiresAt,
      });
      await api.audit.log({
        eventType: "login",
        detail: JSON.stringify({ email: user.email, role: user.role, persistent }),
        actorUserId: user.email,
        actorRole: user.role,
        riskTier: "low",
      });
      if (user.role === "student") {
        try {
          const station = await api.labStation.get();
          const def = getComlab(station.comlabId);
          await api.attendance.checkIn({
            studentEmail: user.email,
            comlabId: def.id,
            comlabLabel: def.label,
            workstationLabel: station.workstationLabel,
            professorName: def.professorName,
          });
        } catch {
          /* Attendance sync is best-effort when Lambda/DB are unavailable. */
        }
      }
      navigate(user.role === "admin" ? "/dashboard" : "/student-dashboard");
    } finally {
      setSubmitting(false);
    }
  };

  const isAdmin = role === "admin";

  return (
    <div
      className="runa-login-screen h-full w-full flex flex-col relative overflow-hidden min-h-0"
      style={{ fontFamily: GROTESK }}
    >
      {/* Corner brackets */}
      <CornerBracket position="top-left" />
      <CornerBracket position="top-right-main" />
      <CornerBracket position="bottom-left" />
      <CornerBracket position="bottom-right" />

      {/* Main content */}
      <div className="runa-login-content flex-1 flex items-center justify-center px-8 py-16 relative">
        {/* Watermark */}
        <div className="runa-login-watermark absolute inset-0 flex items-center justify-center pointer-events-none select-none" style={{ zIndex: 0 }}>
            <div className="text-[#dce3fa] font-black tracking-tighter leading-none" style={{ fontSize: "clamp(180px, 25vw, 340px)", opacity: 0.6, fontFamily: BRAND }}>
            RUNA
          </div>
        </div>

        {/* Two-column layout */}
        <div className="runa-login-layout relative z-[var(--z-banner)] w-full max-w-5xl flex flex-col md:flex-row items-center gap-12">

          {/* Left: Title & Info */}
          <div className="runa-login-brand flex-1 min-w-0">
            <p className="text-[#4a6fa5] tracking-widest uppercase mb-3" style={{ fontSize: "11px", fontFamily: MONO }}>
              System Authentication Required
            </p>
            <h1 className="text-[#7eb5f5] font-black leading-tight mb-4" style={{ fontSize: "clamp(48px, 7vw, 80px)", fontFamily: BRAND, letterSpacing: "0.05em" }}>
              RUNA
            </h1>
            <div className="w-16 h-[2px] bg-[#2a3a55] mb-5" />
            <p className="text-[#4a6fa5] max-w-sm" style={{ fontSize: "14px" }}>
              Robotic Unified Network Agent.
            </p>

            <div className="flex gap-10 mt-8">
              <div>
                <p className="text-[#2a3a55] uppercase tracking-widest mb-1" style={{ fontSize: "9px", fontFamily: MONO }}>
                  System Version
                </p>
                <p className="text-[#c5d5ea]" style={{ fontSize: "12px", fontFamily: MONO }}>
                  V4.0.2-RUNA
                </p>
              </div>
            </div>

            {/* Role info pills — REMOVED */}
          </div>

          {/* Right: Login Form Card */}
          <div
            className="runa-login-card w-full md:w-[360px] shrink-0 rounded-lg border border-[#1e2e48] relative overflow-hidden"
            style={{ background: "rgba(255,255,255,0.78)" }}
          >
            {/* ── Role Toggle Tabs ── */}
            <div className="flex border-b border-[#1e2e48]">
              <button
                onClick={() => { setRole("student"); setEmail(""); setPassword(""); }}
                className={`runa-login-student-tab ${!isAdmin ? "runa-login-student-tab-active" : ""} flex-1 flex items-center justify-center gap-2 py-3.5 transition-all`}
                style={{
                  background: !isAdmin ? "#0f172a" : "transparent",
                  borderBottom: !isAdmin ? "2px solid #3a6fff" : "2px solid transparent",
                  color: !isAdmin ? "#7eb5f5" : "#4a6080",
                  fontSize: "10px",
                  fontFamily: MONO,
                }}
              >
                <GraduationCap size={13} />
                STUDENT
              </button>
              <button
                onClick={() => { setRole("admin"); setEmail(""); setPassword(""); }}
                className={`runa-login-admin-tab ${isAdmin ? "runa-login-admin-tab-active" : ""} flex-1 flex items-center justify-center gap-2 py-3.5 transition-all`}
                style={{
                  background: isAdmin ? "#fff7ed" : "transparent",
                  borderBottom: isAdmin ? "2px solid #e8821a" : "2px solid transparent",
                  color: isAdmin ? "#e8821a" : "#4a6080",
                  fontSize: "10px",
                  fontFamily: MONO,
                }}
              >
                <ShieldCheck size={13} />
                ADMIN
              </button>
            </div>

            {/* Role badge inside card */}
            <div className="px-7 pt-5 pb-0 flex items-center justify-between">
              <div>
                <p className="text-[#4a6080] tracking-widest uppercase" style={{ fontSize: "8px", fontFamily: MONO }}>
                  {isAdmin ? "Administrator Portal" : "Student Portal"}
                </p>
                <p className="text-[#c5d5ea] mt-0.5" style={{ fontSize: "13px" }}>
                  {isAdmin ? "System Access" : "Lab Access"}
                </p>
              </div>
              <div
                className="w-9 h-9 rounded-full flex items-center justify-center border"
                style={{
                  background: isAdmin ? "#fff7ed" : "#eef2ff",
                  borderColor: isAdmin ? "#e8821a40" : "#3a6fff40",
                }}
              >
                {isAdmin
                  ? <ShieldCheck size={16} className="text-[#e8821a]" />
                  : <GraduationCap size={16} className="text-[#3a6fff]" />
                }
              </div>
            </div>

            <form onSubmit={handleSignIn} className="px-7 pt-5 pb-7 space-y-5">
              {/* Email */}
              <div>
                <label className="block text-[#4a6fa5] tracking-widest uppercase mb-2" style={{ fontSize: "9px", fontFamily: MONO }}>
                  {isAdmin ? "Admin Email" : "Organization Email"}
                </label>
                <div className="relative">
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={isAdmin ? "admin@runa.edu.ph" : "student@runa.edu.ph"}
                    className="w-full rounded-sm px-4 py-3 pr-10 text-[#c5d5ea] placeholder-[#2e4060] border outline-none transition-colors"
                    style={{
                      background: "#f7f8fd",
                      borderColor: "#d6def5",
                      fontSize: "13px",
                      fontFamily: MONO,
                    }}
                    onFocus={(e) => (e.target.style.borderColor = isAdmin ? "#e8821a" : "#4a6fa5")}
                    onBlur={(e) => (e.target.style.borderColor = "#1e2e48")}
                  />
                  <AtSign size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-[#2e4060]" />
                </div>
              </div>

              {/* Password */}
              <div>
                <label className="block text-[#4a6fa5] tracking-widest uppercase mb-2" style={{ fontSize: "9px", fontFamily: MONO }}>
                  Password
                </label>
                <div className="relative">
                  <Lock size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#2e4060] pointer-events-none" />
                  <input
                    type={showPassword ? "text" : "password"}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full rounded-sm pl-10 pr-11 py-3 text-[#c5d5ea] placeholder-[#2e4060] border outline-none transition-colors"
                    style={{
                      background: "#f7f8fd",
                      borderColor: "#d6def5",
                      fontSize: "13px",
                      fontFamily: MONO,
                    }}
                    onFocus={(e) => (e.target.style.borderColor = isAdmin ? "#e8821a" : "#4a6fa5")}
                    onBlur={(e) => (e.target.style.borderColor = "#1e2e48")}
                  />
                  <button
                    type="button"
                    tabIndex={-1}
                    onClick={() => setShowPassword((v) => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-[#4a6080] hover:text-[#7eb5f5] transition-colors"
                    title={showPassword ? "Hide password" : "Show password"}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                {loginError && (
                  <div
                    className="mt-2 flex items-start gap-2 text-[#e05c6a]"
                    style={{ fontSize: "10px", fontFamily: MONO }}
                  >
                    <AlertTriangle size={12} className="shrink-0 mt-0.5" />
                    <span>{loginError}</span>
                  </div>
                )}
              </div>

              {/* Persistent session + Recovery */}
              <div className="flex items-center justify-between">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={persistent}
                    onChange={(e) => setPersistent(e.target.checked)}
                    className="w-3 h-3 accent-[#4a6fa5]"
                  />
                  <span className="text-[#4a6080] tracking-widest uppercase" style={{ fontSize: "9px", fontFamily: MONO }}>
                    Persistent Session
                  </span>
                </label>
                <button
                  type="button"
                  className="text-[#4a6fa5] tracking-widest uppercase hover:text-[#7eb5f5] transition-colors"
                  style={{ fontSize: "9px", fontFamily: MONO }}
                >
                  Recovery Flow
                </button>
              </div>

              {/* Sign In button */}
              <button
                type="submit"
                disabled={submitting}
                className={`runa-login-submit ${isAdmin ? "runa-login-admin-submit" : "runa-login-student-submit"} w-full flex items-center justify-center gap-2 py-3 rounded-sm tracking-widest uppercase transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50`}
                style={{
                  background: isAdmin ? "#e8821a" : "#c5d5ea",
                  color: isAdmin ? "#0d1320" : "#0d1320",
                  fontSize: "11px",
                  fontFamily: MONO,
                }}
              >
                {submitting ? "Signing in…" : isAdmin ? "Admin Sign In" : "Sign In"}
                <LogIn size={14} />
              </button>

              {/* Access Code — only for students */}
              {!isAdmin && (
                <button
                  type="button"
                  className="w-full flex items-center justify-center gap-2 py-3 rounded-sm tracking-widest uppercase border border-[#2a3a55] text-[#4a6080] hover:border-[#4a6fa5] hover:text-[#7eb5f5] transition-all"
                  style={{ background: "#f4f6ff", fontSize: "10px", fontFamily: MONO }}
                  onClick={() => navigate("/access-code")}
                >
                  <KeyRound size={13} />
                  Sign In with Access Code
                </button>
              )}

              {/* Admin note */}
              {isAdmin && (
                <p className="text-center text-[#4a6080]" style={{ fontSize: "9px", fontFamily: MONO }}>
                  Admin accounts require dual-factor verification.
                </p>
              )}
            </form>
          </div>
        </div>
      </div>

      {/* Bottom status bar */}
      <div className="flex items-center justify-between px-8 pb-6 relative z-[var(--z-banner)]">
        <div className="flex items-center gap-2 border border-[#7f97d7] bg-white/45 px-4 py-2 rounded-lg">
          <Shield size={12} className="text-[#52638f]" />
          <span className="text-[#52638f] tracking-widest uppercase" style={{ fontSize: "9px", fontFamily: MONO }}>
            System Protection: Active
          </span>
        </div>
        <span className="text-[#2a3a55] tracking-widest uppercase" style={{ fontSize: "9px", fontFamily: MONO }}>
          PCU-Dasmariñas · RUNA
        </span>
        <div className="flex items-center gap-3">
          <span className="text-[#2a3a55] tracking-widest uppercase" style={{ fontSize: "9px", fontFamily: MONO }}>
            © RUNA
          </span>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-[#2a3a55]" />
            <div className="w-2 h-2 rounded-full bg-[#2a3a55]" />
            <div className="w-2 h-2 rounded-full bg-[#4a6fa5]" />
          </div>
        </div>
      </div>
    </div>
  );
}

function CornerBracket({ position }: { position: string }) {
  const size = 20;
  const thickness = 2;
  const color = "#2a3a55";

  const styles: Record<string, React.CSSProperties> = {
    "top-left":       { position: "absolute", top: 12,    left: 12,  width: size, height: size, borderTop:    `${thickness}px solid ${color}`, borderLeft:  `${thickness}px solid ${color}` },
    "top-right-main": { position: "absolute", top: 12,    right: 12, width: size, height: size, borderTop:    `${thickness}px solid ${color}`, borderRight: `${thickness}px solid ${color}` },
    "bottom-left":    { position: "absolute", bottom: 12, left: 12,  width: size, height: size, borderBottom: `${thickness}px solid ${color}`, borderLeft:  `${thickness}px solid ${color}` },
    "bottom-right":   { position: "absolute", bottom: 12, right: 12, width: size, height: size, borderBottom: `${thickness}px solid ${color}`, borderRight: `${thickness}px solid ${color}` },
  };

  return <div style={styles[position]} />;
}