"use strict";
// ---------------------------------------------------------------------------
// shadcn-install — install the OFFICIAL upstream shadcn skill for BOTH Claude
// (~/.claude/skills/shadcn) AND Codex ($CODEX_HOME/skills/shadcn). The one
// source the source-integration issue (G3 #191) names for both tools.
//
// This does NOT vendor a frozen copy of the skill content. It materializes the
// PINNED upstream bundle (via an injectable source provider — the real provider
// runs `pnpm dlx skills add shadcn/ui`; the test provider materializes an
// offline fixture so CI has no network), verifies the bundle against the pinned
// manifest's expected file list, then installs the SAME tree into BOTH tool
// skill dirs with W0-style ownership/idempotency:
//   - install via a temp dir + atomic replace;
//   - write an ownership sidecar (the pin + a content hash);
//   - a FOREIGN existing shadcn dir (no sidecar / different owner) is REFUSED
//     unless { force:true } — never silently clobber a user's / another tool's
//     skill dir;
//   - re-running with the same pin is idempotent (same final state; it
//     re-materializes + atomically re-installs rather than being a literal no-op);
//   - the two destinations are verified IDENTICAL (same file list + same hash).
//
// SAFETY: install targets a HOME / CODEX_HOME the CALLER chooses. The deterministic
// CLI path (dev-tools shadcn-install) and the tests both target a sandbox HOME /
// sandbox CODEX_HOME — never the real ~/.claude or ~/.codex. The Claude leg reuses
// the W0 containment guards (which independently refuse the live ~/.claude); the
// Codex leg refuses the real ~/.codex unless { force:true } is set.
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const containment = require("./containment.cjs");
const { claudeConfigDir, codexSkillsDir } = require("./runtime-artifact-layout.cjs");
const { NAMESPACE } = require("../package-identity.cjs");

const OWNER = `${NAMESPACE}-source`; // the ownership marker value in the sidecar

// The PROTECTED live Codex home — the one the real-home guard must never write to
// without --force. Anchored to the REAL user home (os.userInfo().homedir), NOT
// os.homedir() (which follows $HOME and is therefore spoofable by a sandbox HOME).
// Mirrors W0 containment.liveClaudeDir() exactly so the Codex leg has the same
// "can't be tricked by a sandbox HOME into thinking the real home is the sandbox"
// guarantee the Claude leg gets from W0 containment.
function liveCodexHome() {
  let realHome;
  try { realHome = os.userInfo().homedir; } catch { realHome = os.homedir(); }
  return path.join(realHome, ".codex");
}

// Load the pinned source manifest (payload/shared/shadcn-source.manifest.json).
// Resolution mirrors dev-tools.cjs: prefer the staged payload, fall back to the
// in-repo payload when run from source.
function manifestPath() {
  const staged = path.join(os.homedir(), ".claude", `${NAMESPACE}-core`, "shared", "shadcn-source.manifest.json");
  if (fs.existsSync(staged)) return staged;
  return path.join(__dirname, "..", "..", "payload", "shared", "shadcn-source.manifest.json");
}

function loadManifest(p = manifestPath()) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ---- bundle helpers -------------------------------------------------------

// Recursively list a bundle dir's files as posix-relative paths (sorted).
function listBundleFiles(root) {
  const out = [];
  (function walk(dir, rel) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push(r);
    }
  })(root, "");
  return out.sort();
}

// A deterministic content hash over the whole bundle (path + bytes), so two
// destinations can be proven identical and a drifted re-install is detectable.
function hashBundle(root) {
  const h = crypto.createHash("sha256");
  for (const rel of listBundleFiles(root)) {
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

// Verify a materialized bundle against the manifest. Proves "SKILL.md + all
// referenced relative files intact": every REQUIRED file AND every EXPECTED file
// (the known bundle shape) must be present. Upstream may ADD files (extras are
// tolerated), but a MISSING required-or-expected file fails closed — so a partial
// or wrong upstream fetch can never be installed as if complete.
function verifyBundle(root, manifest) {
  const present = new Set(listBundleFiles(root));
  const required = manifest.bundle.required || [];
  const expected = manifest.bundle.expected || [];
  const missingRequired = required.filter((f) => !present.has(f));
  if (missingRequired.length) {
    throw Object.assign(
      new Error(`shadcn bundle is missing required file(s): ${missingRequired.join(", ")}`),
      { code: "SHADCN_BUNDLE_INCOMPLETE", missing: missingRequired }
    );
  }
  // the expected set must ALSO be fully present (SKILL.md + its referenced files).
  const missingExpected = expected.filter((f) => !present.has(f));
  if (missingExpected.length) {
    throw Object.assign(
      new Error(
        `shadcn bundle is missing expected file(s) (SKILL.md + referenced relative files): ${missingExpected.join(", ")}`
      ),
      { code: "SHADCN_BUNDLE_INCOMPLETE", missing: missingExpected }
    );
  }
  return { files: [...present].sort(), hash: hashBundle(root) };
}

// ---- source providers -----------------------------------------------------

// The default (real) source provider: run the pinned upstream install command to
// materialize the bundle into `destBundleDir`. The `skills` CLI installs into a
// skills dir; we point it at a temp skills root and pick up `<root>/shadcn`.
// Network-dependent — never invoked in CI (tests inject an offline provider).
//
// Returns `{ resolvedRef }` — the IMMUTABLE upstream ref this install actually
// resolved, so the recorded pin in the destination sidecar is TRUTHFUL (never the
// manifest's `UNPINNED` placeholder). Resolution order: (a) the resolved commit
// the upstream source repo is at right now (`git ls-remote <repo> HEAD`); else
// (b) a truthful `resolved-latest@<ISO-date>` marker (we DID take latest at this
// time) — never the literal "UNPINNED" in production.
function realSourceProvider({ manifest, destBundleDir }) {
  // Drive the documented `skills` CLI (vercel-labs/skills) NONINTERACTIVELY into a
  // temp PROJECT dir (cwd = temp, NO -g so it does NOT touch the real ~/.claude or
  // ~/.codex), then copy the materialized bundle into our controlled stage. The
  // CLI installs a project agent's skills under a documented agent subpath
  // (codex → `.agents/skills/<skill>`); we read that subpath and re-install it via
  // our own atomic/ownership-guarded path into the caller's chosen sandbox dirs.
  // Per the CLI options: --agent codex, --copy (real files, not symlinks), --yes.
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), `${NAMESPACE}-shadcn-src-`));
  try {
    // installCommand = "pnpm dlx skills add shadcn/ui" → runner+CLI = "pnpm dlx
    // skills"; replace the trailing "add <slug>" with the explicit noninteractive
    // cliFetchArgs from the manifest (add shadcn/ui --agent codex --copy --yes).
    const cmdParts = manifest.upstream.installCommand.split(/\s+/);
    const runner = cmdParts[0];                          // e.g. "pnpm"
    const runnerArgs = cmdParts.slice(1, 3);             // e.g. ["dlx", "skills"]
    const fetchArgs = manifest.upstream.cliFetchArgs;    // ["add","shadcn/ui","--agent","codex","--copy","--yes"]
    execFileSync(runner, [...runnerArgs, ...fetchArgs], {
      cwd: tmpProject,        // project mode: writes under <tmpProject>/<subpath>, never the real homes
      env: { ...process.env, CI: "1" }, // CI=1 nudges noninteractive even if a prompt slips through
      stdio: "pipe",
      timeout: 120000,
    });
    const produced = path.join(tmpProject, manifest.upstream.cliBundleSubpath); // <tmp>/.agents/skills/shadcn
    if (!fs.existsSync(produced)) {
      throw Object.assign(
        new Error(
          `upstream install did not produce the shadcn bundle at ${manifest.upstream.cliBundleSubpath} ` +
          `under ${tmpProject} (see ${manifest.upstream.skillsCliOptions})`
        ),
        { code: "SHADCN_UPSTREAM_EMPTY" }
      );
    }
    copyTree(produced, destBundleDir);
    return { resolvedRef: resolveUpstreamRef(manifest) };
  } finally {
    fs.rmSync(tmpProject, { recursive: true, force: true });
  }
}

// Resolve the immutable upstream ref for the recorded pin. Best-effort: the live
// commit of the source repo, else a truthful resolved-latest marker. NEVER returns
// the literal "UNPINNED" so the production sidecar always carries a meaningful pin.
function resolveUpstreamRef(manifest) {
  const repo = manifest.upstream.sourceRepo; // e.g. "shadcn-ui/ui"
  try {
    const out = execFileSync(
      "git",
      ["ls-remote", `https://github.com/${repo}.git`, "HEAD"],
      { stdio: ["ignore", "pipe", "ignore"], timeout: 30000 }
    ).toString();
    const sha = out.split(/\s+/)[0];
    if (sha && /^[0-9a-f]{40}$/i.test(sha)) return `${repo}@${sha}`;
  } catch { /* fall through to the dated marker */ }
  return `${repo}@resolved-latest:${new Date().toISOString().slice(0, 10)}`;
}

// Plain recursive copy (source is trusted upstream content in a temp dir).
function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

// ---- ownership / destination safety ---------------------------------------

function sidecarName(manifest) {
  return (manifest.install && manifest.install.ownershipSidecar) || ".cinatra-dev-source.json";
}

// Decide whether we may write `destDir`:
//   - absent           → OK (fresh install)
//   - ours (sidecar)   → OK (idempotent re-install / refresh)
//   - foreign          → REFUSE unless force
function inspectDestination(destDir, manifest) {
  if (!fs.existsSync(destDir)) return { state: "absent" };
  const sc = path.join(destDir, sidecarName(manifest));
  if (fs.existsSync(sc)) {
    try {
      const meta = JSON.parse(fs.readFileSync(sc, "utf8"));
      if (meta && meta.owner === OWNER) return { state: "ours", meta };
    } catch { /* fall through to foreign */ }
  }
  return { state: "foreign" };
}

// ---- per-leg safety assertions (BEFORE any write) -------------------------
//
// Both legs assert safety FIRST — no parent mkdir, no temp stage, no remove
// happens until the destination path is proven safe (W0 "refuse before write").
//
// Claude leg: delegate to the W0 containment (logical containment + no symlink
// component below ~/.claude + the live-~/.claude refusal + inode/dir-alias arms).
function assertClaudeSafe(destDir, claudeDir) {
  containment.assertContained(destDir, claudeDir, "path");
}

// Codex leg: the W0 containment is ~/.claude-specific, so guard the Codex
// destination with the SAME structural checks scoped to the Codex skills root:
//   (1) the real Codex skills root must not resolve into the real ~/.codex
//       (a symlinked --codex-home can't redirect a sandbox write into live ~/.codex);
//   (2) no symlink component on the path from the (real) skills root down to the
//       destination (a `skills` symlink or a `shadcn` symlink can't redirect the
//       write/delete outside the chosen tree).
function assertCodexSafe(destDir, codexSkillsRoot, { force, codexHome }) {
  // (1) refuse a root that RESOLVES into the real ~/.codex unless forced (catches
  // a --codex-home symlink that points at ~/.codex, AND a `skills` symlink under a
  // sandbox home that lands back in ~/.codex).
  const realRoot = containment.realResolve(codexSkillsRoot);
  const realCodexHome = containment.realResolve(liveCodexHome());
  if (!force && (containment.contains(realCodexHome, realRoot) || realRoot === realCodexHome)) {
    throw Object.assign(
      new Error(
        `refusing Codex install: ${codexSkillsRoot} resolves inside the real Codex home (${realCodexHome}); ` +
        `pass force:true (or --force), or set --codex-home to a sandbox dir.`
      ),
      { code: "SHADCN_REAL_CODEX_HOME" }
    );
  }
  // (2) NO SYMLINK COMPONENT on the ORIGINAL (un-resolved) path from the Codex
  // HOME (the caller-supplied anchor) down to the destination. The anchor is the
  // codexHome itself — NOT `<codexHome>/skills` — so a symlinked `--codex-home`
  // (the home dir itself being a symlink to an arbitrary outside dir) is caught
  // too, not just a symlinked `skills` / `shadcn` below it. Any symlink here would
  // be silently FOLLOWED by realResolve / mkdirSync(recursive), redirecting the
  // write/delete outside the chosen tree — so we fail closed before any write.
  const anchor = path.resolve(codexHome || path.dirname(codexSkillsRoot));
  const target = path.resolve(destDir);
  const rel = path.relative(anchor, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw Object.assign(
      new Error(`refusing Codex install: ${destDir} is not contained within the Codex home ${anchor}.`),
      { code: "SHADCN_CODEX_ESCAPE" }
    );
  }
  // walk the anchor itself + every component down to the target.
  const checkChain = [anchor];
  let cur = anchor;
  for (const seg of rel.split(path.sep).filter((s) => s && s !== ".")) {
    cur = path.join(cur, seg);
    checkChain.push(cur);
  }
  for (const p of checkChain) {
    let st;
    try { st = fs.lstatSync(p); } catch { continue; } // a fresh (not-yet-created) component is fine
    if (st.isSymbolicLink()) {
      throw Object.assign(
        new Error(`refusing Codex install: symlinked path component ${p} could redirect the write outside ${anchor}.`),
        { code: "SHADCN_CODEX_SYMLINK" }
      );
    }
  }
}

// ---- install a verified bundle into ONE destination -----------------------
//
// Safety (the caller-supplied `assertSafe` for this leg) is asserted FIRST,
// before ANY filesystem mutation. `removeGuarded` is the leg's safe-remove
// (W0 guardedRemove for Claude; the post-assert plain rm for Codex, which has
// already been proven symlink-free above).
function installBundleInto({ srcBundleDir, destDir, manifest, sidecarMeta, assertSafe, removeExisting, priorState }) {
  // (1) REFUSE BEFORE WRITE — assert the destination path is safe first.
  assertSafe(destDir);

  // (2) only now touch the filesystem: stage into a sibling temp, atomic-rename.
  const parent = path.dirname(destDir);
  fs.mkdirSync(parent, { recursive: true });
  const tmpDest = path.join(parent, `.shadcn.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  try {
    copyTree(srcBundleDir, tmpDest);
    fs.writeFileSync(
      path.join(tmpDest, sidecarName(manifest)),
      JSON.stringify(sidecarMeta, null, 2) + "\n"
    );
    // remove an existing (ours/absent — foreign already refused by the caller)
    // destination via the leg's guarded remove, then rename the staged tree in.
    if (fs.existsSync(destDir)) removeExisting(destDir);
    fs.renameSync(tmpDest, destDir);
  } finally {
    if (fs.existsSync(tmpDest)) {
      try { fs.rmSync(tmpDest, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  }
  return { state: priorState, dir: destDir };
}

// Is `dir` the real (non-sandbox) Codex home? Refuse it unless forced. Resolves
// realpaths so a symlinked --codex-home pointing AT ~/.codex is also caught.
// Anchored to the REAL user home (liveCodexHome → os.userInfo().homedir), so a
// sandbox $HOME cannot spoof the protected home into looking like the sandbox.
function isRealCodexHome(codexHome) {
  const realDefault = containment.realResolve(liveCodexHome());
  return containment.realResolve(codexHome) === realDefault;
}

// ---- the public entrypoint -------------------------------------------------
//
//   installShadcnForBothTools({
//     home,            // the HOME whose ~/.claude/skills/shadcn we write
//     codexHome,       // $CODEX_HOME (default ~/.codex); we write <codexHome>/skills/shadcn
//     force,           // overwrite a foreign existing shadcn dir / allow real ~/.codex
//     manifest,        // loaded pin manifest (default: the staged/in-repo one)
//     sourceProvider,  // ({manifest,destBundleDir}) => void  (default: realSourceProvider)
//     env,             // env for codexSkillsDir resolution (default: process.env)
//   })
//
// Returns a summary: { hash, files, claude:{...}, codex:{...}, identical:true }.
function installShadcnForBothTools(opts = {}) {
  const manifest = opts.manifest || loadManifest();
  const sourceProvider = opts.sourceProvider || realSourceProvider;
  const force = Boolean(opts.force);
  const env = opts.env || process.env;

  if (!opts.home) throw new Error("installShadcnForBothTools: home is required");
  const home = path.resolve(opts.home);

  // Codex home: explicit option wins, else env CODEX_HOME, else ~/.codex.
  const codexHome = opts.codexHome
    ? path.resolve(opts.codexHome)
    : (env.CODEX_HOME ? path.resolve(env.CODEX_HOME) : path.join(os.homedir(), ".codex"));

  // Real-home safety: refuse the real ~/.codex unless forced (the Claude leg is
  // independently guarded by W0 containment against the live ~/.claude).
  if (isRealCodexHome(codexHome) && !force) {
    throw Object.assign(
      new Error(
        `refusing to install into the real Codex home (${codexHome}); pass force:true (or --force) to target it, ` +
        `or set CODEX_HOME / --codex-home to a sandbox dir.`
      ),
      { code: "SHADCN_REAL_CODEX_HOME" }
    );
  }

  const claudeDir = claudeConfigDir(home);                 // <home>/.claude
  const claudeDest = path.join(claudeDir, "skills", manifest.install.claudeSkillDirName);
  const codexSkillsRoot = codexSkillsDir({ ...env, CODEX_HOME: codexHome });
  const codexDest = path.join(codexSkillsRoot, manifest.install.codexSkillDirName);

  // Per-leg safety closures (asserted INSIDE installBundleInto, BEFORE any write).
  const claudeAssert = (dest) => assertClaudeSafe(dest, claudeDir);
  const codexAssert = (dest) => assertCodexSafe(dest, codexSkillsRoot, { force, codexHome });
  const claudeRemove = (dest) => containment.guardedRemove(dest, claudeDir, { recursive: true });
  // Codex remove is plain rm — but only AFTER assertCodexSafe proved the path has
  // no symlink component, so it cannot unlink through an alias.
  const codexRemove = (dest) => fs.rmSync(dest, { recursive: true, force: true });

  // 1. FAIL CLOSED BEFORE ANY WRITE OR NETWORK: assert each leg's destination is
  //    safe, and refuse a FOREIGN existing dir — all before the (network) provider
  //    runs and before either destination is touched (codex nit 1+3, blocker 1+2).
  for (const leg of [
    { label: "claude", dest: claudeDest, assert: claudeAssert },
    { label: "codex", dest: codexDest, assert: codexAssert },
  ]) {
    leg.assert(leg.dest); // refuse-before-write: containment / alias / symlink guards
    const insp = inspectDestination(leg.dest, manifest);
    if (insp.state === "foreign" && !force) {
      throw Object.assign(
        new Error(
          `refusing to overwrite a foreign existing shadcn skill dir for ${leg.label}: ${leg.dest} ` +
          `(no ${OWNER} ownership sidecar). Pass force:true (or --force) to replace it.`
        ),
        { code: "SHADCN_FOREIGN_DEST", label: leg.label, dir: leg.dest }
      );
    }
  }
  const claudePrior = inspectDestination(claudeDest, manifest).state;
  const codexPrior = inspectDestination(codexDest, manifest).state;

  // 2. Materialize the pinned upstream bundle ONCE into a temp dir, resolve the
  //    real pin it produced, and verify the bundle against the manifest.
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), `${NAMESPACE}-shadcn-bundle-`));
  try {
    const provided = sourceProvider({ manifest, destBundleDir: stage }) || {};
    // The provider reports the IMMUTABLE ref it actually resolved (the real
    // provider records the live upstream commit; the offline fixture reports its
    // own ref). This makes the recorded sidecar pin TRUTHFUL. A provider that
    // reports nothing falls back to a dated resolved-at marker — NEVER the
    // manifest's "UNPINNED" placeholder (which only means "resolve latest").
    const resolvedRef = provided.resolvedRef
      || `${manifest.upstream.sourceRepo}@resolved-at:${new Date().toISOString().slice(0, 10)}`;
    const verified = verifyBundle(stage, manifest);

    const sidecarMeta = {
      owner: OWNER,
      skill: "shadcn",
      source: {
        sourceRepo: manifest.upstream.sourceRepo,
        registrySlug: manifest.upstream.registrySlug,
        installCommand: manifest.upstream.installCommand,
        upstreamDocs: manifest.upstream.upstreamDocs,
        pinnedRef: resolvedRef,
        lastVerified: manifest.upstream.lastVerified,
      },
      bundleHash: verified.hash,
      files: verified.files,
      installedAt: new Date().toISOString(),
    };

    // 3. Install the SAME verified bundle into BOTH destinations (safety is
    //    re-asserted inside installBundleInto right before each write).
    const claudeRes = installBundleInto({
      srcBundleDir: stage, destDir: claudeDest, manifest, sidecarMeta,
      assertSafe: claudeAssert, removeExisting: claudeRemove, priorState: claudePrior,
    });
    const codexRes = installBundleInto({
      srcBundleDir: stage, destDir: codexDest, manifest, sidecarMeta,
      assertSafe: codexAssert, removeExisting: codexRemove, priorState: codexPrior,
    });

    // 4. Verify the two installed trees are IDENTICAL (excluding the sidecar,
    //    which is byte-identical anyway). Compare content hashes of the bundle
    //    files only (sidecar carries a timestamp; exclude it from the equality).
    const claudeHash = hashBundleExcludingSidecar(claudeDest, manifest);
    const codexHash = hashBundleExcludingSidecar(codexDest, manifest);
    const identical = claudeHash === codexHash && claudeHash === verified.hash;
    if (!identical) {
      throw Object.assign(
        new Error("shadcn install verification failed: the Claude and Codex trees are not identical"),
        { code: "SHADCN_DEST_MISMATCH", claudeHash, codexHash, expected: verified.hash }
      );
    }

    return {
      hash: verified.hash,
      files: verified.files,
      claude: { dir: claudeDest, state: claudeRes.state },
      codex: { dir: codexDest, state: codexRes.state },
      identical,
      pinnedRef: resolvedRef,
      lastVerified: manifest.upstream.lastVerified,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

// Hash an installed destination's bundle files, EXCLUDING the ownership sidecar
// (so the equality check ignores the per-install timestamp).
function hashBundleExcludingSidecar(destDir, manifest) {
  const sc = sidecarName(manifest);
  const h = crypto.createHash("sha256");
  for (const rel of listBundleFiles(destDir)) {
    if (rel === sc) continue;
    h.update(rel);
    h.update("\0");
    h.update(fs.readFileSync(path.join(destDir, rel)));
    h.update("\0");
  }
  return h.digest("hex");
}

module.exports = {
  installShadcnForBothTools,
  loadManifest,
  manifestPath,
  verifyBundle,
  hashBundle,
  listBundleFiles,
  inspectDestination,
  realSourceProvider,
  OWNER,
};
