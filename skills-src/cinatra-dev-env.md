---
name: cinatra-dev-env
description: "Bring up or refresh the Cinatra LOCAL dev / verify stack and explain the dev extension locks and the LLM-call credential principle. Covers the reusable verify-stack recipe (dedicated db/redis ports + an .env.local template + a per-worktree dev port and queue name) and the common pitfall where a stray published-marker artifact breaks a pinned sync. Activates for: 'run cinatra locally', 'bring up the cinatra dev environment', 'spin up the verify stack', 'make LLM calls locally', 'the dev extension locks'. Credentials resolve from the environment and stay in memory — the skill never surfaces or writes a secret value."
argument-hint: "[--up | --refresh]"
allowed-tools:
  - Read
  - Bash
triggers:
  - "run cinatra locally"
  - "bring up the cinatra dev environment"
  - "cinatra dev environment"
  - "spin up the verify stack"
  - "make llm calls locally"
  - "dev extension locks"
antiTriggers:
  - "pdf"
  - "personal repo"
  - "court"
---


<objective>
Bring up or refresh the Cinatra LOCAL dev/verify stack and explain the dev
extension locks and the verify-stack recipe. Keep credentials environment-sourced
and in-memory only — never surface or write a secret value.
</objective>

<process>
1. Bring up the LOCAL verify stack from the recipe in the workflow body (its
   dedicated db/redis ports + the .env.local template + a per-worktree dev port
   and queue name). Spinning up the local stack to live-prove a fix is fine;
   use authoritative read-only DB/CLI reads only.
2. Dev extension locks: the dev-lock auto-bump absorbs tip drift — never manually
   relock; the required-extension equality is untouchable (see the conventions
   skill for the full choreography).
3. Credential principle for LLM calls: keys resolve ENV-FIRST and stay RAM-only; a
   key value is NEVER passed as a CLI subcommand argument (that would expose it)
   and NEVER written into a skill, log, or commit.
</process>

# Workflow: cinatra-dev-env

> Engine body for the `cinatra-dev-env` skill. Bring up / refresh the local
> dev + verify stack; explain the dev extension locks and the LLM-call credential
> principle.

> Evidence rule (what counts as proof): drive the real surface (never a stub),
> only trust a CONCLUDED check, bind a verdict to the exact commit SHA, capture
> output rather than a piped exit code, and confirm a change actually landed.

## Local verify stack

The reusable local verification stack: a dedicated postgres + redis on their own
ports, an `.env.local` template, and a per-worktree dev port + queue name so
parallel worktrees never collide, plus seeded fixtures. Spinning up the LOCAL
stack to live-prove a fix is fine; use authoritative read-only DB/CLI reads only.
Run a worktree's dev server on its OWN port + queue name.

Common pitfall: a stray published-marker artifact left in the tree breaks a
pinned sync — clean strays before trusting a refresh.

## Dev extension universe (locks)

- The rolling **dev-lock auto-bump** absorbs tip drift — NEVER manually relock a
  dev/required lock.
- The `requiredExtensions == systemExtensions == lock` equality is untouchable;
  pins ride the same core PR as the baseline/manifest. The full choreography is
  the extension-conventions skill — this skill only points at it for local dev.

## Credential principle for local LLM calls

- Keys resolve **ENV-FIRST** and stay **RAM-only**.
- A key value is **NEVER** passed as a CLI subcommand argument (that would expose
  it), and **NEVER** written into a skill, a log, or a commit.
- No secret value appears in this pack, ever.

## Remote / hosted ingress

Connecting the local stack to any hosted service is an operator-managed step and
is out of scope for this public skill — it depends on your own deployment. Keep
the local-stack work above self-contained; never improvise a remote ingress or
embed environment-specific endpoints or credentials here.
