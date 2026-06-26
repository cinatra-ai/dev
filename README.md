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

This package is **not published to npm**. Access and distribution are via this
GitHub repository — having access to the repo is the access gate. Skill
source lives in [`skills-src/`](./skills-src/).

**What belongs here vs elsewhere:** skills that guide *how to develop with
Cinatra* live here. Runtime application code, extension source, and
organisation-internal runbooks live in their own repos.

---

## Requirements

- Node.js 20 or later
- Git (the installer clones this repo as its source)
- Claude Code (the skills are installed into the global Claude profile)

---

## Install

Clone this repository, then run the installer:

```sh
git clone https://github.com/cinatra-ai/dev.git
cd dev
node bin/install.mjs --claude --global --i-understand-this-writes-my-real-claude-dir
```

The `--i-understand-this-writes-my-real-claude-dir` flag is required. The
installer's preflight guard refuses to write your real `~/.claude` directory
without an explicit acknowledgement — see [Configuration](#configuration) for
why.

To preview what would be written without making any changes, add `--dry-run`.
The preflight runs before dry-run handling, so the acknowledgement flag is
still required:

```sh
node bin/install.mjs --claude --global --dry-run \
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

Without `--source`, the installer clones the default branch of this repo from
GitHub at install time — the clone is the source, not the local directory you
cloned to check out this file. The installer requires network access and git
credentials capable of reaching this repo.

The installer copies the `payload/` directory from the cloned source into
`~/.claude/dev-core/`. This directory must be present in the repo for the
install to complete. If you see a "Skipping install (nothing written)" notice,
confirm the repo is in a complete release state.

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

This package is distributed via git, not npm. The installer always clones the
default branch HEAD at install time, so updating means re-running the installer
after changes land on `main`.

**To cut a release:**

1. Update the version in `package.json`, `VERSION`, and `version.json` — keep
   all three in sync.
2. Merge the version bump to `main`. The installer clones the default branch
   head at install time; the version-check script reads `version.json` from
   the default branch via the GitHub API. There is no npm publish step.

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

**Clone fails during install ("could not clone…")**

The installer clones this repo from GitHub as its install source. Confirm you
have a working git credential capable of reaching `cinatra-ai/dev`. The
installer fails soft on a clone error — it prints a notice and writes nothing.

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
