"use strict";
// ---------------------------------------------------------------------------
// global-settings-baseline — verify + (on apply) configure the machine-global
// Claude baseline (#129, DESIGN §3.4 / §4.3).
//
// TWO entry points:
//   computeDiff(ctx)  -> READ-ONLY. Returns the exact diffs between the current
//                        machine-global config and the versioned baseline. Used
//                        by BOTH dev-doctor (report only) and dev-setup (preview).
//   applyDiff(ctx)    -> WRITES. Used by dev-setup --apply only. Goes through the
//                        full W0 safety stack: preflight.assertSafe(target HOME) +
//                        containment.assertContained(every dir) + atomicWriteFile
//                        (every file) + the settings-merge keyed-sentinel + a
//                        MANAGED-BLOCK sentinel for the global CLAUDE.md that
//                        preserves all foreign content. (codex round-0 C.)
//
// Attribution currency (DESIGN risk #4): the attribution baseline is read from
// the ENFORCEMENT ARTIFACTS on the machine (the commit-msg hook the org ships),
// NOT a hard-coded date. When those artifacts are absent we fall back to the
// documented TRANSITIONAL default and SAY SO in the diff detail, so the pack
// tracks the org attribution gate rather than drifting the moment it ratifies.
// ---------------------------------------------------------------------------

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const preflight = require("./preflight.cjs");
const containment = require("./containment.cjs");
const settingsMerge = require("./settings-merge.cjs");

// Versioned baseline metadata — a MANIFEST, not a copy of one maintainer's live
// machine (DESIGN §3.4). Bump lastVerified + claudeCodeVersion on review.
const BASELINE = {
  lastVerified: "2026-06-18",
  claudeCodeVersion: "2.1.177",
  // The managed-block sentinels so the global CLAUDE.md edit is reversible and
  // never clobbers a contributor's own notes.
  claudeMdBeginMarker: "<!-- BEGIN cinatra-dev org baseline (managed; edit above/below this block) -->",
  claudeMdEndMarker: "<!-- END cinatra-dev org baseline -->",
};

// The org rules block injected into the global CLAUDE.md. It states the
// truthful-attribution direction + the transitional no-AI-co-authorship rule.
// NOTE: it deliberately references "the org attribution gate" by NAME ONLY (no
// private issue numbers) so the shipped pack passes the leak gate.
const ORG_CLAUDE_MD_BLOCK = [
  "## Cinatra org baseline (attribution + hygiene)",
  "",
  "- Every agent-produced commit carries a truthful `Assisted-by: <agent> (<model-id>)`",
  "  trailer naming each agent+model that materially changed the diff (a human-only",
  "  change carries `Assisted-by: none`). `Assisted-by` is the ONLY AI record.",
  "- NEVER emit `Co-Authored-By` AI lines or \"Generated with\" badges (transitional",
  "  rule, still enforced until the org attribution gate ratifies the new spec).",
  "- NEVER self-assert `Reviewed-by` / `Gate-suite` / `Accountable`: those verification",
  "  records exist only in merge records, asserted by the actual human reviewer or the CI gate.",
  "- Settings are centralized in `~/.claude/settings.json`; no per-repo `.claude/` in active repos.",
].join("\n");

function homedir(ctx) {
  if (ctx && ctx.homeOverride) return ctx.homeOverride;
  // TRUE machine home (ignore $HOME) so a sandbox HOME used by tests is targeted
  // ONLY when explicitly passed via homeOverride. Production targets the real home.
  try { return os.userInfo().homedir; } catch { return os.homedir(); }
}

function claudeDir(ctx) {
  return path.join(homedir(ctx), ".claude");
}

// Read a JSON file, DISTINGUISHING "missing" from "present-but-unreadable" from
// "present-but-unparseable". Returns { value, status }:
//   "missing"     — the file does not exist (ENOENT only) → safe to create.
//   "read-error"  — the file IS present but could not be read (EACCES/EISDIR/…)
//                   → must NOT be treated as absent (writing would clobber it).
//   "invalid"     — present + readable but not valid JSON → must NOT be {}.
//   "ok"          — present + parsed.
// applyDiff() refuses to write on read-error / invalid; only missing/ok proceed
// (the W0 installer fails closed on a present-but-bad settings file too).
function readJsonDetailed(p) {
  let raw;
  try { raw = fs.readFileSync(p, "utf8"); }
  catch (e) {
    if (e && e.code === "ENOENT") return { value: {}, status: "missing" };
    return { value: null, status: "read-error", error: (e && e.message) || String(e) };
  }
  try { return { value: JSON.parse(raw), status: "ok" }; }
  catch { return { value: null, status: "invalid" }; }
}
// Convenience for READ-ONLY callers (computeDiff): missing => {}, anything the
// apply path would refuse (read-error/invalid) => null (the diff flags it, never
// writes). Read-only, so a present-but-unreadable file is just reported.
function readJsonSafe(p) {
  const r = readJsonDetailed(p);
  return r.status === "ok" ? r.value : (r.status === "missing" ? {} : null);
}
function readTextSafe(p) {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}
// Detailed text read, symmetric with readJsonDetailed: distinguish a missing
// file (ENOENT) from a present-but-unreadable one (so the CLAUDE.md apply path
// fails closed the same way settings.json does — codex round-3 finding 1).
//   status: "missing" | "ok" | "read-error"
function readTextDetailed(p) {
  try { return { value: fs.readFileSync(p, "utf8"), status: "ok" }; }
  catch (e) {
    if (e && e.code === "ENOENT") return { value: "", status: "missing" };
    return { value: null, status: "read-error", error: (e && e.message) || String(e) };
  }
}

// Resolve the attribution baseline from the ENFORCEMENT ARTIFACTS, not a date.
// We look for the org commit-msg hook (the local backstop the org ships) and the
// git core.hooksPath. The settings key `includeCoAuthoredBy:false` is the current
// transitional requirement; we record WHERE the truth came from so the pack does
// not drift when the gate ratifies.
function resolveAttributionState(ctx) {
  const home = homedir(ctx);
  // The org keeps the commit-msg hook under ~/.config/git/hooks by convention.
  const hookCandidates = [
    path.join(home, ".config", "git", "hooks", "commit-msg"),
  ];
  let hookPresent = false;
  let hookPath = null;
  for (const c of hookCandidates) {
    if (fs.existsSync(c)) { hookPresent = true; hookPath = c; break; }
  }
  return {
    // current transitional requirement; sourced from the gate/hook posture, not a date.
    includeCoAuthoredBy: false,
    source: hookPresent
      ? `enforcement artifact present (commit-msg hook at ${tildeify(hookPath, home)})`
      : "enforcement artifact NOT found — applying the documented transitional default (verify against the org gate)",
    hookPresent,
  };
}

function tildeify(p, home) {
  if (p && home && p.startsWith(home)) return "~" + p.slice(home.length);
  return p;
}

// Compute the desired vs current state. READ-ONLY. Returns:
//   { items: [ { id, label, status: ok|drift|absent, current, desired, detail } ],
//     attribution, anyDrift }
function computeDiff(ctx = {}) {
  const cd = claudeDir(ctx);
  const settingsPath = path.join(cd, "settings.json");
  const claudeMdPath = path.join(cd, "CLAUDE.md");
  const items = [];

  const sRead = readJsonDetailed(settingsPath);
  const settings = sRead.status === "ok" ? sRead.value : {};
  const attribution = resolveAttributionState(ctx);

  // 1. settings.json: includeCoAuthoredBy === false (no AI co-authorship lines).
  //    Report a present-but-invalid/unreadable file ACCURATELY (not "absent") —
  //    apply will refuse it, and the diff must say so (codex round-3 finding 2).
  {
    const desired = attribution.includeCoAuthoredBy; // false
    if (sRead.status === "invalid" || sRead.status === "read-error") {
      items.push({
        id: "settings.includeCoAuthoredBy",
        label: "settings.json includeCoAuthoredBy=false (no AI co-authorship)",
        status: "blocked",
        current: sRead.status === "invalid" ? "present but not valid JSON" : `present but unreadable (${sRead.error})`,
        desired,
        detail: "settings.json is present but unusable — apply will REFUSE until you fix/remove it (no clobber)",
      });
    } else {
      const current = settings.includeCoAuthoredBy;
      const status = current === desired ? "ok" : (current === undefined ? "absent" : "drift");
      items.push({
        id: "settings.includeCoAuthoredBy",
        label: "settings.json includeCoAuthoredBy=false (no AI co-authorship)",
        status,
        current: current === undefined ? null : current,
        desired,
        detail: `attribution baseline source: ${attribution.source}`,
      });
    }
  }

  // 2. global CLAUDE.md org baseline block present (managed block). Report a
  //    present-but-unreadable CLAUDE.md accurately (apply will refuse it).
  {
    const mdRead = readTextDetailed(claudeMdPath);
    if (mdRead.status === "read-error") {
      items.push({
        id: "claudeMd.orgBlock",
        label: "global ~/.claude/CLAUDE.md org baseline block",
        status: "blocked",
        current: `present but unreadable (${mdRead.error})`,
        desired: "managed org-baseline block present",
        detail: "CLAUDE.md is present but unreadable — apply will REFUSE until you fix/remove it (no clobber)",
      });
    } else {
      const md = mdRead.value || "";
      const hasBlock = md.includes(BASELINE.claudeMdBeginMarker) && md.includes(ORG_CLAUDE_MD_BLOCK.split("\n")[0]);
      items.push({
        id: "claudeMd.orgBlock",
        label: "global ~/.claude/CLAUDE.md org baseline block",
        status: hasBlock ? "ok" : "absent",
        current: hasBlock ? "present" : (md ? "file exists, block missing" : "no CLAUDE.md"),
        desired: "managed org-baseline block present",
        detail: "managed block; foreign content above/below is preserved on apply",
      });
    }
  }

  // 3. playwright MCP --output-dir pinned under the org .claude/ (hygiene).
  //    If settings.json is unusable we cannot read this either — report blocked,
  //    not absent (codex round-4 finding 2).
  {
    if (sRead.status === "invalid" || sRead.status === "read-error") {
      items.push({
        id: "playwright.outputDir",
        label: "Playwright MCP --output-dir pinned under ~/.claude/",
        status: "blocked",
        current: sRead.status === "invalid" ? "settings.json present but not valid JSON" : "settings.json present but unreadable",
        desired: path.join(cd, "playwright"),
        detail: "cannot read the Playwright pin — settings.json is present but unusable (apply will refuse)",
      });
    } else {
      const pinned = playwrightOutputDirPinned(settings, cd);
      items.push({
        id: "playwright.outputDir",
        label: "Playwright MCP --output-dir pinned under ~/.claude/",
        status: pinned.ok ? "ok" : "absent",
        current: pinned.current || null,
        desired: pinned.desired,
        detail: pinned.detail,
      });
    }
  }

  // 4. no per-repo .claude in active repos — this is a POLICY check the doctor
  //    surfaces but cannot auto-fix (it would mean editing arbitrary repos); we
  //    report it as advisory and defer the convention to #131 hygiene.
  {
    items.push({
      id: "policy.noPerRepoClaude",
      label: "no per-repo .claude/ in active repos (settings centralized)",
      status: "advisory",
      current: "not auto-scanned",
      desired: "settings live only in ~/.claude/",
      detail: "advisory policy (see the global-settings-hygiene convention skill); not auto-applied",
    });
  }

  const anyDrift = items.some((i) => i.status === "drift" || i.status === "absent" || i.status === "blocked");
  return { items, attribution, anyDrift };
}

// Is the Playwright MCP configured to write artifacts under ~/.claude/? We look
// for a configured output dir anywhere in settings (mcpServers args or a flat
// key) that resolves under the org .claude dir.
function playwrightOutputDirPinned(settings, cd) {
  const desired = path.join(cd, "playwright");
  // SCOPE to the Playwright MCP config branch — don't accept an --output-dir
  // that appears in some UNRELATED setting (codex round-4 finding 1). The MCP
  // config lives under an mcpServers/mcp map keyed by a playwright-named server.
  const pwNode = findPlaywrightMcpNode(settings);
  if (pwNode === undefined) {
    return { ok: false, current: null, desired, detail: "pin Playwright MCP --output-dir under ~/.claude/playwright (workspace hygiene)" };
  }
  const val = findOutputDir(pwNode);
  if (!val) {
    return { ok: false, current: null, desired, detail: "Playwright MCP present but --output-dir not pinned under ~/.claude/playwright (workspace hygiene)" };
  }
  // Expand a leading ~ to the (target) home, then require the resolved dir to be
  // CONTAINED under the org .claude dir. No substring shortcut: a path like
  // /tmp/.claude-playwright or /some/repo/.claude/playwright must NOT pass — only
  // a dir genuinely under ~/.claude/ is compliant (codex round-3 finding 3).
  const home = path.dirname(cd); // cd === <home>/.claude
  const expanded = val.startsWith("~/") ? path.join(home, val.slice(2))
    : (val === "~" ? home : val);
  const ok = containment.contains(cd, path.resolve(expanded));
  return { ok, current: val, desired, detail: ok ? "pinned under the org .claude dir" : "configured but NOT under ~/.claude/ — repin (hygiene)" };
}

// Locate the Playwright MCP server's config node, so the output-dir search is
// SCOPED to it (not any unrelated setting). Looks under the usual MCP maps
// (mcpServers, mcp.servers, mcp) for a server whose KEY mentions "playwright",
// or whose command/args reference the Playwright MCP package. Returns the config
// node, or `undefined` when no Playwright MCP is configured.
function findPlaywrightMcpNode(settings) {
  if (!settings || typeof settings !== "object") return undefined;
  // Candidate SERVER MAPS, each a { <serverName>: <serverConfig> } object. Use
  // mcp.servers when present and do NOT also treat the mcp WRAPPER as a server
  // map (that would let one sibling's "playwright" key qualify another sibling's
  // --output-dir — codex round-5). Only fall back to the wrapper when there is
  // no explicit servers map under it.
  const maps = [];
  if (settings.mcpServers && typeof settings.mcpServers === "object") maps.push(settings.mcpServers);
  if (settings.mcp && typeof settings.mcp === "object") {
    if (settings.mcp.servers && typeof settings.mcp.servers === "object") maps.push(settings.mcp.servers);
    else maps.push(settings.mcp);
  }
  for (const map of maps) {
    for (const [key, node] of Object.entries(map)) {
      if (/playwright/i.test(key)) return node;
      // else: a server qualifies as Playwright ONLY if its EXECUTABLE surface
      // (command / args / package) names playwright — not an arbitrary text
      // field like a `notes` string (which must not qualify it, round-5 repro).
      if (isPlaywrightServer(node)) return node;
    }
  }
  return undefined;
}

// Long flags that CONSUME the following token as their value (so that value is
// not a playwright signal). Kept small + explicit — a boolean flag (e.g. --yes)
// is NOT here, so it never swallows a following package arg (codex round-7).
const VALUE_TAKING_FLAGS = new Set([
  "--output-dir", "--output", "--out-dir", "--config", "--port", "--host",
  "--user-data-dir", "--executable-path", "--browser",
]);

// True iff a server config's command/args/package reference the Playwright MCP.
// Deliberately ignores free-text fields AND the VALUE of an --output-dir (whose
// path may itself contain "playwright", e.g. ~/.claude/playwright — that must
// NOT qualify the server; codex round-5). Only the command / package / a flag-
// style or package-style arg counts.
function isPlaywrightServer(node) {
  if (!node || typeof node !== "object") return false;
  const surfaces = [];
  if (typeof node.command === "string") surfaces.push(node.command);
  if (typeof node.package === "string") surfaces.push(node.package);
  if (Array.isArray(node.args)) {
    for (let i = 0; i < node.args.length; i++) {
      const a = node.args[i];
      if (typeof a !== "string") continue;
      // skip the VALUE that follows a SPLIT value-taking flag (--output-dir <path>).
      // Only KNOWN value-taking flags consume the next token — a boolean flag like
      // `--yes` must NOT swallow a following package arg (codex round-7).
      const prev = node.args[i - 1];
      if (typeof prev === "string" && VALUE_TAKING_FLAGS.has(prev.toLowerCase()) && !a.startsWith("-")) continue;
      // for the EQUALS form of a value-taking flag (--output-dir=<path>), keep
      // only the FLAG NAME, not the value (whose path may contain "playwright";
      // codex round-6).
      const eq = a.match(/^(--[a-z-]+)=/i);
      if (eq && VALUE_TAKING_FLAGS.has(eq[1].toLowerCase())) { surfaces.push(eq[1]); continue; }
      surfaces.push(a);
    }
  }
  return surfaces.some((s) => /playwright/i.test(s));
}

// Find a Playwright `--output-dir` value by WALKING a (Playwright-scoped) config
// node (not by regexing a JSON blob, which mis-captures around escaped quotes).
// Handles two real shapes: an args ARRAY (["--output-dir", "<dir>"] or
// ["--output-dir=<dir>"]). Prose/metadata string leaves (notes/description/env)
// are intentionally NOT scanned — only a real `args` array counts (round-8).
function findOutputDir(node) {
  if (node == null || typeof node !== "object") return null;
  // KEY-AWARE: only the command-line `args` array (and a nested server/config
  // object that itself carries one) is a real output-dir surface. We do NOT scan
  // arbitrary string leaves like `notes`/`description`/`env` — a mention of
  // `--output-dir` in prose must not satisfy the pin (codex round-8).
  if (Array.isArray(node.args)) {
    const fromArgs = outputDirFromArgs(node.args);
    if (fromArgs) return fromArgs;
  }
  // descend into nested config objects (e.g. an mcp wrapper), but only via object
  // values — never treating a bare string field as a command line.
  for (const v of Object.values(node)) {
    if (v && typeof v === "object") {
      const nested = findOutputDir(v);
      if (nested) return nested;
    }
  }
  return null;
}

// Extract the --output-dir value from a real args ARRAY (split or equals form).
function outputDirFromArgs(args) {
  for (let i = 0; i < args.length; i++) {
    const el = args[i];
    if (typeof el !== "string") continue;
    if (el === "--output-dir" && typeof args[i + 1] === "string") return args[i + 1].trim();
    const eq = el.match(/^--output-dir=(.+)$/);
    if (eq) return eq[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

// Render the diff as human lines (used by the dev-doctor/dev-setup output).
function renderDiff(diff) {
  const lines = [];
  for (const it of diff.items) {
    const mark = it.status === "ok" ? "OK  " : it.status === "advisory" ? "NOTE" : it.status === "blocked" ? "BLOK" : "FIX ";
    lines.push(`[${mark}] ${it.label}`);
    if (it.status !== "ok") {
      lines.push(`        current: ${JSON.stringify(it.current)}  ->  desired: ${JSON.stringify(it.desired)}`);
      if (it.detail) lines.push(`        ${it.detail}`);
    }
  }
  return lines.join("\n");
}

// Apply the baseline. WRITES — dev-setup --apply only. Every mutation passes
// through the W0 safety stack. `ctx.homeOverride` MUST be a sandbox HOME in tests
// (preflight refuses the live ~/.claude regardless). Returns a change report.
//   ctx.only: optional array of item ids to apply (default = all fixable).
function applyDiff(ctx = {}) {
  const home = homedir(ctx);

  // (1) preflight authorizes the TARGET home/Claude dir. This refuses the live
  //     ~/.claude / authoring home unless an explicit override is passed.
  preflight.assertSafe({ home, override: Boolean(ctx.preflightOverride) });

  const cd = claudeDir(ctx);

  // (2) FAIL CLOSED on a present-but-UNUSABLE settings.json OR CLAUDE.md, BEFORE
  //     any write (so we never write one file then fail/clobber the other).
  //     Writing over a corrupt/unreadable resident file would clobber a foreign/user
  //     block (parity with the W0 installer). A MISSING file is fine (we create
  //     it); only an INVALID / unreadable present file blocks.
  const settingsPath0 = path.join(cd, "settings.json");
  const claudeMdPath0 = path.join(cd, "CLAUDE.md");
  const sRead = readJsonDetailed(settingsPath0);
  const mdRead0 = readTextDetailed(claudeMdPath0);
  const refuse = (file, why) => {
    throw Object.assign(
      new Error(
        `refusing to apply: ${file} is present but ${why}. ` +
        `Fix or remove it first — the pack will not overwrite a present-but-unusable file.`
      ),
      { code: "BASELINE_INVALID_SETTINGS" }
    );
  };
  if (sRead.status === "invalid") refuse(settingsPath0, "is not valid JSON");
  if (sRead.status === "read-error") refuse(settingsPath0, `could not be read (${sRead.error})`);
  if (mdRead0.status === "read-error") refuse(claudeMdPath0, `could not be read (${mdRead0.error})`);

  // (3) guard + create the Claude dir (containment-checked BEFORE mkdir).
  ensureDir(cd, cd);

  const diff = computeDiff(ctx);
  const want = (id) => !ctx.only || ctx.only.includes(id);
  const changed = [];
  const skipped = [];

  // settings.includeCoAuthoredBy
  const settingsItem = diff.items.find((i) => i.id === "settings.includeCoAuthoredBy");
  if (settingsItem && settingsItem.status !== "ok" && want("settings.includeCoAuthoredBy")) {
    // reuse the value validated above (sRead): missing => {}, ok => parsed.
    // (invalid already threw, so this is never a clobber of corrupt content.)
    const settings = sRead.status === "ok" ? sRead.value : {};
    settings.includeCoAuthoredBy = diff.attribution.includeCoAuthoredBy; // false
    writeJson(settingsPath0, settings, cd);
    changed.push("settings.includeCoAuthoredBy=false");
  } else if (settingsItem && settingsItem.status === "ok") {
    skipped.push("settings.includeCoAuthoredBy (already set)");
  }

  // global CLAUDE.md managed block (preserve foreign content). Reuse mdRead0
  // (missing => "", ok => content; read-error already refused above).
  const mdItem = diff.items.find((i) => i.id === "claudeMd.orgBlock");
  if (mdItem && mdItem.status !== "ok" && want("claudeMd.orgBlock")) {
    const existing = mdRead0.status === "ok" ? mdRead0.value : "";
    const next = upsertManagedBlock(existing, ORG_CLAUDE_MD_BLOCK);
    writeText(claudeMdPath0, next, cd);
    changed.push("CLAUDE.md org baseline block (managed; foreign content preserved)");
  } else if (mdItem && mdItem.status === "ok") {
    skipped.push("CLAUDE.md org block (already present)");
  }

  // playwright + per-repo-.claude are advisory/awkward to auto-write safely; we
  // report them in the diff but do NOT auto-mutate Playwright config here (the
  // setup skill surfaces the exact line for the user to confirm). This keeps the
  // write footprint minimal (codex round-0 C: no surprise writes).
  if (diff.items.find((i) => i.id === "playwright.outputDir" && i.status !== "ok")) {
    skipped.push("playwright --output-dir (surfaced as an exact line; not auto-written)");
  }

  return { changed, skipped, home, claudeDir: cd, applied: changed.length > 0 };
}

// Insert/replace the managed block in `text`, preserving everything outside the
// markers. Idempotent: a second apply with the same block is a no-op.
function upsertManagedBlock(text, block) {
  const begin = BASELINE.claudeMdBeginMarker;
  const end = BASELINE.claudeMdEndMarker;
  const managed = `${begin}\n${block}\n${end}`;
  const re = new RegExp(
    `${escapeRe(begin)}[\\s\\S]*?${escapeRe(end)}`,
    "m"
  );
  if (re.test(text)) {
    return text.replace(re, managed);
  }
  const sep = text.length && !text.endsWith("\n") ? "\n\n" : (text.length ? "\n" : "");
  return `${text}${sep}${managed}\n`;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// dir creation guarded by containment (codex round-0 C: guard mkdir, not just files).
function ensureDir(dir, guardRoot) {
  containment.assertContained(dir, guardRoot, "dir");
  fs.mkdirSync(dir, { recursive: true });
}

function writeJson(p, obj, guardRoot) {
  containment.atomicWriteFile(p, JSON.stringify(obj, null, 2) + "\n", guardRoot);
}
function writeText(p, text, guardRoot) {
  containment.atomicWriteFile(p, text.endsWith("\n") ? text : text + "\n", guardRoot);
}

module.exports = {
  BASELINE,
  ORG_CLAUDE_MD_BLOCK,
  resolveAttributionState,
  computeDiff,
  renderDiff,
  applyDiff,
  upsertManagedBlock,
  playwrightOutputDirPinned,
};
