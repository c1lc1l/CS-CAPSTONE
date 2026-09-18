/**
 * runaFiles.ts
 *
 * Student-safe workspace: **Runa_Folder** next to the packaged Runa `.exe`
 * (portable deploy). In development, uses `userData/Runa_Folder` so paths stay
 * writable and predictable. All automation MUST resolve inside this vault.
 */

import path from "path";
import fs from "fs";
import type { App } from "electron";

/** Folder name beside `Runa.exe` (or under userData in dev). */
const VAULT_DIR_NAME = "Runa_Folder";
/** Hard cap for a single text write from the assistant path. */
export const MAX_TEXT_FILE_BYTES = 512 * 1024;

let cachedVaultRoot: string | null = null;

export function getRunaVaultRoot(application: App): string {
  if (cachedVaultRoot) return cachedVaultRoot;
  const fallback = path.join(application.getPath("userData"), VAULT_DIR_NAME);
  if (!application.isPackaged) {
    cachedVaultRoot = fallback;
    return cachedVaultRoot;
  }
  // The portable build unpacks to a temp folder that is deleted on exit, so
  // process.execPath points there. electron-builder exposes the folder the
  // user actually launched the .exe from.
  const launchDir = process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath);
  const besideExe = path.join(launchDir, VAULT_DIR_NAME);
  try {
    fs.mkdirSync(besideExe, { recursive: true });
    fs.accessSync(besideExe, fs.constants.W_OK);
    cachedVaultRoot = besideExe;
  } catch {
    // Read-only location (protected folder, read-only share): keep the vault per user.
    cachedVaultRoot = fallback;
  }
  return cachedVaultRoot;
}

export function ensureVaultExists(application: App): string {
  const root = getRunaVaultRoot(application);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * Resolves a path relative to the vault root. Rejects absolute paths and `..`.
 */
export function resolveUnderVault(
  application: App,
  relativePath: string,
): { ok: true; absolute: string; root: string } | { ok: false; error: string } {
  const root = ensureVaultExists(application);
  const trimmed = String(relativePath ?? "").trim().replace(/\\/g, "/");
  if (!trimmed) {
    return { ok: true, absolute: root, root };
  }
  if (path.isAbsolute(trimmed)) {
    return { ok: false, error: "Absolute paths are not allowed." };
  }
  const normalized = path.normalize(trimmed);
  if (normalized.split(path.sep).includes("..")) {
    return { ok: false, error: "Path segments cannot contain '..'." };
  }
  const absolute = path.resolve(path.join(root, normalized));
  const rootResolved = path.resolve(root);
  if (absolute === rootResolved) {
    return { ok: true, absolute, root };
  }
  const sep = path.sep;
  const prefix = rootResolved.endsWith(sep) ? rootResolved : rootResolved + sep;
  if (!absolute.startsWith(prefix)) {
    return { ok: false, error: "Path escapes Runa_Folder — request denied." };
  }
  return { ok: true, absolute, root };
}

export function sessionRelativeFolder(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9._@-]+/g, "_").slice(0, 128);
  return path.join("sessions", safe || "anonymous");
}
