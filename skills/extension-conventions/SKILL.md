---
name: extension-conventions
description: "Apply the conventions for authoring or integrating a cinatra extension, reconciled to the current architecture (one repo per extension; five kinds — agent/connector/artifact/skill/workflow; scaffolded by create-cinatra-extension; the package.json#cinatra manifest). Activates for: 'lock-pin choreography', 'required extension lock equality', 'system extension lock equality', 'create-cinatra-extension', 'package.json#cinatra', 'connector manifest shape', 'agent manifest shape', 'artifact manifest shape', 'companion merge choreography', 'seed the transitive required closure', 'extension repo conventions'. Pins ride the same core PR as the manifest; requiredExtensions == systemExtensions == lock is untouchable; the rolling dev-lock auto-bump is never manually relocked; seed the transitive required-closure before boot or the app crashes."
argument-hint: "[connector | agent | artifact | skill | workflow]"
allowed-tools:
  - Read
  - Bash
triggers:
  - "lock-pin choreography"
  - "required extension lock equality"
  - "system extension lock equality"
  - "create-cinatra-extension"
  - "package.json#cinatra"
  - "connector manifest shape"
  - "agent manifest shape"
  - "artifact manifest shape"
  - "companion merge choreography"
  - "seed the transitive required closure"
  - "extension repo conventions"
antiTriggers:
  - "pdf"
  - "personal repo"
  - "court"
  - "npm package for my"
---


<objective>
Apply cinatra extension conventions reconciled to current architecture: one repo per
extension across the five kinds (agent/connector/artifact/skill/workflow), scaffolded
by create-cinatra-extension, with the kind-specific package.json#cinatra manifest.
Keep pins on the same core PR as the manifest; keep requiredExtensions ==
systemExtensions == lock equal; let the rolling dev-lock auto-bump roll (never
manually relock); seed the transitive required-closure before booting on the real
surface.
</objective>

# Workflow: extension-conventions

> Engine body for the `extension-conventions` skill. The heavy doctrine lives
> in the body; the thin skill launcher stays stable across content updates.

> Evidence rule (what counts as proof): drive the real surface (never a stub),
> only trust a CONCLUDED check, bind a verdict to the exact commit SHA, capture
> output rather than a piped exit code, and confirm a change actually landed.

## Purpose

The conventions for AUTHORING and integrating a Cinatra extension, reconciled to
the CURRENT architecture. This skill states the final conventions a developer
applies. Reconcile against the live architecture at authoring time, since the
architecture drifts — the rules below are the durable distillation.

## Current architecture (the model every convention is grounded in)

- **One repo per extension.** Each connector / agent / artifact / skill / workflow
  is its OWN repo, published under the `@cinatra-ai/<slug>-<kind>` npm identity
  (skill bundles use the plural `-skills` suffix); a vendor-scoped extension uses
  `@<vendor>/<slug>-<kind>`. There is no in-tree monorepo source tree for
  extensions anymore — that model is gone.
- **Scaffolded, not hand-built.** `npx create-cinatra-extension <kind> [name]
  [--scope <vendor>]` writes a ready-to-author, ready-to-publish repo for one of
  the **five kinds** (agent, connector, artifact, skill, workflow), pre-wired with
  the `package.json#cinatra` manifest, a kind-appropriate payload stub, the org
  hygiene CI gates, a license, and a marketplace release workflow. Start from the
  scaffolder, not a hand-rolled tree.
- **Marketplace ↔ registry boundary (boundary level only).** The marketplace is the
  vendor-facing storefront where vendors register and publish; the registry is the
  machine-facing npm-protocol endpoint app instances install from. Publishing
  crosses that boundary with source-mirror CI. Keep this at the boundary level —
  never embed marketplace vendor-stack internals in a skill.

## Manifest shape per kind (`package.json#cinatra`)

The manifest always carries `apiVersion: "cinatra.ai/v1"` + `kind` + `dependencies`,
plus kind-specific fields. Re-verify the exact field set against the live SDK
packages + `create-cinatra-extension` at authoring time.

- **connector** — `displayName`, `serverEntry` (the `register(ctx)` entry the host
  calls at boot), `requestedHostPorts` (the SDK host capabilities the connector
  asks the host for — the SDK host-port surface). Wire `serverEntry` +
  `requestedHostPorts` against the live SDK host-port packages; there is no in-tree
  registration helper.
- **agent** — `packageType`, `manifestVersion`, `sourceTemplateId` /
  `sourceVersionId`, `type`, `riskLevel`, `hasApprovalGates`, `toolAccess`, `roles`;
  the repo carries an OpenAgentSpec payload dir + a `skills/` dir. An agent is a
  full extension repo now — not a single virtual-agent config file.
- **artifact** — `roles` + `artifact: { accepts: { file: { mimeTypes } }, skills:
  { matchers }, matcherConfidenceThreshold }`. The content-type slug names the
  CONTENT (not the producer); pair a matcher skill with an author skill; do not ship
  an agent payload from an artifact repo; reuse an existing artifact rather than
  abstracting prematurely.
- **skill** — `capabilities` (a `{ "domain.action": "skill-slug" }` map). Theme the
  bundle by its consumer, use a verb-noun inner slug, and respect the
  workspace-visible vs system-visible distinction. Author it as a DEV process that
  produces a product-skill extension — it is not itself a runtime skill.
- **workflow** — the fifth current kind; ground it directly from
  `create-cinatra-extension workflow` + the live kind-gate validator (the archived
  source set predates this kind, so there is no legacy convention to reconcile).
- Agent and workflow repos carry a self-contained **kind-gate validator** that
  checks their spec sidecar in CI without registry access — keep it green.

## Companion-merge + lock-pin choreography (the coupling invariant)

The app repo pins the extension set in root lockfiles (a dev-extension lock + a
required-extension lock); the dev flow clones the pinned extension repos back into
the app, and the live SDK packages register them.

- **Destination-first companion merges.** When a change spans an extension repo and
  the app, land the destination side in the order the coupling requires; the pins
  ride the SAME core PR as the baseline/manifest change — a manifest change and its
  pin are one merge, never split across PRs.
- **`requiredExtensions == systemExtensions == lock` equality is untouchable.** These
  three must stay equal; a drift between them is a coupling break. Pinned-empty
  coupling gates exist to catch exactly this — keep them satisfied.
- **The rolling dev-lock auto-bump absorbs tip drift — never manually relock.** Let
  the dev/required lock roll forward on its own; a hand-edited relock fights the
  auto-bump and lands a phantom pin.
- **Seed the transitive required-closure BEFORE boot verification.** A required
  extension that pulls in further required extensions must have its FULL transitive
  closure seeded, or the app boot crashes on a missing closure member. Seed the
  closure first, then verify boot on the real surface (see the evidence recipe
  above for what a real boot proof requires).

## Worktree-evaporates, branch-survives

A workflow worktree may be auto-cleaned when an agent finishes, but the committed
BRANCH ref survives — recover work from the branch in the parent clone, do not
assume it was lost. And a green repo GATE is not the same as architecturally
correct: a passing gate can still miss a coupling/architecture defect, so pair the
gate with a real-surface boot verification.

## Steps (operational)

1. Identify the extension KIND and start from `create-cinatra-extension <kind>` —
   never hand-roll the tree.
2. Fill `package.json#cinatra` with the kind-specific fields above, re-verified
   against the live SDK + scaffolder.
3. For a change spanning the extension and the app: keep the pin on the SAME core
   PR as the manifest; keep `requiredExtensions == systemExtensions == lock` equal;
   let the dev-lock auto-bump roll; seed the transitive required-closure.
4. Verify the integrated result by booting on the REAL surface (the evidence recipe)
   — a green gate alone is not proof of correct coupling.
