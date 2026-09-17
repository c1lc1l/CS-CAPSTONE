/**
 * Tests for the audit hash chain.
 *
 * Runs against the COMPILED module (dist-electron/electron/auditChain.js) so
 * these exercise the same code the app loads, not a reimplementation.
 *
 *   npm run build:electron && node electron/auditChain.test.mjs
 */

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { sealRow, verifyAuditChain, GENESIS_HASH } = require("../dist-electron/electron/auditChain.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed += 1;
  } catch (err) {
    console.log(`  FAIL  ${name}`);
    console.log(`        ${err.message}`);
    failed += 1;
  }
}

function makeRow(id, overrides = {}) {
  return {
    id,
    createdAt: 1_700_000_000_000 + id * 1000,
    eventType: "login",
    actorUserId: `student${id}@runa.edu.ph`,
    actorRole: "student",
    detail: `event ${id}`,
    riskTier: "low",
    ...overrides,
  };
}

function buildChain(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) {
    rows.push(sealRow(makeRow(i), rows[rows.length - 1]));
  }
  return rows;
}

console.log("audit chain");

test("an untampered chain verifies", () => {
  const report = verifyAuditChain(buildChain(20));
  assert.equal(report.ok, true, report.reason ?? "");
  assert.equal(report.rowsChecked, 20);
});

test("first row anchors to genesis", () => {
  const rows = buildChain(3);
  assert.equal(rows[0].prevHash, GENESIS_HASH);
});

test("each row links to its predecessor", () => {
  const rows = buildChain(5);
  for (let i = 1; i < rows.length; i++) {
    assert.equal(rows[i].prevHash, rows[i - 1].rowHash);
  }
});

test("MODIFIED row content is detected", () => {
  const rows = buildChain(10);
  rows[4].detail = "quietly rewritten";
  const report = verifyAuditChain(rows);
  assert.equal(report.ok, false);
  assert.equal(report.brokenRowId, 5);
  assert.match(report.reason, /modified after it was written/);
});

test("changing the actor on a row is detected", () => {
  const rows = buildChain(8);
  rows[2].actorUserId = "someone.else@runa.edu.ph";
  const report = verifyAuditChain(rows);
  assert.equal(report.ok, false);
  assert.equal(report.brokenRowId, 3);
});

test("DELETED row is detected", () => {
  const rows = buildChain(10);
  rows.splice(5, 1); // remove row id 6
  const report = verifyAuditChain(rows);
  assert.equal(report.ok, false);
  assert.match(report.reason, /altered, removed, or reordered/);
});

test("REORDERED rows are detected", () => {
  const rows = buildChain(10);
  [rows[3], rows[7]] = [rows[7], rows[3]];
  const report = verifyAuditChain(rows);
  assert.equal(report.ok, false);
});

test("re-sealing a tampered row still breaks the chain (cannot be patched locally)", () => {
  const rows = buildChain(10);
  rows[4].detail = "rewritten";
  // Attacker recomputes just that row's hash to hide the edit.
  sealRow(rows[4], rows[3]);
  const report = verifyAuditChain(rows);
  assert.equal(report.ok, false, "row 6 should no longer link to the new hash of row 5");
  assert.equal(report.brokenRowId, 6);
});

test("truncated window still verifies (retention cap does not false-positive)", () => {
  const rows = buildChain(50).slice(-20); // simulate AUDIT_LIMIT trimming
  const report = verifyAuditChain(rows);
  assert.equal(report.ok, true, report.reason ?? "");
  assert.equal(report.rowsChecked, 20);
});

test("legacy rows without hashes do not false-positive", () => {
  const legacy = [makeRow(1), makeRow(2)]; // never sealed
  const report = verifyAuditChain(legacy);
  assert.equal(report.ok, true, report.reason ?? "");
});

test("chain re-anchors after legacy rows", () => {
  const legacy = [makeRow(1), makeRow(2)];
  const sealed = [];
  for (let i = 3; i <= 6; i++) {
    sealed.push(sealRow(makeRow(i), sealed[sealed.length - 1]));
  }
  const report = verifyAuditChain([...legacy, ...sealed]);
  assert.equal(report.ok, true, report.reason ?? "");
});

test("empty log verifies", () => {
  assert.equal(verifyAuditChain([]).ok, true);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
