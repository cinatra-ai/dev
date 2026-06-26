#!/usr/bin/env node
// ---------------------------------------------------------------------------
// install.mjs — the GSD-parity, clone-based installer for cinatra-ai/dev.
//
// Flow (DESIGN §2.1):
//   0. PREFLIGHT (hard): refuse to write the live ~/.claude / authoring HOME
//      unless an explicit override is passed (W0 constraint C3). Always runs.
//   1. Resolve the SOURCE. --source <path> uses a local repo fixture (tests +
//      dev); otherwise use THIS package's own checkout when it is a complete
//      pack (the `npx github:cinatra-ai/dev[#<ref>]` / `npx @cinatra-ai/dev`
//      path — reproducible: the npx-pinned ref IS the installed content); only
//      if the running checkout is NOT a pack, fall back to a shallow clone of
//      the locked repo (the legacy clone-as-access-gate path). A clone failure
//      is SKIP-WITH-NOTICE (exit 0, nothing written) — never a hard session
//      failure (R2's only fallback).
//   2. Assert payload-dir ownership (.identity) — fail closed if a different
//      package squats ~/.claude/dev-core/ (codex finding 4).
//   3. Stage payload -> ~/.claude/dev-core/.
//   4. Convert + stage skills -> ~/.claude/skills/dev-<name>/SKILL.md.
//   5. Stage called agents -> ~/.claude/agents/dev-<name>.md.
//   6. Deep-merge settings (keyed-sentinel, never clobber GSD) -> settings.json.
//   7. Write file manifest (sha256/file) + install-state + .dev-profile +
//      pristine snapshot + ownership sidecar.
//
// --dry-run prints the plan and writes nothing (also how installer.test.mjs
// validates against a sandbox HOME without mutating it).
//
// Usage:
//   node bin/install.mjs --claude --global [--source <path>] [--dry-run]
//   HOME=/tmp/sandbox node bin/install.mjs --claude --global --source .
// ---------------------------------------------------------------------------

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const { REPO_HTTPS, NAMESPACE } = require("./package-identity.cjs");
const preflight = require("./lib/preflight.cjs");
const containment = require("./lib/containment.cjs");
const { resolveRuntimeArtifactLayout } = require("./lib/runtime-artifact-layout.cjs");
const profiles = require("./lib/install-profiles.cjs");
const settingsMerge = require("./lib/settings-merge.cjs");

// Guarded fs wrappers (W0 blocker B1 + Verify2 inode-aliasing class). Every
// write/mkdir/rm root is proven CONTAINED within the target Claude dir, free of
// an escaping symlink component, AND not a second name (hardlink / live-inode)
// for a live-config file BEFORE the syscall. File writes/copies go through the
// ATOMIC temp-then-rename path (containment.atomicWriteFile/atomicCopyFile) so a
// hardlinked or symlinked destination is NEVER truncated — rename swaps the dir
// entry and leaves the aliased inode intact. The guard is unconditional.
function guardedMkdir(p, claudeDir) {
  containment.assertContained(p, claudeDir, "dir");
  fs.mkdirSync(p, { recursive: true });
}
function guardedWriteFile(p, data, claudeDir) {
  containment.atomicWriteFile(p, data, claudeDir);
}
function guardedRm(p, claudeDir) {
  containment.guardedRemove(p, claudeDir);
}
function guardedCopyFile(s, d, claudeDir) {
  containment.atomicCopyFile(s, d, claudeDir);
}

function parseArgs(argv) {
  const a = {
    runtime: "claude",
    scope: "global",
    dryRun: false,
    source: null,
    profile: null,
    override: false,
    home: process.env.HOME || os.homedir(),
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--claude") a.runtime = "claude";
    else if (t === "--global") a.scope = "global";
    else if (t === "--dry-run") a.dryRun = true;
    else if (t === preflight.OVERRIDE_FLAG) a.override = true;
    else if (t === "--source") a.source = argv[++i];
    else if (t === "--profile") a.profile = argv[++i];
    else if (t === "--home") a.home = argv[++i];
  }
  return a;
}

function sha256File(p) {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

function copyDir(src, dst, manifest, relBase, claudeDir) {
  guardedMkdir(dst, claudeDir);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d, manifest, path.join(relBase, entry.name), claudeDir);
    else if (entry.isFile()) {
      guardedCopyFile(s, d, claudeDir);
      if (manifest) manifest[path.join(relBase, entry.name)] = sha256File(d);
    }
  }
}

// A directory is a valid pack SOURCE only if it can produce a real install:
//   • a non-empty skills-src/ (≥1 `.md` — these are the artifacts that get
//     staged; a source with zero skills stages nothing, so it is NOT a pack),
//     AND
//   • a bin/ tree (the staged dev-tools shim is copied UNCONDITIONALLY at the
//     write step — its absence would crash AFTER the destructive payloadDir rm).
// payload/ is OPTIONAL: a pack whose skills carry their workflow body INLINE
// (the public dev pack) needs no payload/workflows/ — the converter emits a
// self-contained launcher for those. This predicate is the fail-closed gate:
// anything that is not a complete pack SKIPS-WITH-NOTICE before any write.
function isPackSource(root) {
  const skillsSrc = path.join(root, "skills-src");
  const hasSkills =
    fs.existsSync(skillsSrc) &&
    fs.readdirSync(skillsSrc).some((f) => f.endsWith(".md"));
  const hasBin = fs.existsSync(path.join(root, "bin"));
  return hasSkills && hasBin;
}

// Resolve the pack SOURCE root. Order:
//   1. --source <path> (dev/tests fixtures, local development).
//   2. THIS package's own checkout — when the installer runs from a complete
//      pack (e.g. `npx github:cinatra-ai/dev[#<ref>]` or `npx @cinatra-ai/dev`,
//      where npm has already fetched THIS exact version into place). Installing
//      from the fetched tree makes the install REPRODUCIBLE — the version you
//      npx-pin is the version you get — and needs no second network round-trip.
//   3. A fresh shallow clone of the locked repo (the legacy clone-as-access-gate
//      path), used only when the running checkout is NOT itself a pack.
// A clone failure is SKIP-WITH-NOTICE (exit 0, nothing written) — never a hard
// session failure. Returns { sourceRoot, cleanup } or { skip: true, reason }.
function resolveSource(args) {
  if (args.source) {
    let src = args.source;
    if (src.startsWith("file://")) src = fileURLToPath(src);
    src = path.resolve(src);
    if (!isPackSource(src)) {
      return { skip: true, reason: `--source ${src} is not a complete pack source (needs a non-empty skills-src/ and a bin/)` };
    }
    return { sourceRoot: src, cleanup: () => {} };
  }
  // The installer's own checkout (bin/ -> repo root). When run via npx, npm has
  // already fetched THIS exact ref here, so use it directly (reproducible; no
  // re-clone of a moving default branch).
  const selfRoot = path.resolve(__dirname, "..");
  if (isPackSource(selfRoot)) {
    return { sourceRoot: selfRoot, cleanup: () => {} };
  }
  // Legacy fallback: clone the locked repo into a temp dir (access gate).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cinatra-dev-clone-"));
  try {
    execFileSync("git", ["clone", "--depth", "1", REPO_HTTPS, tmp], { stdio: "pipe" });
    if (!isPackSource(tmp)) {
      fs.rmSync(tmp, { recursive: true, force: true });
      return { skip: true, reason: `cloned ${REPO_HTTPS} but it is not a complete pack source (needs a non-empty skills-src/ and a bin/)` };
    }
    return { sourceRoot: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
  } catch (e) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
    return {
      skip: true,
      reason:
        `could not clone ${REPO_HTTPS} (${(e.stderr || e.message || "").toString().trim().slice(0, 200)}). ` +
        `Privacy is the access gate — confirm you have access to this repo. Skipping install (nothing written).`,
    };
  }
}

// Assert ~/.claude/dev-core/ is ours (or absent) before staging (finding 4).
function assertPayloadOwnership(layout, identity) {
  const idFile = layout.identityFile;
  const payloadExists = fs.existsSync(layout.payloadDir);
  if (!payloadExists) return; // nothing to clobber — fresh install

  // The payload dir already exists. It is ONLY safe to clobber if it is provably
  // ours, i.e. it carries a .identity naming this exact package. A dev-core/
  // that exists WITHOUT a .identity is an unknown/foreign dir — FAIL CLOSED
  // rather than rm -rf it (codex finding 2).
  if (!fs.existsSync(idFile)) {
    throw Object.assign(
      new Error(
        `${layout.payloadDir} already exists but has no .identity marker; it is not provably owned by ${identity.package}. ` +
        `Refusing to clobber it. Remove it manually if you intend to replace it.`
      ),
      { code: "PAYLOAD_OWNERSHIP" }
    );
  }
  try {
    const rec = JSON.parse(fs.readFileSync(idFile, "utf8"));
    if (rec.package !== identity.package) {
      throw Object.assign(
        new Error(
          `${layout.payloadDir} is owned by a different package (${rec.package || "unknown"}); refusing to clobber. ` +
          `Remove it manually if you intend to replace it.`
        ),
        { code: "PAYLOAD_OWNERSHIP" }
      );
    }
  } catch (e) {
    if (e.code === "PAYLOAD_OWNERSHIP") throw e;
    // unreadable/invalid .identity → be conservative, refuse
    throw Object.assign(
      new Error(`${idFile} is unreadable or invalid; refusing to clobber ${layout.payloadDir}`),
      { code: "PAYLOAD_OWNERSHIP" }
    );
  }
}

function run(argv) {
  const args = parseArgs(argv);
  const notes = [];

  // ---- 0. PREFLIGHT (hard, always) ----
  const pf = preflight.evaluate({ home: args.home, override: args.override });
  if (!pf.ok) {
    return { ok: false, refused: true, reason: pf.reason };
  }

  const layout = resolveRuntimeArtifactLayout({ runtime: args.runtime, scope: args.scope, home: args.home });
  const version = fs.readFileSync(path.join(__dirname, "..", "VERSION"), "utf8").trim();
  const identity = { package: require("./package-identity.cjs").PACKAGE_NAME, version };

  // ---- 1. Resolve source (clone = access gate; skip-with-notice) ----
  const src = resolveSource(args);
  if (src.skip) {
    return { ok: true, skipped: true, reason: src.reason };
  }
  const sourceRoot = src.sourceRoot;

  try {
    // ---- 2. Ownership assertion (unless dry-run) ----
    if (!args.dryRun) {
      try {
        assertPayloadOwnership(layout, identity);
      } catch (e) {
        if (e.code === "PAYLOAD_OWNERSHIP") return { ok: false, reason: e.message };
        throw e;
      }
    }

    // ---- 3..5. Build the staging plan ----
    const payloadSrc = path.join(sourceRoot, "payload");
    const hasPayload = fs.existsSync(payloadSrc);
    const skillsSrcDir = path.join(sourceRoot, "skills-src");
    // A skill's heavy body lives EITHER in payload/workflows/<stem>.md (the
    // split-launcher form) OR inline in skills-src/<stem>.md (the self-contained
    // form). The converter must only @-include a payload workflow that is
    // actually staged — otherwise the installed launcher dangles on a missing
    // file. A pack with no payload/ stages every skill self-contained.
    const hasPayloadWorkflow = (stem) =>
      hasPayload && fs.existsSync(path.join(payloadSrc, "workflows", `${stem}.md`));

    // discover source skills + their requires for the closure
    const sourceSkills = fs.existsSync(skillsSrcDir)
      ? fs.readdirSync(skillsSrcDir).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""))
      : [];
    const requiresOf = (stem) => {
      const p = path.join(skillsSrcDir, `${stem}.md`);
      if (!fs.existsSync(p)) return [];
      const { frontmatter } = profiles.splitFrontmatter(fs.readFileSync(p, "utf8"));
      return profiles.parseRequires(frontmatter);
    };
    const profileSpec = args.profile || readProfileMarker(layout) || "full";
    const effective = profiles.resolveEffectiveProfile(profileSpec, requiresOf, sourceSkills);

    // convert skills + collect called agents
    const stagedSkills = [];
    const calledAgents = new Set();
    for (const stem of effective) {
      const srcPath = path.join(skillsSrcDir, `${stem}.md`);
      const content = fs.readFileSync(srcPath, "utf8");
      const converted = profiles.convertSourceToSkill(content, stem, {
        hasPayloadWorkflow: hasPayloadWorkflow(stem),
      });
      stagedSkills.push({ id: `${NAMESPACE}-${stem}`, content, converted });
      for (const ag of profiles.scanCalledAgents(content)) calledAgents.add(ag);
    }

    const agentsSrcDir = path.join(sourceRoot, "agents-src");
    const stagedAgents = [];
    for (const ag of calledAgents) {
      const srcPath = path.join(agentsSrcDir, `${ag}.md`);
      if (fs.existsSync(srcPath)) {
        stagedAgents.push({ id: `${NAMESPACE}-${ag}`, content: fs.readFileSync(srcPath, "utf8") });
      }
    }

    // ---- settings block + merge plan ----
    const block = buildSettingsBlock(layout);
    // Read the existing settings.json FAIL-CLOSED: a MISSING file is fine (-> {}),
    // but a file that exists and does NOT parse must NOT be swallowed as {} and
    // then overwritten — that would silently drop a real GSD/user settings block
    // (codex finding 3). Refuse instead.
    let existingSettings;
    if (fs.existsSync(layout.settingsFile)) {
      try {
        existingSettings = JSON.parse(fs.readFileSync(layout.settingsFile, "utf8"));
      } catch (e) {
        return {
          ok: false,
          reason:
            `${layout.settingsFile} exists but is not valid JSON (${e.message}); refusing to overwrite it ` +
            `(this would drop your existing settings). Fix or remove the file, then re-run.`,
        };
      }
    } else {
      existingSettings = {};
    }
    const priorOwnership = readJsonOr(path.join(layout.pristineDir, "settings-ownership.json"), null);
    const merged = settingsMerge.mergeBlock(existingSettings, block, priorOwnership);

    const plan = {
      version,
      profile: profileSpec,
      payloadDir: layout.payloadDir,
      skills: stagedSkills.map((s) => path.join(layout.skillsDir, s.id, "SKILL.md")),
      agents: stagedAgents.map((a) => path.join(layout.agentsDir, `${a.id}.md`)),
      settingsFile: layout.settingsFile,
      hooksMerged: Object.keys(block.hooks || {}),
      source: sourceRoot,
      hasPayload,
    };

    if (args.dryRun) {
      return { ok: true, dryRun: true, plan, notes };
    }

    // ---- WRITE ----
    // Every write/mkdir/rm below goes through a containment guard (blocker B1 +
    // the inode-aliasing arm): each root is proven inside layout.configDir, with
    // no escaping symlink component and no live-inode/hardlink alias, before the
    // syscall. File writes are atomic (temp-then-rename). cd = the target Claude dir.
    const cd = layout.configDir;
    const manifest = {};

    // ---- PRUNE STALE ARTIFACTS (profile-shrink gap, CodeRabbit) ----
    // A reinstall that NARROWS the profile (e.g. full -> core) must remove the
    // skills/agents/hooks the PREVIOUS install managed but the new subset no
    // longer stages — otherwise stale launchers stay active and the rewritten
    // manifest can no longer uninstall them. Read the prior manifest BEFORE we
    // overwrite it, and delete every recorded artifact NOT in the new staged set.
    // We reuse the SAME exact-shape validation the uninstaller uses so a tampered
    // prior manifest key (e.g. `skills/..`) can never delete outside the dev-*
    // artifacts, and every delete goes through the guarded (contained + atomic)
    // path.
    pruneStaleArtifacts({
      layout,
      cd,
      keepSkillIds: new Set(stagedSkills.map((s) => s.id)),
      keepAgentIds: new Set(stagedAgents.map((a) => a.id)),
      keepHookBasenames: new Set(Object.keys(hookScripts(layout)).map((p) => path.basename(p))),
    });

    // payload (engine dir). The pack ALWAYS gets a dev-core/ — it carries the
    // staged bin/ shim, VERSION, and .identity even when the source ships no
    // payload/ dir (a self-contained pack whose skill bodies are inline). When
    // a payload/ IS present, copy its contents (workflows, shared manifests, …).
    guardedRm(layout.payloadDir, cd);
    guardedMkdir(layout.payloadDir, cd);
    if (hasPayload) copyDir(payloadSrc, layout.payloadDir, manifest, "payload", cd);
    // also stage bin/lib so the staged dev-tools shim can resolve its modules
    copyDir(path.join(sourceRoot, "bin"), path.join(layout.payloadDir, "bin"), manifest, "bin", cd);
    // write VERSION + .identity into the payload dir
    guardedWriteFile(path.join(layout.payloadDir, "VERSION"), version + "\n", cd);
    guardedWriteFile(layout.identityFile, JSON.stringify(identity, null, 2) + "\n", cd);

    // skills
    guardedMkdir(layout.skillsDir, cd);
    for (const s of stagedSkills) {
      const dir = path.join(layout.skillsDir, s.id);
      guardedMkdir(dir, cd);
      const f = path.join(dir, "SKILL.md");
      guardedWriteFile(f, s.converted, cd);
      manifest[path.join("skills", s.id, "SKILL.md")] = sha256File(f);
    }

    // agents
    if (stagedAgents.length) guardedMkdir(layout.agentsDir, cd);
    for (const a of stagedAgents) {
      const f = path.join(layout.agentsDir, `${a.id}.md`);
      guardedWriteFile(f, a.content, cd);
      manifest[path.join("agents", `${a.id}.md`)] = sha256File(f);
    }

    // hook scripts the settings block references MUST be staged on disk, or the
    // merged FileChanged entry would dangle (codex finding 4). Stage them before
    // writing the settings that point at them, and record them in the manifest.
    guardedMkdir(layout.hooksDir, cd);
    for (const [absPath, contents] of Object.entries(hookScripts(layout))) {
      guardedWriteFile(absPath, contents, cd);
      manifest[path.join("hooks", path.basename(absPath))] = sha256File(absPath);
    }

    // settings merge + pristine snapshot + ownership sidecar
    guardedMkdir(layout.pristineDir, cd);
    writeJson(layout.settingsFile, merged.settings, cd);
    writeJson(path.join(layout.pristineDir, "settings-ownership.json"), merged.ownership, cd);
    writeJson(path.join(layout.pristineDir, "settings-block.json"), block, cd);

    // state + manifest + profile marker
    writeJson(layout.fileManifest, { version, timestamp: new Date().toISOString(), mode: "full", files: manifest }, cd);
    writeJson(layout.installState, { version, installedAt: new Date().toISOString(), appliedMigrations: [], profile: profileSpec }, cd);
    guardedWriteFile(layout.profileMarker, profileSpec + "\n", cd);

    return {
      ok: true,
      installed: true,
      plan,
      stagedSkillCount: stagedSkills.length,
      stagedAgentCount: stagedAgents.length,
      notes,
    };
  } catch (e) {
    // A containment violation (a child symlink escaping the target Claude dir,
    // a `..` escape, a live-dir landing, or an unresolvable component) is a HARD
    // fail-closed: report it as a structured failure (exit 1) rather than letting
    // it write/delete through. Anything else re-throws.
    if (e && typeof e.code === "string" && e.code.startsWith("CONTAINMENT_")) {
      return { ok: false, refusedWrite: true, reason: e.message };
    }
    throw e;
  } finally {
    src.cleanup();
  }
}

function readProfileMarker(layout) {
  try { return fs.readFileSync(layout.profileMarker, "utf8").trim(); } catch { return null; }
}

// Exact per-kind manifest shapes (mirror uninstall.mjs MANIFEST_SHAPES). Only a
// key matching one of these maps to a deletable artifact; a tampered key (e.g.
// `skills/..`, an absolute path, a non-dev name) is ignored — containment alone
// would otherwise let `skills/..` resolve to the whole .claude dir.
const PRUNE_SHAPES = [
  { bucket: "skills", re: new RegExp(`^skills/${NAMESPACE}-[a-z0-9][a-z0-9-]*/SKILL\\.md$`) },
  { bucket: "agents", re: new RegExp(`^agents/${NAMESPACE}-[a-z0-9][a-z0-9-]*\\.md$`) },
  { bucket: "hooks", re: new RegExp(`^hooks/${NAMESPACE}-[a-z0-9][a-z0-9-]*\\.js$`) },
];

// Remove artifacts the PREVIOUS install recorded that the new staged set no
// longer includes (profile-shrink prune). Shape-validated + guarded-delete only.
// Returns nothing (best-effort prune); a missing prior manifest is a no-op.
function pruneStaleArtifacts({ layout, cd, keepSkillIds, keepAgentIds, keepHookBasenames }) {
  const prior = readJsonOr(layout.fileManifest, null);
  if (!prior || !prior.files) return;
  for (const rel of Object.keys(prior.files)) {
    const match = PRUNE_SHAPES.find((m) => m.re.test(rel));
    if (!match) continue; // ignore anything not an exact dev-* artifact shape
    let target = null;
    if (match.bucket === "skills") {
      const skillId = rel.split("/")[1]; // skills/<id>/SKILL.md
      if (keepSkillIds.has(skillId)) continue; // still in the new profile — keep
      target = path.join(layout.skillsDir, skillId); // remove the whole skill DIR
    } else if (match.bucket === "agents") {
      const base = path.basename(rel); // <id>.md
      if (keepAgentIds.has(base.replace(/\.md$/, ""))) continue;
      target = path.join(layout.agentsDir, base);
    } else {
      const base = path.basename(rel); // <name>.js
      if (keepHookBasenames.has(base)) continue;
      target = path.join(layout.hooksDir, base);
    }
    if (target && fs.existsSync(target)) {
      guardedRm(target, cd); // contained + inode-safe delete
    }
  }
}

function readJsonOr(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}

function writeJson(p, obj, claudeDir) {
  guardedMkdir(path.dirname(p), claudeDir);
  guardedWriteFile(p, JSON.stringify(obj, null, 2) + "\n", claudeDir);
}

// The minimal hooks block cinatra/dev contributes. Footprint kept tiny to
// reduce collision surface (DESIGN §2.5): a single FileChanged config-reload
// hook. cinatra/dev does NOT set a statusLine (GSD owns it).
function reloadHookPath(layout) {
  return path.join(layout.hooksDir, `${NAMESPACE}-config-reload.js`);
}

function buildSettingsBlock(layout) {
  const reload = reloadHookPath(layout);
  return {
    hooks: {
      FileChanged: [
        {
          matcher: ".cinatra-dev/config.json",
          hooks: [{ type: "command", command: `node "${reload}"` }],
        },
      ],
    },
  };
}

// The hook scripts the settings block references. Staged on disk so no merged
// hook entry dangles (codex finding 4). The W0 config-reload hook is a minimal,
// safe no-op stub (exit 0); the real hot-reload logic lands with the config wave.
function hookScripts(layout) {
  const reload = reloadHookPath(layout);
  return {
    [reload]:
      "#!/usr/bin/env node\n" +
      "// cinatra-dev config-reload hook (FileChanged on .cinatra-dev/config.json).\n" +
      "// W0 stub: a safe no-op so the merged hook entry never dangles. The real\n" +
      "// hot-reload (re-read + re-validate the project config) lands in the\n" +
      "// configuration wave. Exits 0 so it never blocks a tool call.\n" +
      "process.exit(0);\n",
  };
}

// entrypoint
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = run(process.argv.slice(2));
  if (result.refused) {
    console.error(`[install] REFUSED: ${result.reason}`);
    process.exit(3);
  }
  if (result.refusedWrite) {
    console.error(`[install] REFUSED (containment): ${result.reason}`);
    process.exit(4);
  }
  if (result.skipped) {
    console.warn(`[install] skip-with-notice: ${result.reason}`);
    process.exit(0);
  }
  if (result.dryRun) {
    console.log(`[install] DRY RUN — would stage:`);
    console.log(JSON.stringify(result.plan, null, 2));
    process.exit(0);
  }
  if (result.ok) {
    console.log(`[install] OK — staged ${result.stagedSkillCount} skill(s), ${result.stagedAgentCount} agent(s) into ${result.plan.payloadDir}`);
    process.exit(0);
  }
  console.error(`[install] FAILED: ${result.reason || "unknown"}`);
  process.exit(1);
}

export { run, parseArgs, buildSettingsBlock };
