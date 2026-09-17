import { useEffect, useState } from "react";
import { useElectron } from "../ipc/useElectron";

const MONO = "'Share Tech Mono', monospace";

type DefinitionsStatus = { engine?: "clamd" | "stub"; definitions?: string | null; detail?: string };
type HealthBody = {
  status?: string;
  clamd?: boolean;
  usb?: boolean;
  timestamp?: number;
  definitionsStatus?: DefinitionsStatus;
};

/**
 * Polls `GET /health` on the bundled Python sidecar. Read-only; safe when
 * the process is not running (shows offline, no throws).
 */
export function PythonServiceBadge() {
  const { python } = useElectron();
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [health, setHealth] = useState<HealthBody | null>(null);

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const r = await python.call<HealthBody>("/health", undefined, {
        method: "GET",
        timeoutMs: 5000,
      });
      if (cancelled) return;
      if (r.ok && r.data && typeof r.data === "object" && (r.data as HealthBody).status === "ok") {
        setReachable(true);
        setHealth(r.data as HealthBody);
      } else {
        setReachable(false);
        setHealth(null);
      }
    };
    void tick();
    const id = setInterval(() => void tick(), 15000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [python]);

  const dot =
    reachable === null ? "#2a3a55" : reachable ? "#4ac77e" : "#e8821a";
  const label =
    reachable === null ? "Security service …" : reachable ? "Security service OK" : "Security service offline";

  return (
    <div
      className="flex items-center gap-2 px-2 py-1 rounded-sm border border-[#1e2e48]"
      style={{ background: "#111d30" }}
      title={
        health
          ? health.definitionsStatus?.detail ?? `clamd=${String(health.clamd)} usb=${String(health.usb)}`
          : reachable === false
            ? "Start python-service or check FLASK_PORT"
            : "Python microservice health"
      }
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
      <span className="text-[#c5d5ea] tracking-tight" style={{ fontSize: "9px", fontFamily: MONO }}>
        {label}
      </span>
      {health && reachable && (
        <span className="text-[#4a6080] hidden sm:inline" style={{ fontSize: "8px", fontFamily: MONO }}>
          {health.definitionsStatus?.engine === "clamd"
            ? `defs ${health.definitionsStatus.definitions ?? "unknown"}`
            : "engine: stub (no ClamAV)"}{" "}
          · usb {health.usb ? "on" : "off"}
        </span>
      )}
    </div>
  );
}
