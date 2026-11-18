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
5. **Cross-check against the previous report** (`git show code-reviews:docs/REVIEW-<prev>.md`
   — since 2026-11-18 every report lives on that one branch): verdict every still-open old
   finding as STILL OPEN (new anchors) / FIXED (cite the commit via `git log -S <symbol>`) /
   SUPERSEDED, so work never gets re-proposed.
6. **The report goes on the branch that carries the reports — `code-reviews` — not on a
   branch of its own** (changed 2026-11-18 on request: "the old branch `review-2026-11-17`
   should not exist locally or on the fork any more, only `code-reviews`"). Write
   `docs/REVIEW-<YYYY-MM-DD>.md` in the `code-reviews` worktree and commit documents only;
   the document names the baseline its anchors hold on. The earlier rounds cut a `review-<date>`
   branch off current main and later had to carry the file across — and a **branch merge cannot
   do that carry**: `git merge-base code-reviews review-2026-11-17` answers **`c66014b9`**, so
   merging such a round branch in would have put the 49 commits `main` gained after `c66014b9`
   (23 of them after the previous round's base `2b5881e2`) onto a documents-only branch, code
   and all. The carry that works copies the one file — `git show <branch>:docs/REVIEW-<date>.md
   > docs/REVIEW-<date>.md` — and proves it with the blob: `git hash-object docs/…` against
   `git rev-parse <branch>:docs/…`, both `bcbea62ce25c7bdb078afa36c51af3f1dcfbe4fe` for the 788-line
   2026-11-17 report. After such a carry the round's own branch goes: worktree, then `git branch -D`,
   then `git push origin --delete`. The other direction is the one that is allowed and was asked for
   on 2026-11-18: **merge `main`/`upstream/main` into the report branch**, which brings `main`'s own
   commits under it and leaves `git diff main...code-reviews` documents-only, so the reports sit on
   the current tree and their anchors hold at the branch head. Merging `upstream/main` (`abcdd8d2`)
   into `code-reviews` landed **`22f2df9d`** (parents `50ed6855` × `abcdd8d2`, merge base `c66014b9`,
   51 files / 2 363 insertions / 2 256 deletions over the old head, and `git diff --name-only code-reviews
   upstream/main -- src` → **0**): no landing got re-opened, because the 49 commits came in as `main`'s
   own, and `npm test` in that worktree still read **260 pass / 0 fail over 67 suites** — the bar holds.
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
   the report, so no work package of the agent's ever lands on the report's own
   branch and the verdicts in the report stay the record of what landed where.
   (What that branch may take is `main`'s own tree by a merge — the 2026-11-18
   merge of `upstream/main` into `code-reviews`, `22f2df9d`, brought 49 commits
   that were already `main`'s and no fix of the agent's, which is why it did not
   re-open a single landing.) **A pull request is never
   opened, edited or merged by the agent** — landing stops at `git push origin
   <branch>`, and the human opens the pull request manually. Hand over the exact
   `gh pr create` line, never run it — unless the user instructs it in the
   conversation, which counts as their confirmation and must be recorded as such
   (and the record must always name which pull requests were opened by whom,
   flagging the one case where nobody asked). **And when one does get opened, it is
   opened against the upstream repo, never against the fork** —
   `gh pr create --repo <upstream>/<repo> --base main --head '<fork-owner>:<branch>'`:
   the fork is only the push target, so the branch can be seen, while the review and
   the merge happen upstream (`CONTRIBUTING.md` "open a Pull Request against `main`
   of <upstream>"). **Issues follow the same two rules** — never opened by the agent,
   and always against `<upstream>/<repo>`: hand over the `gh issue create --repo
   <upstream>/<repo> …` line instead of running it — and when the person does instruct
    it, the issue opens upstream and the record names whose instruction it was (recorded
    2026-11-13: B11's decision question became upstream issue #345 on request). Measure
    what the fork owner can and cannot do upstream — opening worked, but adding a label
    failed (`AddLabelsToLabelable`: the fork owner lacks the permission), so the repo's
    own title convention (`[Bug]:` / `[Feature]:`) is the marker that actually lands.
    Fill an issue template from measurements, never from its `placeholder:` values (same
    day: the version line came back as the template's example `0.8.5` from `bug_report.yml:11`,
    while `CHANGELOG.md`'s newest release was `0.8.7`), and name the commit a source-level
    finding was read at.
    **Re-cutting a landed fix branch is allowed only against the current upstream head, and pushing it
    is a force-push onto a branch an open pull request tracks** (same 2026-11-13: R3 was rebased
    `--onto db1e1de8` from its stale `c66014b9`, and `--force-with-lease` moved PR #344's head by
    itself, taking it from `CONFLICTING` to `MERGEABLE`/`CLEAN`). The conflict is resolved by taking
    the **migrated** side of each hunk and re-deriving the upstream decision inside it — not by keeping
    upstream's code and not by accepting git's guess; re-measure after with `git diff --stat <upstream>
    HEAD` (it must answer the same file list as before) and re-run the whole suite on the rebased tree
    before the push.
    **And a branch whose pull request is still open and unmerged keeps taking its follow-ups on that
    same branch** — refinement of a landed-but-unmerged package is new commits on the branch plus a push,
    never a second branch for the same feature, since the open pull request tracks the branch and follows
    its head by itself (recorded 2026-11-13: R3's two recorded frame nits were closed as `f4c1bf74`/`b8b753dd`
    on the branch, a **plain** push moved PR #344's head from `32b899e5` to `b8b753dd` and its diff from
    9 to 10 files, and the agent merged nothing). Re-run the suite on the branch and re-measure the
    pull request after such a push — its file count and head are the record, and a fix that reaches a
    shared file widens the branch's file list, which the record has to name.
 9. **Withdrawal**: a package the user rejects is deleted everywhere — unlink the worktree's
    `node_modules` symlink and `git worktree remove`, `git branch -D`, `git push origin
    --delete <branch>` — and its item goes back to open: a FIXED verdict may only name a
    branch that still exists, so re-check the branch before trusting a verdict. The finding
    is not re-reported; what the attempt learned stays in its verdict as a record of the
    attempt, not as a claim about the code, and a later attempt re-argues constants rather
    than copying them.
    **Pruning is not withdrawal** (recorded 2026-11-13, when the person asked which worktrees,
    local branches and fork branches could be deleted and then had them deleted): a package whose
    pull request has **merged** is history, and its branch, worktree and fork ref may go. Decide by
    measurement, never by memory — `git merge-base --is-ancestor <head> <current main>` answers
    whether the deletion can lose anything. Worktrees go in the withdrawal order (unlink the `node_modules`
    symlink, then `git worktree remove`, never `rm -rf`); local branches go with **`git branch -d`**
    so git itself refuses anything unmerged; fork refs go with `git push origin --delete`. Never prune
    the branch of a pull request that is open, or of one that is **closed without merging** (`merged_at`
    null — the content landed nowhere), or a branch that was never opened as a pull request at all, or
    the branch carrying the report. What pruning does to the record: the FIXED verdicts that named those
    branch names now name refs that no longer resolve, so they are read from the **merge commit in
    `main`** (where their anchors were re-measured) — a branch that was *withdrawn* is the other case and
    says NOT LANDED. Record the pruning in the report: which worktrees, which local branches, which
    remote heads, the counts before and after, and the list of what stayed and why.
    **Two exceptions to the "closed without merging ⇒ keep" half of that rule, both measured rather than
    assumed.** A docs branch whose PR was closed unmerged may still go when its file is preserved
    byte-identically elsewhere (`git rev-parse <head>:<path>` against the branch that carries it) — then
    the citation is re-pointed at the branch that holds it, so a later round cannot be told to re-report
    a document it can no longer find. **2026-11-18 is this exception, not the ancestor rule**: asked
    to delete `review-2026-11-17` locally and on the fork, `git merge-base --is-ancestor 1cad8e36
    abcdd8d2` answers **no** — so the rule by itself would refuse the deletion — but the branch's
    only unique content is `docs/REVIEW-2026-11-17.md`, whose blob `bcbea62ce25c7bdb078afa36c51af3f1dcfbe4fe`
    is byte-identical on `code-reviews` (`git diff review-2026-11-17 code-reviews -- docs/REVIEW-2026-11-17.md`
    answers empty), so the deletion could lose nothing and went in withdrawal order. It needed **no
    worktree removal**: the repo registers three (`git worktree list --porcelain` → `projects/resonus`,
    `neon-canyon`, `proud-engine`), and the directory that held it, `…/worktree/f6e584/lively-canyon`,
    was already gone. What went: one local branch (`git branch -D` — its head is unmerged, so a plain
    `-d` had nothing merged to accept) and one fork ref (`git push origin --delete`). Counts before →
    after: local branches **9 → 8**, fork heads **12 → 11**, worktrees **3 → 3**. Every citation of
    that branch name in the reports is re-pointed at `code-reviews`, which holds the file.
    And an unmerged fix branch may go when the issue it fixes was
    **fixed upstream by a different implementation** (compare what the branch adds against what `main`
    has: our module absent, upstream's module present; the upstream issue `closed`,
    `state_reason=completed`): that verdict is **NOT LANDED, do not re-propose**, and the record names the
    upstream commit and module that actually carries the fix, plus what the attempt had learned —
    otherwise a later round rediscovers a dead design as if it were still an open problem.
10. **Endpoint facts come from the upstream server's own documentation, not from behaviour**
    (recorded 2026-11-12, when the person asked to read the official spec before a fix was proposed).
    A request that succeeds while silently omitting a field looks identical to one that did the work
    — the UI can answer "updated" for a change that cannot happen — so behaviour cannot distinguish
    them. Fetch the published specification (here: the stable OpenAPI document at api.jellyfin.org,
    quoting its `info.version`), copy the model's field list into the verdict, and name what could
    not be read: a per-version document the docs do not publish under that name (every such fetch
    answered 404). When no door has the field, the defect is the **affordance**, and the fix hides the
    row (the codebase's idiom: `hidePublic`, capability gates on `serverType`) and omits the field
    from the edit, so an offline-queued patch cannot carry something the server will drop.
11. **Credit every observation to whoever made it, and keep the kinds of evidence apart** (recorded
    2026-11-12, when the person verified a landed fix by hand against a real Jellyfin server and on an
    Android emulator, superseding a verdict that claimed "not tested on a device"). "Not tested"
    describes the agent's reach, not the app. When a human tests it, the verdict says which part was
    measured where — the agent's check suite on the branch, the reporter's manual run on the device,
    the endpoint's own published documentation — and never counts a human's run as the agent's test
    coverage. Itemise only what the human stated they observed; do not infer the rest.
12. **When upstream `main` moves, re-sync and re-measure before working anything** (recorded
    2026-11-12, when the report's own pull requests were merged upstream and the fork was synced
    on GitHub). Fetch both remotes and bring the fork's local `main` across with **`git merge
    --ff-only origin/main`** — fast-forward only, never a rebase and never a force: a moved `main`
    must not paper over a commit that belongs on a branch, and if it cannot fast-forward, stop and
    report it. Then re-measure in order: the **check suite** on the new head (its numbers become the
    bar from here on), and every still-open item's **own `Verify:` as written**. Record the answers
    in a dated re-run section near the top of the report — one row per item, what its `Verify:`
    answers on the new head, and what that leaves owed — rather than editing items to fit: an item
    whose fix **merged** stops being owed and its "open, not merged" prose is corrected in place;
    anchors that moved get the new numbers; a claim that no longer reproduces is a correction.
    A fix branch cut off the **old** head is stale — when it touches files upstream also touched,
    its pull request reads `CONFLICTING`/`DIRTY`, and re-cutting it off the new head re-opens a
    landing that was already recorded, so measure the overlap file by file first and let the
    re-cut itself wait for an explicit instruction. The branch that carries the reports grows
    only by documents **and by merges of `main` itself**: each round adds its own `docs/REVIEW-<date>.md`
    to `code-reviews` and commits nothing else, and when `upstream/main` was merged into that branch
    on 2026-11-18 (**`22f2df9d`**) the only thing it took in was `main`'s own 49 commits — never a
    fix of the agent's that is not already on `main`. Measured after that merge: `git diff --name-only
    code-reviews upstream/main` answers **4** files, the four report documents, and `git diff --name-only
    code-reviews upstream/main -- src` answers **0** — so the branch's `src/` is `main`'s tree and
    `git diff main...code-reviews` is documents only. That supersedes the earlier claim that the branch's
    `src/` stayed the pre-fix tree (`git diff --name-only c66014b9 code-reviews -- src` → 0 files, true
    only until that merge); either way every section still names the baseline its anchors hold on, and
    a claim from an older section is read on the commit that section shows.

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
4. CONTINUITY — previous report at code-reviews:docs/REVIEW-<prev>.md — since
   2026-11-18 the branch that carries the reports is always `code-reviews`, never
   a `review-<date>` branch of its own: give every still-open finding a verdict on
   THIS tree: STILL OPEN (re-anchored) / FIXED (git log -S proof) / SUPERSEDED.
   List commits since the old baseline that already shipped fixes so nobody
   re-proposes them.

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
