"use strict";
// ---------------------------------------------------------------------------
// package-identity — the single locked identity of this pack.
//
// Mirrors GSD's bin/lib/package-identity.cjs: the package/repo name is a hard
// code constant, not an LLM- or arg-derived value, so check-latest-version,
// clone-source resolution, and the ~/.claude/dev-core/.identity ownership
// assertion can never drift to a typosquat or a foreign fork squatting the
// generic `dev-` prefix.
// ---------------------------------------------------------------------------

// The npm-style package name (informational; this pack is NOT published to npm).
const PACKAGE_NAME = "@cinatra-ai/dev";

// The GitHub repo this pack is distributed from. The clone of THIS repo is the
// access gate (privacy = access). check-latest-version.cjs and the installer's
// clone-source both key on this constant.
const REPO_SLUG = "cinatra-ai/dev";
const REPO_HTTPS = `https://github.com/${REPO_SLUG}.git`;
const REPO_SSH = `git@github.com:${REPO_SLUG}.git`;

// The on-disk namespace prefix for every staged artifact (skills, agents,
// state files) and the payload dir name. Chosen to co-exist with a live GSD
// install (`gsd-*`) on the same machine — zero collision.
const NAMESPACE = "dev";

module.exports = Object.freeze({
  PACKAGE_NAME,
  REPO_SLUG,
  REPO_HTTPS,
  REPO_SSH,
  NAMESPACE,
});
