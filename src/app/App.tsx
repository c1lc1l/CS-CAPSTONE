/**
 * App.tsx  (updated for Electron)
 *
 * Wraps the entire app in a flex-column layout:
 *   ┌──────────────────────┐
 *   │  TitleBar (36px)     │  ← custom window chrome
 *   ├──────────────────────┤
 *   │  Router outlet       │  ← all existing pages unchanged
 *   └──────────────────────┘
 */
import { RouterProvider } from "react-router";
import { Toaster } from "sonner";
import { useEffect, useState } from "react";
import { router } from "./routes";
import { TitleBar } from "./components/TitleBar";
import { NotificationProvider } from "./providers/NotificationProvider";
import { PRESENCE_HEARTBEAT_INTERVAL_MS } from "./constants/presence";

const CONSENT_KEY = "runa.governanceConsent.v1";

export default function App() {
  const [showConsent, setShowConsent] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(CONSENT_KEY)) setShowConsent(true);
    } catch {
      setShowConsent(true);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;
    let lastVisible: boolean | null = null;
    let lastSentAt = 0;

    const sendHeartbeat = async (reason: "interval" | "visibility_change") => {
      if (typeof window === "undefined" || !window.electronAPI) return;
      const now = Date.now();
      const visible = typeof document !== "undefined" ? document.visibilityState === "visible" : true;
      const minIntervalMs = visible ? PRESENCE_HEARTBEAT_INTERVAL_MS : PRESENCE_HEARTBEAT_INTERVAL_MS * 2;
      const visibilityChanged = lastVisible === null ? true : lastVisible !== visible;
      if (reason === "interval" && now - lastSentAt < minIntervalMs) return;
      if (reason === "interval" && !visibilityChanged && now - lastSentAt < minIntervalMs) return;
      try {
        const session = await window.electronAPI.session.get();
        if (!session) return;
        await window.electronAPI.audit.log({
          eventType: "presence_heartbeat",
          detail: JSON.stringify({
            platform: "desktop",
            visible,
            reason,
          }),
          actorUserId: session.userId,
          actorRole: session.role,
          riskTier: "low",
        });
        lastVisible = visible;
        lastSentAt = now;
      } catch {
        // Heartbeat is best-effort for demo presence visualization.
      }
    };

    const onVisibilityChange = () => {
      if (!cancelled) void sendHeartbeat("visibility_change");
    };

    void sendHeartbeat("interval");
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisibilityChange);
    }
    timer = window.setInterval(() => {
      if (!cancelled) void sendHeartbeat("interval");
    }, PRESENCE_HEARTBEAT_INTERVAL_MS);

    return () => {
      cancelled = true;
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (timer) window.clearInterval(timer);
    };
  }, []);

  const acceptConsent = async () => {
    try {
      localStorage.setItem(CONSENT_KEY, String(Date.now()));
    } catch {
      // ignore storage failures
    }
    setShowConsent(false);
    if (typeof window !== "undefined" && window.electronAPI) {
      const session = await window.electronAPI.session.get();
      await window.electronAPI.audit.log({
        eventType: "consent_given",
        detail: "User accepted governance consent banner.",
        actorUserId: session?.userId ?? "unknown",
        actorRole: session?.role ?? "system",
        riskTier: "low",
      });
    }
  };

  return (
    <div
      className="runa-light-app"
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        background: "linear-gradient(135deg, #4169e1 0%, #7594ea 42%, #eef1fb 100%)",
      }}
    >
      <TitleBar />
      <div style={{ flex: 1, overflow: "hidden" }}>
        <NotificationProvider>
          <RouterProvider router={router} />
        </NotificationProvider>
      </div>
      <Toaster richColors position="bottom-right" theme="dark" closeButton />
      {showConsent && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(30, 48, 104, 0.42)",
            backdropFilter: "blur(14px)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 11000,
            padding: "16px",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "560px",
              border: "1px solid rgba(255, 255, 255, 0.72)",
              background: "rgba(255, 255, 255, 0.88)",
              boxShadow: "0 24px 70px rgba(46, 65, 133, 0.24)",
              borderRadius: "16px",
              padding: "16px",
              color: "#17233d",
              fontFamily: "'Exo 2', sans-serif",
            }}
          >
            <h2 style={{ margin: 0, marginBottom: "8px", fontSize: "16px" }}>Governance Consent</h2>
            <p style={{ margin: 0, marginBottom: "12px", fontSize: "12px", color: "#66708a" }}>
              RUNA automation is bounded. Medium/high-risk actions require HITL approval and audit evidence.
              Logs are minimized to operational security data only.
            </p>
            <button
              type="button"
              onClick={() => void acceptConsent()}
              style={{
                border: "1px solid #4169e155",
                background: "#4169e1",
                color: "#ffffff",
                borderRadius: "9px",
                padding: "8px 12px",
                cursor: "pointer",
                fontSize: "12px",
              }}
            >
              I Understand
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
