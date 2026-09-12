/**
 * Typography aligned with StudentDashboard + ProductivityAssistant chrome
 * (HUD labels ~8–10px, body ~10–12px) so the rail does not read larger than the center column.
 */
export const PANEL_SANS = "'Exo 2', sans-serif";
export const PANEL_MONO = "'Share Tech Mono', monospace";

/** Uppercase rail / HUD label (matches header “Elapsed Time”, assistant tool strip). */
export const sectionTitleClass =
  "block text-[#4a6080] tracking-widest uppercase mb-2 font-semibold text-[9px]";

export const sectionEyebrowClass =
  "text-[#4a6080] tracking-widest uppercase font-semibold text-[9px]";

/** Muted helper (matches assistant scope bar ~10px). */
export const bodyMutedClass = "text-[#52638f] text-[10px] leading-relaxed";

/** Primary rail body copy — between assistant scope (10px) and bubbles (12px). */
export const bodyClass = "text-[#243052] text-[11px] leading-snug";
