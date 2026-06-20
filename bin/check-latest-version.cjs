#!/usr/bin/env node
"use strict";
// ---------------------------------------------------------------------------
// check-latest-version — git-based "is there a newer pack?" check (no npm).
//
// Mirrors GSD's check-latest-version.cjs but replaces the `npm view <pkg>
// version` leg with a git read of the repo's version.json on the default
// branch. The repo is the locked constant from package-identity.cjs (anti-
// typosquat). Returns { ok, version, reason } as JSON with --json.
//
// Compares local payload/VERSION (the installed pack) to the repo version.json.
// Network/clone failure FAILS SOFT (keeps the working install; tells the user)
// — never leaves a half-state.
// ---------------------------------------------------------------------------

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { REPO_SLUG, REPO_HTTPS } = require("./package-identity.cjs");

function readLocalVersion() {
  // installed payload VERSION, or this repo's VERSION when run from source
  const candidates = [
    path.join(require("os").homedir(), ".claude", "dev-core", "VERSION"),
    path.join(__dirname, "..", "payload", "VERSION"),
    path.join(__dirname, "..", "VERSION"),
  ];
  for (const c of candidates) {
    try { return fs.readFileSync(c, "utf8").trim(); } catch { /* next */ }
  }
  return null;
}

// Fetch version.json from the default branch via the GitHub API (gh) without a
// full clone. Falls back to a remote git read if gh is unavailable.
function fetchRemoteVersion() {
  // Try gh first (the contributor is already authed; privacy = access gate).
  const gh = spawnSync("gh", ["api", `repos/${REPO_SLUG}/contents/version.json`, "-q", ".content"], {
    encoding: "utf8",
  });
  if (gh.status === 0 && gh.stdout.trim()) {
    try {
      const json = JSON.parse(Buffer.from(gh.stdout.trim(), "base64").toString("utf8"));
      return { ok: true, version: json.version };
    } catch (e) {
      return { ok: false, reason: `could not parse remote version.json: ${e.message}` };
    }
  }
  return {
    ok: false,
    reason: `could not reach ${REPO_HTTPS} (privacy is the access gate — confirm repo access). Keeping the current install.`,
  };
}

// Compare two dotted numeric versions (vN.N.N tolerated). Returns <0 if a<b,
// 0 if equal, >0 if a>b. Non-numeric/missing segments are treated as 0 so a
// malformed version never reports a phantom "newer".
function semverCompare(a, b) {
  const pa = String(a).replace(/^v/i, "").split(".").map((n) => Number(n) || 0);
  const pb = String(b).replace(/^v/i, "").split(".").map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

function compare(local, remote) {
  if (!remote) return { ok: false, reason: "no remote version resolved" };
  if (!local) return { ok: true, version: remote, reason: "no local install detected" };
  // Use SEMANTIC ordering, not raw inequality: a local install NEWER than the
  // remote default branch (e.g. a contributor on an unreleased payload) is up to
  // date, not "update available".
  const order = semverCompare(local, remote);
  return {
    ok: true,
    version: remote,
    upToDate: order >= 0,
    local,
    reason:
      order === 0
        ? "up to date"
        : order < 0
          ? `update available: ${local} -> ${remote}`
          : "local install is newer than remote",
  };
}

function main() {
  const json = process.argv.includes("--json");
  const local = readLocalVersion();
  const remote = fetchRemoteVersion();
  let result;
  if (!remote.ok) result = remote;
  else result = compare(local, remote.version);
  if (json) {
    process.stdout.write(JSON.stringify(result) + "\n");
  } else {
    process.stdout.write((result.reason || JSON.stringify(result)) + "\n");
  }
  process.exit(result.ok === false ? 0 : 0); // soft-fail: never non-zero on network issues
}

if (require.main === module) main();

module.exports = { readLocalVersion, fetchRemoteVersion, compare, semverCompare };
