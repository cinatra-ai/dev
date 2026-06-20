#!/usr/bin/env node
// ---------------------------------------------------------------------------
// uninstall.mjs — reverse the install (DESIGN §2.3).
//
//   1. Remove ~/.claude/skills/dev-* and ~/.claude/agents/dev-*.
//   2. Un-merge the settings block via the keyed-sentinel ownership map: remove
//      ONLY entries whose current value still hashes to the recorded
//      appliedValue; a diverged (user-edited) entry is LEFT in place + noticed.
//      Foreign (GSD/user) entries are never touched.
//   3. Drop dev-core/, dev-{file-manifest,install-state}.json, .dev-profile,
//      dev-{pristine,local-patches}/. Leave ~/.dev/defaults.json + cloned repos.
//
// The same hard preflight runs first (never operate on the live ~/.claude
// unless explicitly overridden).
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { PACKAGE_NAME, NAMESPACE } = require("./package-identity.cjs");
const preflight = require("./lib/preflight.cjs");
const containment = require("./lib/containment.cjs");
const { resolveRuntimeArtifactLayout } = require("./lib/runtime-artifact-layout.cjs");
const settingsMerge = require("./lib/settings-merge.cjs");

// Guarded delete/write — same containment layer as install (blocker B1 + the
// Verify2 inode-aliasing class): the target is proven inside layout.configDir,
// with no escaping symlink component, and is not a second name (hardlink /
// live-inode) for a live-config file before the destructive syscall. The
// settings un-merge write goes through the ATOMIC temp-then-rename path so a
// hardlinked/symlinked settings.json is never truncated onto the live config;
// deletes refuse a hardlinked/live-inode target outright.
function guardedRm(p, claudeDir) {
  containment.guardedRemove(p, claudeDir);
}
function guardedWriteFile(p, data, claudeDir) {
  containment.atomicWriteFile(p, data, claudeDir);
}

// A manifest entry is only honoured for deletion if it matches an EXACT,
// expected shape (codex round-3 correction 2). Containment alone is not enough:
// a tampered manifest key like `skills/..` maps to skillsDir/.. which is still
// "inside" .claude, so containment would not stop it deleting the whole config.
// We therefore require the precise per-kind shape before mapping to a path.
//   skills/dev-<name>/SKILL.md   agents/dev-<name>.md   hooks/dev-<name>.js
const NS = NAMESPACE; // "dev"
const MANIFEST_SHAPES = [
  { bucket: "skills", re: new RegExp(`^skills/${NS}-[a-z0-9][a-z0-9-]*/SKILL\\.md$`) },
  { bucket: "agents", re: new RegExp(`^agents/${NS}-[a-z0-9][a-z0-9-]*\\.md$`) },
  { bucket: "hooks", re: new RegExp(`^hooks/${NS}-[a-z0-9][a-z0-9-]*\\.js$`) },
];

function parseArgs(argv) {
  const a = { runtime: "claude", scope: "global", override: false, dryRun: false, home: process.env.HOME || os.homedir() };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--dry-run") a.dryRun = true;
    else if (t === preflight.OVERRIDE_FLAG) a.override = true;
    else if (t === "--home") a.home = argv[++i];
  }
  return a;
}

function readJsonOr(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

// The payload dir is provably ours ONLY if its .identity names this exact
// package. A missing/unreadable .identity or a different package => NOT ours =>
// we must not delete it (symmetric with the install-side guard).
function payloadIsOurs(layout) {
  try {
    const rec = JSON.parse(fs.readFileSync(layout.identityFile, "utf8"));
    return rec.package === PACKAGE_NAME;
  } catch {
    return false;
  }
}

// Remove ONLY the artifacts this install recorded in the file manifest — never
// a blanket prefix wipe, so a user's / a foreign pack's same-prefixed artifact
// is left intact (codex finding 5). `kinds` selects which manifest sections
// (skills/agents/hooks) map onto which target dir.
function rmManifestArtifacts(manifest, layout, dryRun) {
  const removed = { skills: [], agents: [], hooks: [] };
  const skipped = [];
  if (!manifest || !manifest.files) return { removed, skipped, hadManifest: false };
  for (const rel of Object.keys(manifest.files)) {
    // SHAPE VALIDATION FIRST (codex round-3): only an exact, expected manifest
    // shape maps to a deletable path. A tampered key (e.g. `skills/..`,
    // `skills/../../foo`, an absolute path, a non-dev name) is ignored, not
    // deleted — containment alone would let `skills/..` resolve to the whole
    // .claude dir.
    const match = MANIFEST_SHAPES.find((m) => m.re.test(rel));
    if (!match) {
      skipped.push(rel);
      continue;
    }
    const bucket = match.bucket;
    let target;
    if (bucket === "skills") {
      // rel = skills/dev-<name>/SKILL.md → remove the skill DIR
      target = path.join(layout.skillsDir, rel.split("/")[1]);
    } else if (bucket === "agents") {
      target = path.join(layout.agentsDir, path.basename(rel));
    } else {
      target = path.join(layout.hooksDir, path.basename(rel));
    }
    if (fs.existsSync(target)) {
      removed[bucket].push(target);
      // guardedRm proves containment + no escaping symlink before deleting.
      if (!dryRun) guardedRm(target, layout.configDir);
    }
  }
  return { removed, skipped, hadManifest: true };
}

function run(argv) {
  const args = parseArgs(argv);
  const pf = preflight.evaluate({ home: args.home, override: args.override });
  if (!pf.ok) return { ok: false, refused: true, reason: pf.reason };

  const layout = resolveRuntimeArtifactLayout({ runtime: args.runtime, scope: args.scope, home: args.home });
  const report = { removedSkills: [], removedAgents: [], removedHooks: [], settings: null, removedPaths: [], notes: [] };

  try {
  // 1. skills + agents + hooks — manifest-driven (only what we installed)
  const manifest = readJsonOr(layout.fileManifest, null);
  if (!manifest) {
    report.notes.push("no file manifest found — nothing removed by manifest (refusing a blind prefix wipe)");
  }
  const { removed, skipped } = rmManifestArtifacts(manifest, layout, args.dryRun);
  report.removedSkills = removed.skills;
  report.removedAgents = removed.agents;
  report.removedHooks = removed.hooks;
  if (skipped && skipped.length) {
    report.notes.push(`ignored ${skipped.length} manifest entr${skipped.length === 1 ? "y" : "ies"} not matching an expected dev-* artifact shape (refusing to delete an unexpected path)`);
  }

  // 2. settings un-merge
  const settings = readJsonOr(layout.settingsFile, null);
  const ownership = readJsonOr(path.join(layout.pristineDir, "settings-ownership.json"), null);
  if (settings && ownership) {
    const un = settingsMerge.unmergeBlock(settings, ownership);
    report.settings = { removed: un.removed, kept: un.kept };
    // guardedWriteFile refuses to write THROUGH a symlinked settings.json.
    if (!args.dryRun) guardedWriteFile(layout.settingsFile, JSON.stringify(un.settings, null, 2) + "\n", layout.configDir);
  }

  // 3. drop the payload dir — ONLY if it is provably ours. Symmetric with the
  // install-side fail-closed ownership rule (codex round-2 blocker): a foreign /
  // no-identity ~/.claude/dev-core must NOT be rm -rf'd by uninstall. We remove
  // it only when its .identity names this exact package.
  if (fs.existsSync(layout.payloadDir)) {
    if (payloadIsOurs(layout)) {
      report.removedPaths.push(layout.payloadDir);
      if (!args.dryRun) guardedRm(layout.payloadDir, layout.configDir);
    } else {
      report.notes.push(`left ${layout.payloadDir} in place — no .identity matching ${PACKAGE_NAME} (not provably ours)`);
    }
  }

  // 4. drop OUR namespaced state files (these are uniquely ours by name).
  const stateDrop = [
    layout.fileManifest,
    layout.installState,
    layout.profileMarker,
    layout.pristineDir,
    layout.localPatchesDir,
  ];
  for (const p of stateDrop) {
    if (fs.existsSync(p)) {
      report.removedPaths.push(p);
      if (!args.dryRun) guardedRm(p, layout.configDir);
    }
  }

  return { ok: true, dryRun: args.dryRun, report };
  } catch (e) {
    // A containment violation (a child symlink escaping the target Claude dir,
    // etc.) is a HARD fail-closed: stop and report rather than delete/overwrite
    // through it. The partial report is preserved so the caller sees what was
    // removed before the refusal. Anything else re-throws.
    if (e && typeof e.code === "string" && e.code.startsWith("CONTAINMENT_")) {
      return { ok: false, refusedWrite: true, reason: e.message, report };
    }
    throw e;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = run(process.argv.slice(2));
  if (r.refused) { console.error(`[uninstall] REFUSED: ${r.reason}`); process.exit(3); }
  if (r.refusedWrite) { console.error(`[uninstall] REFUSED (containment): ${r.reason}`); process.exit(4); }
  console.log(`[uninstall] ${r.dryRun ? "DRY RUN" : "done"}`);
  if (r.report.settings && r.report.settings.kept.length) {
    console.warn(`[uninstall] kept ${r.report.settings.kept.length} diverged (user-edited) dev hook(s) — review manually.`);
  }
  process.exit(0);
}

export { run, parseArgs };
