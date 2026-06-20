---
name: domain-gotchas
description: "Apply the per-repo domain trap that bites when working in a specific cinatra repo: design-repo asset/spec conformance (the spec wins; defer to the live design system, never fork it), reusable release CI already exists (reuse, don't reinvent), schema-migration fixture re-apply, Next.js dev cold-compile staleness during live verification, the browser-URL vs container-URL split, a CodeQL false-positive needs an explicit dismissal, and the docs-repo convention. Activates for: 'design repo asset conformance', 'asset spec conformance', 'reusable release ci', 'schema migration fixture re-apply', 'codeql false positive dismissal', 'next cold compile staleness', 'browser url vs container url', 'docs repo convention', 'split a package'. Each is a non-obvious fact that has cost real rework; re-verify against current state since the repos drift."
argument-hint: "[design | release-ci | schema | codeql | docs]"
allowed-tools:
  - Read
  - Bash
triggers:
  - "design repo asset conformance"
  - "asset spec conformance"
  - "reusable release ci"
  - "schema migration fixture re-apply"
  - "codeql false positive dismissal"
  - "next cold compile staleness"
  - "browser url vs container url"
  - "docs repo convention"
  - "split a package"
antiTriggers:
  - "pdf"
  - "personal repo"
  - "court"
---


<objective>
Apply the per-repo domain trap for the cinatra repo in play: derive design assets
from the spec (spec wins; defer to the live design system, never fork); reuse the
existing reusable release CI; re-apply a schema-migration fixture after a real
ledger entry; warm a Next.js route past its cold compile before trusting it; keep
the browser-URL and container-URL straight for server-to-server vs front-end calls;
dismiss a CodeQL false positive explicitly to clear it; and follow the docs-repo
convention. Re-verify each against current state — the repos drift.
</objective>

# Workflow: domain-gotchas

> Engine body for the `domain-gotchas` skill. The heavy doctrine lives in the
> body; the thin skill launcher stays stable across content updates.

> Evidence rule (what counts as proof): for anything verification-shaped below,
> drive the real surface (never a stub), only trust a CONCLUDED check, bind the
> verdict to the exact commit SHA, capture output rather than a piped exit code,
> and confirm the change actually landed.

## Purpose

The per-repo domain traps that bite a developer working in specific cinatra repos —
each a fact that is non-obvious and has cost real rework. Apply the relevant one
when working in that repo's domain; verify each against current state at the time,
since the underlying repos drift.

## Design-repo asset / spec conformance — derive from the spec, do not fork

- **The spec wins over the artifacts.** Derive every asset decision from the design
  spec rules; when an artifact disagrees with the spec, the spec is authoritative.
  Keep the conformance check + its CI gate strong.
- **Do NOT fork the canonical design/system contract.** The design system already
  ships as its own live source (a design repo + an in-app design skill + a published
  designer guide). Forking the rulebook into this pack guarantees drift — defer to
  the live design-system source for the rulebook and record only the durable
  "defer-to-live-source, never fork" boundary. The composition split: the design
  source owns *what semantic / which token*; the UI layer owns *how to compose / add*.

## Reusable release CI already EXISTS — do not reinvent

A reusable extension-release workflow + a build-image / create-release path already
exist in the org. Before writing a new release rig, reuse the existing reusable
workflow; assuming "there is no release CI" and rolling a new one is wasted work and
drifts from the org pattern.

## Docs-repo convention

The canonical docs repo is docs-only and publishes to the docs site through a
separate sync/deploy pipeline. Re-verify the live publish pipeline (its
include-list + the sidebar coupling) before shipping any path/command claim, since
it drifts. Keep the durable rules: relative-`.md` link form; one canonical
home per topic + cross-link; a section `README.md` is required; and the binding
terminology rulings ("open source" with no hyphen, "extension" not "package",
kind-at-END package names).

## Package-split refactor discipline (a domain note)

When splitting a package: preserve behaviour; separate the generic from the
domain-specific; reuse existing `SKILL.md`-style assets rather than rewriting them;
declare which steps are deterministic vs LLM-driven; and prefer MCP-chaining over
direct imports.

## Schema-migration fixtures must re-apply after a real ledger entry

A schema-migration fixture has to be RE-APPLIED after any real entry lands in the
table it seeds — a real write can invalidate the seeded fixture state, reddening the
build until the fixture is re-applied. When a migration touches a seeded table,
re-apply its fixture as part of the change.

## Next dev cold-compile staleness during live verification

A Next.js dev server compiles routes lazily (cold compile): the FIRST request to a
route after a change can serve stale output until the route finishes compiling.
During live verification, warm the route (or wait for the compile to settle) before
trusting what the page shows — a cold-compile artifact is not the real behaviour.

## The browser-URL vs container-URL split

When the app runs in containers, the URL the BROWSER uses to reach a service is not
the URL one CONTAINER uses to reach another. Server-to-server calls need the
container-network address (with a host-gateway alias where a container must reach the
host), while the browser needs the externally reachable address. Keep the two
straight: read a base-URL env on the server side for server-to-server, and use the
browser-reachable origin for the front end. Conflating them breaks integration runs
in subtle, environment-only ways.

## A CodeQL false-positive needs an explicit DISMISSAL to clear

Fixing a finding with a custom sanitizer barrier (a containment guard the taint
tracker cannot model) does NOT clear the alert — the tracker re-flags the sink. To
clear it you must DISMISS it as a false positive (with a concise justification within
the comment cap) or it sits open silently. The dismissal is part of completing the
fix; pair it with a converged review of the barrier before dismissing a higher-
severity alert.

## Steps (operational)

1. Identify which repo's domain you are in and apply the matching gotcha above.
2. Re-verify the underlying fact against current state (these repos drift) — for
   anything verification-shaped (release CI, CodeQL, a live page), apply the shared
   evidence recipe above for what counts as proof.
3. Prefer the existing org pattern (reusable release CI, the live design-system
   source) over reinventing or forking.
