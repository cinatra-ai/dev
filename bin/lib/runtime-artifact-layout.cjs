"use strict";
// ---------------------------------------------------------------------------
// runtime-artifact-layout — resolve, for a (runtime, scope), the on-disk
// locations the installer stages into. Mirrors GSD's
// runtime-artifact-layout.cjs:resolveRuntimeArtifactLayout, scoped to what W0
// needs (claude global is the parity path; codex is reserved for #191 shadcn).
// ---------------------------------------------------------------------------

const os = require("node:os");
const path = require("node:path");
const { NAMESPACE } = require("../package-identity.cjs");

// The canonical Claude config dir for a given HOME. Centralized so the HOME
// preflight (preflight.cjs) and the layout resolver agree on exactly one path.
function claudeConfigDir(home) {
  return path.join(home, ".claude");
}

// The Codex skills dir (for #191 shadcn-for-Codex, later wave). $CODEX_HOME
// wins; default ~/.codex.
function codexSkillsDir(env) {
  const codexHome = (env && env.CODEX_HOME) || path.join(os.homedir(), ".codex");
  return path.join(codexHome, "skills");
}

// Resolve the staging layout. Returns an object of absolute dirs/files the
// installer will write, plus the payload root.
//
//   runtime: "claude" (only claude is wired in W0)
//   scope:   "global" (parity path) — "local" reserved
//   home:    the HOME the install targets (sandbox in tests; real in prod)
function resolveRuntimeArtifactLayout({ runtime = "claude", scope = "global", home } = {}) {
  if (!home) throw new Error("resolveRuntimeArtifactLayout: home is required");
  if (runtime !== "claude") {
    throw new Error(`runtime '${runtime}' not supported in this build (only 'claude')`);
  }
  if (scope !== "global") {
    throw new Error(`scope '${scope}' not supported in this build (only 'global')`);
  }

  // Normalize HOME to an absolute path ONCE so every derived path this function
  // advertises is absolute even when called with a relative HOME.
  const resolvedHome = path.resolve(home);
  const configDir = claudeConfigDir(resolvedHome);
  return {
    runtime,
    scope,
    home: resolvedHome,
    configDir,
    // payload engine dir (mirror of ~/.claude/gsd-core/)
    payloadDir: path.join(configDir, `${NAMESPACE}-core`),
    // native autoload dirs
    skillsDir: path.join(configDir, "skills"), // each skill → skills/dev-<name>/SKILL.md
    agentsDir: path.join(configDir, "agents"), // each agent → agents/dev-<name>.md
    hooksDir: path.join(configDir, "hooks"), // dev-* hook scripts
    // settings + state
    settingsFile: path.join(configDir, "settings.json"),
    fileManifest: path.join(configDir, `${NAMESPACE}-file-manifest.json`),
    installState: path.join(configDir, `${NAMESPACE}-install-state.json`),
    profileMarker: path.join(configDir, `.${NAMESPACE}-profile`),
    pristineDir: path.join(configDir, `${NAMESPACE}-pristine`),
    localPatchesDir: path.join(configDir, `${NAMESPACE}-local-patches`),
    identityFile: path.join(configDir, `${NAMESPACE}-core`, ".identity"),
  };
}

module.exports = { resolveRuntimeArtifactLayout, claudeConfigDir, codexSkillsDir };
