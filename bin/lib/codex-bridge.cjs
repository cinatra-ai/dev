"use strict";
// ---------------------------------------------------------------------------
// codex-bridge — the one sanctioned way to invoke codex for convergence.
//
// Codex MUST be driven via STDIN (`codex exec --skip-git-repo-check < prompt`);
// passing the prompt as an argv hangs. The verdict is CAPTURED to a file, never
// tail-piped (capture-not-tail integrity). Read-only / advisory. The
// dev-codex-pairing skill shells out to this helper so the discipline can't
// drift to a hanging argv invocation.
//
// W0 ships the command BUILDER + a guard that rejects argv-prompt misuse
// (pure + testable). The skill calls runCodex() at runtime.
// ---------------------------------------------------------------------------

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");

// Build the argv for a codex exec convergence run. The prompt is supplied on
// STDIN by the caller — it is NEVER placed in this argv. Throws if a caller
// tries to smuggle a prompt as an argument.
function buildCodexArgs({ extraArgs = [] } = {}) {
  for (const a of extraArgs) {
    if (typeof a !== "string") throw new Error("codex args must be strings");
  }
  // The prompt is read from stdin; --skip-git-repo-check lets it run in a
  // scratch dir that is not a git repo.
  return ["exec", "--skip-git-repo-check", ...extraArgs];
}

// Default subprocess timeout: a stuck `codex` run must never hang the flow
// indefinitely. 15 minutes is generous for a convergence pass; callers can
// override via `timeoutMs`.
const DEFAULT_CODEX_TIMEOUT_MS = 15 * 60 * 1000;

// Run codex with the prompt on STDIN and capture stdout/stderr to a file.
// Returns { ok, code, outputFile, timedOut }. Read-only/advisory; failures are
// surfaced, not thrown, so the caller can decide. A timeout kills the process
// (SIGKILL) and is reported as timedOut:true (ok:false) so the caller never
// mistakes a hung run for a clean verdict.
function runCodex({ prompt, outputFile, extraArgs = [], bin = "codex", timeoutMs = DEFAULT_CODEX_TIMEOUT_MS } = {}) {
  if (typeof prompt !== "string" || prompt.length === 0) {
    throw new Error("runCodex: a non-empty prompt string is required (passed on STDIN)");
  }
  if (!outputFile) throw new Error("runCodex: outputFile is required (capture-not-tail)");
  const args = buildCodexArgs({ extraArgs });
  const res = spawnSync(bin, args, {
    input: prompt,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const timedOut = res.error && res.error.code === "ETIMEDOUT";
  let combined = `${res.stdout || ""}${res.stderr || ""}`;
  if (timedOut) {
    combined += `\n[codex-bridge] TIMEOUT after ${timeoutMs}ms — process killed (SIGKILL). Verdict is NOT trustworthy.\n`;
  }
  fs.writeFileSync(outputFile, combined);
  return { ok: res.status === 0 && !timedOut, code: res.status, outputFile, timedOut: Boolean(timedOut) };
}

module.exports = { buildCodexArgs, runCodex };
