"use strict";
// ---------------------------------------------------------------------------
// preflight — the HARD safety gate (W0 constraint C3).
//
// install.mjs MUST refuse to write the running user's real ~/.claude. This
// preflight FAILS CLOSED if:
//   (a) the resolved HOME is the running user's real HOME (os.userInfo().homedir),
//   (b) the resolved Claude config dir is the live ~/.claude of the current
//       process's real HOME,
// unless the caller passes an explicit override (--i-understand-this-writes-my-
// real-claude-dir). W0 NEVER passes that override; tests assert the refusal.
//
// This is independent of the sandbox-HOME test discipline: even a fat-fingered
// `node bin/install.mjs` with no HOME override on the running machine is
// caught here.
// ---------------------------------------------------------------------------

const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const OVERRIDE_FLAG = "--i-understand-this-writes-my-real-claude-dir";

function normalize(p) {
  if (!p) return p;
  // Resolve to an absolute, normalized path. We ALSO resolve symlinks so a
  // HOME that is a symlink pointing at the running user's real HOME can't slip
  // past the guard via a string compare (codex finding 1). realpath throws on a
  // missing leaf (the
  // sandbox dir may not yet exist), so we realpath the NEAREST EXISTING ancestor
  // and re-append the missing tail — the dangerous case (a symlink pointing at
  // the real home) always has an existing target, so it is fully canonicalized.
  const abs = path.resolve(p);
  let prefix = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(prefix);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(prefix);
      if (parent === prefix) return abs; // reached root, nothing existed
      tail.push(path.basename(prefix));
      prefix = parent;
    }
  }
}

// true iff `child` is `parent` or strictly inside it (both canonical/absolute).
// Used for the subtree-containment boundary (blocker B2): a target under the
// live ~/.claude must be rejected even though it is not byte-equal to it.
function contains(parent, child) {
  if (parent === child) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// The Claude config dir of the process's REAL home (independent of any HOME we
// were handed) — the thing we must protect.
function liveClaudeDir() {
  // CRITICAL: use os.userInfo().homedir, NOT os.homedir(). On POSIX,
  // os.homedir() follows $HOME — so when a sandbox HOME is exported (exactly the
  // W0 test discipline), os.homedir() would point at the sandbox and this guard
  // would wrongly flag the sandbox as the live dir. os.userInfo().homedir reads
  // the passwd database and ignores $HOME, giving the TRUE machine home to
  // protect regardless of how HOME was overridden.
  let realHome;
  try {
    realHome = os.userInfo().homedir;
  } catch {
    realHome = os.homedir();
  }
  return path.join(realHome, ".claude");
}

// Decide whether an install targeting `home` is allowed.
//   home:     the HOME the install will write into
//   override: boolean (explicit acknowledgement to write the real dir)
// Returns { ok: true } or { ok: false, reason }.
function evaluate({ home, override = false } = {}) {
  if (!home || typeof home !== "string") {
    return { ok: false, reason: "no HOME resolved for the install target" };
  }
  const resolvedHome = normalize(home);
  const targetClaude = normalize(path.join(resolvedHome, ".claude"));
  const live = normalize(liveClaudeDir());
  // Derive the running user's real HOME at evaluation time — NOT a hardcoded
  // literal — so the guard can't be bypassed by building with someone else's
  // username baked in. Uses the same passwd-based source as liveClaudeDir().
  let realHome;
  try { realHome = os.userInfo().homedir; } catch { realHome = os.homedir(); }
  const forbiddenHome = normalize(realHome);

  if (override === true) {
    return { ok: true, override: true };
  }

  if (resolvedHome === forbiddenHome) {
    return {
      ok: false,
      reason:
        `refusing to install: HOME resolves to the running user's real HOME (${forbiddenHome}). ` +
        `This would write the live ~/.claude. Use a sandbox HOME, or pass ${OVERRIDE_FLAG} to override.`,
    };
  }

  if (targetClaude === live) {
    return {
      ok: false,
      reason:
        `refusing to install: target Claude dir (${targetClaude}) is the live ~/.claude of this machine. ` +
        `Use a sandbox HOME, or pass ${OVERRIDE_FLAG} to override.`,
    };
  }

  // SUBTREE NON-CONTAINMENT (blocker B2): reject a target that is NESTED inside
  // the live ~/.claude (e.g. a --home pointing into the running user's real
  // ~/.claude subtree), which would write a .claude subtree INSIDE the live
  // config dir. Also reject the inverse (live nested under the target), where
  // installing would envelop the live dir. The exact-equal case is already
  // handled above; these catch the proper-subtree relationships.
  if (contains(live, targetClaude)) {
    return {
      ok: false,
      reason:
        `refusing to install: target Claude dir (${targetClaude}) is nested inside the live ~/.claude (${live}). ` +
        `This would write a .claude subtree inside the live config. Use a sandbox HOME, or pass ${OVERRIDE_FLAG} to override.`,
    };
  }
  if (contains(targetClaude, live)) {
    return {
      ok: false,
      reason:
        `refusing to install: the live ~/.claude (${live}) is nested inside the target Claude dir (${targetClaude}). ` +
        `Installing here would envelop the live config. Use a sandbox HOME, or pass ${OVERRIDE_FLAG} to override.`,
    };
  }

  return { ok: true };
}

// Convenience: throw on refusal (install.mjs calls this).
function assertSafe(opts) {
  const r = evaluate(opts);
  if (!r.ok) {
    const err = new Error(r.reason);
    err.code = "PREFLIGHT_REFUSED";
    throw err;
  }
  return r;
}

module.exports = {
  evaluate,
  assertSafe,
  liveClaudeDir,
  contains,
  OVERRIDE_FLAG,
};
