# How a Resonus review report gets built (reusable prompt)

> This file documents the protocol that produced `docs/REVIEW-<date>.md`.
> Copy the **MASTER PROMPT** into a fresh agent session and fill in the
> placeholders. The sub-agent prompts are the fan-out that produced the
> 2026-11-11 report.

## Master procedure (the protocol)

1. **Anchor the baseline first.** Record the exact commit under analysis
   (`git rev-parse main`, plus `origin/main`/`upstream/main` if they differ),
   the file/LOC counts (`find src -name "*.ts*" | wc -l`, `xargs wc -l`), and
   the check-suite baselines **measured on this tree**:
   `npm test` (record pass/fail counts), `npm run typecheck` (record error
   lines verbatim — a dirty baseline must be reported, not papered over),
   `pnpm i18n:status` (record missing AND stale columns verbatim).
2. **Fan out parallel analyses** (one concern per agent, disjoint prompts):
   dead code · bug scans (api / store / app+components+hooks) ·
   refactor & simplification · continuity-check of the previous report.
3. **Every claim must be mechanically checkable.** A finding without a
   `file:LINE` anchor **in the current tree** and a one-line `Verify:` grep/shell
   command whose output proves it does not belong in the report. Agents run their
   own Verify commands before writing the finding.
4. **Tag certainty** (`certain` / `high` / `medium`) and mark runtime-behavior
   changes `⚠ BEHAVIOR`; keep a **Do-not-delete guard list** for apparent-dead
   items that have dynamic consumers (string-keyed maps, glyph names, i18n keys,
   expo-router route files).
5. **Cross-check against the previous report** (`git show review-<prev>:docs/REVIEW-<prev>.md`):
   verdict every still-open old finding as STILL OPEN (new anchors) / FIXED (cite
   the commit via `git log -S <symbol>`) / SUPERSEDED, so work never gets re-proposed.
6. **Land the report on its own branch**: `git branch review-<YYYY-MM-DD>` at
   current main, write `docs/REVIEW-<YYYY-MM-DD>.md` (+ this protocol file),
   commit only docs, so `git diff main...review-<date>` is just the documents.
7. **Carry-over notes**: if the report is later merged after main moved on,
   add an "Update after the tree moved on" section at the top — line anchors
   re-drift; the symbol names stay trustworthy, re-measure baselines.
8. **Landing discipline for the fix work packages the report proposes** (recorded
   2026-11-12, it applies to every later round as well): code never changes on
   `main` and never on the report's own branch — each work package gets a fresh
   branch `fix/<what-it-does>` off the report's baseline commit, checked out in
   its own worktree, and one branch carries one feature or one bug fix only.
   Related changes do not share a branch; grouping belongs in prose. Nothing
   merges anything: the fix branch is never merged into the branch that carries
   the report, so the report's `src/` stays the pre-fix tree and the verdicts in
   the report are the record of what landed where. **A pull request is never
   opened, edited or merged by the agent** — landing stops at `git push origin
   <branch>`, and the human opens the pull request manually. Hand over the exact
   `gh pr create` line, never run it. **And when the user does open one, it is
   opened against the upstream repo, never against the fork** —
   `gh pr create --repo <upstream>/<repo> --base main --head '<fork-owner>:<branch>'`:
   the fork is only the push target, so the branch can be seen, while the review and
   the merge happen upstream (`CONTRIBUTING.md` "open a Pull Request against `main`
   of <upstream>"). **Issues follow the same two rules** — never opened by the agent,
   and always against `<upstream>/<repo>`: hand over the `gh issue create --repo
   <upstream>/<repo> …` line instead of running it.

## MASTER PROMPT (fill placeholders, then split per the fan-out)

```text
Review repo <repo> at branch <branch> @ <commit> — analysis ONLY: do not edit,
create or delete anything, do not switch branches.
Project: <one-paragraph description: stack, entry points, dirs>.
Code map: <src layout: api/screens/components/hooks/lib/store + config files
+ helper module dirs + scripts/*.mjs + locale JSONs>.

TASK — report exactly these four concerns, fresh against THIS tree:
1. DEAD CODE — unused exports (grep import sites repo-wide), files nothing
   imports (beware router-reachable screens), removable deps (check plugin
   manifests AND implicit framework requirements), dead keys in <asset maps>,
   stale i18n keys (run the repo's i18n status script), commented-out blocks,
   write-only fields.
2. BUGS — logic/correctness (not type errors tsc already catches): missing/
   inconsistent timeouts, cache-served-before-permission-gate ordering, races
   on shared state, listener leaks (add-without-remove), timer leaks,
   unbounded caches, off-by-one pagination, credentials in URLs, silent/empty
   catches, error-type inconsistencies, stale state surviving profile switches.
3. REFACTOR & SIMPLIFY — hand-copied UI blocks (grep-count them), reimplemented
   shared components, bypassed shared helpers (call-site vs helper counts),
   hand-copied try/catch cascades, duplicated request plumbing across siblings,
   god components (count props) and god files (propose concrete extractions),
   same-named helpers defined in ≥2 files, hand-unrolled chains replaceable by
   a loop/table. Quantify each: "~X lines would disappear".
4. CONTINUITY — previous report at <branch>:<docs/REVIEW-<prev>.md>: give every
   still-open finding a verdict on THIS tree: STILL OPEN (re-anchored) / FIXED
   (git log -S proof) / SUPERSEDED. List commits since the old baseline that
   already shipped fixes so nobody re-proposes them.

HARD RULES
- Exact anchor `file:LINE` in the CURRENT tree for every finding.
- A `Verify:` one-line grep/shell command per finding, which YOU ran; its output
  must prove the claim. If it contradicts, stop and report the contradiction.
- Certainty tag `certain|high|medium` + one-sentence suggested fix per finding.
- `⚠ BEHAVIOR` where the fix changes runtime behavior.
- Apparent-dead items with dynamic consumers go into a guard list, not dead code.
- Nothing gets applied — the report is an execution plan, never a patch.
- Report the measured check-suite baselines (test counts, typecheck errors,
  i18n columns) so a worker can prove "no regression" after each work package.
- Cap: ≤15 findings per concern, ranked; add a short "checked & clean" list.
```

## Sub-agent fan-out (what 2026-11-11 actually ran: 3 agents, background)

| Agent | Scope |
|---|---|
| dead-code + continuity | whole repo (imports, deps, asset maps, i18n, comment blocks) + re-verify the old report's open items with `git log -S` verdicts |
| bug scan: api + store + app/components/hooks | all of `src/` correctness hunting, one prompt per area folded into a single agent |
| refactor + simplification | duplication census with grep counts and LOC-win estimates |

Practical notes that proved necessary while running this protocol:

- Sub-agents append findings incrementally to a scratch file
  (`/tmp/opencode/review-notes/agentN.md`) so a crashed host doesn't lose the
  analysis; the orchestrator assembles the final document from those files.
  (2026-11-11: both sub-agent batches got interrupted by host restarts; the
  agents were relaunched in *background* mode and the orchestrator kept
  measuring baselines itself meanwhile — run them backgrounded on trees this
  large.)
- The orchestrator re-runs the headline `Verify:` commands against the source
  itself before publishing (spot-verified on 2026-11-11: the podcasts body-read
  hang, the subsonic bare-`Error` sites, the downloads TOCTOU, the 77/91 press
  counts, the 22–24 cascade catches, the `safe()` ×2).
- 135 src commits moved between the two reviews — re-anchoring old findings is
  not optional; only symbol names carry across trees.
- Keep one work package = one focused change in the final doc (the WP protocol
  both reviews use), so a fixer agent can land items one at a time with the
  regression-suite check between each.
