/**
 * TitleBar.tsx
 *
 * Custom window titlebar that replaces the native OS chrome.
 * Draggable region + minimize / maximize / close controls.
 * Shown only when running inside Electron (window.electronAPI exists).
 */
import { Minus, Square, X } from "lucide-react";
import { useWindowControls } from "../ipc/useElectron";

const MONO = "'Share Tech Mono', monospace";
const BRAND = "'Orbitron', sans-serif";

interface TitleBarProps {
  title?: string;
}

export function TitleBar({ title = "PCU Lab Portal" }: TitleBarProps) {
  // Only render inside Electron
  if (typeof window === "undefined" || !window.electronAPI) return null;

  const { minimize, maximize, close } = useWindowControls();

  return (
    <div
    style={{
      // -webkit-app-region: drag makes the whole bar draggable in Electron
      WebkitAppRegion: "drag",
      background: "rgba(255,255,255,0.7)",
      borderBottom: "1px solid rgba(99, 102, 241, 0.16)",
      height: 36,
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      paddingLeft: 12,
      paddingRight: 0,
      userSelect: "none",
      flexShrink: 0,
      backdropFilter: "blur(18px)",
    } as any}
  >
      {/* App label */}
      <span
        style={{
          color: "#3d5cad",
          fontSize: 10,
          fontFamily: MONO,
          letterSpacing: "0.15em",
          textTransform: "uppercase",
        }}
      >
        ◈ {title}
      </span>

      {/* Window controls — must NOT be draggable */}
      <div
        style={{
          display: "flex",
          WebkitAppRegion: "no-drag",
        } as any}
      >
        <WinBtn icon={<Minus size={10} />} onClick={minimize} hover="rgba(65, 105, 225, 0.12)" />
        <WinBtn icon={<Square size={9} />} onClick={maximize} hover="rgba(65, 105, 225, 0.12)" />
        <WinBtn
          icon={<X size={11} />}
          onClick={close}
          hover="rgba(224, 92, 106, 0.18)"
          closeBtn
        />
      </div>
    </div>
  );
}

// ── Helper ──────────────────────────────────────────────────────────────────
function WinBtn({
  icon,
  onClick,
  hover,
  closeBtn = false,
}: {
  icon: React.ReactNode;
  onClick: () => void;
  hover: string;
  closeBtn?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        width: 46,
        height: 36,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "transparent",
        border: "none",
        color: "#52638f",
        cursor: "pointer",
        transition: "background 0.15s, color 0.15s",
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = hover;
        (e.currentTarget as HTMLButtonElement).style.color = closeBtn
          ? "#d14b62"
          : "#17233d";
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLButtonElement).style.background = "transparent";
        (e.currentTarget as HTMLButtonElement).style.color = "#52638f";
      }}
    >
      {icon}
    </button>
  );
}
