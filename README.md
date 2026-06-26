# cinatra-ai/dev

Claude Code skills that help a single developer set up and build **with**
Cinatra. Install once; the skills activate on natural-language triggers inside
Claude Code.

> Licensed under the Apache License 2.0 — see [LICENSE](./LICENSE).

## What is this repo?

This repository ships a set of Claude Code skills for contributors working on
or with Cinatra. The skills cover:

- **Toolchain bootstrap** — get a fresh machine ready to contribute.
- **New-contributor orientation** — find your first issue and follow the
  standard issue → PR → merge flow.
- **Local dev/verify stack** — bring up the local Cinatra stack for testing.
- **Extension authoring conventions** — the rules for building, pinning, and
  integrating a Cinatra extension.
- **Domain gotchas** — per-repo traps that have cost real rework.

This is a **public** package. The fastest way to install is a single `npx`
command (see [Install](#install)); you can also clone the repo and run the
installer directly. Skill source lives in [`skills-src/`](./skills-src/).

**What belongs here vs elsewhere:** skills that guide *how to develop with
Cinatra* live here. Runtime application code, extension source, and
organisation-internal runbooks live in their own repos.

---

## Requirements

- Node.js 20 or later
- Claude Code (the skills are installed into the global Claude profile)
- `npx` (bundled with npm) for the one-command install, **or** Git if you prefer
  to clone and run the installer manually

---

## Install

### Option A — one command with `npx` (recommended)

Install straight from the public GitHub repo — no clone, no npm publish needed:

```sh
npx --yes github:cinatra-ai/dev --claude --global \
  --i-understand-this-writes-my-real-claude-dir
```

Pin to a specific tag for a reproducible install (recommended for CI):

```sh
npx --yes github:cinatra-ai/dev#<tag> --claude --global \
  --i-understand-this-writes-my-real-claude-dir
```

`npx` fetches this exact ref and installs the skills it carries — the version
you pin is the version you get (the installer no longer re-clones a moving
default branch).

> Once the package is published to npm, the same install is available as
> `npx @cinatra-ai/dev --claude --global …` (and `npx @cinatra-ai/dev@<version>`
> to pin). Publishing is gated on the org's npm scope + a release-on-tag
> workflow; until then, use the `github:` spec above.

### Option B — clone and run the installer

```sh
git clone https://github.com/cinatra-ai/dev.git
cd dev
node bin/install.mjs --claude --global --i-understand-this-writes-my-real-claude-dir
```

### Required acknowledgement + dry run

The `--i-understand-this-writes-my-real-claude-dir` flag is required for every
install path. The installer's preflight guard **fails closed** — it refuses to
write your real `~/.claude` directory without an explicit acknowledgement — see
[Configuration](#configuration) for why.

To preview what would be written without making any changes, add `--dry-run`.
The preflight runs before dry-run handling, so the acknowledgement flag is
still required:

```sh
npx --yes github:cinatra-ai/dev --claude --global --dry-run \
  --i-understand-this-writes-my-real-claude-dir
```

---

## Skills

| Skill | What it does | Example trigger |
|---|---|---|
| `setup` | Bootstrap a fresh contributor machine: missing toolchain + global Claude baseline. Dry-run by default; writes only on `--apply`. | `"set up my machine"` |
| `onboarding` | Walk a new contributor from nothing installed to a first shipped change. | `"how do I start contributing"` |
| `cinatra-dev-env` | Bring up or refresh the local Cinatra dev / verify stack. | `"bring up the cinatra dev environment"` |
| `extension-conventions` | Conventions for authoring, pinning, and integrating a Cinatra extension. | `"extension repo conventions"` |
| `domain-gotchas` | Per-repo domain traps that have cost real rework (design conformance, release CI, schema fixtures, etc.). | `"domain gotchas"` |

Trigger phrases are matched by Claude Code. See each skill file under
[`skills-src/`](./skills-src/) for the full trigger list and workflow body.

---

## Configuration

### Installer safety model

The installer writes skill files into `~/.claude/` through a layered safety
stack:

- **Preflight guard** — refuses to write the live `~/.claude` unless the
  explicit flag `--i-understand-this-writes-my-real-claude-dir` is passed.
  Tests always run against a sandbox `HOME` so the live config is never
  touched automatically.
- **Containment** — every write and `mkdir` is proven to be inside the target
  Claude directory before the syscall. File writes go through an atomic
  temp-then-rename path so a symlinked destination is never silently
  truncated.
- **Settings merge** — `settings.json` changes use a keyed-sentinel merge that
  never clobbers existing tool or user blocks. An unparseable `settings.json`
  causes the installer to refuse rather than overwrite it.
- **Ownership assertion** — if `~/.claude/dev-core/` already exists but is not
  provably owned by this package (missing or mismatched `.identity`), the
  installer fails closed rather than removing a foreign directory.

### Install source

The installer resolves its source in this order:

1. `--source <path>` — a local pack checkout (used by the tests and local
   development).
2. **This package's own checkout** — when the installer runs from a complete
   pack (the `npx github:cinatra-ai/dev[#<ref>]` / `npx @cinatra-ai/dev` path,
   where the package has already been fetched into place). Installing from the
   fetched tree makes the install reproducible: the ref you pin is the content
   you get, with no second network round-trip.
3. A shallow clone of `cinatra-ai/dev` — a fallback used only when the running
   checkout is not itself a pack.

The skills in this package carry their workflow body **inline**, so no separate
`payload/` directory is required for them to install. If a future build ships a
`payload/` directory, its contents are staged into `~/.claude/dev-core/`
alongside the skills. If you see a "Skipping install (nothing written)" notice,
the resolved source was not a valid pack (no `skills-src/`) — re-run from a
complete checkout or via `npx`.

### Profile selection

Pass `--profile <name>` to install a subset of skills. Without this flag the
`full` profile installs all skills.

---

## Uninstall

```sh
node bin/uninstall.mjs --claude --global \
  --i-understand-this-writes-my-real-claude-dir
```

The same preflight guard applies. The uninstaller removes the installed skill
files (`~/.claude/skills/dev-*`) and agent files (`~/.claude/agents/dev-*.md`),
un-merges only the `settings.json` entries this package wrote (leaving any
user-edited values in place), and removes the `dev-core/` payload directory.
It never touches settings entries owned by other tools.

---

## Release

This package is installed from GitHub today (`npx github:cinatra-ai/dev`) and is
designed to also publish to npm as a public package (`npx @cinatra-ai/dev`) once
the org's npm scope and a release-on-tag workflow are in place.

**To cut a release:**

1. Update the version in `package.json`, `VERSION`, and `version.json` — keep
   all three in sync.
2. Merge the version bump to `main`, then tag the release commit so `npx
   github:cinatra-ai/dev#<tag>` resolves a reproducible, immutable ref. The
   version-check script reads `version.json` from the default branch via the
   GitHub API.
3. (npm end state, owner-gated) Once the scope is registered, the release-on-tag
   workflow publishes the tagged version to npm as a public package.

**To check whether an update is available:**

```sh
node bin/check-latest-version.cjs --json
```

This reads the version from the remote repository via the GitHub API and
compares it to the locally installed version.

---

## Troubleshooting

**The installer refuses with "refusing to install: HOME resolves to the running user's real HOME"**

The preflight guard requires an explicit acknowledgement before writing your
real `~/.claude`. Add the flag:

```sh
node bin/install.mjs --claude --global --i-understand-this-writes-my-real-claude-dir
```

**Skills are not activating after install**

- Confirm the install completed without errors.
- Restart Claude Code after install so the new skill files are picked up.
- Check `~/.claude/skills/` for directories named `dev-<skill>/` each
  containing a `SKILL.md` file.
- Re-run with `--dry-run` (plus the acknowledgement flag) to see what the
  installer would write, then run without `--dry-run` to apply.

**"Skipping install (nothing written)" / clone fallback fails**

When run via `npx` or from a cloned checkout, the installer uses that checkout
directly as its source. The clone fallback only runs if the checkout is not a
valid pack; it fails soft (prints a notice, writes nothing) if `cinatra-ai/dev`
cannot be reached. Re-run from a complete checkout or via
`npx --yes github:cinatra-ai/dev`.

**The installer refuses: "dev-core/ exists but has no .identity marker"**

A directory at `~/.claude/dev-core/` exists that is not owned by this package.
Remove it manually if you intend to replace it:

```sh
rm -rf ~/.claude/dev-core
```

Then re-run the installer.

**The local dev stack won't start**

A stray published-marker artifact in the tree can break a pinned sync. Clean
strays before trusting a refresh. See the
[`cinatra-dev-env` skill](./skills-src/cinatra-dev-env.md) for the full
recipe.

---

## Contributing

Issues and PRs welcome. This package contains no proprietary mechanics.

When contributing:

- Keep skill bodies inside `skills-src/` — one `.md` file per skill.
- Do not push planning or scratch artifacts into this repo; keep them local.
- All CI gates must be green before merging. The org gate suite runs on every
  push.
- Verify your change on the real surface before opening a PR.
