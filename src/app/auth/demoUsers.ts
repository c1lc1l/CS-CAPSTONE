import type { ElectronRole } from "../../types/electron";

/**
 * demoUsers.ts
 *
 * Hard-coded demo accounts for the thesis defense sprint. Replaces
 * a real auth provider (Cognito) until Phase 2 of the thesis timeline.
 *
 * Adding a new account: append to DEMO_USERS. Roles are constrained
 * to ElectronRole from src/types/electron.d.ts so renaming propagates.
 */

export interface DemoUser {
  email: string;
  password: string;
  role: ElectronRole;
  displayName: string;
}

export const DEMO_USERS: DemoUser[] = [
  {
    email: "admin@runa.edu.ph",
    password: "Runa-Admin!2026",
    role: "admin",
    displayName: "System Administrator",
  },
  {
    email: "labadmin.dasma@runa.edu.ph",
    password: "Runa-LabAdmin!2026",
    role: "admin",
    displayName: "COMLAB Proctor (Dasmariñas)",
  },
  {
    email: "casio.2021103456@runa.edu.ph",
    password: "Runa-Stu!3456",
    role: "student",
    displayName: "Gen Benedict Casio",
  },
  {
    email: "grospe.2021103457@runa.edu.ph",
    password: "Runa-Stu!3457",
    role: "student",
    displayName: "Neil Christian Grospe",
  },
  {
    email: "iledan.2021103458@runa.edu.ph",
    password: "Runa-Stu!3458",
    role: "student",
    displayName: "John Benedict Iledan",
  },
  {
    email: "pardinas.2021103459@runa.edu.ph",
    password: "Runa-Stu!3459",
    role: "student",
    displayName: "Markjay Pardinas",
  },
  {
    email: "delacruz.2022110210@runa.edu.ph",
    password: "Runa-Stu!0210",
    role: "student",
    displayName: "Maria Clara Dela Cruz",
  },
  {
    email: "santos.2022110288@runa.edu.ph",
    password: "Runa-Stu!0288",
    role: "student",
    displayName: "Rafael Santos",
  },
];

/**
 * Authenticate by email + password. Returns the matched user or null.
 * Email comparison is case-insensitive and trimmed; password is exact match.
 */
export function authenticate(email: string, password: string): DemoUser | null {
  const normalizedEmail = email.trim().toLowerCase();
  return (
    DEMO_USERS.find(
      (u) => u.email.toLowerCase() === normalizedEmail && u.password === password,
    ) ?? null
  );
}

/**
 * Look up a demo user by email (no password check). Used by the
 * SessionGuard / dashboards to recover the displayName for a stored session.
 */
export function findDemoUser(email: string): DemoUser | null {
  const normalizedEmail = email.trim().toLowerCase();
  return DEMO_USERS.find((u) => u.email.toLowerCase() === normalizedEmail) ?? null;
}
