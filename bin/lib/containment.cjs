"use strict";
// ---------------------------------------------------------------------------
// containment — the per-write/per-delete safety guard (W0 blockers B1/B2).
//
// The HOME preflight (preflight.cjs) decides whether the TARGET Claude dir is
// allowed at all. This module is the SECOND, always-on layer: for EVERY
// concrete path the installer writes or the uninstaller deletes, it proves the
// real on-disk location is CONTAINED within that target Claude dir and that NO
// path component below the target is a symlink that escapes it (or points at the
// machine's live ~/.claude).
//
// Why a separate layer (codex round-3): the preflight canonicalizes only the
// HOME ancestor. A perfectly legitimate sandbox HOME can still hold a CHILD
// symlink below ~/.claude — e.g. a sandbox ~/.claude/settings.json symlinked to
// the real config, or ~/.claude/skills symlinked to a decoy dir — and a naive
// writeFileSync/mkdirSync/rmSync FOLLOWS that link and writes/deletes the real
// target (blocker B1). realpath-of-the-deepest-existing-ancestor alone misses a
// DANGLING symlink leaf (settings.json -> /outside/parent/not-yet-existing):
// realpath of the leaf throws, the walk backs up to a contained ancestor, and
// the write still follows the link. So we additionally LSTAT every component
// below the target and FAIL CLOSED on any symlink component.
//
// This guard takes NO override — it is unconditional. The deliberate
// "--i-understand-this-writes-my-real-claude-dir" escape hatch only relaxes the
// preflight HOME/subtree decision; it never licenses following a child symlink
// out of the chosen target.
//
// INODE ALIASING (Verify2 HARDLINK write-through). lstat-symlink rejection only
// catches the SYMLINK shape. A second on-disk NAME for a live-config file — a
// HARDLINK — shares the SAME inode but is NOT a symlink, so lstat().isSymbolic-
// Link() is false and the old guard let it through; a plain writeFileSync /
// copyFileSync then TRUNCATED the shared inode, writing through onto the live
// config. (A bind-mount or any other "second pathname to the same inode" variant
// is the same class.) Two structural defenses close the whole class here:
//
//   1. ATOMIC WRITE/COPY (the primary, structural fix). Every file write is done
//      to a FRESH temp file created with O_CREAT|O_EXCL inside the guarded target
//      dir, then fs.renameSync(tmp, dest). rename() swaps the directory ENTRY and
//      NEVER truncates the inode the old name pointed to — so a hardlinked or
//      symlinked destination is left byte-for-byte intact (its OTHER link still
//      names the original, now-detached inode). This makes "the destination is a
//      second name for a live file" a no-op against the live file by construction,
//      independent of how that aliasing was set up.
//
//   2. FAIL-CLOSED INODE PROBE (defense in depth). Before writing OR deleting any
//      path, if a resolved EXISTING regular-file destination has st_nlink > 1
//      (it is hardlinked somewhere) OR its (st_dev, st_ino) matches ANY probed
//      live ~/.claude file (settings.json + the skills/agents/hooks dirs), FAIL
//      CLOSED. Deletes additionally refuse to unlink any entry whose (dev,ino) is
//      a live-config inode. This catches the aliasing explicitly and refuses,
//      rather than silently relying on rename() semantics alone.
// ---------------------------------------------------------------------------

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");

// realpath the NEAREST EXISTING ancestor of `p` and re-append the missing tail.
// Mirrors preflight.normalize so the two layers canonicalize identically. A
// non-ENOENT error on the existing prefix (EACCES/ELOOP/…) is FATAL — we must
// not guess a path we cannot stat.
function realResolve(p) {
  const abs = path.resolve(p);
  let prefix = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(prefix);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch (e) {
      if (e && e.code && e.code !== "ENOENT" && e.code !== "ENOTDIR") {
        // a real, non-missing error resolving the prefix: fail closed.
        throw Object.assign(
          new Error(`cannot resolve real path of ${prefix} (${e.code}); refusing to proceed`),
          { code: "CONTAINMENT_RESOLVE_ERROR", cause: e }
        );
      }
      const parent = path.dirname(prefix);
      if (parent === prefix) return abs; // reached root, nothing existed
      tail.push(path.basename(prefix));
      prefix = parent;
    }
  }
}

// The machine's live ~/.claude (passwd home, NOT $HOME — see preflight). Kept
// here too so containment is self-sufficient and can independently reject a
// resolved leaf that lands in the live dir.
function liveClaudeDir() {
  let realHome;
  try {
    realHome = os.userInfo().homedir;
  } catch {
    realHome = os.homedir();
  }
  return path.join(realHome, ".claude");
}

// true iff `child` is `parent` or strictly inside it (both must already be
// canonical/absolute). The empty relative means child === parent (contained).
function contains(parent, child) {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Walk every path component from `root` (exclusive) down to `target` and FAIL
// CLOSED if any EXISTING component is a symlink. `root` must be a canonical,
// existing dir (the resolved target Claude dir). Stops at the first
// non-existing component (the rest is a fresh tail we are about to create).
function assertNoSymlinkComponentBelow(root, target) {
  const rel = path.relative(root, target);
  if (rel === "") return; // target IS the root
  const segs = rel.split(path.sep).filter((s) => s.length && s !== ".");
  let cur = root;
  for (const seg of segs) {
    cur = path.join(cur, seg);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e && e.code === "ENOENT") return; // this + deeper don't exist yet — safe tail
      // any other lstat failure (EACCES/ELOOP/ENOTDIR/…) — fail closed
      throw Object.assign(
        new Error(`cannot lstat ${cur} (${e.code}); refusing to write/delete through it`),
        { code: "CONTAINMENT_LSTAT_ERROR", cause: e }
      );
    }
    if (st.isSymbolicLink()) {
      throw Object.assign(
        new Error(
          `refusing to operate through a symlink: ${cur} is a symlink below the target Claude dir ` +
          `(${root}). A symlinked component can write/delete OUTSIDE the sandbox (the live ~/.claude). ` +
          `Remove the symlink, or use a real (non-symlinked) sandbox tree.`
        ),
        { code: "CONTAINMENT_SYMLINK" }
      );
    }
  }
}

// The set of (dev,ino) identities of the machine's LIVE ~/.claude config files
// we must never write/delete THROUGH a second name (hardlink/bind-mount/…). We
// probe the live settings.json plus the skills/agents/hooks dirs read-only; a
// hardlink to ANY of these shares its inode. Computed lazily and memoized (the
// live tree does not change within a single install/uninstall run).
let _liveInodeCache = null;
function liveConfigInodes() {
  if (_liveInodeCache) return _liveInodeCache;
  const set = new Set();
  const live = liveClaudeDir();
  const probes = [
    path.join(live, "settings.json"),
    path.join(live, "skills"),
    path.join(live, "agents"),
    path.join(live, "hooks"),
    live,
  ];
  for (const p of probes) {
    try {
      const st = fs.statSync(p); // follow links: we want the REAL live inode
      set.add(`${st.dev}:${st.ino}`);
    } catch {
      /* a live file that doesn't exist contributes no inode — fine */
    }
  }
  _liveInodeCache = set;
  return set;
}

// FAIL CLOSED if a sandbox DIRECTORY `dirPath` (already lexically contained under
// `claudeDir`, symlink-free) is an ALIAS — bind-mount or other same-inode device
// — of the corresponding LIVE ~/.claude directory. We map dirPath's claudeDir-
// relative subpath onto liveClaudeDir and stat THAT single live path; if the two
// resolve to the same (dev,ino) the sandbox dir IS the live dir and any write/
// delete into it would hit the real config. This is bounded (one extra stat per
// dir) and COMPLETE for the realistic same-relative bind-mount case at ANY depth
// (sandbox .claude/skills[/dev-x] ↔ live .claude/skills[/dev-x]). It cannot
// detect a deliberately CROSS-relative bind (sandbox .claude/tmp/x mounted onto
// live .claude/skills/dev-x) — that is undetectable with bounded stat-only checks
// and an absurd self-inflicted setup; the symlink + leaf-inode + nlink arms still
// cover the file-level cases. `dirSt` is dirPath's lstat (a real directory).
function assertNotLiveDirAlias(dirPath, claudeDir, dirSt, kind = "dir", liveRoot = liveClaudeDir()) {
  let rel;
  try {
    rel = path.relative(path.resolve(claudeDir), path.resolve(dirPath));
  } catch {
    return;
  }
  if (rel.startsWith("..") || path.isAbsolute(rel)) return; // not under claudeDir — other arms own it
  const liveCandidate = rel === "" ? liveRoot : path.join(liveRoot, rel);
  let liveSt;
  try {
    liveSt = fs.statSync(liveCandidate); // follow links: the REAL live dir inode
  } catch {
    return; // no corresponding live dir (the common case) — nothing to alias
  }
  if (liveSt.dev === dirSt.dev && liveSt.ino === dirSt.ino) {
    throw Object.assign(
      new Error(
        `refusing to write/delete ${kind}: ${dirPath} resolves to the SAME (dev:ino ${dirSt.dev}:${dirSt.ino}) as the ` +
        `live ~/.claude path ${liveCandidate} (bind-mount/alias). Operating here would hit the real config. ` +
        `Use a real, unaliased sandbox tree.`
      ),
      { code: "CONTAINMENT_INODE_ALIAS" }
    );
  }
}

// FAIL CLOSED on inode aliasing for a concrete `targetPath` (already proven
// lexically contained + symlink-free). If the destination EXISTS as a regular
// file and either (a) shares a (dev,ino) with a probed live-config file, or
// (b) has st_nlink > 1 (it is hardlinked elsewhere — a second name could be the
// live file), refuse. This is the explicit defense-in-depth arm; the atomic
// write/copy below is the structural one. Non-existing destinations are safe
// (nothing to alias). A directory destination is not checked here (we write
// FILES atomically; dirs are created fresh by mkdir).
function assertNoInodeAliasing(targetPath, kind = "path") {
  let st;
  try {
    st = fs.lstatSync(targetPath);
  } catch (e) {
    if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return; // nothing there
    throw Object.assign(
      new Error(`cannot lstat ${targetPath} (${e.code}); refusing to write/delete it`),
      { code: "CONTAINMENT_LSTAT_ERROR", cause: e }
    );
  }
  if (st.isSymbolicLink()) return; // the symlink arm (check 2) owns this case
  if (!st.isFile()) return; // dirs/fifos/etc — file-aliasing N/A
  const id = `${st.dev}:${st.ino}`;
  if (liveConfigInodes().has(id)) {
    throw Object.assign(
      new Error(
        `refusing to write/delete ${kind}: ${targetPath} is a second name (dev:ino ${id}) for a LIVE ~/.claude ` +
        `config file. Writing/deleting through it would corrupt the real config. Use a real, unaliased sandbox tree.`
      ),
      { code: "CONTAINMENT_INODE_ALIAS" }
    );
  }
  if (st.nlink > 1) {
    throw Object.assign(
      new Error(
        `refusing to write/delete ${kind}: ${targetPath} has st_nlink=${st.nlink} (it is hardlinked elsewhere). ` +
        `A second name could be the live config; refusing to risk a write/delete-through. Use an unaliased sandbox tree.`
      ),
      { code: "CONTAINMENT_HARDLINK" }
    );
  }
}

// THE guard. For a concrete write/delete `targetPath` that must stay inside the
// `claudeDir`, prove containment FIVE ways and throw CONTAINMENT_* on any
// violation:
//   1. the LOGICAL (lexically-normalized) target is inside the target dir,
//   2. no EXISTING path component below the target dir is a symlink (so a write
//      cannot follow a link out — catches dangling-leaf symlinks too),
//   3. the resolved real location is NOT inside the machine's live ~/.claude
//      (defense in depth, even if claudeDir itself were mis-resolved),
//   4. the existing destination is not a second NAME (hardlink / live-inode) for
//      a live-config file (the leaf inode-aliasing arm; Verify2 hardlink class),
//   5. no EXISTING ancestor directory (or a leaf dir) is a same-relative alias
//      (bind-mount) of the corresponding live ~/.claude dir (the dir-alias arm).
//
// `claudeDir` is the layout.configDir (~/.claude under the chosen HOME).
function assertContained(targetPath, claudeDir, kind = "path") {
  if (!targetPath || !claudeDir) {
    throw Object.assign(new Error("assertContained: targetPath and claudeDir are required"), {
      code: "CONTAINMENT_ARGS",
    });
  }
  // Canonicalize the target Claude dir (resolves any symlink in the HOME
  // ANCESTOR, e.g. the macOS /var -> /private/var tmpdir link, AND the
  // sandbox-HOME-points-at-real-home case).
  const realClaude = realResolve(claudeDir);

  // Express the target UNDER the canonical Claude dir WITHOUT resolving any
  // symlink BELOW claudeDir: take the lexical sub-path from the (un-resolved)
  // claudeDir to the (un-resolved) target — both are in the same namespace as
  // passed by the caller — and re-root it under realClaude. This keeps below-
  // claudeDir symlink components UNRESOLVED so check (2) can still catch them,
  // while putting both sides in one namespace so the OS-tmpdir ancestor link
  // does not produce a false escape.
  const relUnder = path.relative(path.resolve(claudeDir), path.resolve(targetPath));
  const canonicalTarget = path.join(realClaude, relUnder);

  // (1) logical containment: the target must be the dir or under it (rejects a
  // `..`-escaping or absolute relUnder, e.g. a tampered `skills/..` chain that
  // climbs ABOVE the Claude dir).
  if (!contains(realClaude, canonicalTarget)) {
    throw Object.assign(
      new Error(
        `refusing to write/delete ${kind} outside the target Claude dir: ${path.resolve(targetPath)} is not ` +
        `contained within ${realClaude}.`
      ),
      { code: "CONTAINMENT_ESCAPE" }
    );
  }

  // (2) no symlinked component below the target dir (the B1 core): walk the
  // real on-disk path under realClaude and fail closed on any symlink hop.
  assertNoSymlinkComponentBelow(realClaude, canonicalTarget);

  // (3) the fully-resolved real leaf must not land in the live ~/.claude
  // (defense in depth, even if realClaude itself were somehow mis-resolved).
  const realLeaf = realResolve(canonicalTarget);
  const live = realResolve(liveClaudeDir());
  if (contains(live, realLeaf)) {
    throw Object.assign(
      new Error(
        `refusing to write/delete ${kind}: resolved path ${realLeaf} lands inside the live ~/.claude (${live}).`
      ),
      { code: "CONTAINMENT_LIVE" }
    );
  }

  // (4) inode-aliasing arm (Verify2 hardlink class): if the destination already
  // exists as a regular file that is a second name for a live-config inode, or
  // is hardlinked elsewhere, FAIL CLOSED. Check the destination as the caller
  // named it (canonicalTarget is the same on-disk file via realClaude). A symlink
  // destination is already handled by check (2)'s component walk.
  assertNoInodeAliasing(canonicalTarget, kind);

  // (5) directory-alias arm (bind-mount of a live dir): every EXISTING ancestor
  // directory of the target — from realClaude down to the deepest existing one —
  // must not be a same-relative alias of the corresponding live ~/.claude dir.
  // This closes the bind-mounted-directory write/delete-through that no path
  // component being a symlink would reveal. Bounded: one stat per existing
  // ancestor dir.
  assertNoLiveDirAliasOnPath(realClaude, canonicalTarget, kind);

  return true;
}

// Walk every EXISTING directory from `root` (inclusive) down toward `target`'s
// parent and fail closed if any is a same-relative alias of the live dir. Stops
// at the first non-existing component (the fresh tail we are about to create).
// `liveRoot` is injectable for tests; defaults to the real live ~/.claude.
function assertNoLiveDirAliasOnPath(root, target, kind = "path", liveRoot = liveClaudeDir()) {
  // root itself (the resolved sandbox claudeDir) must not BE the live dir alias.
  try {
    const rootSt = fs.lstatSync(root);
    if (rootSt.isDirectory()) assertNotLiveDirAlias(root, root, rootSt, kind, liveRoot);
  } catch (e) {
    if (e && e.code === "CONTAINMENT_INODE_ALIAS") throw e;
    // a non-existing/unstattable root is handled by other arms; nothing to alias here
  }
  const rel = path.relative(root, target);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return;
  const segs = rel.split(path.sep).filter((s) => s.length && s !== ".");
  // Walk the FULL path including the leaf: a leaf that is itself an existing
  // DIRECTORY (e.g. a mkdir target, or a dir we delete) must also be checked; a
  // leaf regular FILE is covered by the (4) leaf-inode arm and is simply skipped
  // here (not a directory). Stop at the first non-existing component.
  let cur = root;
  for (let i = 0; i < segs.length; i++) {
    cur = path.join(cur, segs[i]);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (e) {
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) return; // fresh tail — done
      throw Object.assign(
        new Error(`cannot lstat ${cur} (${e.code}); refusing to write/delete through it`),
        { code: "CONTAINMENT_LSTAT_ERROR", cause: e }
      );
    }
    if (st.isDirectory()) assertNotLiveDirAlias(cur, root, st, kind, liveRoot);
  }
}

// Atomic write: assert containment, then write to a FRESH O_CREAT|O_EXCL temp
// file inside the destination's (guarded) directory and rename() over `dest`.
// rename swaps the dir ENTRY and never truncates the inode `dest` previously
// named — so a hardlinked/symlinked live destination is left intact (its other
// link still owns the original inode). This is the structural close of the
// inode-aliasing class for writes.
function atomicWriteFile(dest, data, claudeDir, opts = {}) {
  assertContained(dest, claudeDir, "file");
  const dir = path.dirname(dest);
  const base = path.basename(dest);
  // temp name in the SAME dir (so rename is atomic on one filesystem) and inside
  // the guarded tree (the dir was containment-checked by the caller's mkdir).
  const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${crypto.randomBytes(6).toString("hex")}`);
  let fd;
  let renamed = false;
  try {
    // O_CREAT|O_EXCL|O_WRONLY — fail if it somehow already exists; never follow a link.
    fd = fs.openSync(tmp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    // preserve a requested source mode (atomicCopyFile) before exposing the file.
    if (opts.mode !== undefined && opts.mode !== null) {
      fs.chmodSync(tmp, opts.mode);
    }
    fs.renameSync(tmp, dest);
    renamed = true;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* already closed */ }
    }
    // If we created the temp file but never renamed it over the dest (a write/
    // fsync/rename failure threw), clean it up so no stray temp leaks behind.
    if (!renamed) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* best effort cleanup */ }
    }
  }
}

// Atomic copy: same temp-then-rename discipline, sourcing bytes from `src` and
// PRESERVING the source file mode (so an executable/source bit copyFileSync would
// have carried is not lost — the temp is created 0600, so we chmod it to the
// source mode before the rename).
function atomicCopyFile(src, dest, claudeDir) {
  // Read the source first (it is OUTSIDE the guarded dir — the pack source), then
  // hand off to the atomic writer so the destination inode is never truncated.
  const data = fs.readFileSync(src);
  let mode;
  try { mode = fs.statSync(src).mode & 0o777; } catch { mode = undefined; }
  atomicWriteFile(dest, data, claudeDir, { mode });
}

// Guarded delete that refuses to unlink THROUGH an alias — for the WHOLE subtree,
// not just the top entry. assertContained's inode arm refuses a hardlinked/
// live-inode TOP target, but a recursive delete also descends into children; a
// plain recursive fs.rmSync would unlink a child regular file that is hardlinked
// elsewhere or is a live-config inode, or follow a child dir symlink OUT. So we
// walk the subtree with lstat at every node (post-order) and FAIL CLOSED on any
// child that is a symlink, a live-config inode, or hardlinked (nlink>1) before
// removing it. Directory entries are removed only AFTER their (verified) contents.
function guardedRemove(target, claudeDir, opts = {}) {
  assertContained(target, claudeDir, "path");
  const recursive = opts.recursive !== false;
  let top;
  try {
    top = fs.lstatSync(target);
  } catch (e) {
    if (e && e.code === "ENOENT") return; // nothing to remove
    throw Object.assign(
      new Error(`cannot lstat ${target} (${e.code}); refusing to delete it`),
      { code: "CONTAINMENT_LSTAT_ERROR", cause: e }
    );
  }
  // A symlinked TOP target: defensive only — assertContained() above already
  // rejects a symlinked leaf via its component walk (CONTAINMENT_SYMLINK), so
  // this is normally unreachable. If it ever is reached, unlink the LINK itself
  // (never recurse through it).
  if (top.isSymbolicLink()) {
    fs.unlinkSync(target);
    return;
  }
  if (!top.isDirectory() || !recursive) {
    // a file/other (or non-recursive): the inode arm in assertContained above
    // already refused a hardlinked/live-inode file, so it is safe to remove.
    fs.rmSync(target, { force: opts.force !== false });
    return;
  }
  // The top dir itself must not be an alias (e.g. a bind-mount) of the
  // corresponding live-config dir — otherwise the recursive walk would delete the
  // LIVE dir's contents. `claudeDir` anchors the relative-mapping onto live.
  assertNotLiveDirAlias(target, claudeDir, top, "dir");
  // Directory: post-order walk, guarding EVERY descendant before unlinking it.
  safeRemoveDir(target, claudeDir);
}

// Recursively remove a directory. A symlink descendant is UNLINKED (the link
// itself, never followed out); FAIL-CLOSED on any descendant that is a
// live-config inode, hardlinked (nlink>1), or a bind-mounted alias of the
// corresponding live dir. Assumes `dir` itself was
// already lstat'd as a real directory, proven contained, and checked for a live
// alias by the caller. `claudeDir` anchors the relative-mapping onto live for
// descendant dirs. Children are lstat'd (never stat — we must not follow links).
function safeRemoveDir(dir, claudeDir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    throw Object.assign(
      new Error(`cannot read dir ${dir} (${e.code}); refusing to delete through it`),
      { code: "CONTAINMENT_READDIR_ERROR", cause: e }
    );
  }
  for (const ent of entries) {
    const child = path.join(dir, ent.name);
    let st;
    try {
      st = fs.lstatSync(child);
    } catch (e) {
      if (e && e.code === "ENOENT") continue; // vanished concurrently — fine
      throw Object.assign(
        new Error(`cannot lstat ${child} (${e.code}); refusing to delete through it`),
        { code: "CONTAINMENT_LSTAT_ERROR", cause: e }
      );
    }
    if (st.isSymbolicLink()) {
      // unlink the LINK itself; never descend/delete through it.
      fs.unlinkSync(child);
      continue;
    }
    if (st.isDirectory()) {
      // refuse a bind-mounted/aliased live dir at ANY depth (mapped-relative inode
      // comparison), THEN recurse into the now-verified real dir.
      assertNotLiveDirAlias(child, claudeDir, st, "dir");
      safeRemoveDir(child, claudeDir);
      continue;
    }
    // a regular file (or other non-dir): refuse if it is a live-config inode or
    // hardlinked elsewhere (a second name could be the live config), else unlink.
    const id = `${st.dev}:${st.ino}`;
    if (liveConfigInodes().has(id)) {
      throw Object.assign(
        new Error(
          `refusing to delete ${child}: it is a second name (dev:ino ${id}) for a LIVE ~/.claude config file.`
        ),
        { code: "CONTAINMENT_INODE_ALIAS" }
      );
    }
    if (st.nlink > 1) {
      throw Object.assign(
        new Error(
          `refusing to delete ${child}: st_nlink=${st.nlink} (hardlinked elsewhere); a second name could be the live config.`
        ),
        { code: "CONTAINMENT_HARDLINK" }
      );
    }
    fs.unlinkSync(child);
  }
  fs.rmdirSync(dir); // now-empty, verified directory
}

module.exports = {
  assertContained,
  contains,
  realResolve,
  liveClaudeDir,
  assertNoSymlinkComponentBelow,
  assertNoInodeAliasing,
  assertNotLiveDirAlias,
  assertNoLiveDirAliasOnPath,
  liveConfigInodes,
  atomicWriteFile,
  atomicCopyFile,
  guardedRemove,
};
