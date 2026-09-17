/**
 * useElectron.ts
 *
 * React hook that wraps window.electronAPI.
 * Falls back gracefully when running in a plain browser (dev/test).
 */
import { useCallback } from "react";
import type { ElectronAPI, ElectronAttendanceSessionRow, PythonResult } from "../../types/electron";

const isElectron = (): boolean =>
  typeof window !== "undefined" && !!window.electronAPI;

const noop = () => {};
const asyncNoop = async () => {};

const browserStubs: ElectronAPI = {
  session: {
    get: async () => null,
    set: async () => true,
    clear: async () => true,
  },
  settings: {
    get: async () => ({ kioskMode: false, theme: "dark", notifications: true }),
    set: async (p) => ({ kioskMode: false, theme: "dark", notifications: true, ...p }),
  },
  window: {
    minimize: noop,
    maximize: noop,
    close: noop,
  },
  python: {
    call: async <T = unknown>(
      _endpoint: string,
      _payload?: unknown,
      _options?: { method?: "GET" | "POST"; timeoutMs?: number },
    ): Promise<PythonResult<T>> => ({ ok: false, error: "Not in Electron" }),
  },
  dialog: {
    openFile: async () => null,
  },
  lab: {
    getShortcuts: async () => [],
    addShortcut: async () => ({
      ok: false as const,
      shortcuts: [],
      error: "Not in Electron",
    }),
    updateShortcut: async () => ({
      ok: false as const,
      shortcuts: [],
      error: "Not in Electron",
    }),
    removeShortcut: async () => ({
      ok: false as const,
      shortcuts: [],
      error: "Not in Electron",
    }),
    launch: async () => ({ ok: false, error: "Not in Electron" }),
  },
  runaFiles: {
    getVaultRoot: async () => ({ ok: false, path: null, error: "Not in Electron" }),
    getSessionWorkspaceRelative: async () => ({
      ok: false,
      relative: null,
      error: "Not in Electron",
    }),
    createFolder: async () => ({ ok: false, error: "Not in Electron" }),
    writeTextFile: async () => ({ ok: false, error: "Not in Electron" }),
    readTextFile: async () => ({ ok: false, error: "Not in Electron" }),
    listDir: async () => ({ ok: false, entries: [], error: "Not in Electron" }),
  },
  telemetry: {
    record: async () => true,
  },
  tray: {
    notify: noop,
  },
  app: {
    version: async () => "0.0.0-browser",
    platform: async () => "browser",
  },
  audit: {
    log: async () => true,
    list: async () => [],
    verifyIntegrity: async () => ({
      ok: true,
      rowsChecked: 0,
      brokenAtIndex: null,
      brokenRowId: null,
      reason: null,
    }),
  },
  labStation: {
    get: async () => ({ comlabId: "08", workstationLabel: "PC-01" }),
    set: async (payload) => ({
      comlabId: String(payload.comlabId || "08").trim(),
      workstationLabel: String(payload.workstationLabel || "PC-01").trim().slice(0, 64),
    }),
  },
  attendance: {
    checkIn: async () => true,
    checkOut: async () => true,
    list: async (): Promise<ElectronAttendanceSessionRow[]> => [],
  },
  agent: {
    propose: async () => ({
      autoExecuted: true,
      tier: "low" as const,
      result: { ok: true, message: "Browser stub" },
    }),
    listPending: async () => [],
    listHistory: async () => [],
    approve: async (args) => ({
      request: {
        id: args.id,
        createdAt: Date.now(),
        requesterId: "stub",
        requesterRole: "admin",
        action: {
          type: "wipe_terminal",
          scope: "lab",
          reversible: false,
          payload: {},
          reasoning: "stub",
        },
        riskTier: "high",
        status: "approved",
      },
      result: { ok: true, message: "Browser stub" },
    }),
    reject: async (args) => ({
      id: args.id,
      createdAt: Date.now(),
      requesterId: "stub",
      requesterRole: "admin",
      action: {
        type: "wipe_terminal",
        scope: "lab",
        reversible: false,
        payload: {},
        reasoning: "stub",
      },
      riskTier: "high",
      status: "rejected",
    }),
    requestInfo: async (args) => ({
      id: args.id,
      createdAt: Date.now(),
      requesterId: "stub",
      requesterRole: "admin",
      action: {
        type: "wipe_terminal",
        scope: "lab",
        reversible: false,
        payload: {},
        reasoning: "stub",
      },
      riskTier: "high",
      status: "info_requested",
      comments: [{ at: Date.now(), byUserId: args.byUserId, text: args.text }],
    }),
  },
  security: {
    listBlockedDomains: async () => [],
    checkUrl: async () => ({
      ok: false,
      blocked: false,
      domain: "",
      reason: "invalid_url" as const,
    }),
    listQuarantinedUsb: async () => [],
  },
  on: noop,
  off: noop,
};

export function useElectron(): ElectronAPI {
  return isElectron() ? window.electronAPI : browserStubs;
}

export function usePython() {
  const { python } = useElectron();

  const call = useCallback(
    <T = unknown>(
      endpoint: string,
      payload?: unknown,
      options?: { method?: "GET" | "POST"; timeoutMs?: number },
    ) => python.call<T>(endpoint, payload, options),
    [python],
  );

  return { call };
}

export interface AIMessage {
  role: "user" | "assistant";
  content: { text: string }[];
}

export interface AITaskPayload {
  prompt: string;
  system?: string;
  role?: "student" | "admin";
  tools?: string[];
  history?: AIMessage[];
  maxTokens?: number;
  temperature?: number;
  /** When false, Lambda skips Supabase KB retrieval. Default true. */
  useKnowledgeBase?: boolean;
  /** Chunk count for KB retrieval (1–12). */
  kbTopK?: number;
  /** Provider function-calling schemas the model may select from. */
  toolSpecs?: unknown[];
}

export interface AITaskResult {
  ok: boolean;
  response?: string;
  source?: "groq" | "lambda" | "local_fallback";
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  updatedHistory?: AIMessage[];
  error?: string;
  detail?: string;
  ragCitations?: Array<{ id?: number; source?: string; title?: string; score?: number }>;
  ragUsed?: boolean;
  /** Tools the model selected. Selection only — the client governs execution. */
  toolCalls?: Array<{ name: string; arguments: Record<string, unknown> }>;
}

export function useAI() {
  const { python } = useElectron();

  const call = useCallback(async (payload: AITaskPayload): Promise<AITaskResult> => {
    const result = await python.call<AITaskResult>("/ai-task", payload, {
      method: "POST",
      timeoutMs: 60_000,
    });
    if (!result.ok) {
      return { ok: false, error: result.error ?? "Python sidecar unreachable" };
    }
    return result.data ?? { ok: false, error: "Empty response" };
  }, [python]);

  return { call };
}

export function useWindowControls() {
  const { window: win } = useElectron();
  return {
    minimize: win.minimize,
    maximize: win.maximize,
    close: win.close,
  };
}
