import { useEffect, useState } from "react";
import { useElectron } from "../ipc/useElectron";

const MONO = "'Share Tech Mono', monospace";

type HealthBody = { status?: string; clamd?: boolean; usb?: boolean; timestamp?: number };

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
      reachable === null ? "#6474a2" : reachable ? "#16a05d" : "#b86b2d";
  const label =
    reachable === null ? "Security service …" : reachable ? "Security service OK" : "Security service offline";

  return (
    <div
      className="flex items-center gap-2 px-2 py-1 rounded-md border"
      style={{
        background: reachable === false ? "rgba(255,247,237,0.58)" : "rgba(247,248,253,0.82)",
          borderColor: reachable === false ? "rgba(249,115,22,0.2)" : "rgba(99,102,241,0.18)",
      }}
      title={
        health
          ? `clamd=${String(health.clamd)} usb=${String(health.usb)}`
          : reachable === false
            ? "Start python-service or check FLASK_PORT"
            : "Python microservice health"
      }
    >
      <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dot }} />
      <span className="text-[#3f568d] tracking-tight" style={{ fontSize: "9px", fontFamily: MONO, fontWeight: 600 }}>
        {label}
      </span>
      {health && reachable && (
        <span className="text-[#526b9f] hidden sm:inline" style={{ fontSize: "8px", fontFamily: MONO }}>
          clam {health.clamd ? "on" : "off"} · usb {health.usb ? "on" : "off"}
        </span>
      )}
    </div>
  );
}
