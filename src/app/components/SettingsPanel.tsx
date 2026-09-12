import { useEffect, useState } from "react";
import { ArrowLeft, Bell, MonitorCog, Shield, SlidersHorizontal } from "lucide-react";
import { useNavigate } from "react-router";
import { useElectron } from "../ipc/useElectron";
import type { ElectronSettings, ElectronRole } from "../../types/electron";

const MONO = "'Share Tech Mono', monospace";
const GROTESK = "'Exo 2', sans-serif";

const DEFAULT_SETTINGS: ElectronSettings = {
  kioskMode: false,
  theme: "light",
  notifications: true,
};

export function SettingsPanel() {
  const navigate = useNavigate();
  const api = useElectron();
  const [settings, setSettings] = useState<ElectronSettings>(DEFAULT_SETTINGS);
  const [role, setRole] = useState<ElectronRole | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.settings.get(), api.session.get()]).then(([stored, session]) => {
      if (cancelled) return;
      setSettings({ ...DEFAULT_SETTINGS, ...stored });
      setRole(session?.role ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const goBack = () => navigate(role === "student" ? "/student-dashboard" : "/dashboard");

  const updateSetting = async <K extends keyof ElectronSettings>(key: K, value: ElectronSettings[K]) => {
    setSaving(String(key));
    setStatus("");
    try {
      const next = await api.settings.set({ [key]: value });
      setSettings({ ...DEFAULT_SETTINGS, ...next });
      if (key === "theme") {
        document.documentElement.dataset.runaTheme = String(value);
      }
      window.dispatchEvent(new CustomEvent("runa-settings-changed", { detail: next }));
      setStatus("Settings saved.");
    } catch {
      setStatus("Could not save settings.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="runa-settings-screen h-full min-h-0 overflow-y-auto" style={{ fontFamily: GROTESK }}>
      <div className="mx-auto w-full max-w-3xl px-6 py-8">
        <button
          type="button"
          onClick={goBack}
          className="mb-6 inline-flex items-center gap-2 rounded-lg border border-[#cbd5f0] bg-white/55 px-3 py-2 text-[#3156b8] transition-colors hover:bg-white/80"
          style={{ fontSize: "10px", fontFamily: MONO }}
        >
          <ArrowLeft size={13} /> BACK TO DASHBOARD
        </button>

        <div className="rounded-2xl border border-white/70 bg-white/65 p-6 shadow-[0_18px_50px_rgba(45,72,155,0.12)] backdrop-blur-xl">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 tracking-widest text-[#526b9f]" style={{ fontSize: "9px", fontFamily: MONO }}>
                RUNA CONFIGURATION
              </p>
              <h1 className="text-2xl font-semibold text-[#17233d]">Settings</h1>
              <p className="mt-1 text-sm text-[#52638f]">Manage the desktop session and notification behavior.</p>
            </div>
            <SlidersHorizontal className="mt-1 text-[#4169e1]" size={22} />
          </div>

          <div className="space-y-3">
            <SettingRow
              icon={<MonitorCog size={18} />}
              title="Kiosk mode"
              description="Lock the window to the lab experience and manage student launchers centrally."
              control={
                <Toggle
                  checked={settings.kioskMode}
                  disabled={saving === "kioskMode"}
                  onChange={(checked) => void updateSetting("kioskMode", checked)}
                  label="Toggle kiosk mode"
                />
              }
            />
            <SettingRow
              icon={<Bell size={18} />}
              title="Notifications"
              description="Allow in-app toast notifications and the notification panel."
              control={
                <Toggle
                  checked={settings.notifications}
                  disabled={saving === "notifications"}
                  onChange={(checked) => void updateSetting("notifications", checked)}
                  label="Toggle notifications"
                />
              }
            />
            <SettingRow
              icon={<Shield size={18} />}
              title="Theme"
              description="Choose the persisted application theme preference."
              control={
                <select
                  value={settings.theme}
                  disabled={saving === "theme"}
                  onChange={(event) => void updateSetting("theme", event.target.value as ElectronSettings["theme"])}
                  className="rounded-lg border border-[#cbd5f0] bg-[#f7f8fd] px-3 py-2 text-[#17233d] outline-none focus:border-[#7b96e8]"
                  style={{ fontSize: "11px", fontFamily: MONO }}
                  aria-label="Theme"
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark preference</option>
                </select>
              }
            />
          </div>

          <div className="mt-6 flex items-center justify-between border-t border-[#dfe6f7] pt-4">
            <span className="text-[#526b9f]" style={{ fontSize: "10px", fontFamily: MONO }}>
              {role ? `${role.toUpperCase()} SESSION` : "SESSION"}
            </span>
            <span className="text-[#3156b8]" style={{ fontSize: "10px", fontFamily: MONO }} aria-live="polite">
              {status}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function SettingRow({
  icon,
  title,
  description,
  control,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  control: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-xl border border-[#dfe6f7] bg-white/45 px-4 py-4">
      <div className="flex min-w-0 items-start gap-3">
        <div className="mt-0.5 text-[#4169e1]">{icon}</div>
        <div>
          <p className="text-sm font-semibold text-[#243052]">{title}</p>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-[#52638f]">{description}</p>
        </div>
      </div>
      {control}
    </div>
  );
}

function Toggle({ checked, disabled, onChange, label }: { checked: boolean; disabled: boolean; onChange: (value: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${checked ? "border-[#4169e1] bg-[#4169e1]" : "border-[#b8c5e2] bg-[#e8edf7]"}`}
    >
      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
    </button>
  );
}
