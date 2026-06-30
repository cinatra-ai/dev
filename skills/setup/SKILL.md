---
name: setup
description: "Bootstrap a fresh cinatra contributor machine: install the missing toolchain (VS Code + the Claude Code extension, Codex CLI, gh, node/pnpm, Docker, git, and a GSD install) then configure the global Claude baseline (settings.json attribution keys, the org CLAUDE.md block, git core.hooksPath + the commit-msg hook). Activates for: 'set up my cinatra machine', 'install the cinatra prerequisites', 'bootstrap my dev environment', 'install the toolchain', 'fresh machine setup for cinatra'. Idempotent: --dry-run shows EXACT diffs and writes nothing by default; --apply installs/configures on confirm. OS matrix (Homebrew / apt / documented manual); privileged steps are flagged + confirmed separately."
argument-hint: "[--dry-run | --apply]"
allowed-tools:
  - Read
  - Bash
triggers:
  - "set up my cinatra machine"
  - "set up my machine"
  - "install the cinatra prerequisites"
  - "install prerequisites"
  - "bootstrap my dev environment"
  - "bootstrap environment"
  - "install the toolchain"
  - "fresh machine setup"
antiTriggers:
  - "pdf"
  - "personal repo"
  - "set up a meeting"
  - "court"
---


<objective>
Take a fresh machine to a working cinatra contributor setup: install the missing
toolchain, then configure the global Claude baseline. DRY-RUN by default (show
exact diffs, write nothing); install + configure only on --apply or explicit
confirm. Idempotent; user-scope by default; privileged steps flagged separately.
</objective>

<process>
1. Diagnose first — run the read-only doctor probe so you act only on real gaps
   (the bundled doctor CLI):

   ```sh
   node "$CLAUDE_PLUGIN_ROOT/bin/dev-tools.cjs" doctor --json
   ```

2. Preview the global-baseline changes EXACTLY (still read-only):

   ```sh
   node "$CLAUDE_PLUGIN_ROOT/bin/dev-tools.cjs" global-settings-diff
   ```

3. On --apply (or confirm), install missing tools per the OS matrix in the
   workflow body (Homebrew / apt / documented manual), then apply the global
   baseline. Every config write goes through the pack's containment + HOME
   preflight guards (it refuses to write the live ~/.claude); the org CLAUDE.md
   edit is a MANAGED block that preserves your other notes.
4. Privileged installs (VS Code, Docker) are flagged and confirmed separately,
   never bundled into a silent run.
5. Re-run is a no-op on anything already in place.
</process>

# Workflow: setup

> Engine body for the `setup` skill. Installs the missing toolchain, then
> configures the global Claude baseline. DRY-RUN by default; writes only on
> `--apply`/confirm. Idempotent.

> Evidence rule (what counts as proof): drive the real surface, never a stub; a
> check only counts once it has CONCLUDED (a pending check is treated as missing);
> bind any verdict to the exact commit SHA; capture command output rather than
> trusting a piped exit code; and confirm a mutation actually landed before
> claiming it did.

## Order of operations

1. **Diagnose** with the read-only doctor probe so you act only on real gaps
   (the bundled doctor CLI):

   ```sh
   node "$CLAUDE_PLUGIN_ROOT/bin/dev-tools.cjs" doctor --json
   ```

2. **Preview** the global-baseline diff (still read-only — exact added/changed
   keys):

   ```sh
   node "$CLAUDE_PLUGIN_ROOT/bin/dev-tools.cjs" global-settings-diff
   ```

3. **Apply** only on `--apply` or explicit confirm.

## Toolchain install — OS matrix (NOT a blanket cross-platform claim)

Install only what doctor reports missing. User-scope by default.

- **macOS (Homebrew):** `brew install gh node pnpm git`; Docker Desktop and
  VS Code via cask (PRIVILEGED — flagged + confirmed separately). Codex CLI and
  a GSD install per their own installers. The VS Code Claude Code extension after VS Code.
- **Debian/Ubuntu (apt):** the apt packages for gh / git, NodeSource for node,
  corepack for pnpm, Docker engine per the official repo (PRIVILEGED). VS Code
  via the Microsoft repo.
- **Other:** documented MANUAL fallback per tool — never a silent cross-platform
  assumption.

Privileged steps (VS Code, Docker) are flagged and confirmed on their own, never
bundled into a silent run.

The setup flow can also land the **shadcn skill for Codex** as an optional
cross-tool install during a fresh setup.

## Global Claude baseline — applied SAFELY

On apply, the baseline is written ONLY through the pack's safety stack:

- A **HOME preflight** authorizes the target home; it FAILS CLOSED if it would
  write the live `~/.claude` (or the authoring home) unless an explicit override
  is passed. All automated tests pass a throwaway sandbox HOME; the real home is
  never written by tests.
- Every directory is **containment-checked before mkdir**, and every file is
  written via an **atomic temp-then-rename** that refuses to escape the target
  `.claude/`.
- `settings.json` changes use the **keyed-sentinel** merge so they never clobber
  a resident GSD/user block.
- The global `CLAUDE.md` org block is a **MANAGED block** delimited by markers —
  your own notes above/below it are preserved, and a re-apply replaces only the
  managed region.

What it sets:

- `settings.json`: no AI co-authorship lines (`includeCoAuthoredBy:false`),
  sourced from the ENFORCEMENT artifacts (the commit-msg hook), not a date — so
  the pack tracks the org gate instead of drifting when the policy ratifies.
- The global `CLAUDE.md` org baseline block (truthful-attribution direction +
  the transitional no-co-authorship rule + settings-centralization).
- git `core.hooksPath` + the commit-msg hook are surfaced; the Playwright
  `--output-dir` pin is surfaced as an exact line to confirm (not silently
  written), keeping the write footprint minimal.

## Idempotency

Re-running is a no-op on anything already in place. A diverged (user-edited)
managed entry is left alone with a notice, never silently overwritten.
