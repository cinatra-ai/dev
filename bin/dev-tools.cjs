#!/usr/bin/env node
"use strict";
// ---------------------------------------------------------------------------
// dev-tools — the deterministic SDK CLI that dev-* skills shell out to.
//
// Parity with GSD's gsd-tools.cjs: deterministic operations (model resolution,
// install-context, leak scan, version) go through this shim so a skill never
// makes them an LLM free-choice (no drift). It resolves the staged payload
// (~/.claude/dev-core/) first, then the in-repo payload when run from source.
//
// Subcommands:
//   route --class <c> [--runtime r] [--json]      resolve model for a task class
//   route --skill <id> [--runtime r] [--json]     resolve model for a dispatching skill
//   update-context [--json]                       installed version + payload dir
//   doctor [--json]                               READ-ONLY toolchain/env probe (#129)
//   global-settings-diff [--json]                 READ-ONLY global-baseline drift (#129)
//   shadcn-install [--home d] [--codex-home d]    install upstream shadcn for
//                  [--force] [--json]             BOTH Claude AND Codex (#191)
//   version                                       print pack version
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { NAMESPACE } = require("./package-identity.cjs");
const modelCatalog = require("./lib/model-catalog.cjs");

function payloadDir() {
  const staged = path.join(os.homedir(), ".claude", `${NAMESPACE}-core`);
  if (fs.existsSync(path.join(staged, "shared", "model-catalog.json"))) return staged;
  return path.join(__dirname, "..", "payload"); // run-from-source
}

function catalogPath() {
  return path.join(payloadDir(), "shared", "model-catalog.json");
}

function readVersion() {
  for (const c of [path.join(payloadDir(), "VERSION"), path.join(__dirname, "..", "VERSION")]) {
    try { return fs.readFileSync(c, "utf8").trim(); } catch { /* next */ }
  }
  return "unknown";
}

function parseFlags(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { flags[key] = next; i++; }
      else flags[key] = true;
    }
  }
  return flags;
}

function emit(obj, json) {
  if (json) process.stdout.write(JSON.stringify(obj) + "\n");
  else process.stdout.write((typeof obj === "string" ? obj : JSON.stringify(obj, null, 2)) + "\n");
}

function cmdRoute(argv) {
  const flags = parseFlags(argv);
  const catalog = modelCatalog.loadCatalog(catalogPath());
  const runtime = flags.runtime || "claude";
  let result;
  if (flags.skill) {
    result = modelCatalog.resolveForSkill(flags.skill, { catalog, runtime });
  } else if (flags.class) {
    result = modelCatalog.resolveModel(flags.class, { catalog, runtime });
  } else {
    console.error("route: pass --class <c> or --skill <id>");
    process.exit(2);
  }
  emit(result, Boolean(flags.json));
}

function cmdUpdateContext(argv) {
  const flags = parseFlags(argv);
  emit({
    package: `@cinatra-ai/${NAMESPACE}`,
    version: readVersion(),
    payloadDir: payloadDir(),
    runtime: flags.runtime || "claude",
  }, Boolean(flags.json));
}

// Resolve the effective `currency.dependency` knob: the baked default
// (config-defaults.manifest.json) overlaid by a project .cinatra-dev/config.json
// if one is present in CWD. Best-effort + fail-safe — a bad/missing config falls
// back to the baked default ("notify-only"), never throws in the doctor path.
function resolveCurrencyKnob() {
  try {
    const cfg = require("./lib/configuration.cjs");
    const defaults = require(path.join(payloadDir(), "shared", "config-defaults.manifest.json"));
    const schema = require(path.join(payloadDir(), "shared", "config-schema.manifest.json"));
    let parsed = {};
    const projPath = path.join(process.cwd(), ".cinatra-dev", "config.json");
    if (fs.existsSync(projPath)) {
      try { parsed = JSON.parse(fs.readFileSync(projPath, "utf8")); } catch { parsed = {}; }
    }
    // loadConfig returns { config, warnings } — read the merged `config`.
    const { config } = cfg.loadConfig(parsed, schema, defaults);
    return (config && config.currency && config.currency.dependency) || "notify-only";
  } catch {
    return "notify-only";
  }
}

// doctor — READ-ONLY toolchain/currency/global-settings probe (#129). Never
// writes; spawns only read-only version/status/path commands (doctor.cjs owns
// the spawn safety). Exit 1 when any check FAILS so a script/CI can gate on it;
// warnings keep exit 0.
function cmdDoctor(argv) {
  const flags = parseFlags(argv);
  const doctor = require("./lib/doctor.cjs");
  const gsb = require("./lib/global-settings-baseline.cjs");
  const checks = doctor.runToolchain();
  const settings = gsb.computeDiff();
  const sum = doctor.summarize(checks);
  const currencyKnob = resolveCurrencyKnob();
  const currency = doctor.currencyStatus(currencyKnob, { online: false });
  const report = {
    package: `@cinatra-ai/${NAMESPACE}`,
    version: readVersion(),
    summary: sum,
    checks,
    currency,
    globalSettings: { anyDrift: settings.anyDrift, attribution: settings.attribution, items: settings.items },
  };
  if (flags.json) { emit(report, true); }
  else {
    const lines = [`dev-doctor (read-only) — ${report.package} ${report.version}`, ""];
    for (const c of checks) {
      const mark = c.status === "ok" ? "OK  " : c.status === "warn" ? "WARN" : "FAIL";
      lines.push(`[${mark}] ${c.label}: ${c.detail}`);
      if (c.fix && c.status !== "ok") lines.push(`        fix: ${c.fix}`);
    }
    lines.push("", `Toolchain currency (${currency.mode}): ${currency.status} — ${currency.detail}`);
    if (currency.command) lines.push(`        check: ${currency.command}`);
    lines.push("", "Global Claude baseline:", gsb.renderDiff(settings));
    lines.push("", `summary: ${sum.counts.ok} ok / ${sum.counts.warn} warn / ${sum.counts.fail} fail`);
    emit(lines.join("\n"), false);
  }
  process.exit(sum.verdict === "fail" ? 1 : 0);
}

// global-settings-diff — READ-ONLY exact diffs for the machine-global baseline
// (#129 §4.3). Applying is done by the dev-setup skill (--apply), not here.
function cmdGlobalSettingsDiff(argv) {
  const flags = parseFlags(argv);
  const gsb = require("./lib/global-settings-baseline.cjs");
  const diff = gsb.computeDiff();
  if (flags.json) emit(diff, true);
  else emit(gsb.renderDiff(diff), false);
  process.exit(diff.anyDrift ? 1 : 0);
}

function cmdShadcnInstall(argv) {
  // deterministic install path for #191 item C: install the pinned upstream
  // shadcn skill into BOTH the Claude and Codex skill dirs. SAFETY: defaults to
  // process.env.HOME / CODEX_HOME; the real ~/.codex is refused without --force
  // (the Claude leg is independently guarded by W0 containment). Tests + the
  // workflow pass a sandbox --home / --codex-home.
  const flags = parseFlags(argv);
  const shadcn = require("./lib/shadcn-install.cjs");
  // A value-bearing flag passed WITHOUT a value yields boolean `true` from
  // parseFlags; reject that rather than letting a boolean flow in as a path.
  for (const k of ["home", "codex-home"]) {
    if (flags[k] === true) {
      emit({ ok: false, code: "SHADCN_BAD_FLAG", error: `--${k} requires a directory value` }, true);
      process.exit(2);
    }
  }
  const home = (typeof flags.home === "string" && flags.home) || process.env.HOME || os.homedir();
  const codexHome = typeof flags["codex-home"] === "string" ? flags["codex-home"] : undefined;
  try {
    const res = shadcn.installShadcnForBothTools({
      home,
      codexHome,
      force: Boolean(flags.force),
    });
    emit({ ok: true, ...res }, Boolean(flags.json));
  } catch (e) {
    emit({ ok: false, code: e.code || "SHADCN_INSTALL_FAILED", error: e.message }, true);
    process.exit(1);
  }
}

function main() {
  const [, , sub, ...rest] = process.argv;
  switch (sub) {
    case "route": return cmdRoute(rest);
    case "update-context": return cmdUpdateContext(rest);
    case "doctor": return cmdDoctor(rest);
    case "global-settings-diff": return cmdGlobalSettingsDiff(rest);
    case "shadcn-install": return cmdShadcnInstall(rest);
    case "version": return emit(readVersion(), false);
    default:
      console.error("dev-tools: unknown subcommand. Use: route | update-context | doctor | global-settings-diff | shadcn-install | version");
      process.exit(2);
  }
}

if (require.main === module) main();

module.exports = { payloadDir, catalogPath, readVersion };
