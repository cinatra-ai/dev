"use strict";
// ---------------------------------------------------------------------------
// repo-clone — tier-aware org-repo clone-all planning (DESIGN §2.1 step 9).
//
// Access model (R2): privacy IS the access gate. Enumerate org repos via `gh`,
// clone ONLY the repos the user can reach into the single parent workspace
// folder, SKIP-WITH-NOTICE per unreachable repo, ALWAYS exclude archived repos.
// New-repo detection auto-clones per the repo-currency knob; renames/archivals
// are surfaced, never auto-deleted.
//
// W0 ships the pure planning logic (testable, no network): given an org repo
// listing + what is already on disk + reachability, decide the clone/skip/exclude
// plan. The #129 workspace skill wires this to live `gh` + git.
// ---------------------------------------------------------------------------

// Archived repos that are OFF-LIMITS and must always be excluded from clone-all.
// Note: private repo names are NOT hardcoded here — the dynamic r.isArchived
// flag (from `gh repo list`) is the authoritative exclusion mechanism.
const ALWAYS_EXCLUDE_ARCHIVED = new Set([]);

// Build a clone/skip/exclude plan.
//   repos: [{ name, isArchived, isAccessible }]  (from `gh repo list` + perms)
//   present: Set<string> of repo names already cloned in the workspace
//   knob: "auto-clone" | "notify"
// Returns { clone:[], skipNotice:[], excluded:[], alreadyPresent:[] }.
function planCloneAll(repos, present = new Set(), knob = "auto-clone") {
  const plan = { clone: [], skipNotice: [], excluded: [], alreadyPresent: [] };
  for (const r of repos || []) {
    if (r.isArchived || ALWAYS_EXCLUDE_ARCHIVED.has(r.name)) {
      plan.excluded.push({ name: r.name, reason: "archived / off-limits" });
      continue;
    }
    if (r.isAccessible === false) {
      plan.skipNotice.push({
        name: r.name,
        reason: "not reachable with current access — skipped with notice (privacy is the access gate)",
      });
      continue;
    }
    if (present.has(r.name)) {
      plan.alreadyPresent.push({ name: r.name });
      continue;
    }
    if (knob === "auto-clone") {
      plan.clone.push({ name: r.name });
    } else {
      plan.skipNotice.push({ name: r.name, reason: "new repo — notify-only (currency.repo=notify)" });
    }
  }
  return plan;
}

module.exports = { ALWAYS_EXCLUDE_ARCHIVED, planCloneAll };
