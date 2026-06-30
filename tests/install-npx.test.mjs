// tests/install-npx.test.mjs — the native-plugin layout + npx-installability
// contract.
//
// This pack is the PUBLIC foundation plugin: its skills carry their workflow
// body INLINE and it ships NO payload/ directory. Skills live in the native
// Claude Code plugin layout skills/<name>/SKILL.md, and the same tree backs the
// legacy npx installer (one source of truth). These tests prove that:
//   1. `npx github:cinatra-ai/dev` works — i.e. the installer can install from
//      THIS package's own checkout (the fetched tree), without a re-clone.
//   2. A no-payload pack installs successfully and stages real skill files.
//   3. The converter emits a SELF-CONTAINED launcher (no dangling
//      @-include of a payload workflow that does not exist on disk).
//   4. --dry-run writes nothing and reports a plan.
//   5. uninstall removes the dev-* artifacts it staged.
//   6. The native-plugin manifests are present and internally consistent
//      (plugin.json <-> marketplace.json name + version agree); the retired
//      self-updater files (VERSION/version.json/check-latest-version.cjs) are
//      gone.
//
// ALL execution targets a SANDBOX HOME — never the real ~/.claude.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(__dirname, "..");

const install = await import("../bin/install.mjs");
const uninstall = await import("../bin/uninstall.mjs");
const profiles = await import("../bin/lib/install-profiles.cjs");

function makeSandbox(label) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `dev-npx-${label}-`));
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  return { home, claude: path.join(home, ".claude") };
}
function readJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }
function rmrf(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }

// Discover the source skill stems in the native-plugin layout
// (skills/<stem>/SKILL.md) — the same shape the installer and Claude Code's
// plugin loader both read.
function sourceStems(root) {
  const skillsDir = path.join(root, "skills");
  if (!fs.existsSync(skillsDir)) return [];
  return fs
    .readdirSync(skillsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(skillsDir, d.name, "SKILL.md")))
    .map((d) => d.name);
}

// The pack ships skills inline in the native-plugin layout with no payload/ —
// assert that precondition so these tests stay honest about WHAT they prove.
test("precondition: this pack carries skills/<name>/SKILL.md and no payload/ (self-contained public plugin)", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "skills")), "skills/ must exist");
  assert.ok(sourceStems(REPO_ROOT).length >= 1, "at least one source skill");
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "payload")), false, "this public pack ships no payload/");
});

test("install from THIS package's own checkout (the npx path) stages skills without --source", () => {
  const sb = makeSandbox("self");
  // No --source: the installer must fall back to its OWN checkout (REPO_ROOT),
  // exactly as it would when run via `npx github:cinatra-ai/dev`. No re-clone.
  const res = install.run(["--claude", "--global", "--home", sb.home]);

  assert.notEqual(res.skipped, true, `must not skip-with-notice: ${res.reason || ""}`);
  assert.equal(res.refused, undefined, `must not be refused: ${res.reason || ""}`);
  assert.equal(res.installed, true, "must report installed");
  assert.ok(res.stagedSkillCount >= 1, "at least one skill staged");
  assert.equal(res.plan.hasPayload, false, "no payload/ in this pack");
  assert.equal(res.plan.source, REPO_ROOT, "source must be this package's own checkout, not a clone");

  // A real, named public skill must be on disk.
  const onboard = path.join(sb.claude, "skills", "dev-onboarding", "SKILL.md");
  assert.ok(fs.existsSync(onboard), "dev-onboarding/SKILL.md must be staged");

  rmrf(sb.home);
});

test("no-payload --source installs and stages every source skill", () => {
  const sb = makeSandbox("nopayload");
  const res = install.run(["--claude", "--global", "--home", sb.home, "--source", REPO_ROOT]);

  assert.equal(res.installed, true, `expected install, got: ${JSON.stringify(res)}`);
  for (const stem of sourceStems(REPO_ROOT)) {
    assert.ok(
      fs.existsSync(path.join(sb.claude, "skills", `dev-${stem}`, "SKILL.md")),
      `dev-${stem}/SKILL.md must be staged`
    );
  }
  rmrf(sb.home);
});

test("converter emits a SELF-CONTAINED launcher (no dangling payload @-include) when no payload workflow", () => {
  const sb = makeSandbox("selfcontained");
  install.run(["--claude", "--global", "--home", sb.home, "--source", REPO_ROOT]);

  const onboard = fs.readFileSync(
    path.join(sb.claude, "skills", "dev-onboarding", "SKILL.md"),
    "utf8"
  );
  // It must NOT reference a payload workflow that does not exist on disk.
  assert.doesNotMatch(
    onboard,
    /@\$HOME\/\.claude\/dev-core\/workflows\/onboarding\.md/,
    "self-contained skill must not @-include a missing payload workflow"
  );
  // And it must keep its real inline body (the launcher is not empty).
  assert.match(onboard, /name:\s*dev-onboarding/, "launcher keeps the namespaced name");
  assert.ok(onboard.trim().length > 200, "launcher carries its inline body");

  rmrf(sb.home);
});

test("converter still injects the @-include when a payload workflow IS present (split form unchanged)", () => {
  // Direct unit check: the split-launcher behaviour is preserved for packs that
  // DO ship payload/workflows/<stem>.md (the private full pack).
  const src = "---\nname: x\ndescription: y\n---\n\nBODY\n";
  const split = profiles.convertSourceToSkill(src, "x", { hasPayloadWorkflow: true });
  assert.match(split, /@\$HOME\/\.claude\/dev-core\/workflows\/x\.md/, "split form must @-include");
  const inline = profiles.convertSourceToSkill(src, "x", { hasPayloadWorkflow: false });
  assert.doesNotMatch(inline, /<execution_context>/, "self-contained form must not inject an include");
  assert.match(inline, /BODY/, "self-contained form keeps the inline body");
});

test("legacy install rewrites the engine path: setup launcher resolves dev-tools under the staged dev-core/, not $CLAUDE_PLUGIN_ROOT", () => {
  const sb = makeSandbox("enginepath");
  install.run(["--claude", "--global", "--home", sb.home]);

  const setup = fs.readFileSync(
    path.join(sb.claude, "skills", "dev-setup", "SKILL.md"),
    "utf8"
  );
  // The native-plugin var must NOT survive into a non-plugin install runtime.
  assert.doesNotMatch(setup, /\$CLAUDE_PLUGIN_ROOT/, "legacy launcher must not reference $CLAUDE_PLUGIN_ROOT");
  // It must point at the engine the installer actually staged.
  assert.match(
    setup,
    /\$HOME\/\.claude\/dev-core\/bin\/dev-tools\.cjs/,
    "legacy launcher must resolve the staged dev-core engine"
  );
  // The staged engine itself must be on disk.
  assert.ok(
    fs.existsSync(path.join(sb.claude, "dev-core", "bin", "dev-tools.cjs")),
    "dev-core/bin/dev-tools.cjs must be staged"
  );
  // And the staged engine must resolve its version from the staged VERSION
  // (no .claude-plugin/ alongside the staged dev-core/, no model-catalog).
  assert.ok(
    fs.existsSync(path.join(sb.claude, "dev-core", "VERSION")),
    "dev-core/VERSION must be staged so the engine can report a version"
  );
  rmrf(sb.home);
});

test("--dry-run writes nothing and returns a plan", () => {
  const sb = makeSandbox("dry");
  const res = install.run(["--claude", "--global", "--home", sb.home, "--dry-run"]);
  assert.equal(res.dryRun, true, "must report dry-run");
  assert.ok(res.plan && res.plan.skills.length >= 1, "plan lists skills");
  assert.equal(fs.existsSync(path.join(sb.claude, "skills", "dev-onboarding")), false, "dry-run writes nothing");
  rmrf(sb.home);
});

test("uninstall removes the dev-* artifacts a no-payload install staged", () => {
  const sb = makeSandbox("uninstall");
  install.run(["--claude", "--global", "--home", sb.home]);
  assert.ok(fs.existsSync(path.join(sb.claude, "skills", "dev-onboarding")), "installed first");

  const un = uninstall.run(["--claude", "--global", "--home", sb.home]);
  assert.notEqual(un.refused, true, `uninstall refused: ${un.reason || ""}`);
  assert.equal(fs.existsSync(path.join(sb.claude, "skills", "dev-onboarding")), false, "skill removed");
  assert.equal(fs.existsSync(path.join(sb.claude, "dev-core")), false, "dev-core removed");
  rmrf(sb.home);
});

test("fail-closed: a --source with no skills/ (or no bin/) SKIPS with notice, writes nothing", () => {
  const sb = makeSandbox("failclosed");
  // A directory that has a payload/ but NO skills/ and NO bin/ is not a
  // complete pack — staging it would write zero skills. Must skip, not install.
  const fakeSrc = path.join(sb.home, "fakepack");
  fs.mkdirSync(path.join(fakeSrc, "payload", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(fakeSrc, "payload", "workflows", "x.md"), "# x\n");

  const res = install.run(["--claude", "--global", "--home", sb.home, "--source", fakeSrc]);
  assert.equal(res.skipped, true, "an incomplete pack must skip-with-notice");
  assert.match(res.reason || "", /not a complete pack source/, "skip reason names the missing pieces");
  assert.equal(fs.existsSync(path.join(sb.claude, "dev-core")), false, "nothing written");
  rmrf(sb.home);
});

test("fail-closed: a source where skills/ or bin/ is a FILE (not a dir) SKIPS with notice", () => {
  const sb = makeSandbox("nondir");
  // skills is a plain file, bin is a plain file — neither is a usable tree.
  const fakeSrc = path.join(sb.home, "nondirpack");
  fs.mkdirSync(fakeSrc, { recursive: true });
  fs.writeFileSync(path.join(fakeSrc, "skills"), "not a dir\n");
  fs.writeFileSync(path.join(fakeSrc, "bin"), "not a dir\n");

  const res = install.run(["--claude", "--global", "--home", sb.home, "--source", fakeSrc]);
  assert.equal(res.skipped, true, "a non-directory skills/ or bin/ must skip-with-notice, not throw");
  assert.equal(fs.existsSync(path.join(sb.claude, "dev-core")), false, "nothing written");
  rmrf(sb.home);
});

test("the staged payload version is stamped from the RESOLVED SOURCE manifest", () => {
  const sb = makeSandbox("srcversion");
  // Stage from THIS checkout; the staged dev-core/VERSION must equal the
  // source's .claude-plugin/plugin.json version (not a hard-coded constant).
  install.run(["--claude", "--global", "--home", sb.home, "--source", REPO_ROOT]);
  const stamped = fs.readFileSync(path.join(sb.claude, "dev-core", "VERSION"), "utf8").trim();
  const manifestVersion = readJson(path.join(REPO_ROOT, ".claude-plugin", "plugin.json")).version;
  assert.equal(stamped, manifestVersion, "staged VERSION must match the source plugin.json version");
  rmrf(sb.home);
});

test("native-plugin manifests are present and internally consistent; legacy self-updater files are retired", () => {
  const pluginPath = path.join(REPO_ROOT, ".claude-plugin", "plugin.json");
  const marketplacePath = path.join(REPO_ROOT, ".claude-plugin", "marketplace.json");
  assert.ok(fs.existsSync(pluginPath), ".claude-plugin/plugin.json must exist");
  assert.ok(fs.existsSync(marketplacePath), ".claude-plugin/marketplace.json must exist");

  const plugin = readJson(pluginPath);
  const marketplace = readJson(marketplacePath);

  // plugin.json carries an explicit semver and a name.
  assert.match(plugin.version, /^\d+\.\d+\.\d+/, "plugin.json version must be semver");
  assert.ok(plugin.name && plugin.name.length > 0, "plugin.json must have a name");

  // The marketplace must list exactly this plugin, with matching name + version.
  const entry = (marketplace.plugins || []).find((p) => p.name === plugin.name);
  assert.ok(entry, "marketplace.json must list the plugin by its plugin.json name");
  assert.equal(entry.version, plugin.version, "marketplace plugin version must match plugin.json");
  assert.equal(entry.source, ".", "single-repo plugin source must be '.'");

  // Every native-plugin skill dir holds a SKILL.md (the auto-discovery layout).
  const stems = sourceStems(REPO_ROOT);
  assert.ok(stems.length >= 1, "at least one skills/<name>/SKILL.md");

  // The retired self-updater files must be gone.
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "VERSION")), false, "VERSION retired");
  assert.equal(fs.existsSync(path.join(REPO_ROOT, "version.json")), false, "version.json retired");
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, "bin", "check-latest-version.cjs")),
    false,
    "check-latest-version.cjs retired"
  );
});
