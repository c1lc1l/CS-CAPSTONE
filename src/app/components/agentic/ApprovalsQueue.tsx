/**
 * ApprovalsQueue.tsx
 *
 * The admin-side HITL panel. Lists pending HIGH-risk approval
 * requests, lets the admin approve / reject / request-info. Persists
 * across reload because the queue itself is in electron-store on the
 * main side; we just render it.
 *
 * Polls every 5s for new pending entries (in addition to refreshing
 * after each action). Lightweight enough that we don't need a
 * subscription pattern for the prototype.
 *
 * Cross-reference: sprint/agentic-architecture.md §5.
 */

import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, XCircle, MessageCircleQuestion, RefreshCw, Inbox, History } from "lucide-react";
import type { ApprovalRequest } from "../../agentic/types";
import {
  approveRequest,
  rejectRequest,
  requestInfo,
  listPending,
  listHistory,
} from "../../agentic/approvalQueue";
import { RiskBadge } from "./RiskBadge";
import { useNotificationContext } from "../../providers/NotificationProvider";

const MONO = "'Share Tech Mono', monospace";
const GROTESK = "'Exo 2', sans-serif";

interface ApprovalsQueueProps {
  /** The currently logged-in admin's email — recorded as approver. */
  currentAdminId: string;
  /** Optional callback fired after any decision so the parent can refresh badges. */
  onChange?: () => void;
}

interface InfoModalState {
  open: boolean;
  request?: ApprovalRequest;
  text: string;
}

export function ApprovalsQueue({ currentAdminId, onChange }: ApprovalsQueueProps) {
  const { pushToast } = useNotificationContext();
  const [pending, setPending] = useState<ApprovalRequest[]>([]);
  const [history, setHistory] = useState<ApprovalRequest[]>([]);
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [infoModal, setInfoModal] = useState<InfoModalState>({ open: false, text: "" });

  const refresh = useCallback(async () => {
    const [p, h] = await Promise.all([listPending(), listHistory(50)]);
    setPending(p);
    setHistory(h);
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  const onApprove = async (req: ApprovalRequest) => {
    if (busyId) return;
    setBusyId(req.id);
    try {
      const res = await approveRequest(req.id, currentAdminId);
      if (res.result.ok) {
        pushToast(res.result.message, "success");
      } else {
        pushToast(`Approved, but execution failed: ${res.result.message}`, "error");
      }
    } catch (err) {
      console.error("[ApprovalsQueue] Approve failed:", err);
      pushToast(err instanceof Error ? err.message : "Approve failed", "error");
    } finally {
      setBusyId(null);
      await refresh();
      onChange?.();
    }
  };

  const onReject = async (req: ApprovalRequest) => {
    if (busyId) return;
    setBusyId(req.id);
    try {
      await rejectRequest(req.id, currentAdminId);
      pushToast("Request rejected.", "info");
    } catch (err) {
      console.error("[ApprovalsQueue] Reject failed:", err);
      pushToast(err instanceof Error ? err.message : "Reject failed", "error");
    } finally {
      setBusyId(null);
      await refresh();
      onChange?.();
    }
  };

  const submitInfo = async () => {
    if (!infoModal.request || !infoModal.text.trim()) return;
    try {
      await requestInfo(infoModal.request.id, currentAdminId, infoModal.text.trim());
    } catch (err) {
      console.error("[ApprovalsQueue] Request-info failed:", err);
    } finally {
      setInfoModal({ open: false, text: "" });
      await refresh();
      onChange?.();
    }
  };

  return (
    <div
      className="h-full flex flex-col"
      style={{ background: "#0d1320", fontFamily: GROTESK }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-6 py-4 border-b border-[#1e2e48]"
        style={{ background: "#101a2c" }}
      >
        <div>
          <p
            className="text-[#4a6080] tracking-widest uppercase mb-1"
            style={{ fontSize: "9px", fontFamily: MONO }}
          >
            HUMAN-IN-THE-LOOP REVIEW
          </p>
          <h1
            className="text-[#c5d5ea] tracking-wider uppercase"
            style={{ fontSize: "20px", fontFamily: MONO, letterSpacing: "0.06em" }}
          >
            Approvals Queue
          </h1>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={refresh}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm border border-[#2a3a55] text-[#7eb5f5] hover:bg-[#1a2a44] transition-colors"
            style={{ fontSize: "10px", fontFamily: MONO }}
            title="Refresh queue"
          >
            <RefreshCw size={11} /> REFRESH
          </button>
          <div
            className="px-3 py-1.5 rounded-sm border border-[#1e2e48]"
            style={{ background: "#0f1a2a", fontSize: "10px", fontFamily: MONO }}
          >
            <span className="text-[#4a6080] tracking-widest uppercase">Pending</span>
            <span className="text-[#e8a83a] ml-2 tabular-nums">{pending.length}</span>
          </div>
        </div>
      </div>

      {/* Tab strip */}
      <div className="flex border-b border-[#1e2e48]" style={{ background: "#0f1828" }}>
        <button
          onClick={() => setTab("pending")}
          className="flex items-center gap-2 px-5 py-2.5 transition-all"
          style={{
            background: tab === "pending" ? "#0d1320" : "transparent",
            borderBottom: tab === "pending" ? "2px solid #e8a83a" : "2px solid transparent",
            color: tab === "pending" ? "#e8a83a" : "#4a6080",
            fontSize: "10px",
            fontFamily: MONO,
            letterSpacing: "0.1em",
          }}
        >
          <Inbox size={11} /> PENDING ({pending.length})
        </button>
        <button
          onClick={() => setTab("history")}
          className="flex items-center gap-2 px-5 py-2.5 transition-all"
          style={{
            background: tab === "history" ? "#0d1320" : "transparent",
            borderBottom: tab === "history" ? "2px solid #4a6fa5" : "2px solid transparent",
            color: tab === "history" ? "#7eb5f5" : "#4a6080",
            fontSize: "10px",
            fontFamily: MONO,
            letterSpacing: "0.1em",
          }}
        >
          <History size={11} /> HISTORY ({history.length})
        </button>
      </div>

      {/* List */}
      <div className="flex-1 overflow-y-auto p-6">
        {tab === "pending" ? (
          pending.length === 0 ? (
            <EmptyState
              icon={<Inbox size={24} className="text-[#2a3a55]" />}
              title="Queue empty"
              subtitle="All HIGH-risk actions have been resolved. New proposals will appear here."
            />
          ) : (
            <div className="space-y-4">
              {pending.map((req) => (
                <RequestCard
                  key={req.id}
                  request={req}
                  busy={busyId === req.id}
                  onApprove={() => onApprove(req)}
                  onReject={() => onReject(req)}
                  onRequestInfo={() => setInfoModal({ open: true, request: req, text: "" })}
                />
              ))}
            </div>
          )
        ) : history.length === 0 ? (
          <EmptyState
            icon={<History size={24} className="text-[#2a3a55]" />}
            title="No history yet"
            subtitle="Resolved approvals will appear here for traceability."
          />
        ) : (
          <div className="space-y-3">
            {history.map((req) => (
              <HistoryCard key={req.id} request={req} />
            ))}
          </div>
        )}
      </div>

      {/* Request-info modal */}
      {infoModal.open && (
        <div
          className="fixed inset-0 flex items-center justify-center z-[var(--z-modal)]"
          style={{ background: "#0008" }}
          onClick={() => setInfoModal({ open: false, text: "" })}
        >
          <div
            className="w-[480px] rounded-sm border border-[#2a3a55] overflow-hidden"
            style={{ background: "#111d30" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-5 py-3 border-b border-[#1e2e48]">
              <p
                className="text-[#c5d5ea] tracking-widest uppercase"
                style={{ fontSize: "11px", fontFamily: MONO }}
              >
                REQUEST MORE INFO
              </p>
            </div>
            <div className="p-5">
              <p
                className="text-[#4a6080] mb-3"
                style={{ fontSize: "11px", fontFamily: MONO }}
              >
                Add a comment for the requester. They'll see this when they next log in.
              </p>
              <textarea
                value={infoModal.text}
                onChange={(e) => setInfoModal({ ...infoModal, text: e.target.value })}
                rows={4}
                placeholder="What additional context do you need?"
                className="w-full rounded-sm px-3 py-2 text-[#c5d5ea] placeholder-[#2e4060] border outline-none resize-none"
                style={{
                  background: "#0f1a2a",
                  borderColor: "#1e2e48",
                  fontSize: "12px",
                  fontFamily: MONO,
                }}
              />
            </div>
            <div className="px-5 py-3 flex justify-end gap-2 border-t border-[#1e2e48]" style={{ background: "#0d1626" }}>
              <button
                onClick={() => setInfoModal({ open: false, text: "" })}
                className="px-4 py-1.5 rounded-sm border border-[#2a3a55] text-[#4a6080] hover:bg-[#1a2a44] transition-colors"
                style={{ fontSize: "10px", fontFamily: MONO }}
              >
                CANCEL
              </button>
              <button
                onClick={submitInfo}
                disabled={!infoModal.text.trim()}
                className="px-4 py-1.5 rounded-sm tracking-widest uppercase disabled:opacity-40 hover:opacity-90 transition-opacity"
                style={{
                  background: "#3a5a9a",
                  color: "#c5d5ea",
                  fontSize: "10px",
                  fontFamily: MONO,
                }}
              >
                SUBMIT
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────
//  Request card (pending)
// ─────────────────────────────────────────────
interface RequestCardProps {
  request: ApprovalRequest;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  onRequestInfo: () => void;
}

function RequestCard({ request, busy, onApprove, onReject, onRequestInfo }: RequestCardProps) {
  return (
    <div
      className="rounded-sm border border-[#2a3a55] overflow-hidden"
      style={{ background: "#111d30" }}
    >
      {/* Card header */}
      <div
        className="flex items-center justify-between px-4 py-2.5 border-b border-[#1e2e48]"
        style={{ background: "#0f1828" }}
      >
        <div className="flex items-center gap-3">
          <span
            className="text-[#4a6080] tabular-nums"
            style={{ fontSize: "10px", fontFamily: MONO }}
          >
            #{request.id.slice(0, 8)}
          </span>
          <span
            className="text-[#7eb5f5] tabular-nums"
            style={{ fontSize: "10px", fontFamily: MONO }}
          >
            {formatTime(request.createdAt)}
          </span>
          <RiskBadge tier="high" />
        </div>
        <span
          className="text-[#c5d5ea] tracking-widest uppercase"
          style={{ fontSize: "10px", fontFamily: MONO }}
        >
          {request.action.type.replace(/_/g, " ")}
        </span>
      </div>

      {/* Body */}
      <div className="p-4 grid grid-cols-2 gap-4">
        <Field label="Requester">
          <span style={{ fontSize: "11px", fontFamily: MONO }}>
            {request.requesterId}
            <span className="text-[#4a6080] ml-2">({request.requesterRole})</span>
          </span>
        </Field>
        <Field label="Scope">
          <span style={{ fontSize: "11px", fontFamily: MONO }}>
            {request.action.scope.toUpperCase()} ·{" "}
            {request.action.reversible ? "REVERSIBLE" : "IRREVERSIBLE"}
          </span>
        </Field>
        <Field label="Action payload" full>
          <pre
            className="text-[#c5d5ea] whitespace-pre-wrap break-words p-2 rounded-sm border border-[#1e2e48]"
            style={{
              background: "#0f1a2a",
              fontSize: "11px",
              fontFamily: MONO,
              lineHeight: 1.4,
            }}
          >
{JSON.stringify(request.action.payload, null, 2)}
          </pre>
        </Field>
        <Field label="Reasoning" full>
          <p
            className="text-[#c5d5ea]"
            style={{ fontSize: "11px", fontFamily: MONO, lineHeight: 1.5 }}
          >
            {request.action.reasoning}
          </p>
        </Field>
        {request.action.confidence !== undefined && (
          <Field label="AI confidence">
            <span style={{ fontSize: "11px", fontFamily: MONO }}>
              {(request.action.confidence * 100).toFixed(0)}%
            </span>
          </Field>
        )}
        {request.evidence?.scanResult ? (
          <Field label="Evidence">
            <span style={{ fontSize: "11px", fontFamily: MONO }}>scan attached</span>
          </Field>
        ) : null}
      </div>

      {/* Actions */}
      <div
        className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[#1e2e48]"
        style={{ background: "#0d1626" }}
      >
        <button
          onClick={onRequestInfo}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm border border-[#2a3a55] text-[#7eb5f5] hover:bg-[#1a2a44] disabled:opacity-40 transition-colors"
          style={{ fontSize: "10px", fontFamily: MONO }}
        >
          <MessageCircleQuestion size={12} /> REQUEST INFO
        </button>
        <button
          onClick={onReject}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-sm border border-[#a02a2a] text-[#ffb1ba] hover:bg-[#2a0c10] disabled:opacity-40 transition-colors"
          style={{ fontSize: "10px", fontFamily: MONO }}
        >
          <XCircle size={12} /> REJECT
        </button>
        <button
          onClick={onApprove}
          disabled={busy}
          className="flex items-center gap-1.5 px-4 py-1.5 rounded-sm disabled:opacity-40 hover:opacity-90 transition-opacity"
          style={{
            background: "#1e7a3e",
            color: "#0d1320",
            fontSize: "10px",
            fontFamily: MONO,
            letterSpacing: "0.1em",
          }}
        >
          <CheckCircle2 size={12} /> APPROVE
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  History card (resolved)
// ─────────────────────────────────────────────
function HistoryCard({ request }: { request: ApprovalRequest }) {
  const statusColor: Record<ApprovalRequest["status"], { bg: string; fg: string; border: string }> = {
    pending: { bg: "#241a08", fg: "#e8a83a", border: "#a06820" },
    approved: { bg: "#0d2418", fg: "#7be39e", border: "#1e7a3e" },
    rejected: { bg: "#2a0c10", fg: "#ffb1ba", border: "#a02a2a" },
    info_requested: { bg: "#1a2a44", fg: "#7eb5f5", border: "#3a5a9a" },
  };
  const c = statusColor[request.status];

  return (
    <div
      className="flex items-center justify-between px-4 py-2.5 rounded-sm border border-[#1e2e48]"
      style={{ background: "#0f1828" }}
    >
      <div className="flex items-center gap-3">
        <span
          className="text-[#4a6080] tabular-nums"
          style={{ fontSize: "10px", fontFamily: MONO }}
        >
          #{request.id.slice(0, 8)}
        </span>
        <span
          className="text-[#c5d5ea] tracking-widest uppercase"
          style={{ fontSize: "10px", fontFamily: MONO }}
        >
          {request.action.type.replace(/_/g, " ")}
        </span>
        <span
          className="text-[#4a6080]"
          style={{ fontSize: "10px", fontFamily: MONO }}
        >
          by {request.requesterId.split("@")[0]}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {request.decision && (
          <span
            className="text-[#4a6080] tabular-nums"
            style={{ fontSize: "10px", fontFamily: MONO }}
          >
            {formatTime(request.decision.decidedAt)} · {request.decision.decidedByUserId.split("@")[0]}
          </span>
        )}
        <span
          className="px-2 py-0.5 rounded-sm border tracking-widest uppercase"
          style={{
            background: c.bg,
            color: c.fg,
            borderColor: c.border,
            fontSize: "9px",
            fontFamily: MONO,
          }}
        >
          {request.status.replace(/_/g, " ")}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────
function Field({
  label,
  children,
  full,
}: {
  label: string;
  children: React.ReactNode;
  full?: boolean;
}) {
  return (
    <div className={full ? "col-span-2" : ""}>
      <p
        className="text-[#4a6080] tracking-widest uppercase mb-1"
        style={{ fontSize: "8px", fontFamily: MONO }}
      >
        {label}
      </p>
      <div className="text-[#c5d5ea]">{children}</div>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  subtitle,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="mb-3">{icon}</div>
      <p
        className="text-[#c5d5ea] tracking-widest uppercase mb-2"
        style={{ fontSize: "12px", fontFamily: MONO }}
      >
        {title}
      </p>
      <p className="text-[#4a6080]" style={{ fontSize: "11px", maxWidth: 360 }}>
        {subtitle}
      </p>
    </div>
  );
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}
