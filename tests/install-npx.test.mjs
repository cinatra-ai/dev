// tests/install-npx.test.mjs — the npx-installability + no-payload pack contract.
//
// This pack is the PUBLIC dev-skills pack: its skills carry their workflow body
// INLINE and it ships NO payload/ directory. These tests prove that:
//   1. `npx github:cinatra-ai/dev` works — i.e. the installer can install from
//      THIS package's own checkout (the fetched tree), without a re-clone.
//   2. A no-payload pack installs successfully and stages real skill files.
//   3. The converter emits a SELF-CONTAINED launcher (no dangling
//      @-include of a payload workflow that does not exist on disk).
//   4. --dry-run writes nothing and reports a plan.
//   5. uninstall removes the dev-* artifacts it staged.
//   6. The three version files (package.json, VERSION, version.json) agree.
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

// The pack ships skills inline with no payload/ — assert that precondition so
// these tests stay honest about WHAT they are proving.
test("precondition: this pack carries skills-src/ and no payload/ (self-contained public pack)", () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "skills-src")), "skills-src/ must exist");
  const skills = fs.readdirSync(path.join(REPO_ROOT, "skills-src")).filter((f) => f.endsWith(".md"));
  assert.ok(skills.length >= 1, "at least one source skill");
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
  const srcSkills = fs.readdirSync(path.join(REPO_ROOT, "skills-src"))
    .filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
  for (const stem of srcSkills) {
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

test("fail-closed: a --source with no skills-src/ (or no bin/) SKIPS with notice, writes nothing", () => {
  const sb = makeSandbox("failclosed");
  // A directory that has a payload/ but NO skills-src/ and NO bin/ is not a
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

test("version alignment: package.json == VERSION == version.json", () => {
  const pkg = readJson(path.join(REPO_ROOT, "package.json")).version;
  const ver = fs.readFileSync(path.join(REPO_ROOT, "VERSION"), "utf8").trim();
  const vj = readJson(path.join(REPO_ROOT, "version.json")).version;
  assert.equal(pkg, ver, "package.json version must equal VERSION");
  assert.equal(pkg, vj, "package.json version must equal version.json version");
});
