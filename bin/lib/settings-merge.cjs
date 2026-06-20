"use strict";
// ---------------------------------------------------------------------------
// settings-merge — deep-merge the pack's hooks block into ~/.claude/settings.json
// WITHOUT clobbering an existing GSD/user block (W0 acceptance + codex finding 3).
//
// Contract (DESIGN §2.5):
//  - Deep-merge: append our hook entries into the existing hooks.<event>[]
//    arrays; never replace an array. Match-on-key (stable, value-independent) so
//    re-running is idempotent and never duplicates.
//  - Leave every foreign entry (GSD, user) exactly as found.
//  - Keyed-sentinel ownership: record { owner, appliedValue: sha256(entry) } for
//    each entry we add, in a SIDECAR ownership map (not inline) so the settings
//    file stays schema-clean. On un-merge we remove an entry ONLY if its current
//    value still hashes to the recorded appliedValue; a user-edited (diverged)
//    entry is left in place with a notice.
//
// Pure functions over plain objects; no fs here (install.mjs owns I/O) so this
// is trivially unit-testable.
// ---------------------------------------------------------------------------

const crypto = require("node:crypto");

const OWNER = "cinatra-dev";

function sha256(obj) {
  // Stable stringify (sorted keys) so the hash is order-independent.
  return crypto.createHash("sha256").update(stableStringify(obj)).digest("hex");
}

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
}

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

// The STABLE identity of a hook entry within an event array, used for both
// idempotent merge and ownership tracking. It must NOT depend on the entry
// VALUE (command): a user editing a dev-owned entry's command must keep the SAME
// identity so the un-merge recognizes it as a diverged owned entry (kept, not
// clobbered) rather than a brand-new foreign one.
//
// A Claude/reference-installer hook entry is { matcher?, hooks: [...] } or flat
// { type, command }. We key on the matcher when present (each cinatra/dev entry
// carries a unique matcher, e.g. ".cinatra-dev/config.json"); matcher-less
// foreign entries fall back to a command-set key so they still get a stable id.
function hookEntryKey(entry) {
  if (entry && entry.matcher !== undefined && entry.matcher !== "") {
    return "m:" + String(entry.matcher);
  }
  let commands = [];
  if (entry && Array.isArray(entry.hooks)) {
    commands = entry.hooks.map((h) => (h && h.command ? String(h.command) : JSON.stringify(h)));
  } else if (entry && entry.command) {
    commands = [String(entry.command)];
  } else {
    commands = [JSON.stringify(entry)];
  }
  return "c:" + commands.slice().sort().join("|");
}

// Merge `block` (the pack's hooks block, shape { hooks: { <event>: [entries] } })
// into `settings`. Returns { settings, ownership } where ownership is the
// keyed-sentinel map of entries we added/own:
//   ownership = { hooks: { <event>: { <entryKey>: { owner, appliedValue } } } }
// `priorOwnership` (optional) lets a re-run recognize entries it owns and
// refresh their applied hash rather than treating an unchanged entry as foreign.
function mergeBlock(settings, block, priorOwnership) {
  const out = deepClone(settings) || {};
  const ownership = { hooks: {} };
  const prior = (priorOwnership && priorOwnership.hooks) || {};

  if (block && block.hooks) {
    out.hooks = out.hooks || {};
    for (const event of Object.keys(block.hooks)) {
      const incoming = block.hooks[event] || [];
      const existing = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
      const byKey = new Map(existing.map((e) => [hookEntryKey(e), e]));
      ownership.hooks[event] = ownership.hooks[event] || {};
      const priorEvent = prior[event] || {};

      for (const entry of incoming) {
        const key = hookEntryKey(entry);
        const applied = sha256(entry);
        if (byKey.has(key)) {
          // Already present. Claim ownership ONLY if we owned it before (prior
          // sidecar). A pre-existing entry that merely happens to be byte-
          // identical to what we would write is NOT ours: it could be a resident
          // user/GSD hook. Claiming it here would let a later un-merge DELETE that
          // foreign entry. So ownership is retained solely from prior ownership
          // (entries first ADDED by the else-branch below get owned there).
          const weOwnedIt = Boolean(priorEvent[key]);
          if (weOwnedIt) {
            // Record the ORIGINAL applied hash (what we first wrote) so a later
            // user edit is detectable as divergence; if it diverged, keep the
            // prior appliedValue.
            const recorded = priorEvent[key].appliedValue ? priorEvent[key].appliedValue : applied;
            ownership.hooks[event][key] = { owner: OWNER, appliedValue: recorded };
          }
          // else: pre-existing foreign entry (identical or not) — leave it, do not own it.
        } else {
          existing.push(deepClone(entry));
          byKey.set(key, entry);
          ownership.hooks[event][key] = { owner: OWNER, appliedValue: applied };
        }
      }
      out.hooks[event] = existing;
    }
  }

  // Optional non-hook keys (e.g. an opt-in statusLine) could be handled here.
  // W0 keeps the footprint to hooks only to minimize collision surface.

  return { settings: out, ownership };
}

// Reverse op: remove the entries we own from `settings` using `ownership`.
// Returns { settings, removed: [...], kept: [...] } where `kept` lists entries
// we owned but that DIVERGED (user-edited) and were therefore left in place.
function unmergeBlock(settings, ownership) {
  const out = deepClone(settings) || {};
  const removed = [];
  const kept = [];
  const owned = (ownership && ownership.hooks) || {};

  if (out.hooks) {
    for (const event of Object.keys(owned)) {
      const arr = Array.isArray(out.hooks[event]) ? out.hooks[event] : [];
      const ownedEntries = owned[event] || {};
      const next = [];
      for (const entry of arr) {
        const key = hookEntryKey(entry);
        const record = ownedEntries[key];
        if (!record) {
          next.push(entry); // foreign — keep
          continue;
        }
        const currentHash = sha256(entry);
        if (currentHash === record.appliedValue) {
          removed.push({ event, key }); // still ours, unmodified — remove
        } else {
          kept.push({ event, key, reason: "diverged (user-edited) — left in place" });
          next.push(entry);
        }
      }
      if (next.length > 0) out.hooks[event] = next;
      else delete out.hooks[event];
    }
    if (out.hooks && Object.keys(out.hooks).length === 0) delete out.hooks;
  }

  return { settings: out, removed, kept };
}

module.exports = {
  OWNER,
  sha256,
  stableStringify,
  hookEntryKey,
  mergeBlock,
  unmergeBlock,
};
