---
name: onboarding
description: "Walk a new contributor through the actionable path into the Cinatra dev process: install this skills pack, run the setup skill, get oriented, and find a first piece of work to pick up. Activates for: 'install the dev skills pack', 'set up the dev pack', 'onboard to the dev workflow', 'how do I start contributing', 'find my first issue', 'find work to pick up', 'new to the cinatra dev process', or 'get oriented to start work'. This is the HOW-TO path; it cross-links the other skills in this pack (setup, cinatra-dev-env, extension-conventions, domain-gotchas)."
argument-hint: ""
allowed-tools:
  - Read
triggers:
  - "install the dev skills pack"
  - "set up the dev pack"
  - "onboard to the dev workflow"
  - "how do i start contributing"
  - "find my first issue"
  - "find work to pick up"
  - "new to the cinatra dev process"
  - "get oriented to start work"
antiTriggers:
  - "pdf"
  - "personal repo"
  - "court"
  - "whiteboard"
---


<objective>
Take a brand-new contributor from "nothing installed" to "working on a first
issue" as an ordered HOW-TO: install and verify the pack, run the setup skill,
get oriented, then find a ready piece of work and start it through a normal
issue/PR flow. This skill is the path; it points at the other skills in this pack
for the details.
</objective>

# Workflow: onboarding (new-contributor how-to)

> Engine body for the `onboarding` skill. This is the HOW-TO path a new
> contributor follows to get productive. It is the ordered route; the other
> skills in this pack hold the details for each step.

> Board/state vocabulary (use the shared meanings, don't invent your own):
> **Backlog / Ready / In Progress / Blocked / Done** are the project board Status
> values; a dependency is only "finished" when it is closed, its board Status is
> Done, and every closing PR is merged with no open follow-up. Boards can exceed
> one page — always paginate a board scan and assert the node count matches the
> total before trusting it. Only move a card or set Status on an item you've been
> assigned; otherwise suggest, don't force.

## The path, in order

A new contributor goes from a bare machine to a first shipped change in a few
ordered moves. Run them in sequence.

1. **Verify + install the toolchain.** Run the `setup` skill — it runs a
   read-only doctor probe first (so you act only on real gaps), then installs
   whatever is missing and lays down the global Claude baseline. It is DRY-RUN by
   default and writes only on confirm. Re-run it until the doctor probe is clean.
2. **Lay out a workspace.** Clone the Cinatra repositories you can reach into one
   parent folder so the tools and skills find them. Keep each repo in its own
   directory; clone only repos you have access to.
3. **Get oriented.** Skim the README of the repo you'll work in and the open
   issues on its board. Use `cinatra-dev-env` to bring up the local dev / verify
   stack when you need to run or test something locally.
4. **Find work and start it.** Pick a READY item off the board (using the shared
   Status vocabulary above), then take that one issue from a grounded start
   through a linked PR, green checks, and merge. Verify the change on the real
   surface before calling it done.

When you're building or integrating a Cinatra extension, read
`extension-conventions`; for the non-obvious per-repo traps that have cost real
rework, read `domain-gotchas`.

## What NOT to do on day one

- **Do not move board cards or board an issue** that isn't assigned to you —
  suggest, don't force.
- **Do not push planning / scratch artifacts** into a repo — keep them local.
- **Do not skip grounding** — re-verify the current state of an issue before you
  start building, not after.

## If multiple efforts share a board

When more than one person or automated loop shares a board, the rule is simple:
work only an issue that is ASSIGNED to you (or the account you act as). Leave
items assigned to someone else (or unassigned) alone — assignment is what keeps
two efforts from colliding on the same work.
