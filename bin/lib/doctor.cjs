"use strict";
// ---------------------------------------------------------------------------
// doctor — READ-ONLY toolchain / currency / global-settings PROBES (#129).
//
// This is the deterministic engine behind the `dev-doctor` skill and the verify
// half of `dev-setup`. It NEVER writes: every probe spawns a read-only command
// (version/auth-status/path), parses the result, and returns a structured
// report. The skills shell out to it via `dev-tools.cjs doctor` so the LLM never
// free-decides what "installed/current/configured" means (parity with the W0
// "skills shell out to dev-tools" pattern).
//
// SAFETY (codex round-0 B):
//   - every probe uses spawnSync with shell:false, stdio piped, a tight timeout,
//     and prompt-disabling env so nothing hangs or prompts.
//   - the codex CLI is probed for PRESENCE only; we NEVER run `codex exec` (argv
//     hangs) — the STDIN-exec rule is documented, not executed.
//   - a timeout / spawn error is a structured warn|fail + fix, never a throw.
//
// TESTABILITY (codex round-0 A/E): spawn + env + which are injectable via the
// `deps` arg so tests fake the toolchain and assert read-only, host-independent
// behaviour.
// ---------------------------------------------------------------------------

const cp = require("node:child_process");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const DEFAULT_TIMEOUT_MS = 8000;

// Env that disables every interactive prompt a probed tool might raise, so a
// read-only probe can never block on stdin (codex round-0 B).
const NONINTERACTIVE_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  CI: "1",
  DEBIAN_FRONTEND: "noninteractive",
  npm_config_yes: "true",
  NO_COLOR: "1",
};

// Default dependency injection surface. Tests pass their own `deps` to fake the
// host toolchain; production uses these.
function defaultDeps() {
  return {
    // run a read-only command; returns { ok, code, stdout, stderr, timedOut, error }
    run(cmd, args, opts = {}) {
      let res;
      try {
        res = cp.spawnSync(cmd, args, {
          shell: false, // never a shell — no injection, no glob, no prompt
          stdio: ["ignore", "pipe", "pipe"],
          timeout: opts.timeout || DEFAULT_TIMEOUT_MS,
          encoding: "utf8",
          env: { ...process.env, ...NONINTERACTIVE_ENV, ...(opts.env || {}) },
        });
      } catch (e) {
        return { ok: false, code: null, stdout: "", stderr: "", timedOut: false, error: e.message };
      }
      if (res.error) {
        const timedOut = res.error.code === "ETIMEDOUT" || res.signal === "SIGTERM";
        return {
          ok: false,
          code: res.status,
          stdout: res.stdout || "",
          stderr: res.stderr || "",
          timedOut,
          error: res.error.message,
        };
      }
      return {
        ok: res.status === 0,
        code: res.status,
        stdout: res.stdout || "",
        stderr: res.stderr || "",
        timedOut: false,
        error: null,
      };
    },
    homedir() {
      // TRUE machine home (ignores $HOME) so a sandbox HOME during tests does not
      // make us misread the global-settings location. Mirrors preflight's choice.
      try { return os.userInfo().homedir; } catch { return os.homedir(); }
    },
    existsSync: (p) => fs.existsSync(p),
    readFileSync: (p) => fs.readFileSync(p, "utf8"),
  };
}

// Extract the first dotted version (1.2.3 / 1.2 / 1) from a tool's output.
function parseVersion(text) {
  const m = String(text || "").match(/\d+(?:\.\d+){1,3}/);
  return m ? m[0] : null;
}

// Compare two dotted versions: -1 / 0 / 1. Missing => treated as 0-padded.
function cmpVersion(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x < y) return -1;
    if (x > y) return 1;
  }
  return 0;
}

// One check result: { id, label, status: ok|warn|fail, detail, fix }.
function mk(id, label, status, detail, fix) {
  return { id, label, status, detail, fix: fix || null };
}

// Probe a tool's presence + version + a floor. READ-ONLY (version flag only).
//   spec: { id, label, cmd, versionArgs, floor?, fix }
function probeTool(spec, deps) {
  const r = deps.run(spec.cmd, spec.versionArgs);
  if (r.timedOut) {
    return mk(spec.id, spec.label, "warn", `${spec.cmd} timed out (probe is read-only; tool may be slow or hung)`, spec.fix);
  }
  // spawn error with ENOENT-style message => not installed
  if (!r.ok && (r.code === null || /ENOENT|not found|No such file/i.test(r.error || r.stderr || ""))) {
    return mk(spec.id, spec.label, "fail", `${spec.cmd} not found on PATH`, spec.fix);
  }
  const version = parseVersion(r.stdout) || parseVersion(r.stderr);
  if (!version) {
    // present but version unreadable — report present, warn (do not block).
    return mk(spec.id, spec.label, r.ok ? "ok" : "warn", `${spec.cmd} present (version not parseable)`, r.ok ? null : spec.fix);
  }
  if (spec.floor && cmpVersion(version, spec.floor) < 0) {
    return mk(spec.id, spec.label, "warn", `${spec.cmd} ${version} is below the floor ${spec.floor}`, spec.fix);
  }
  return mk(spec.id, spec.label, "ok", `${spec.cmd} ${version}`, null);
}

// gh: present + authenticated + required scopes (repo, project read). READ-ONLY
// (`gh auth status` does not mutate). Strengthened wording from #136.
function probeGh(deps) {
  const present = probeTool(
    { id: "gh", label: "GitHub CLI", cmd: "gh", versionArgs: ["--version"], floor: "2.0.0",
      fix: "install gh (brew install gh / apt install gh) then `gh auth login`" },
    deps
  );
  if (present.status === "fail") return [present];
  const auth = deps.run("gh", ["auth", "status"]);
  const out = `${auth.stdout}\n${auth.stderr}`;
  if (!auth.ok && !/Logged in to/i.test(out)) {
    return [present, mk("gh-auth", "gh authenticated", "fail", "gh is not authenticated", "`gh auth login` (account that can reach cinatra-ai)")];
  }
  // scope detection: gh prints "Token scopes: 'repo', 'read:org', 'project'".
  const scopeLine = (out.match(/Token scopes:.*/i) || [""])[0];
  const need = ["repo", "project"];
  const missing = need.filter((s) => !new RegExp(`['\"]?(?:read:)?${s}\\b`, "i").test(scopeLine));
  if (scopeLine && missing.length) {
    return [present, mk("gh-scopes", "gh token scopes", "warn",
      `gh token may be missing scope(s): ${missing.join(", ")} (need repo + project read)`,
      "`gh auth refresh -h github.com -s repo,read:project`")];
  }
  return [present, mk("gh-auth", "gh authenticated", "ok",
    scopeLine ? `authenticated; ${scopeLine.replace(/^.*scopes:\s*/i, "scopes: ")}` : "authenticated", null)];
}

// codex CLI: PRESENCE only. We NEVER run `codex exec` here (argv hangs); the
// STDIN-exec rule lives in the codex-pairing doctrine, not in this probe.
function probeCodex(deps) {
  return probeTool(
    { id: "codex", label: "Codex CLI", cmd: "codex", versionArgs: ["--version"],
      fix: "install the Codex CLI; converge via `codex exec --skip-git-repo-check < file` (STDIN only — argv hangs)" },
    deps
  );
}

// git identity + hooks: user.name/email set; core.hooksPath set; the commit-msg
// hook present (the local attribution backstop). READ-ONLY (`git config --get`).
function probeGit(deps) {
  const out = [];
  out.push(probeTool(
    { id: "git", label: "git", cmd: "git", versionArgs: ["--version"], floor: "2.30.0",
      fix: "install git" },
    deps
  ));
  const name = deps.run("git", ["config", "--get", "user.name"]);
  const email = deps.run("git", ["config", "--get", "user.email"]);
  if (!(name.stdout || "").trim() || !(email.stdout || "").trim()) {
    out.push(mk("git-identity", "git identity", "warn", "git user.name/user.email not both set",
      "set the agent identity for agent PRs / the owner identity otherwise"));
  } else {
    out.push(mk("git-identity", "git identity", "ok", `${name.stdout.trim()} <${email.stdout.trim()}>`, null));
  }
  const hooksPath = deps.run("git", ["config", "--get", "core.hooksPath"]).stdout.trim();
  if (!hooksPath) {
    out.push(mk("git-hookspath", "git core.hooksPath", "warn", "core.hooksPath not configured",
      "set core.hooksPath to your global git hooks dir (carries the commit-msg attribution backstop)"));
  } else {
    const hook = path.join(expandHome(hooksPath, deps), "commit-msg");
    if (deps.existsSync(hook)) {
      out.push(mk("git-hookspath", "git core.hooksPath + commit-msg hook", "ok", `${hooksPath} (commit-msg present)`, null));
    } else {
      out.push(mk("git-hookspath", "git commit-msg hook", "warn", `core.hooksPath=${hooksPath} but no commit-msg hook present`,
        "install the commit-msg hook (normalizes/ensures the Assisted-by attribution trailer; the CI gate owns truth)"));
    }
  }
  return out;
}

function expandHome(p, deps) {
  if (p.startsWith("~/")) return path.join(deps.homedir(), p.slice(2));
  return p;
}

// docker daemon reachable (verify-stack prereq). READ-ONLY (`docker info`).
function probeDocker(deps) {
  const present = probeTool(
    { id: "docker", label: "Docker", cmd: "docker", versionArgs: ["--version"],
      fix: "install Docker Desktop / docker engine and start the daemon" },
    deps
  );
  if (present.status === "fail") return [present];
  const info = deps.run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.timedOut) {
    return [present, mk("docker-daemon", "Docker daemon", "warn", "`docker info` timed out — daemon may be starting", "start the Docker daemon")];
  }
  if (!info.ok || !info.stdout.trim()) {
    return [present, mk("docker-daemon", "Docker daemon", "fail", "Docker is installed but the daemon is not reachable",
      "start the Docker daemon (needed to bring up the local verify stack)")];
  }
  return [present, mk("docker-daemon", "Docker daemon", "ok", `daemon reachable (server ${info.stdout.trim()})`, null)];
}

// Run the full toolchain probe set. READ-ONLY.
function runToolchain(deps = defaultDeps()) {
  const checks = [];
  checks.push(...probeGh(deps));
  checks.push(probeCodex(deps));
  checks.push(probeTool(
    { id: "node", label: "Node.js", cmd: "node", versionArgs: ["--version"], floor: "20.0.0",
      fix: "install Node >= 20 (nvm / brew)" }, deps));
  checks.push(probeTool(
    { id: "pnpm", label: "pnpm", cmd: "pnpm", versionArgs: ["--version"], floor: "8.0.0",
      fix: "`npm i -g pnpm` (or corepack enable)" }, deps));
  checks.push(...probeDocker(deps));
  checks.push(...probeGit(deps));
  // the pack co-exists with a live GSD install; report its presence (not a fail).
  checks.push(probeGsd(deps));
  return checks;
}

// GSD-product presence — the pack co-exists with a live GSD install. Absence is
// informational (warn), never a fail (the pack runs without a GSD install).
function probeGsd(deps) {
  // a GSD install keeps its payload under the machine home; detect it without $HOME.
  const home = deps.homedir();
  const marker = path.join(home, ".claude", "gsd-core", "VERSION");
  if (deps.existsSync(marker)) {
    let v = "present";
    try { v = `v${deps.readFileSync(marker).trim()}`; } catch { /* present */ }
    return mk("gsd-core", "a GSD install (co-resident)", "ok", `a GSD install is present (${v})`, null);
  }
  return mk("gsd-core", "a GSD install (co-resident)", "warn", "a GSD install was not detected (the pack runs without one)",
    "optional: add a GSD install if your workflow uses it (the dev pack co-exists without clobbering a GSD install)");
}

// TOOLCHAIN CURRENCY (installed vs latest), per the `currency.dependency` knob.
//
// HONEST + OFFLINE-SAFE (codex round-0 B/E + finding 2): the doctor probe does
// NOT hit the network by default — an unbounded `brew outdated` / registry call
// could hang and would make doctor host/network-dependent. So by default the
// currency check returns `unknown` with the EXACT command to run a real
// latest-check, and the knob it honors. A caller may pass `online:true` (the
// dev-setup --apply path) to actually run the bounded latest probe.
//
//   knob: "notify-only" | "auto-update"
// Returns { status: "unknown"|"checked", mode, detail, command }.
function currencyStatus(knob = "notify-only", { online = false } = {}) {
  if (!online) {
    return {
      status: "unknown",
      mode: knob,
      detail:
        "currency not probed (offline-safe default — no network call). " +
        (knob === "auto-update"
          ? "On --apply, user-scope-safe upgrades are applied (never a silent downgrade; changes recorded)."
          : "notify-only: you are shown the exact upgrade command, never auto-changed."),
      command: "run your package manager's outdated check (e.g. `brew outdated`, `pnpm outdated -g`) — or dev-setup --apply for the bounded probe",
    };
  }
  // online mode is intentionally minimal here; the bounded per-tool latest probe
  // is wired by dev-setup. Reported as checked so the claim stays truthful.
  return { status: "checked", mode: knob, detail: "currency probe ran (bounded).", command: null };
}

// Summarize a check list into counts + a worst-status verdict.
function summarize(checks) {
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status] = (counts[c.status] || 0) + 1;
  const verdict = counts.fail > 0 ? "fail" : counts.warn > 0 ? "warn" : "ok";
  return { counts, verdict, total: checks.length };
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  NONINTERACTIVE_ENV,
  defaultDeps,
  parseVersion,
  cmpVersion,
  probeTool,
  probeGh,
  probeCodex,
  probeGit,
  probeDocker,
  probeGsd,
  runToolchain,
  currencyStatus,
  summarize,
};
