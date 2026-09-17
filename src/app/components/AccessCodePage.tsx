import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router";
import { Shield, Fingerprint, Lock, ArrowRight, ArrowLeft } from "lucide-react";
import { useElectron } from "../ipc/useElectron";
import { getComlab } from "../data/comlabs";

const MONO = "'Share Tech Mono', monospace";
const BRAND = "'Orbitron', sans-serif";

function CornerBracket({ position }: { position: string }) {
  const size = 20;
  const thickness = 2;
  const color = "#2a3a55";

  const styles: Record<string, React.CSSProperties> = {
    "top-left": {
      position: "absolute",
      top: 12,
      left: 12,
      width: size,
      height: size,
      borderTop: `${thickness}px solid ${color}`,
      borderLeft: `${thickness}px solid ${color}`,
    },
    "top-right": {
      position: "absolute",
      top: 12,
      right: 12,
      width: size,
      height: size,
      borderTop: `${thickness}px solid ${color}`,
      borderRight: `${thickness}px solid ${color}`,
    },
    "bottom-left": {
      position: "absolute",
      bottom: 12,
      left: 12,
      width: size,
      height: size,
      borderBottom: `${thickness}px solid ${color}`,
      borderLeft: `${thickness}px solid ${color}`,
    },
    "bottom-right": {
      position: "absolute",
      bottom: 12,
      right: 12,
      width: size,
      height: size,
      borderBottom: `${thickness}px solid ${color}`,
      borderRight: `${thickness}px solid ${color}`,
    },
  };

  return <div style={styles[position]} />;
}

const CODE_LENGTH = 6;

const ACCESS_SESSION_MS = 8 * 60 * 60 * 1000;

export function AccessCodePage() {
  const navigate = useNavigate();
  const api = useElectron();
  const sessionApi = api.session;
  const [code, setCode] = useState<string[]>(Array(CODE_LENGTH).fill(""));
  const [error, setError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    inputRefs.current[0]?.focus();
  }, []);

  const handleInput = (index: number, value: string) => {
    const char = value.replace(/[^a-fA-F0-9]/gi, "").slice(-1).toUpperCase();
    const newCode = [...code];
    newCode[index] = char;
    setCode(newCode);
    setError(false);
    if (char && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === "Backspace") {
      const newCode = [...code];
      if (code[index]) {
        newCode[index] = "";
        setCode(newCode);
      } else if (index > 0) {
        newCode[index - 1] = "";
        setCode(newCode);
        inputRefs.current[index - 1]?.focus();
      }
    } else if (e.key === "ArrowLeft" && index > 0) {
      inputRefs.current[index - 1]?.focus();
    } else if (e.key === "ArrowRight" && index < CODE_LENGTH - 1) {
      inputRefs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    e.preventDefault();
    const pasted = e.clipboardData
      .getData("text")
      .replace(/[^a-fA-F0-9]/gi, "")
      .toUpperCase()
      .slice(0, CODE_LENGTH);
    const newCode = Array(CODE_LENGTH).fill("");
    pasted.split("").forEach((char, i) => {
      newCode[i] = char;
    });
    setCode(newCode);
    const nextEmpty = Math.min(pasted.length, CODE_LENGTH - 1);
    inputRefs.current[nextEmpty]?.focus();
  };

  const handleValidate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const filled = code.filter((c) => c !== "").length;
    if (filled < CODE_LENGTH) {
      setError(true);
      return;
    }
    setSubmitting(true);
    try {
      const codeStr = code.join("");
      // Pseudonymous identity bound to the proctor-issued code itself — no
      // real student account is required, and the code (not a name) is what
      // ties the session to attendance/audit records.
      const pseudonym = `guest-${codeStr}@runa.access`;
      const now = Date.now();
      await sessionApi.set({
        userId: pseudonym,
        role: "student",
        token: `access-${crypto.randomUUID()}`,
        persistent: false,
        expiresAt: now + ACCESS_SESSION_MS,
      });
      try {
        const station = await api.labStation.get();
        const def = getComlab(station.comlabId);
        await api.attendance.checkIn({
          studentEmail: pseudonym,
          comlabId: def.id,
          comlabLabel: def.label,
          workstationLabel: station.workstationLabel,
          professorName: def.professorName,
        });
      } catch {
        /* attendance sync is best-effort, same as the normal login path */
      }
      await api.audit.log({
        eventType: "guest_access_login",
        detail: JSON.stringify({ code: codeStr }),
        actorUserId: pseudonym,
        actorRole: "student",
        riskTier: "low",
      });
      navigate("/student-dashboard");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="h-full min-h-0 w-full flex flex-col relative overflow-hidden"
      style={{
        background: "#0d1320",
        fontFamily: "'Space Grotesk', sans-serif",
      }}
    >
      {/* Corner brackets */}
      <CornerBracket position="top-left" />
      <CornerBracket position="top-right" />
      <CornerBracket position="bottom-left" />
      <CornerBracket position="bottom-right" />

      {/* Main content */}
      <div className="flex-1 flex items-center justify-center px-8 py-16 relative">
        {/* Watermark "RUNA" */}
        <div
          className="absolute inset-0 flex items-center justify-center pointer-events-none select-none"
          style={{ zIndex: 0 }}
        >
          <div
            className="text-[#1a2540] font-black tracking-tighter leading-none"
            style={{ fontSize: "clamp(180px, 25vw, 340px)", opacity: 0.6, fontFamily: BRAND }}
          >
            RUNA
          </div>
        </div>

        {/* Two-column layout */}
        <div className="relative z-[var(--z-banner)] w-full max-w-5xl flex flex-col md:flex-row items-center gap-12">
          {/* Left: Title & Info */}
          <div className="flex-1 min-w-0">
            <p
              className="text-[#4a6fa5] tracking-widest uppercase mb-3"
              style={{ fontSize: "11px", fontFamily: MONO }}
            >
              System Authentication Required
            </p>
            <h1
              className="text-[#7eb5f5] font-black leading-tight mb-2"
              style={{ fontSize: "clamp(48px, 7vw, 80px)", fontFamily: BRAND, letterSpacing: "0.05em" }}
            >
              RUNA
            </h1>
            <div className="w-16 h-[2px] bg-[#2a3a55] mb-5" />
            <p className="text-[#4a6fa5] max-w-sm" style={{ fontSize: "14px" }}>
              Official Cyber-Physical Lab Interface.
              <br />
              Secure Authorization Protocol Initialized.
            </p>

            <div className="flex gap-10 mt-8">
              <div>
                <p
                  className="text-[#2a3a55] uppercase tracking-widest mb-1"
                  style={{ fontSize: "9px", fontFamily: MONO }}
                >
                  Terminal ID
                </p>
                <p
                  className="text-[#c5d5ea]"
                  style={{ fontSize: "12px", fontFamily: MONO }}
                >
                  Encrypted_L3
                </p>
              </div>
              <div>
                <p
                  className="text-[#2a3a55] uppercase tracking-widest mb-1"
                  style={{ fontSize: "9px", fontFamily: MONO }}
                >
                  Protocol Version
                </p>
                <p
                  className="text-[#c5d5ea]"
                  style={{ fontSize: "12px", fontFamily: MONO }}
                >
                  v2.4.0-RUNA
                </p>
              </div>
            </div>
          </div>

          {/* Right: Access Code Card */}
          <div
            className="w-full md:w-[340px] shrink-0 rounded-lg p-7 border border-[#1e2e48] relative"
            style={{ background: "#131e30" }}
          >
            {/* Faint user icon watermark top right */}
            <div className="absolute top-5 right-5 opacity-10 pointer-events-none">
              <svg
                width="48"
                height="48"
                viewBox="0 0 24 24"
                fill="#7eb5f5"
              >
                <path d="M12 12c2.7 0 4.8-2.1 4.8-4.8S14.7 2.4 12 2.4 7.2 4.5 7.2 7.2 9.3 12 12 12zm0 2.4c-3.2 0-9.6 1.6-9.6 4.8v2.4h19.2v-2.4c0-3.2-6.4-4.8-9.6-4.8z" />
              </svg>
            </div>

            <form onSubmit={handleValidate}>
              {/* Title */}
              <p
                className="text-[#c5d5ea] tracking-widest uppercase mb-1"
                style={{ fontSize: "13px", fontFamily: MONO }}
              >
                Access Authorization
              </p>
              <p
                className="text-[#4a6080] tracking-widest uppercase mb-5"
                style={{ fontSize: "9px", fontFamily: MONO }}
              >
                Input 6-Digit Access Code
              </p>

              {/* Code inputs */}
              <div className="flex gap-2 mb-5">
                {code.map((char, i) => (
                  <input
                    key={i}
                    ref={(el) => { inputRefs.current[i] = el; }}
                    type="text"
                    inputMode="text"
                    maxLength={1}
                    value={char}
                    onChange={(e) => handleInput(i, e.target.value)}
                    onKeyDown={(e) => handleKeyDown(i, e)}
                    onPaste={handlePaste}
                    className="flex-1 text-center rounded-sm border-0 border-b-2 outline-none transition-all"
                    style={{
                      height: "42px",
                      fontSize: "16px",
                      fontFamily: MONO,
                      background: "#0f1a2a",
                      color: char ? "#c5d5ea" : "#2e4060",
                      borderColor: error
                        ? "#e05c6a"
                        : char
                        ? "#4a6fa5"
                        : "#2a3a55",
                      caretColor: "#7eb5f5",
                      maxWidth: "44px",
                    }}
                  />
                ))}
              </div>

              {error && (
                <p
                  className="text-[#e05c6a] mb-4 tracking-widest uppercase"
                  style={{ fontSize: "9px", fontFamily: MONO }}
                >
                  Please fill all 6 digits
                </p>
              )}

              {/* Status badges */}
              <div className="flex gap-4 mb-6">
                <div className="flex items-center gap-2">
                  <Fingerprint size={12} className="text-[#4a6fa5]" />
                  <div>
                    <p
                      className="text-[#c5d5ea] tracking-widest uppercase"
                      style={{ fontSize: "8px", fontFamily: MONO }}
                    >
                      Biometric
                    </p>
                    <p
                      className="text-[#4a6080] tracking-widest uppercase"
                      style={{ fontSize: "8px", fontFamily: MONO }}
                    >
                      Standby
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Lock size={12} className="text-[#4a6fa5]" />
                  <div>
                    <p
                      className="text-[#c5d5ea] tracking-widest uppercase"
                      style={{ fontSize: "8px", fontFamily: MONO }}
                    >
                      Encryption
                    </p>
                    <p
                      className="text-[#4a6080] tracking-widest uppercase"
                      style={{ fontSize: "8px", fontFamily: MONO }}
                    >
                      AES-256
                    </p>
                  </div>
                </div>
              </div>

              {/* Validate Protocol button */}
              <button
                type="submit"
                className="w-full flex items-center justify-center gap-2 py-3 rounded-sm tracking-widest uppercase transition-all hover:opacity-90 active:scale-[0.98] mb-3"
                style={{
                  background: "#c5d5ea",
                  color: "#0d1320",
                  fontSize: "11px",
                  fontFamily: MONO,
                }}
              >
                Validate Protocol
                <ArrowRight size={14} />
              </button>

              {/* Return to email login */}
              <button
                type="button"
                className="w-full flex items-center justify-center gap-2 py-2 text-[#4a6080] hover:text-[#7eb5f5] transition-colors tracking-widest uppercase"
                style={{ fontSize: "9px", fontFamily: MONO }}
                onClick={() => navigate("/")}
              >
                <ArrowLeft size={12} />
                Return to Email Login
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Bottom status bar */}
      <div className="flex items-center justify-between px-8 pb-6 relative z-[var(--z-banner)]">
        <div className="flex items-center gap-2 border border-[#1e2e48] bg-[#111d30] px-4 py-2 rounded-sm">
          <Shield size={12} className="text-[#4a6fa5]" />
          <span
            className="text-[#c5d5ea] tracking-widest uppercase"
            style={{ fontSize: "9px", fontFamily: MONO }}
          >
            System Protection: Active
          </span>
        </div>

        <span
          className="text-[#2a3a55] tracking-widest uppercase"
          style={{ fontSize: "9px", fontFamily: MONO }}
        >
          PCU-Dasmariñas · RUNA
        </span>

        <div className="flex items-center gap-3">
          <span
            className="text-[#2a3a55] tracking-widest uppercase"
            style={{ fontSize: "9px", fontFamily: MONO }}
          >
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