#!/usr/bin/env node
"use strict";
// ---------------------------------------------------------------------------
// verify-reapply-patches — re-apply local patches after a pack update.
//
// Parity with GSD's verify-reapply-patches.cjs: a contributor may locally patch
// staged workflow/skill files; the installer snapshots a pristine baseline
// (~/.claude/dev-pristine/) and lets the update re-apply the recorded patch set
// (~/.claude/dev-local-patches/) on top of the new payload. W0 ships the
// scaffolding (list/plan); the full 3-way merge lands with the self-update wave.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { NAMESPACE } = require("./package-identity.cjs");

function patchesDir(home) {
  return path.join(home || os.homedir(), ".claude", `${NAMESPACE}-local-patches`);
}

function listPatches(home) {
  const dir = patchesDir(home);
  try {
    // sorted for a deterministic re-apply order
    return fs.readdirSync(dir).filter((f) => f.endsWith(".patch")).sort();
  } catch (err) {
    // A MISSING patches dir legitimately means "no local patches". Any other
    // error (EACCES, EIO, …) is a real I/O problem we must NOT mask as an empty
    // set — that would silently skip an expected re-apply. Re-throw it.
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) return [];
    throw err;
  }
}

// Plan the re-apply (W0: report what would be re-applied; no mutation).
function planReapply(home) {
  const patches = listPatches(home);
  return {
    patchesDir: patchesDir(home),
    count: patches.length,
    patches,
    note: patches.length
      ? "patches present — the update wave re-applies these onto the new payload via 3-way merge"
      : "no local patches recorded",
  };
}

if (require.main === module) {
  const plan = planReapply();
  process.stdout.write(JSON.stringify(plan, null, 2) + "\n");
}

module.exports = { patchesDir, listPatches, planReapply };
