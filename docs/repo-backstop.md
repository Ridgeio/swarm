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

1. **One writer per branch/worktree; paths are shared advisorily.** The hard
   boundary is the branch and worktree: never work in another agent's worktree
   and never push to a branch you don't own — freeze and fork instead. Editing
   files that another task also touches is ALLOWED and expected — coordinate it
   with an advisory reservation (rule 11): you are warned on overlap and may
   override with a reason. Do not treat task ownership as a file lock. Branch
   naming: `swarm/<human>/<task-slug>/e<epoch>` (or `<human>/<slug>` outside
   swarm mode).
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
5. **No self-merge; the repo's landing authority merges.** PR → green CI →
   cross-family review → the repository's single named **landing authority**
   merges (not just any human or lead), and only when the pre-landing check
   binds the exact head SHA to a still-valid submission. No exceptions for
   small fixes; the only bypass is the audited break-glass.
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
11. **Reserve work socially, override transparently.** Before starting
    multi-file or multi-agent work, place an advisory reservation on the
    area/files you're taking (identity + a short TTL) so others have
    situational awareness — it warns, it does not block. If you must work a
    scope someone else has reserved, override it WITH A STATED REASON and let
    the holder know; don't silently collide. Reservations are awareness, not
    permission — landing to a protected branch is still the repo's single
    landing authority's call.
12. **Read the design before you change it; keep it current.** If the
    component has a living design doc (`DESIGN.md` or equivalent), read it
    before starting and update it in the SAME PR as your change, so it never
    goes stale. If your change contradicts the recorded design, FLAG the
    component's owner/landing authority rather than silently diverging — design
    conflicts are cheapest to resolve before the work, not at merge.

Repo-specific (edit per repo):
- Protected branches, required checks, CODEOWNERS paths: see `.github/`.
- Landing authority (who merges to protected branches): name them here.
- Shared-environment apply points that are hard-gated at apply, not by file
  locks (DB migrations applied to shared databases, prod deploys): list them
  here. Editing these files stays advisory; only their *application* is gated.
- Living design docs (component → `DESIGN.md` path): list them here.
- Actions budget note if metered.
