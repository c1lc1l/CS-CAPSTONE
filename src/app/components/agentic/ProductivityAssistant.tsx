/**
 * ProductivityAssistant.tsx
 *
 * The bounded agentic chat panel. Same component, two modes (student
 * and admin) parameterized by the `role` prop. Per-mode tools and
 * system prompts come from agentic/toolRegistry.ts.
 *
 * Backend: Python sidecar `POST /ai-task` when available; keyword fallback
 * when offline or on error. High-risk paths use proposeAction → HITL queue.
 *
 * Risk classification: every response is classified before it renders.
 * If a response would mutate state (HIGH-risk request from admin),
 * we DO NOT execute — we route through proposeAction() which queues
 * the request in the Approvals Queue.
 *
 * Cross-reference: sprint/agentic-architecture.md §4.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { Send, Bot, User, ShieldAlert } from "lucide-react";
import type { AgentRole, RiskTier, ToolDefinition } from "../../agentic/types";
import { getAgentContext, findTool } from "../../agentic/toolRegistry";
import { explainClassification } from "../../agentic/riskClassifier";
import { proposeAction, logAudit } from "../../agentic/approvalQueue";
import { useAI, useElectron, type AIMessage as AIConversationMessage } from "../../ipc/useElectron";
import { useNotificationContext } from "../../providers/NotificationProvider";
import { RiskBadge } from "./RiskBadge";
import type { ActionType } from "../../agentic/types";

const MONO = "'Share Tech Mono', monospace";
const GROTESK = "'Exo 2', sans-serif";

export interface ProductivityAssistantHandle {
  /** Puts text in the composer and focuses it (e.g. workflow starters from the side panel). */
  setComposerText: (text: string) => void;
}

interface ProductivityAssistantProps {
  role: AgentRole;
  userId: string;
  /** Login session expiry (ms epoch) for “time left” answers. */
  sessionExpiresAt?: number | null;
  /** Resolved Runa_Folder path on disk (from main). */
  vaultDisplayPath?: string | null;
  /** Optional fixed-height container; defaults to flex-1 of parent. */
  height?: number | string;
}

interface ChatMessage {
  id: string;
  from: "user" | "assistant";
  text: string;
  ts: number;
  riskTier: RiskTier;
  toolUsed?: string;
  /** Set when the message represents a queued HIGH-risk proposal. */
  approvalId?: string;
  /** Set when the assistant refused an out-of-scope request. */
  refused?: boolean;
}

// ─────────────────────────────────────────────
//  Stub backend (Day 2 only — Day 3 replaces with /ai-task)
// ─────────────────────────────────────────────
interface StubResponse {
  text: string;
  toolUsed?: string;
  /** If set, route through proposeAction (HIGH-risk → HITL; LOW/MEDIUM may auto-execute). */
  proposeActionType?: ActionType;
  /** Extra structured fields merged into the proposed action's payload (e.g. relativePath, content). */
  actionPayload?: Record<string, unknown>;
  refused?: boolean;
}

const REFUSAL_TEXT_STUDENT =
  "That request is outside my scope. I help with coursework support, Runa_Folder file organization, session reminders, and lab FAQs — not admin PC tasks or other users' data. Contact lab tech for operational issues.";

const REFUSAL_TEXT_ADMIN =
  'I cannot execute that action directly. I can summarize, recommend, draft, or propose actions for HITL review. State-mutating actions must go through the Approvals Queue.';

/**
 * Stub responder. Pattern-matches against simple keywords. Used as
 * fallback when the sidecar is down or for authoritative refusals.
 */
function stubRespond(prompt: string, role: AgentRole): StubResponse {
  const p = prompt.toLowerCase().trim();

  // ── Universal refusal triggers ──────────────────────────
  // Anything the agent could be tricked into doing that's clearly out-of-scope.
  if (
    /format|erase|rm\s+-rf|drop\s+(table|database)|wipe\s+(disk|drive)/i.test(p)
  ) {
    return {
      text: role === "student" ? REFUSAL_TEXT_STUDENT : REFUSAL_TEXT_ADMIN,
      refused: true,
    };
  }

  if (role === "student") {
    if (
      /complete (my )?(entire )?(assignment|homework|exam)|take my exam|answer (all|every) (the )?(questions|items)|write my whole (essay|paper|thesis)/i.test(
        p,
      )
    ) {
      return {
        text: "I cannot complete graded exams, entire assignments, or impersonate your work. I can explain concepts, review a short passage you wrote, suggest structure, or help debug errors. Ask lab staff if you need accommodations.",
        toolUsed: "integrity_guardrail",
        refused: true,
      };
    }
    if (/send (this |my |an )?email|submit (to )?(canvas|moodle|blackboard|lms)|upload (my )?(assignment|work) to/i.test(p)) {
      return {
        text: "Sending email or submitting to an external system is not done automatically. I will queue this for lab staff review (human-in-the-loop). You can still copy text yourself and submit manually.",
        proposeActionType: "student_hitl_escalation",
      };
    }

    // ── Runa_Folder vault operations ────────────────────────
    {
      const mkFolder = p.match(/(?:create|make)\s+(?:a\s+)?folder\s+(?:called|named)?\s*"?([a-z0-9 _\-./]{1,80})"?/i);
      if (mkFolder) {
        const relativePath = mkFolder[1].trim();
        return {
          text: `Creating folder "${relativePath}" under Runa_Folder.`,
          toolUsed: "vault_create_folder",
          proposeActionType: "runa_create_folder",
          actionPayload: { relativePath },
        };
      }

      const writeFile = p.match(/(?:write|save)\s+"(.+?)"\s+(?:to|as|in)\s+"?([a-z0-9 _\-./]{1,80}\.[a-z0-9]{1,10})"?/i);
      if (writeFile) {
        const [, content, relativePath] = writeFile;
        return {
          text: `Writing "${relativePath.trim()}" under Runa_Folder.`,
          toolUsed: "vault_write_file",
          proposeActionType: "runa_write_file",
          actionPayload: { relativePath: relativePath.trim(), content },
        };
      }

      const readFile = p.match(/(?:read|open|show)\s+(?:the\s+)?file\s+"?([a-z0-9 _\-./]{1,80}\.[a-z0-9]{1,10})"?/i);
      if (readFile) {
        const relativePath = readFile[1].trim();
        return {
          text: `Reading "${relativePath}" from Runa_Folder.`,
          toolUsed: "vault_read_file",
          proposeActionType: "runa_read_file",
          actionPayload: { relativePath },
        };
      }

      const deleteFile = p.match(/delete\s+(?:the\s+)?file\s+"?([a-z0-9 _\-./]{1,80}\.[a-z0-9]{1,10})"?/i);
      if (deleteFile) {
        const relativePath = deleteFile[1].trim();
        return {
          text: `Deleting "${relativePath}" is a MEDIUM-risk action — queued for lab staff review before it happens.`,
          toolUsed: "vault_delete_file",
          proposeActionType: "runa_delete_within_vault",
          actionPayload: { relativePath },
        };
      }

      const moveFile = p.match(/move\s+(?:the\s+)?file\s+"?([a-z0-9 _\-./]{1,80})"?\s+to\s+"?([a-z0-9 _\-./]{1,80})"?/i);
      if (moveFile) {
        const [, fromRelative, toRelative] = moveFile;
        return {
          text: `Moving "${fromRelative.trim()}" to "${toRelative.trim()}" under Runa_Folder.`,
          toolUsed: "vault_move_file",
          proposeActionType: "runa_move_within_vault",
          actionPayload: { fromRelative: fromRelative.trim(), toRelative: toRelative.trim() },
        };
      }

      // Read-only listing has no governed action type — handled directly by
      // the caller via runaFiles.listDir, flagged by this toolUsed marker.
      if (/(?:list|show)\s+(?:my\s+)?files/i.test(p)) {
        return {
          text: "Listing files under Runa_Folder.",
          toolUsed: "vault_list_files",
          actionPayload: {},
        };
      }
    }
    if (/explain.*(big[\s-]?o|complexity|algorithm)/.test(p))
      return {
        text:
          "Big-O notation describes how an algorithm's runtime or space grows with input size. O(1) is constant — independent of n. O(n) is linear — doubles when n doubles. O(n²) is quadratic — quadruples when n doubles. Use it to compare algorithms at scale, not for small inputs where constants dominate.",
        toolUsed: "explain_concept",
      };
    if (/explain|what is|define/.test(p))
      return {
        text:
          "Here is a concise explanation (offline fallback): break the idea into definition, one example, and one common pitfall. When the lab assistant service is online, you will get a fuller answer. Try pasting a specific paragraph or error if you have one.",
        toolUsed: "explain_concept",
      };
    if (/summari[sz]e|tldr|tl;dr/.test(p))
      return {
        text:
          "Offline fallback: paste the passage here. I would compress it to three sentences keeping the main claims. Use the assistant service when online for a tailored summary.",
        toolUsed: "summarize_text",
      };
    if (/review|check|critique|feedback/.test(p))
      return {
        text:
          "Offline fallback: paste the code. I would check correctness, readability, null handling, and bounds. When online, the sidecar can give line-level comments.",
        toolUsed: "code_review",
      };
    if (/outline|essay|paper/.test(p))
      return {
        text:
          "Offline outline template:\n  I. Introduction — context, thesis\n     A. Hook\n     B. Background\n  II. Body — arguments with evidence\n  III. Conclusion — recap and implication\nPaste your topic when online for a tighter outline.",
        toolUsed: "generate_outline",
      };
    if (/error|exception|stack trace|undefined/.test(p))
      return {
        text:
          "Offline fallback: paste the exact error text and a few lines of surrounding code. I would trace the likely cause and one fix. When online, the sidecar can go deeper.",
        toolUsed: "explain_error",
      };
    return {
      text:
        "I matched your prompt to my general 'explain' tool. Try a more specific phrasing — 'summarize this:', 'review this code:', 'outline an essay on X', or 'explain this error:'.",
      toolUsed: "explain_concept",
    };
  }

  // ── ADMIN MODE ──────────────────────────────────────────
  if (/lock.*(cluster|comlab|lab\s*0?8)/.test(p))
    return {
      text:
        "I cannot lock the cluster directly. This is a HIGH-risk action and must go through the Approvals Queue. I have queued the proposal for your review — see APPROVALS QUEUE in the sidebar.",
      proposeActionType: "lock_cluster",
    };
  if (/terminate.*session/.test(p))
    return {
      text:
        "I cannot terminate sessions directly. This is a HIGH-risk action; I have queued the proposal. Please review it in the Approvals Queue.",
      proposeActionType: "terminate_session",
    };
  if (/wipe.*(terminal|pc|workstation)/.test(p))
    return {
      text:
        "I cannot wipe a terminal directly. HIGH-risk action queued for HITL approval. Review in the Approvals Queue.",
      proposeActionType: "wipe_terminal",
    };
  if (/quarantine.*(usb|drive|removable)/.test(p))
    return {
      text:
        "I cannot quarantine USB devices directly. HIGH-risk action queued for HITL approval. Review in the Approvals Queue.",
      proposeActionType: "quarantine_usb",
    };
  if (/block.*(url|website|domain)/.test(p))
    return {
      text:
        "Modifying the enforced blocklist is a HIGH-risk action. I have queued the proposal for your review.",
      proposeActionType: "enforce_blocklist",
    };
  if (/summari[sz]e.*audit|audit.*summary/.test(p))
    return {
      text:
          "Audit summary mode: I will summarize recent login, scan, approval, and policy events from the shared audit stream.",
      toolUsed: "summarize_audit",
    };
  if (/explain.*alert|what.*alert/.test(p))
    return {
      text:
        "Alert explanation mode: I will interpret the most recent warning/blocked event and provide operator-ready context.",
      toolUsed: "explain_alert",
    };
  if (/recommend|response|action.*to.*(alert|incident)/.test(p))
    return {
      text:
        "Recommended response:\n  1. Contain impacted session.\n  2. Review recent scan/URL/USB evidence.\n  3. Escalate high-risk remediation through HITL approvals.\nI cannot execute these directly; admin review is required.",
      toolUsed: "recommend_response",
    };
  if (/draft.*(policy|blocklist)/.test(p))
    return {
      text:
        "Policy draft mode: I can prepare a copy-pasteable blocklist/policy entry with domain, rationale, actor, and timestamp.",
      toolUsed: "draft_policy",
    };
  return {
    text:
      "Admin assistant ready. Ask me to summarize audit activity, explain alerts, recommend containment steps, draft policy entries, or propose high-risk actions for HITL.",
    toolUsed: "summarize_audit",
  };
}

// ─────────────────────────────────────────────
//  Component
// ─────────────────────────────────────────────
export const ProductivityAssistant = forwardRef<ProductivityAssistantHandle, ProductivityAssistantProps>(
  function ProductivityAssistant({ role, userId, sessionExpiresAt, vaultDisplayPath, height }, ref) {
  const ctx = useMemo(() => getAgentContext(role, userId), [role, userId]);
  const electron = useElectron();
  const { call: callAI } = useAI();
  const { pushToast } = useNotificationContext();
  const reminderTimers = useRef<number[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const buildWelcomeText = useCallback((vaultPath: string | null | undefined) => {
    const ac = getAgentContext(role, userId);
    const toolList = ac.availableTools.map((t) => t.label).join(", ");
    if (role === "student") {
      const vaultLine =
        vaultPath && vaultPath.trim().length > 0
          ? ` Runa_Folder path: ${vaultPath.length > 88 ? `${vaultPath.slice(0, 40)}…${vaultPath.slice(-40)}` : vaultPath}.`
          : "";
      return `Welcome. I am Runa — your lab assistant. I help with coursework, Runa_Folder (beside Runa when packaged), session reminders, and lab FAQs.${vaultLine} Tools: ${toolList}. Add program launchers with + on the left rail. The right panel shows automation governance: approvals, your audit trace, and workflow starters. Programs always open in Windows.`;
    }
    return `Operational assistant ready. Available tools: ${toolList}. HIGH-risk proposals route through the Approvals Queue.`;
  }, [role, userId]);

  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: "welcome",
      from: "assistant",
      text: buildWelcomeText(undefined),
      ts: Date.now(),
      riskTier: "low",
    },
  ]);

  useEffect(() => {
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.id === "welcome");
      if (i === -1) return prev;
      const nextText = buildWelcomeText(vaultDisplayPath);
      if (prev[i].text === nextText) return prev;
      const copy = [...prev];
      copy[i] = { ...prev[i], text: nextText };
      return copy;
    });
  }, [vaultDisplayPath, buildWelcomeText]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<AIConversationMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useImperativeHandle(
    ref,
    () => ({
      setComposerText: (text: string) => {
        setInput(text);
        queueMicrotask(() => {
          const el = textareaRef.current;
          if (!el) return;
          el.focus();
          const len = text.length;
          try {
            el.setSelectionRange(len, len);
          } catch {
            /* ignore */
          }
        });
      },
    }),
    [],
  );

  useEffect(() => {
    return () => {
      reminderTimers.current.forEach((tid) => window.clearTimeout(tid));
    };
  }, []);

  useEffect(() => {
    setHistory([]);
  }, [role, userId]);

  // Auto-scroll on new messages
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    const activeSession = await electron.session.get();
    if (!activeSession) {
      setHistory([]);
      return;
    }

    const userMsg: ChatMessage = {
      id: `u-${Date.now()}`,
      from: "user",
      text,
      ts: Date.now(),
      riskTier: "low",
    };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setBusy(true);

    await logAudit({
      eventType: "chat_request",
      detail: JSON.stringify({ prompt: text, role }),
      actorUserId: userId,
      actorRole: role,
      riskTier: "low",
    });

    let handled = false;
    let assistantText = "";
    let toolUsed: string | undefined;
    let refused = false;

    if (role === "student") {
      void electron.telemetry.record("student_chat_send", { length: text.length });

      const rem = text.match(/remind me (?:to (.+?) )?in (\d+)\s*minutes?/i);
      if (rem) {
        const minutes = Math.min(120, Math.max(1, parseInt(rem[2], 10)));
        const what = (rem[1] ?? "your reminder").trim().slice(0, 120) || "your reminder";
        const tid = window.setTimeout(() => {
          pushToast(`Reminder: ${what}`, "info");
          void logAudit({
            eventType: "student_reminder_fired",
            detail: JSON.stringify({ what, minutes }),
            actorUserId: userId,
            actorRole: "student",
            riskTier: "low",
          });
        }, minutes * 60 * 1000);
        reminderTimers.current.push(tid);
        assistantText = `In-app reminder set for ${minutes} minute(s): “${what}”. Reminders only fire while this window stays open; they do not extend official lab attendance.`;
        toolUsed = "session_lab_help";
        handled = true;
        void electron.telemetry.record("reminder_scheduled", { minutes });
      }

      if (
        !handled &&
        /how much time|time (do i |left)|(session|login).{0,12}(left|remain|expire)|remaining.{0,16}session/i.test(
          text,
        )
      ) {
        if (sessionExpiresAt != null && sessionExpiresAt > Date.now()) {
          const mins = Math.max(0, Math.floor((sessionExpiresAt - Date.now()) / 60000));
          assistantText = `About ${mins} minute(s) remain before your Runa login session expires (${new Date(sessionExpiresAt).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}). Lab closing and attendance rules come from staff — this timer is only your app sign-in.`;
        } else {
          assistantText =
            "I do not have your session expiry in this view. Ask lab staff for lab hours and attendance.";
        }
        toolUsed = "session_lab_help";
        handled = true;
      }

      if (!handled && /(create|make) (a |an |the )?folder|mkdir|new folder/i.test(text)) {
        const nameMatch =
          text.match(/(?:named|called)\s*["']?([^"'\n]+?)["']?\s*$/i) ||
          text.match(/folder\s+["']?([^"'\n]+)["']?/i) ||
          text.match(/mkdir\s+["']?([^"'\n]+)["']?/i);
        const folderName =
          (nameMatch?.[1] ?? "New folder").trim().replace(/[<>:"/\\|?*]/g, "_").slice(0, 80) || "New folder";
        const relBase = await electron.runaFiles.getSessionWorkspaceRelative();
        if (!relBase.ok || !relBase.relative) {
          assistantText = relBase.error ?? "You must be signed in to use Runa_Folder.";
          toolUsed = "runa_files_help";
        } else {
          const relativePath = `${String(relBase.relative).replace(/\\/g, "/")}/${folderName}`;
          const cr = await electron.runaFiles.createFolder(relativePath);
          if (cr.ok) {
            assistantText = `Created folder in your Runa vault:\n${relativePath}\n(Under Runa_Folder next to the app when installed — scoped to your session; not visible to other lab accounts.)`;
            toolUsed = "runa_files_help";
          } else {
            assistantText = `Could not create folder: ${cr.error ?? "Unknown error"}. If this persists, contact lab tech.`;
            toolUsed = "runa_files_help";
          }
        }
        handled = true;
      }
    }

    if (handled) {
      const tierFromRegistry: RiskTier =
        toolUsed && findTool(role, toolUsed)
          ? (findTool(role, toolUsed) as ToolDefinition).riskTier
          : "low";
      setMessages((m) => [
        ...m,
        {
          id: `a-${Date.now()}`,
          from: "assistant",
          text: assistantText,
          ts: Date.now(),
          riskTier: refused ? "low" : tierFromRegistry,
          toolUsed,
          refused,
        },
      ]);
      await logAudit({
        eventType: refused ? "request_refused" : "chat_response",
        detail: JSON.stringify({ tool: toolUsed ?? null, path: "student_local_handler" }),
        actorUserId: userId,
        actorRole: "student",
        riskTier: refused ? "low" : tierFromRegistry,
      });
      setBusy(false);
      return;
    }

    const stub = stubRespond(text, role);

    if (stub.toolUsed === "vault_list_files") {
      const listing = await electron.runaFiles.listDir("");
      const body = listing.ok
        ? listing.entries.length > 0
          ? listing.entries.map((e) => `  • ${e}`).join("\n")
          : "  (empty)"
        : `Could not list Runa_Folder: ${listing.error ?? "unknown error"}`;
      setMessages((m) => [
        ...m,
        {
          id: `a-${Date.now()}`,
          from: "assistant",
          text: `${stub.text}\n\n${body}`,
          ts: Date.now(),
          riskTier: "low",
          toolUsed: "vault_list_files",
        },
      ]);
      // No separate logAudit here — runaFiles:listDir already logs
      // "runa_files_list" in main.ts; a second entry would double-count it.
      setBusy(false);
      return;
    }

    if (stub.proposeActionType) {
      const isStudentEscalation = stub.proposeActionType === "student_hitl_escalation";
      const proposeRes = await proposeAction(
        {
          type: stub.proposeActionType,
          scope: role === "admin" ? "lab" : "self",
          reversible: isStudentEscalation,
          payload: {
            source: role === "admin" ? "admin_assistant" : "student_assistant",
            prompt: text.slice(0, 500),
            ...(stub.actionPayload ?? {}),
          },
          confidence: 0.85,
          reasoning: `${role} assistant proposing ${stub.proposeActionType} from prompt: "${text.slice(0, 80)}"`,
        },
        userId,
        role,
      );

      if (proposeRes.autoExecuted) {
        const tier = proposeRes.tier;
        const ok = proposeRes.result.ok;
        let displayText = ok ? stub.text : `Could not complete that: ${proposeRes.result.message}`;
        if (ok && stub.proposeActionType === "runa_read_file") {
          const content = proposeRes.result.evidence?.content;
          if (typeof content === "string") {
            const clipped = content.length > 4000 ? `${content.slice(0, 4000)}\n…(truncated)` : content;
            displayText = `${stub.text}\n\n---\n${clipped}`;
          }
        }
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}`,
            from: "assistant",
            text: displayText,
            ts: Date.now(),
            riskTier: tier,
            toolUsed: "propose_action",
          },
        ]);
      } else {
        const id = proposeRes.request.id;
        setMessages((m) => [
          ...m,
          {
            id: `a-${Date.now()}`,
            from: "assistant",
            text: `${stub.text}\n\nApproval ID: ${id.slice(0, 8)}…`,
            ts: Date.now(),
            riskTier: "high",
            toolUsed: "propose_action",
            approvalId: id,
          },
        ]);
      }
      setBusy(false);
      return;
    }

    assistantText = stub.text;
    toolUsed = stub.toolUsed;
    refused = Boolean(stub.refused);
    let sidecarSource: string | undefined;
    let inputTokens = 0;
    let outputTokens = 0;

    if (!refused) {
      const ai = await callAI({
        prompt: text,
        system: ctx.systemPrompt,
        role,
        tools: ctx.availableTools.map((t) => t.id),
        history,
        maxTokens: 1024,
        temperature: 0.3,
        useKnowledgeBase: true,
        kbTopK: 5,
      });
      if (ai.ok && typeof ai.response === "string" && ai.response.trim().length > 0) {
        assistantText = ai.response.trim();
        toolUsed = "ai_task";
        refused = false;
        sidecarSource = ai.source;
        inputTokens = ai.inputTokens ?? 0;
        outputTokens = ai.outputTokens ?? 0;
        setHistory(ai.updatedHistory ?? []);
      } else if (!ai.ok) {
        if ((await electron.session.get()) == null) {
          setHistory([]);
        }
        assistantText =
          stub.text +
          `\n\nThe assistant service is offline or unreachable${ai.error ? ` (${ai.error})` : ""}. Please try again when the lab network is available. If this keeps happening, contact lab tech.`;
      } else {
        assistantText =
          ai.detail?.toLowerCase().includes("credential")
            ? "AI service is offline. Please check AWS credentials or contact the lab tech."
            : "Could not reach AI service. Try again.";
      }
    }

    const responseAction = {
      type: "chat_response" as const,
      scope: "self" as const,
      reversible: true,
      payload: { responseLength: assistantText.length },
      reasoning: refused
        ? "Out-of-scope request refused per policy"
        : `Assistant tool: ${toolUsed ?? "chat_response"}`,
    };

    const tierFromRegistry: RiskTier =
      toolUsed && findTool(role, toolUsed)
        ? (findTool(role, toolUsed) as ToolDefinition).riskTier
        : "low";
    const finalTier = refused ? "low" : tierFromRegistry;

    const reason = refused
      ? "Out-of-scope request — refused per policy"
      : explainClassification(responseAction);

    setMessages((m) => [
      ...m,
      {
        id: `a-${Date.now()}`,
        from: "assistant",
        text: assistantText,
        ts: Date.now(),
        riskTier: finalTier,
        toolUsed,
        refused,
      },
    ]);

    const auditActor = role === "student" ? userId : "system";
    const auditRole = role === "student" ? "student" : "agent";

    await logAudit({
      eventType: refused ? "request_refused" : "chat_response",
      detail: JSON.stringify({
        tool: toolUsed ?? null,
        reason,
        sidecarSource,
        inputTokens,
        outputTokens,
      }),
      actorUserId: auditActor,
      actorRole: auditRole,
      riskTier: finalTier,
    });

    if (toolUsed && !refused) {
      await logAudit({
        eventType: "tool_invoked",
        detail: JSON.stringify({ tool: toolUsed, sidecarSource }),
        actorUserId: auditActor,
        actorRole: auditRole,
        riskTier: finalTier,
      });
    }

    setBusy(false);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div
      className="flex flex-col rounded-sm border border-[#1e2e48] overflow-hidden"
      style={{
        background: "#0f1828",
        height: height ?? "100%",
        fontFamily: GROTESK,
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b border-[#1e2e48]"
        style={{ background: "#111d30" }}
      >
        <div className="flex items-center gap-2">
          <Bot size={14} className="text-[#7eb5f5]" />
          <span
            className="text-[#c5d5ea] tracking-widest uppercase"
            style={{ fontSize: "10px", fontFamily: MONO }}
          >
            Productivity Assistant · {role.toUpperCase()} MODE
          </span>
        </div>
        <span
          className="text-[#4a6080] tracking-widest uppercase"
          style={{ fontSize: "8px", fontFamily: MONO }}
        >
          Bounded · {ctx.availableTools.length} tools
        </span>
      </div>

      {/* Scope statement */}
      <div
        className="px-4 py-2 border-b border-[#1a2640]"
        style={{ background: "#0d1626" }}
      >
        <div
          className="flex items-start gap-2 text-[#4a6080]"
          style={{ fontSize: "10px" }}
        >
          <ShieldAlert size={11} className="mt-0.5 shrink-0 text-[#a06820]" />
          <p style={{ lineHeight: 1.4 }}>
            {role === "student"
              ? "Hi I'm Runa, your AI assistant. I'm here to help you with your tasks. In-app reminders only. Tools: "
              : "I summarize, recommend, and draft. I do not directly execute state-mutating actions; HIGH-risk proposals route through the Approvals Queue. Tools available: "}
            <span className="text-[#7eb5f5]">
              {ctx.availableTools.map((t) => t.label).join(" · ")}
            </span>
          </p>
        </div>
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-4 py-3 space-y-3"
        style={{ background: "#0f1828" }}
      >
        {messages.map((m) => (
          <div
            key={m.id}
            className={`flex ${m.from === "user" ? "justify-end" : "justify-start"}`}
          >
            <div
              className="max-w-[85%] rounded-sm border px-3 py-2"
              style={{
                background: m.from === "user" ? "#1a2a44" : "#111d30",
                borderColor: m.from === "user" ? "#3a5a9a" : "#1e2e48",
              }}
            >
              <div className="flex items-center gap-2 mb-1">
                {m.from === "user" ? (
                  <User size={10} className="text-[#7eb5f5]" />
                ) : (
                  <Bot size={10} className="text-[#7eb5f5]" />
                )}
                <span
                  className="text-[#4a6080] tracking-widest uppercase"
                  style={{ fontSize: "8px", fontFamily: MONO }}
                >
                  {m.from === "user" ? "YOU" : "ASSISTANT"}
                </span>
                <RiskBadge tier={m.riskTier} />
                {m.toolUsed && (
                  <span
                    className="text-[#4a6080]"
                    style={{ fontSize: "8px", fontFamily: MONO }}
                  >
                    · {m.toolUsed}
                  </span>
                )}
                {m.refused && (
                  <span
                    className="text-[#e05c6a]"
                    style={{ fontSize: "8px", fontFamily: MONO }}
                  >
                    · REFUSED
                  </span>
                )}
                {m.approvalId && (
                  <span
                    className="text-[#e8a83a]"
                    style={{ fontSize: "8px", fontFamily: MONO }}
                  >
                    · QUEUED
                  </span>
                )}
              </div>
              <div
                className="text-[#c5d5ea] whitespace-pre-wrap"
                style={{ fontSize: "12px", lineHeight: 1.45 }}
              >
                {m.text}
              </div>
            </div>
          </div>
        ))}
        {busy && (
          <div className="flex justify-start">
            <div
              className="rounded-sm border border-[#1e2e48] px-3 py-2"
              style={{ background: "#111d30" }}
            >
              <span
                className="text-[#4a6080] tracking-widest uppercase"
                style={{ fontSize: "9px", fontFamily: MONO }}
              >
                ASSISTANT THINKING
                <span className="inline-block animate-pulse ml-1">···</span>
              </span>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div
        className="border-t border-[#1e2e48] p-3 flex items-end gap-2"
        style={{ background: "#0d1626" }}
      >
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            role === "student"
              ? "Ask a concept, paste code, “create folder …”, “remind me in 10 minutes”, session time…"
              : "Summarize today's audit, explain an alert, propose an action..."
          }
          rows={2}
          disabled={busy}
          className="flex-1 rounded-sm px-3 py-2 text-[#c5d5ea] placeholder-[#2e4060] border outline-none resize-none"
          style={{
            background: "#0f1a2a",
            borderColor: "#1e2e48",
            fontSize: "12px",
            fontFamily: MONO,
          }}
        />
        <button
          onClick={send}
          disabled={busy || !input.trim()}
          className="flex items-center gap-1.5 px-4 py-2 rounded-sm tracking-widest uppercase disabled:opacity-40 disabled:cursor-not-allowed transition-opacity hover:opacity-90"
          style={{
            background: "#3a5a9a",
            color: "#c5d5ea",
            fontSize: "10px",
            fontFamily: MONO,
          }}
        >
          SEND <Send size={11} />
        </button>
      </div>
    </div>
  );
});

ProductivityAssistant.displayName = "ProductivityAssistant";
