import { Clock } from "lucide-react";
import { PANEL_MONO, sectionTitleClass, bodyMutedClass, bodyClass } from "./panelTokens";

export interface LabEnvironmentSectionProps {
  sessionRemainingLabel: string;
  vaultPathTail: string | null;
  vaultPathFull: string | null;
  kioskMode: boolean | null;
  canEditShortcuts: boolean;
}

export function LabEnvironmentSection({
  sessionRemainingLabel,
  vaultPathTail,
  vaultPathFull,
  kioskMode,
  canEditShortcuts,
}: LabEnvironmentSectionProps) {
  const launcherNote = (() => {
    if (kioskMode === true) return "Launchers: left rail (IT-managed in kiosk).";
    if (canEditShortcuts) return "Launchers: left rail — use + to add programs.";
    return "Launchers: left rail.";
  })();

  return (
    <section className="runa-student-runtime-card rounded-lg border border-[#dfeaff]/60 bg-white/36 px-3.5 py-3 min-w-0">
      <span className={sectionTitleClass}>Lab &amp; runtime</span>
      <div className="space-y-3">
        <div className="flex gap-2.5">
          <Clock size={15} className="text-[#5a9eff] shrink-0 mt-0.5" strokeWidth={1.75} />
          <div className="min-w-0">
            <p className={`${bodyMutedClass} font-medium uppercase tracking-wider text-[8px] mb-0.5`}>
              Session (app login)
            </p>
            <p
              className="text-[#c5d5ea] tabular-nums font-semibold tracking-tight text-[14px]"
              style={{ fontFamily: PANEL_MONO }}
            >
              {sessionRemainingLabel === "—" ? "—" : `${sessionRemainingLabel} left`}
            </p>
            <p className={`${bodyMutedClass} mt-1`}>App sign-in only; not lab attendance.</p>
          </div>
        </div>
        <div>
          <p className={`${bodyMutedClass} font-medium uppercase tracking-wider text-[8px] mb-1`}>Runa_Folder</p>
          {vaultPathTail ? (
            <p
              className="text-[#6a8098] break-all text-[10px] leading-relaxed"
              style={{ fontFamily: PANEL_MONO }}
              title={vaultPathFull ?? undefined}
            >
              {vaultPathTail}
            </p>
          ) : (
            <p className={bodyClass}>Not resolved yet.</p>
          )}
        </div>
        <p className={`${bodyClass} border-t border-[#1a2640] pt-2.5`}>{launcherNote}</p>
      </div>
    </section>
  );
}
