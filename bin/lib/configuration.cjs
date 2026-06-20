"use strict";
// ---------------------------------------------------------------------------
// configuration — config precedence + key-conflict semantics.
//
// Precedence (parity with GSD's configuration.cjs): baked CONFIG_DEFAULTS
// (payload/shared/config-defaults.manifest.json) < project config; deep-merge,
// arrays replaced wholesale. Keys are gated by config-schema.manifest.json
// (validKeys + dynamicKeyPatterns).
//
// Key-conflict semantics (codex finding 5, DESIGN §3.1a):
//   - unknown key (not in validKeys, no dynamicKeyPatterns match) → WARN + drop
//   - invalid value for a known key (wrong type/enum)             → FAIL CLOSED
//   - deprecated key (deprecatedKeys map → canonical)             → WARN + migrate
//   - unknown runtime/tier in model_profile_overrides.*          → WARN + drop
// ---------------------------------------------------------------------------

// Flatten a nested object to dot-path → value (arrays are leaf values).
function flatten(obj, prefix = "", out = {}) {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    if (prefix) out[prefix] = obj;
    return out;
  }
  for (const k of Object.keys(obj)) {
    flatten(obj[k], prefix ? `${prefix}.${k}` : k, out);
  }
  return out;
}

function setPath(obj, dotted, value) {
  const parts = dotted.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur[parts[i]] = cur[parts[i]] || {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function deepMerge(base, override) {
  const out = base === undefined ? {} : JSON.parse(JSON.stringify(base));
  if (override === null || typeof override !== "object" || Array.isArray(override)) {
    return override === undefined ? out : override;
  }
  for (const k of Object.keys(override)) {
    const ov = override[k];
    if (ov && typeof ov === "object" && !Array.isArray(ov) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], ov);
    } else {
      out[k] = ov === undefined ? out[k] : JSON.parse(JSON.stringify(ov === null ? null : ov));
    }
  }
  return out;
}

// Validate a single value against a schema descriptor.
//   descriptor: { type: "boolean"|"string"|"number"|"object", enum?: [...] }
function valueValid(value, descriptor) {
  if (!descriptor) return true;
  if (descriptor.type === "boolean" && typeof value !== "boolean") return false;
  if (descriptor.type === "number" && typeof value !== "number") return false;
  if (descriptor.type === "string" && typeof value !== "string") return false;
  if (descriptor.type === "object" && (typeof value !== "object" || value === null || Array.isArray(value))) return false;
  if (descriptor.enum && !descriptor.enum.includes(value)) return false;
  return true;
}

// Match a dotted key against the dynamicKeyPatterns. Each pattern entry is
// { pattern: <regex string>, value?: <descriptor>, groups?: { name: [allowed] } }.
// `groups` lets us validate captured segments (e.g. the <runtime>/<tier> in
// model_profile_overrides.<runtime>.<tier>): an unknown segment → drop.
function matchDynamic(key, dynamicKeyPatterns) {
  for (const dp of dynamicKeyPatterns || []) {
    const re = new RegExp(dp.pattern);
    const m = key.match(re);
    if (m) return { dp, match: m };
  }
  return null;
}

// loadConfig: merge a parsed project config over the baked defaults, applying
// the conflict semantics. Returns { config, warnings }. Throws (fail-closed) on
// an invalid value for a known key.
//
//   parsed:   the project config object (or {})
//   schema:   { validKeys: { "<dotted>": descriptor }, dynamicKeyPatterns: [...],
//              deprecatedKeys: { "<old>": "<canonical>" } }
//   defaults: the baked CONFIG_DEFAULTS object
function loadConfig(parsed, schema, defaults) {
  const warnings = [];
  const validKeys = (schema && schema.validKeys) || {};
  const dynamic = (schema && schema.dynamicKeyPatterns) || [];
  const deprecated = (schema && schema.deprecatedKeys) || {};

  const incoming = flatten(parsed || {});
  const accepted = {};

  for (const [key, value] of Object.entries(incoming)) {
    // deprecated → migrate
    if (deprecated[key]) {
      const canonical = deprecated[key];
      warnings.push(`deprecated key '${key}' migrated to '${canonical}'`);
      const descriptor = validKeys[canonical];
      if (descriptor && !valueValid(value, descriptor)) {
        const allowed = descriptor.enum ? ` allowed: ${JSON.stringify(descriptor.enum)}` : ` expected ${descriptor.type}`;
        throwInvalid(canonical, value, allowed);
      }
      setPath(accepted, canonical, value);
      continue;
    }

    // exact validKey
    if (Object.prototype.hasOwnProperty.call(validKeys, key)) {
      const descriptor = validKeys[key];
      if (!valueValid(value, descriptor)) {
        const allowed = descriptor.enum ? ` allowed: ${JSON.stringify(descriptor.enum)}` : ` expected ${descriptor.type}`;
        throwInvalid(key, value, allowed);
      }
      setPath(accepted, key, value);
      continue;
    }

    // dynamic pattern
    const dyn = matchDynamic(key, dynamic);
    if (dyn) {
      // validate captured groups (e.g. unknown runtime/class → drop)
      if (dyn.dp.groups) {
        let dropped = false;
        const names = Object.keys(dyn.dp.groups);
        for (let i = 0; i < names.length; i++) {
          const captured = dyn.match[i + 1];
          const allowed = dyn.dp.groups[names[i]];
          if (allowed && captured !== undefined && !allowed.includes(captured)) {
            warnings.push(`unknown ${names[i]} '${captured}' in '${key}' — override dropped`);
            dropped = true;
            break;
          }
        }
        if (dropped) continue;
      }
      if (dyn.dp.value && !valueValid(value, dyn.dp.value)) {
        const d = dyn.dp.value;
        const allowed = d.enum ? ` allowed: ${JSON.stringify(d.enum)}` : ` expected ${d.type}`;
        throwInvalid(key, value, allowed);
      }
      setPath(accepted, key, value);
      continue;
    }

    // unknown → warn + drop
    warnings.push(`unknown config key '${key}' ignored`);
  }

  const config = deepMerge(defaults || {}, accepted);
  return { config, warnings };
}

function throwInvalid(key, value, allowedMsg) {
  const err = new Error(`invalid value for '${key}': ${JSON.stringify(value)}.${allowedMsg}`);
  err.code = "CONFIG_INVALID_VALUE";
  throw err;
}

module.exports = { loadConfig, deepMerge, flatten, valueValid, matchDynamic };
