# Swarm doctrine backstop — drop-in for repo AGENTS.md / CLAUDE.md

Canonical source for the "Working agreements (all agents)" section installed into
repos where multiple humans and agents collaborate (PromptEden app + marketing
first). The point of a backstop: these rules bind ANY agent working the repo —
swarm-coordinated or not, whichever human drives it — because they live in the
files every agent CLI reads. Keep this file canonical; repo copies cite it.

Install: copy the section below into the repo's `AGENTS.md` and `CLAUDE.md`
(or `@`-include it), adjusting the repo-specific list at the bottom.

---

## Working agreements (all agents) — swarm doctrine backstop

These rules apply to every AI agent in this repo, regardless of which human
runs it or which CLI it is. They are the distillation of field-tested swarm
doctrine (see swarm repo `docs/philosophy.md`); the swarm CLI enforces them
mechanically where it is installed, but they bind even without it.

1. **One writer per lane.** Never edit files another agent's task owns. Before
   starting multi-file work, claim it (swarm task, issue assignment, or an
   explicit note from your human). Branch naming: `swarm/<human>/<task-slug>`
   (or `<human>/<slug>` outside swarm mode). One branch = one owner; never
   push to a branch you don't own — freeze and fork instead.
2. **Worktree isolation.** One writing agent per checkout. Never run two
   writing agents in the same working tree.
3. **Completion claims require evidence.** "Done" means: the artifact exists
   and you cite it — commit SHA reachable from the target branch, passing test
   output, a green CI run id, a deployed URL that responds. A claim without
   its artifact is an acknowledgment, not a fact. State what you did NOT
   establish alongside what you did.
4. **Cross-family adversarial review (model inversion).** Gate-critical
   changes get reviewed by a DIFFERENT model family than the author
   (Claude-authored → GPT/Codex reviews; Codex-authored → Claude reviews) with
   fresh context. Priors: hunt missing behavior in Claude-authored code; hunt
   build breakage in Codex-authored code. "Looks good" is not a review —
   evidence required: file/line, counterexample, or failing test.
5. **No self-merge.** PR → green CI → cross-family review → human (or
   designated lead) merges. No exceptions for small fixes.
6. **CI is a budget.** Open PRs as DRAFTS; flip ready-for-review only when the
   work is review-ready. Never push empty commits to retrigger CI; never loop
   CI on a red you don't understand.
7. **Secrets never enter model-visible files.** No keys, tokens, or passwords
   in code, docs, prompts, commit messages, or PR bodies. If a task touches a
   credential file, STOP and escalate to your human first.
8. **Destructive operations are operator-gated.** `git clean`, force-push,
   branch deletion, history rewrite, data deletion, prod mutations: only with
   explicit human approval, stated in the task/PR record.
9. **Externalize state continuously.** Long tasks checkpoint durable state
   (what's decided, what failed, next action) into the task ledger or PR
   description as you go — assume your session can die at any moment and a
   successor (or another human's agent) must resume from artifacts alone.
10. **When blocked, say so early.** >30 min blocked → surface it to your
    human/lead with the exact blocker. Never loop silently; never widen scope
    to route around a blocker without approval.

Repo-specific (edit per repo):
- Protected branches, required checks, CODEOWNERS paths: see `.github/`.
- Known hotspots requiring serialization (migrations, lockfiles, generated
  registries): list them here.
- Actions budget note if metered.
