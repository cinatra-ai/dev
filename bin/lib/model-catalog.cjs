"use strict";
// ---------------------------------------------------------------------------
// model-catalog — the resolver every dispatching skill uses to pick its model.
//
// Resolution chain (DESIGN §3.1):
//   1. task-class -> tier (taskClasses[class].tier)
//   2. tier -> concrete model id for the runtime (runtimeTierDefaults[runtime][tier])
//      (falls back to tiers[tier].model when no per-runtime id)
//   3. per-machine override: model_profile_overrides.<runtime>.<tier> wins over
//      the baked default (an unknown runtime/class override is ignored upstream
//      by configuration.cjs WARN+drop).
// Returns { model, reasoning_effort, tier, class, source }.
//
// This module is what makes the #128 acceptance bar testable: a dispatching
// skill resolves its model FROM this catalog (routing.test.mjs).
// ---------------------------------------------------------------------------

const fs = require("node:fs");
const path = require("node:path");

function loadCatalog(catalogPath) {
  const p = catalogPath || path.join(__dirname, "..", "..", "payload", "shared", "model-catalog.json");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// Resolve the effective model for a task class.
//   class:    a key of taskClasses (e.g. "extension-architecture")
//   runtime:  "claude" | "codex" | ... (default "claude")
//   catalog:  the parsed model-catalog.json
//   overrides: optional { model_profile_overrides: { <runtime>: { <tier>: { model } } } }
function resolveModel(taskClass, { runtime = "claude", catalog, overrides } = {}) {
  if (!catalog) throw new Error("resolveModel: catalog is required");
  const classDef = catalog.taskClasses && catalog.taskClasses[taskClass];
  if (!classDef) {
    const known = Object.keys(catalog.taskClasses || {}).join(", ");
    throw new Error(`unknown task class '${taskClass}' (known: ${known})`);
  }
  const tier = classDef.tier;
  const tierDef = catalog.tiers && catalog.tiers[tier];
  if (!tierDef) throw new Error(`task class '${taskClass}' references unknown tier '${tier}'`);

  const reasoning = tierDef.reasoning_effort;

  // baked per-runtime concrete id. FAIL CLOSED for an unknown runtime / missing
  // per-runtime tier mapping rather than falling back to tierDef.model — that
  // fallback carries a CLAUDE-tier id and would emit an invalid model id for a
  // non-Claude runtime (e.g. codex). The catalog must define every supported
  // runtime's tier ids explicitly.
  const rt = catalog.runtimeTierDefaults && catalog.runtimeTierDefaults[runtime];
  if (!rt) {
    const known = Object.keys(catalog.runtimeTierDefaults || {})
      .filter((k) => !k.startsWith("$"))
      .join(", ");
    throw new Error(`unsupported runtime '${runtime}' (no runtimeTierDefaults entry; known: ${known})`);
  }
  if (!rt[tier] || !rt[tier].model) {
    throw new Error(`runtime '${runtime}' has no model mapping for tier '${tier}'`);
  }
  let model = rt[tier].model;
  let source = "baked-default";

  // per-machine override
  const ov =
    overrides &&
    overrides.model_profile_overrides &&
    overrides.model_profile_overrides[runtime] &&
    overrides.model_profile_overrides[runtime][tier];
  if (ov && ov.model) {
    model = ov.model;
    source = "machine-override";
  }

  return { model, reasoning_effort: reasoning, tier, class: taskClass, runtime, source };
}

// Resolve for a dispatching skill by its catalog row.
function resolveForSkill(skillId, opts = {}) {
  const catalog = opts.catalog || loadCatalog(opts.catalogPath);
  const row = catalog.agents && catalog.agents[skillId];
  if (!row || !row.taskClass) {
    throw new Error(`skill '${skillId}' has no routing row / taskClass in the model catalog`);
  }
  return resolveModel(row.taskClass, { ...opts, catalog });
}

module.exports = { loadCatalog, resolveModel, resolveForSkill };
