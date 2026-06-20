"use strict";
// ---------------------------------------------------------------------------
// activation-matcher — a conservative proxy for Claude Code's skill-activation
// behaviour, used by tests/trigger-coverage.test.mjs (R6).
//
// Claude Code activates a skill by matching a user prompt against the skill's
// frontmatter `description` (the activation string). We model that as a
// keyword/trigger-overlap score so the fixture tests are a faithful,
// deterministic proxy: a skill's description enumerates concrete triggers
// (DESIGN §5, R5), the matcher scores each skill against a prompt, and the
// highest-scoring skill (above a floor) "wins".
//
// The matcher is deliberately CONSERVATIVE (DESIGN risk #6): it rewards
// DISCRIMINATING triggers (multi-word phrases the description declares) far more
// than the bare word "cinatra", so two skills can't both win on "cinatra"
// alone — which is exactly the cross-skill disambiguation the harness enforces.
//
// A skill declares its triggers explicitly in a `triggers:` frontmatter list
// (authoritative) and/or implicitly via its description prose; the matcher uses
// the explicit list when present (stable), else tokenizes the description.
// ---------------------------------------------------------------------------

// Generic cinatra-domain tokens that MANY skills share — low discriminating
// power, so they score low (they cannot, alone, win a skill).
const SHARED_LOW_SIGNAL = new Set([
  "cinatra",
  "extension",
  "connector",
  "marketplace",
  "agent",
  "workflow",
  "board",
  "closeout",
  "repo",
  "issue",
  "pr",
]);

function normalize(s) {
  return String(s || "").toLowerCase();
}

// Tokenize a prompt into words + retain it whole for phrase matching.
function tokenize(text) {
  return normalize(text)
    .replace(/[`*_>#]/g, " ")
    .split(/[^a-z0-9@/#.+:-]+/)
    .filter(Boolean);
}

// Score a single skill against a prompt.
//   skill: { id, triggers: [string], antiTriggers?: [string] }
//   each trigger may be a phrase ("admin merge") or a token ("renovate") or a
//   pattern marker like "owner/repo#n" (matched structurally).
// Returns a numeric score (0 = no match).
function scoreSkill(prompt, skill) {
  const p = normalize(prompt);
  const tokens = new Set(tokenize(prompt));
  let score = 0;

  for (const rawTrig of skill.triggers || []) {
    const trig = normalize(rawTrig);
    if (!trig) continue;

    // structural patterns
    if (trig === "owner/repo#n") {
      if (/[a-z0-9_.-]+\/[a-z0-9_.-]+#\d+/.test(p)) score += 3;
      continue;
    }
    if (trig === "#n" || trig === "issue-ref") {
      if (/#\d+/.test(p)) score += 2;
      continue;
    }
    if (trig === "@cinatra-ai/*") {
      if (/@cinatra-ai\/[a-z0-9-]+/.test(p)) score += 3;
      continue;
    }
    if (trig === "orgs/cinatra-ai/projects/*") {
      if (/orgs\/cinatra-ai\/projects/.test(p)) score += 3;
      continue;
    }
    if (trig === "github.com/cinatra-ai/*") {
      if (/github\.com\/cinatra-ai\//.test(p)) score += 3;
      continue;
    }

    // phrase (multi-word) — high discriminating power
    if (trig.includes(" ")) {
      if (p.includes(trig)) score += 3;
      continue;
    }

    // single token
    if (tokens.has(trig)) {
      score += SHARED_LOW_SIGNAL.has(trig) ? 0.5 : 2;
    }
  }

  // anti-triggers suppress (e.g. "personal repo", "pdf")
  for (const rawAnti of skill.antiTriggers || []) {
    const anti = normalize(rawAnti);
    if (anti.includes(" ") ? p.includes(anti) : tokens.has(anti)) {
      score -= 5;
    }
  }

  return score;
}

// Decide the winning skill for a prompt among a set.
//   skills: [{ id, triggers, antiTriggers }]
//   floor:  minimum score to "activate" (below → NONE). Default 2 so a single
//           shared low-signal token (cinatra, 0.5) can never activate a skill.
// Returns { winner: id|null, scores: { id: score } }.
function activate(prompt, skills, { floor = 2 } = {}) {
  const scores = {};
  let best = null;
  let bestScore = -Infinity;
  let tie = false;
  for (const skill of skills) {
    const s = scoreSkill(prompt, skill);
    scores[skill.id] = s;
    if (s > bestScore) {
      bestScore = s;
      best = skill.id;
      tie = false;
    } else if (s === bestScore) {
      tie = true;
    }
  }
  // A skill wins only if it clears the floor AND is the unambiguous top scorer.
  const winner = bestScore >= floor && !tie ? best : null;
  return { winner, scores, bestScore, tie };
}

module.exports = { scoreSkill, activate, tokenize, SHARED_LOW_SIGNAL };
