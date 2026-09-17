/**
 * Single source of truth for COMLAB 08–11 across admin panels.
 * Deterministic values (no Math.random) so demos and screenshots reproduce.
 */

export const COMLAB_IDS = ["08", "09", "10", "11", "12"] as const;
export type ComlabId = (typeof COMLAB_IDS)[number];

export type DashboardTerminalStatus = "active" | "idle" | "alert" | "offline" | "blocked";
export type MonitoringPcStatus = "active" | "idle" | "alert" | "offline";
export type AccessNodeStatus = "normal" | "alert" | "offline" | "blocked" | "scanning";

export interface ComlabDefinition {
  id: ComlabId;
  /** e.g. COMLAB 08 */
  label: string;
  /** Key used by institutional audit mock data (COMLAB 8 … 11) */
  auditLogKey: string;
  subject: string;
  professorName: string;
  timeRange: string;
  utilizationPercent: number;
  incidentCount: number;
  healthLabel: string;
  gridRows: number;
  gridCols: number;
  alertIdx: number;
  blockedIdx: number;
}

export const COMLAB_DEFINITIONS: readonly ComlabDefinition[] = [
  {
    id: "08",
    label: "COMLAB 08",
    auditLogKey: "COMLAB 8",
    subject: "Cybersecurity",
    professorName: "Prof. Andy Anciro",
    timeRange: "09:00 — 12:00",
    utilizationPercent: 87,
    incidentCount: 1,
    healthLabel: "ELEVATED",
    gridRows: 4,
    gridCols: 8,
    alertIdx: 2,
    blockedIdx: -1,
  },
  {
    id: "09",
    label: "COMLAB 09",
    auditLogKey: "COMLAB 9",
    subject: "Application Development",
    professorName: "Prof. Maria Santos",
    timeRange: "10:00 — 13:00",
    utilizationPercent: 72,
    incidentCount: 0,
    healthLabel: "HEALTHY",
    gridRows: 4,
    gridCols: 8,
    alertIdx: -1,
    blockedIdx: -1,
  },
  {
    id: "10",
    label: "COMLAB 10",
    auditLogKey: "COMLAB 10",
    subject: "ICT Fundamentals",
    professorName: "Prof. Ramon Cruz",
    timeRange: "08:00 — 11:00",
    utilizationPercent: 60,
    incidentCount: 0,
    healthLabel: "HEALTHY",
    gridRows: 4,
    gridCols: 8,
    alertIdx: -1,
    blockedIdx: 3,
  },
  {
    id: "11",
    label: "COMLAB 11",
    auditLogKey: "COMLAB 11",
    subject: "Capstone Research",
    professorName: "Prof. Elena Reyes",
    timeRange: "13:00 — 16:00",
    utilizationPercent: 20,
    incidentCount: 0,
    healthLabel: "HEALTHY",
    gridRows: 4,
    gridCols: 8,
    alertIdx: -1,
    blockedIdx: 25,
  },
  {
    id: "12",
    label: "COMLAB 12",
    auditLogKey: "COMLAB 12",
    subject: "Networking & IT Support",
    professorName: "Prof. Diego Villanueva",
    timeRange: "14:00 — 17:00",
    utilizationPercent: 45,
    incidentCount: 0,
    healthLabel: "HEALTHY",
    gridRows: 4,
    gridCols: 8,
    alertIdx: -1,
    blockedIdx: -1,
  },
] as const;

export function getComlab(id: string): ComlabDefinition {
  const d = COMLAB_DEFINITIONS.find((c) => c.id === id);
  return d ?? COMLAB_DEFINITIONS[0];
}

/** Deterministic dashboard matrix (4×8 = 32 cells per lab). */
export function buildDashboardStatuses(def: ComlabDefinition): DashboardTerminalStatus[] {
  const n = def.gridRows * def.gridCols;
  const out: DashboardTerminalStatus[] = [];
  for (let i = 0; i < n; i++) {
    if (i === def.alertIdx) {
      out.push("alert");
      continue;
    }
    if (def.blockedIdx >= 0 && i === def.blockedIdx) {
      out.push("blocked");
      continue;
    }
    const seed = (def.id.charCodeAt(0) + def.id.charCodeAt(1) + i * 17) % 100;
    if (seed < 52) out.push("active");
    else if (seed < 76) out.push("idle");
    else if (seed < 86) out.push("offline");
    else out.push("idle");
  }
  return out;
}

/** 30 PCs per lab — monitoring matrix. */
export function buildMonitoringPcs(def: ComlabDefinition): { id: string; status: MonitoringPcStatus }[] {
  const alertIdx = def.id === "08" ? 0 : -1;
  return Array.from({ length: 30 }, (_, i) => {
    if (i === alertIdx) return { id: `PC-${String(i + 1).padStart(2, "0")}`, status: "alert" as const };
    const seed = (def.id.charCodeAt(1) * 31 + i * 13) % 100;
    let status: MonitoringPcStatus = "idle";
    if (seed < 58) status = "active";
    else if (seed < 82) status = "idle";
    else if (seed < 92) status = "offline";
    else status = "idle";
    return { id: `PC-${String(i + 1).padStart(2, "0")}`, status };
  });
}

/** Access governance node strip (40 nodes). */
export function buildAccessNodes(def: ComlabDefinition): { id: string; status: AccessNodeStatus; label: string }[] {
  const cycle: AccessNodeStatus[] = [
    "normal",
    "normal",
    "normal",
    "normal",
    "alert",
    "blocked",
    "offline",
    "scanning",
    "normal",
    "normal",
  ];
  const off = def.id === "08" ? 0 : def.id === "09" ? 2 : def.id === "10" ? 4 : def.id === "11" ? 6 : 8;
  return Array.from({ length: 40 }, (_, i) => {
    const status = cycle[(i + off) % cycle.length];
    const labNum = parseInt(def.id, 10);
    return {
      id: `N-${String(i + 1).padStart(3, "0")}`,
      label: `STA-${String(i + 1).padStart(2, "0")}-C${labNum}`,
      status,
    };
  });
}

export function fleetAverageUtilization(): number {
  const sum = COMLAB_DEFINITIONS.reduce((a, c) => a + c.utilizationPercent, 0);
  return Math.round((sum / COMLAB_DEFINITIONS.length) * 10) / 10;
}

export function fleetOpenIncidents(): number {
  return COMLAB_DEFINITIONS.reduce((a, c) => a + c.incidentCount, 0);
}

export interface AttendanceRow {
  name: string;
  id: string;
  pc: string;
  ip: string;
  status: string;
  color: string;
}

/** Deterministic “live desk” rows per lab (demo data). */
export const ATTENDANCE_BY_LAB: Record<ComlabId, AttendanceRow[]> = {
  "08": [
    { name: "Casio, Gen Benedict", id: "202110299", pc: "PC-05", ip: "192.168.8.105", status: "ONLINE", color: "#4ac77e" },
    { name: "Santos, Maria Clara", id: "202211548", pc: "PC-12", ip: "192.168.8.112", status: "ALERT", color: "#e05c6a" },
    { name: "Reyes, Jonathan P.", id: "202116056", pc: "PC-28", ip: "192.168.8.128", status: "ONLINE", color: "#4ac77e" },
  ],
  "09": [
    { name: "Cruz, Lian", id: "202312001", pc: "PC-02", ip: "192.168.9.102", status: "ONLINE", color: "#4ac77e" },
    { name: "Torres, Mika", id: "202298765", pc: "PC-15", ip: "192.168.9.115", status: "ONLINE", color: "#4ac77e" },
  ],
  "10": [
    { name: "Bautista, Ken", id: "202145612", pc: "PC-08", ip: "192.168.10.108", status: "IDLE", color: "#4a6080" },
    { name: "Lim, Zoe", id: "202267890", pc: "PC-19", ip: "192.168.10.119", status: "ONLINE", color: "#4ac77e" },
  ],
  "11": [
    { name: "Garcia, Ana", id: "202401122", pc: "PC-03", ip: "192.168.11.103", status: "ONLINE", color: "#4ac77e" },
    { name: "Navarro, Eli", id: "202388901", pc: "PC-22", ip: "192.168.11.122", status: "ONLINE", color: "#4ac77e" },
    { name: "Fernandez, Pat", id: "202355432", pc: "PC-27", ip: "192.168.11.127", status: "ONLINE", color: "#4ac77e" },
  ],
  "12": [
    { name: "Villanueva, Marco", id: "202398211", pc: "PC-06", ip: "192.168.12.106", status: "ONLINE", color: "#4ac77e" },
    { name: "Aquino, Bea", id: "202267412", pc: "PC-17", ip: "192.168.12.117", status: "ONLINE", color: "#4ac77e" },
  ],
};

export const COMLAB_SECURITY_FEED = [
  {
    time: "14:22:31",
    icon: "login",
    msg: "Admin SSO — COMLAB 08 session broker acknowledged",
    level: "secure",
  },
  {
    time: "14:26:08",
    icon: "alert",
    msg: "Policy check — COMLAB 11 · USB controller · integrity baseline",
    level: "critical",
  },
  {
    time: "14:31:00",
    icon: "sync",
    msg: "Scheduled sync — RUNA node manifests (COMLAB 08–11)",
    level: "system",
  },
] as const;
