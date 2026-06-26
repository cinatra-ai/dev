"use strict";
// ---------------------------------------------------------------------------
// install-profiles — surface profiles + requires: closure + the source→SKILL.md
// converter. Mirrors GSD's install-profiles.cjs (PROFILES, parseRequires,
// stageSkillsForRuntimeAsSkills, agent-call scan) at the level W0 needs.
//
// A "source skill" in skills-src/<name>.md is converted at install into a thin
// launcher at ~/.claude/skills/dev-<name>/SKILL.md whose body @-includes the
// heavy workflow from the staged payload dir
// (@$HOME/.claude/dev-core/workflows/<name>.md) — exactly GSD's stable-shell
// pattern, so the skill survives payload updates.
// ---------------------------------------------------------------------------

const { NAMESPACE } = require("../package-identity.cjs");

const SKILL_PREFIX = `${NAMESPACE}-`; // dev-

// Surface profiles. `full` = every skill. core/standard are smaller curated
// sets; the effective set is the transitive `requires:` closure of the base.
// (W0 seeds the structure; later waves populate the curated lists as skills land.)
const PROFILES = {
  core: ["start-here", "doctor", "codex-pairing", "merge-doctrine", "board-mechanics"],
  standard: [
    "start-here",
    "doctor",
    "setup",
    "workspace",
    "codex-pairing",
    "merge-doctrine",
    "board-mechanics",
    "owner-queue",
    "pr-lifecycle",
    "grounding",
  ],
  full: "*",
};

// Parse a flow-style `requires: [a, b]` (or block list) from skill frontmatter.
function parseRequires(frontmatter) {
  if (!frontmatter) return [];
  const m = frontmatter.match(/^requires:\s*(.+)$/m);
  if (!m) {
    // block list form:
    const block = frontmatter.match(/^requires:\s*\n((?:\s*-\s*.+\n?)+)/m);
    if (!block) return [];
    return block[1]
      .split("\n")
      .map((l) => l.replace(/^\s*-\s*/, "").trim())
      .filter(Boolean);
  }
  const raw = m[1].trim();
  if (raw.startsWith("[")) {
    return raw
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }
  return [raw.replace(/^["']|["']$/g, "")];
}

// Compute the transitive closure of a base set over a requires-graph.
//   base: array of skill stems (or "*" for all)
//   requiresOf: (stem) => string[]   — the declared requires of a stem
//   allStems: string[]               — every available stem
function resolveClosure(base, requiresOf, allStems) {
  if (base === "*" || (Array.isArray(base) && base.includes("*"))) {
    return [...allStems];
  }
  const seen = new Set();
  const stack = [...base];
  while (stack.length) {
    const s = stack.pop();
    if (seen.has(s)) continue;
    if (!allStems.includes(s)) continue; // ignore unknown requires
    seen.add(s);
    for (const dep of requiresOf(s) || []) stack.push(dep);
  }
  return [...seen];
}

// Resolve the effective profile: a profile name, a comma-composition
// (core,doctrine), or "*". Returns the closure stem list.
function resolveEffectiveProfile(profileSpec, requiresOf, allStems) {
  const spec = (profileSpec || "full").trim();
  if (spec === "full" || spec === "*") return [...allStems];
  const parts = spec.split(",").map((p) => p.trim()).filter(Boolean);
  const union = new Set();
  for (const part of parts) {
    const base = PROFILES[part] || [part]; // unknown name → treat as a single stem
    for (const s of resolveClosure(base, requiresOf, allStems)) union.add(s);
  }
  return [...union];
}

// Split a source skill .md into { frontmatter, body }.
function splitFrontmatter(content) {
  const m = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return { frontmatter: "", body: content };
  return { frontmatter: m[1], body: m[2] };
}

// The converter: source skill content → SKILL.md launcher content.
// Injects/normalizes the frontmatter `name` to dev-<stem> and preserves the
// activation-optimized `description` + allowed-tools.
//
// Body shape depends on WHERE the heavy workflow lives:
//   • SPLIT form (payload workflow staged) — the body @-includes the staged
//     payload workflow (@$HOME/.claude/dev-core/workflows/<stem>.md), so the
//     thin launcher survives payload updates (the stable-shell pattern).
//   • SELF-CONTAINED form (no payload workflow) — the skill body already
//     carries its full workflow inline (the public dev pack ships skills this
//     way and has no payload/), so the launcher keeps that inline body and we
//     do NOT inject an include that would dangle on a missing file.
//
//   content: the source skills-src/<stem>.md
//   stem:    the bare stem (e.g. "merge-doctrine")
//   opts.hasPayloadWorkflow: whether payload/workflows/<stem>.md is staged
//     (default true for backward compatibility with the split-launcher pack).
// Returns the converted SKILL.md text.
function convertSourceToSkill(content, stem, opts = {}) {
  const { hasPayloadWorkflow = true } = opts;
  const skillName = `${SKILL_PREFIX}${stem}`;
  const { frontmatter, body } = splitFrontmatter(content);

  // Force the name to the namespaced id (idempotent if already set).
  let fm = frontmatter;
  if (/^name:\s*/m.test(fm)) {
    fm = fm.replace(/^name:\s*.*$/m, `name: ${skillName}`);
  } else {
    fm = `name: ${skillName}\n${fm}`;
  }

  let outBody = body;
  // Only inject the payload @-include when a payload workflow is actually staged
  // AND the body does not already declare its own execution_context (a source
  // may include several payload files). With no staged workflow, the inline body
  // IS the skill — never reference a file that will not exist on disk.
  if (hasPayloadWorkflow && !/<execution_context>/.test(outBody)) {
    // The $HOME-rooted include of the staged payload workflow. Absolute so it
    // resolves regardless of CWD.
    const includeLine = `@$HOME/.claude/${NAMESPACE}-core/workflows/${stem}.md`;
    outBody =
      `<execution_context>\n${includeLine}\n</execution_context>\n\n` + outBody;
  }

  return `---\n${fm.trim()}\n---\n\n${outBody.trim()}\n`;
}

// Scan a (converted or source) skill body for agent-call references so the
// installer stages only the agents surfaced skills actually call. Convention:
// a skill names a called agent via `dev-tools dispatch --agent dev-<name>` or a
// `_calls_agents_<name>` marker (parity with GSD's call scan).
function scanCalledAgents(body) {
  const agents = new Set();
  const re1 = /_calls_agents_([a-z0-9-]+)/g;
  const re2 = /--agent\s+(?:dev-)?([a-z0-9-]+)/g;
  let m;
  while ((m = re1.exec(body))) agents.add(m[1]);
  while ((m = re2.exec(body))) agents.add(m[1]);
  return [...agents];
}

module.exports = {
  SKILL_PREFIX,
  PROFILES,
  parseRequires,
  resolveClosure,
  resolveEffectiveProfile,
  splitFrontmatter,
  convertSourceToSkill,
  scanCalledAgents,
};
