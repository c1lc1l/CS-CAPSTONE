/**
 * RiskBadge.tsx
 *
 * The LOW / MED / HIGH chip used everywhere agent actions surface.
 * Visual style matches the RUNA console: monospace label, dark fill,
 * colored border + dot.
 *
 * Cross-reference: sprint/agentic-architecture.md §3.
 */

import type { RiskTier } from "../../agentic/types";

const MONO = "'Share Tech Mono', monospace";

interface RiskBadgeProps {
  tier: RiskTier;
  /** Optional reason string shown in the tooltip / aria-label. */
  reason?: string;
  /** Compact mode hides the label and shows just the dot. */
  compact?: boolean;
}

interface TierStyle {
  label: string;
  border: string;
  dot: string;
  text: string;
  bg: string;
}

const TIER_STYLES: Record<RiskTier, TierStyle> = {
  low: {
    label: "LOW",
    border: "#34a86b",
    dot: "#16a05d",
    text: "#15803d",
    bg: "rgba(220, 252, 231, 0.9)",
  },
  medium: {
    label: "MED",
    border: "#a06820",
    dot: "#e8a83a",
    text: "#f0c66e",
    bg: "rgba(138, 95, 22, 0.22)",
  },
  high: {
    label: "HIGH",
    border: "#a02a2a",
    dot: "#e05c6a",
    text: "#ffb1ba",
    bg: "rgba(133, 37, 45, 0.22)",
  },
};

export function RiskBadge({ tier, reason, compact = false }: RiskBadgeProps) {
  const s = TIER_STYLES[tier];
  const ariaLabel = `Risk: ${s.label}${reason ? `. ${reason}` : ""}`;

  if (compact) {
    return (
      <span
        title={ariaLabel}
        aria-label={ariaLabel}
        className="inline-flex items-center justify-center"
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: s.dot,
          boxShadow: `0 0 4px ${s.dot}80`,
        }}
      />
    );
  }

  return (
    <span
      title={reason}
      aria-label={ariaLabel}
      className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border tracking-widest uppercase shadow-sm"
      style={{
        borderColor: s.border,
        background: s.bg,
        boxShadow: `inset 0 0 0 1px ${s.border}22, 0 0 12px ${s.border}20`,
        color: s.text,
        fontSize: "9px",
        fontFamily: MONO,
        letterSpacing: "0.1em",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          background: s.dot,
          boxShadow: `0 0 6px ${s.dot}cc`,
        }}
      />
      <span>RISK · {s.label}</span>
    </span>
  );
}
