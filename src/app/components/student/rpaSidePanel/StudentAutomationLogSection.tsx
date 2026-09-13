import { ChevronDown, ScrollText } from "lucide-react";
import type { AuditRow } from "../../../agentic/types";
import { RiskBadge } from "../../agentic/RiskBadge";
import { formatAuditEventLabel, formatTimestamp, truncateDetail } from "./formatters";
import { PANEL_MONO, sectionEyebrowClass, bodyMutedClass, bodyClass } from "./panelTokens";
import { detailsSummaryFocusClass, scrollDetailsPanelIntoView } from "./detailsAccessibility";

export interface StudentAutomationLogSectionProps {
  rows: AuditRow[];
}

export function StudentAutomationLogSection({ rows }: StudentAutomationLogSectionProps) {
  const subtitle = rows.length === 0 ? "No entries yet" : `${rows.length} entries (local)`;

  return (
    <details
      className="group rounded-lg border border-[#dfeaff]/60 bg-white/32 min-w-0"
      onToggle={scrollDetailsPanelIntoView}
    >
      <summary
        className={`flex cursor-pointer list-none items-center justify-between gap-2 px-3.5 py-2.5 hover:bg-white/45 rounded-lg transition-all duration-200 ease-out [&::-webkit-details-marker]:hidden ${detailsSummaryFocusClass}`}
      >
        <span className="flex items-center gap-2 min-w-0">
          <ScrollText size={15} className="text-[#7eb5f5] shrink-0" strokeWidth={1.75} />
          <span className="flex flex-col min-w-0">
            <span className={sectionEyebrowClass}>Activity log</span>
            <span className={`${bodyMutedClass} truncate normal-case tracking-normal font-normal`}>{subtitle}</span>
          </span>
        </span>
        <ChevronDown
          size={16}
          className="text-[#6c82a8] shrink-0 transition-all duration-200 ease-out group-open:rotate-180 group-open:text-[#8fb5ff]"
          strokeWidth={1.75}
        />
      </summary>

      <div className="border-t border-[#dfeaff]/60 px-3.5 pb-3 pt-2 min-w-0">
        {rows.length === 0 ? (
          <div className="flex items-center gap-2 rounded-md border border-[#dfeaff]/60 bg-white/35 px-2.5 py-2.5 text-[#52638f] shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]">
            <ScrollText size={13} className="text-[#7eb5f5] shrink-0" strokeWidth={1.75} />
            <p className={`${bodyClass} m-0 leading-relaxed`}>
              No entries yet. Use the assistant or Runa_Folder actions to generate log rows.
            </p>
          </div>
        ) : (
          <ul className="space-y-1.5 max-h-[min(220px,38vh)] overflow-y-auto overflow-x-hidden pr-0.5 min-w-0">
            {rows.map((row) => (
              <li
                key={row.id}
                className="rounded-md border px-2 py-2"
                style={{ background: "rgba(255,255,255,0.46)", borderColor: "rgba(99,102,241,0.15)" }}
              >
                <div className="flex items-center flex-wrap gap-1.5 mb-0.5">
                  <span
                    className="text-[#c5d5ea] font-medium capitalize text-[9px]"
                    style={{ fontFamily: PANEL_MONO }}
                  >
                    {formatAuditEventLabel(row.eventType)}
                  </span>
                  {row.riskTier && <RiskBadge tier={row.riskTier} compact />}
                </div>
                <p
                  className="text-[#6a8098] break-words text-[9px] leading-relaxed"
                  style={{ fontFamily: PANEL_MONO }}
                  title={row.detail}
                >
                  {truncateDetail(row.detail, 110)}
                </p>
                <p className="text-[#4a6080] mt-1 text-[9px]" style={{ fontFamily: PANEL_MONO }}>
                  {formatTimestamp(row.createdAt)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}
