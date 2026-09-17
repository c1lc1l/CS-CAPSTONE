/**
 * auditChain.ts
 *
 * Tamper-evident hash chaining for the audit log.
 *
 * Each row carries the hash of the row before it, so altering or deleting any
 * historical row breaks every hash after it. This does not make the log
 * immutable — a local file can always be edited — but it makes edits
 * *detectable*, which is the property RA 10173 accountability actually needs:
 * an administrator cannot quietly remove evidence of their own access.
 *
 * Scope: the chain covers one workstation's local append-only sequence. A
 * single global chain across the shared cloud table is not well defined when
 * many lab machines append concurrently, so integrity is per-device by design.
 *
 * Kept free of Electron imports so it can be unit-tested directly.
 */

import { createHash } from "crypto";

export const GENESIS_HASH = "0".repeat(64);

/** Minimal shape required for chaining; the full AuditRow is a superset. */
export interface ChainableAuditRow {
  id: number;
  createdAt: number;
  eventType: string;
  eventDescription?: string;
  threatLevel?: string;
  actorUserId: string;
  actorRole: string;
  detail: string;
  approvalId?: string;
  approverUserId?: string;
  riskTier?: string;
  confidenceScore?: number;
  prevHash?: string;
  rowHash?: string;
}

export interface AuditChainReport {
  ok: boolean;
  rowsChecked: number;
  /** Index of the first row whose hash does not verify, if any. */
  brokenAtIndex: number | null;
  brokenRowId: number | null;
  reason: string | null;
}

/** Canonical serialization — field order is fixed so hashes are reproducible. */
export function canonicalAuditPayload(row: ChainableAuditRow, prevHash: string): string {
  return JSON.stringify([
    row.id,
    row.createdAt,
    row.eventType,
    row.eventDescription ?? "",
    row.threatLevel ?? "",
    row.actorUserId,
    row.actorRole,
    row.detail,
    row.approvalId ?? "",
    row.approverUserId ?? "",
    row.riskTier ?? "",
    row.confidenceScore ?? "",
    prevHash,
  ]);
}

export function computeRowHash(row: ChainableAuditRow, prevHash: string): string {
  return createHash("sha256").update(canonicalAuditPayload(row, prevHash)).digest("hex");
}

/** Seals a row against the current chain tail. Mutates and returns the row. */
export function sealRow<T extends ChainableAuditRow>(row: T, tail: ChainableAuditRow | undefined): T {
  row.prevHash = tail?.rowHash ?? GENESIS_HASH;
  row.rowHash = computeRowHash(row, row.prevHash);
  return row;
}

/**
 * Recomputes every hash in sequence and reports the first divergence.
 *
 * The local log is capped, so the oldest entries are eventually dropped.
 * Verification therefore anchors on the first retained hashed row rather than
 * requiring the window to begin at genesis — the guarantee is continuity
 * across the retained window, not since first boot.
 */
export function verifyAuditChain(rows: ChainableAuditRow[]): AuditChainReport {
  let prev: string | null = null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];

    // Rows written before chaining was introduced carry no hash; the chain
    // re-anchors at the next row that does.
    if (!row.rowHash) {
      prev = null;
      continue;
    }

    if (prev === null) {
      // Anchor: accept this row's stated predecessor, then verify forward.
      prev = row.prevHash ?? GENESIS_HASH;
    }

    if ((row.prevHash ?? GENESIS_HASH) !== prev) {
      return {
        ok: false,
        rowsChecked: i,
        brokenAtIndex: i,
        brokenRowId: row.id,
        reason:
          "prevHash does not match the preceding row — a row was altered, removed, or reordered",
      };
    }

    if (computeRowHash(row, prev) !== row.rowHash) {
      return {
        ok: false,
        rowsChecked: i,
        brokenAtIndex: i,
        brokenRowId: row.id,
        reason: "row content does not match its recorded hash — this row was modified after it was written",
      };
    }

    prev = row.rowHash;
  }

  return {
    ok: true,
    rowsChecked: rows.length,
    brokenAtIndex: null,
    brokenRowId: null,
    reason: null,
  };
}
