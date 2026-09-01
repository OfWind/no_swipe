---
name: no-swipe-release-loop
description: Build, install, test, diagnose, iterate, and release No Swipe candidate plugins for Douyin RPA across Codex's built-in browser and an explicitly requested external Chrome. Use for candidate packaging, closed-loop acceptance, regression analysis, or release readiness; use the sibling douyin-recommendation-rpa skill for ordinary feed collection.
---

# No Swipe candidate acceptance and release loop

Use this skill for maintainer work on No Swipe. Its output is an evidence-backed candidate decision, not merely a successful command or a long browser run.

For an ordinary recommendation-feed run, use the sibling `douyin-recommendation-rpa` skill instead. Before any live Douyin action in this workflow, read that sibling skill completely from the exact candidate plugin root being tested and obey its authorization, identity, RunConfig, Goal, action, persistence, and safety gates.

## Load only the references needed

- Always read [references/acceptance-matrix.md](references/acceptance-matrix.md) before choosing the test scope or declaring a candidate accepted.
- Read [references/browser-protocol.md](references/browser-protocol.md) before controlling either browser.
- Read [references/release-gates.md](references/release-gates.md) only when the user asks to publish, commit, push, promote, or verify a published build.

Use [scripts/verify_candidate.mjs](scripts/verify_candidate.mjs) to compare the authoritative source plugin, the staged candidate, and the installed cache. Do not substitute a comparison of three selected files for a whole-package check.

## Authorization and ownership boundaries

A request to prepare or iterate a candidate authorizes the in-scope source edits needed for that request. A request only to test or diagnose authorizes read-only inspection, automated tests, candidate staging, local plugin installation, and the specifically confirmed live test; it does not authorize a source fix unless the user also asks to fix or iterate. Neither request authorizes publishing artifacts, deploying services, applying database migrations, committing, pushing, or changing an account's interaction policy.

Keep these boundaries explicit:

- Source fixes belong in the repository. Never edit `~/.codex/plugins/cache` or use a staged candidate directory as the source of truth.
- Candidate directories and installed caches are generated evidence. Replace them only through a new candidate cycle.
- Preserve unrelated worktree changes and report them separately.
- Never expose cookies, tokens, authorization headers, OTPs, device codes, or reusable browser-session material.
- A live test reuses an already confirmed test RunConfig. If none exists, stop at the browser boundary and use the sibling runtime skill's compact confirmation flow.
- For every live test, verify the visible Douyin account identity from the current page, account menu, or avatar area first; use the canonical self page only when the runtime Skill permits it, and never open another creator's homepage.
- Commit, push, upload, deploy, release, promote, and destructive cleanup require the user's explicit request for that action.

## The closed loop

Run the following loop until one candidate passes every required gate or the evidence identifies a real blocker.

### 1. Open a cycle record

Before changing code, record:

- the user-visible problem and the narrow acceptance claim;
- repository path, base commit, dirty files, and files owned by this change;
- source plugin version, candidate build ID, CLI version, and CLI binary SHA-256;
- formal pinned CLI path/hash, candidate CLI path/hash, and candidate-only data directory when CLI bytes differ;
- installed plugin version and resolved installed path;
- required browser modes;
- test account identity, confirmed RunConfig hash, test database, and starting SQLite/outbox counts when live testing is authorized.

Use one immutable candidate build ID per shipped file set. Any source, Skill, reference, script, fixture, package metadata, or binary change invalidates the prior candidate result. Stamp a new `x.y.z+codex.<timestamp>` build ID, reinstall, and reopen the cycle record.

Treat these as separate facts:

```text
source tree -> staged candidate -> installed cache -> CLI binary -> browser run -> SQLite/outbox -> server ACK -> published release
```

Never infer one fact from another. In particular, a published version is not proof that the local task loaded it, and an installed plugin is not proof that its pinned binary matches the tested artifact.

### 2. Reproduce at the lowest failing layer

Start with the smallest deterministic reproduction:

1. static syntax and schema;
2. unit and contract tests;
3. package self-containment and source/candidate/cache equality;
4. CLI persistence and sync behavior without a browser;
5. one live zero-interaction item in the affected browser;
6. a 10-item checkpoint run;
7. the agreed full acceptance target.

Do not continue to a larger stage after a failure. A long run never substitutes for a minimal reproducer, and a mock browser success never substitutes for the affected live browser.

### 3. Build and run automated gates

Use the repository's current commands. For this repository the baseline gates are:

```bash
cd <repo>/cli && bun test
cd <repo>/plugins/no-swipe && npm test
cd <repo>/plugins/no-swipe && npm run check
```

Build all CLI artifacts with `bun run build` from `<repo>/cli` when CLI source, dependency metadata, build logic, or the pinned CLI version changed. Install the host artifact for candidate tests under `~/.config/no-swipe/candidates/<candidate-build-id>/no-swipe` and pass that exact path to every candidate CLI call and runner instance. Keep candidate drafts, bindings, SQLite/outbox, and exports under a cycle-specific test data directory. Never overwrite, prune, or invoke `~/.config/no-swipe/bin/<base-version>/no-swipe` as candidate evidence. Do not rebuild the binary for Skill-only changes. If Bun is unavailable, report the build gate as blocked; do not replace the compiled CLI with the retired Node or Python path.

Add a regression test at the failing layer. The test should reproduce the invariant that failed, such as delayed transition verification, missing fallback control, viewport visibility, transition audit persistence, sync recovery, or absence of `process` in the browser host. Prefer a test that fails before the source fix and passes after it.

### 4. Stage and install a local candidate

Use a dedicated local marketplace named `no-swipe-local-rc`. Copy the repository's `.agents/plugins/marketplace.json` and complete `plugins/no-swipe` tree into its candidate root, change only the candidate marketplace name/display name, and assign a fresh build ID in the candidate plugin manifest. Keep the base plugin, marketplace, package, configuration, and CLI versions paired.

If CLI code changed, install the exact locally built host artifact into the candidate-specific binary path and record both its SHA-256 and the unchanged formal pinned binary SHA-256. Candidate activation must use the candidate binary explicitly and must not run the production bootstrap path. If CLI code did not change, record the existing formal binary hash and prove it stayed unchanged.

Install with the configured local marketplace, then verify the actual state:

```bash
codex plugin add no-swipe@no-swipe-local-rc --json
codex plugin list
node <source-plugin>/skills/no-swipe-release-loop/scripts/verify_candidate.mjs \
  --source <source-plugin> \
  --candidate <candidate-plugin> \
  --installed <installed-cache-plugin>
```

The verifier must report `ok=true`, matching base versions, no missing/extra/mismatched files, and the exact installed build ID. Resolve the installed cache path from current Codex state; never guess it from an earlier cycle.

A running Codex task may retain old Skill context and module imports after installation. Use a new task for clean activation when the test is meant to prove plugin discovery or default behavior. An existing controlled test task may continue only when it imports the exact new candidate path explicitly and records that narrower claim.

### 5. Run progressive live acceptance

Follow the acceptance matrix and browser protocol. Full dual-browser acceptance uses independent test sessions for:

- the Codex built-in browser; and
- external Chrome only when explicitly selected or required by the acceptance scope.

Start with an all-zero-interaction RunConfig. Keep separate browser bindings, tabs, run IDs, SQLite files, and evidence for each mode. Advance from 1 item to 10 items to the agreed full target only after the prior stage passes.

At every stage prove the whole item lifecycle:

```text
read facts -> plan -> execute each authorized control once -> verify ->
commit transition-pending SQLite/outbox -> transition once ->
finalize transition audit -> checkpoint sync -> verify server ACK
```

The browser hot path must not depend on remote upload completion. The upload path must not invent browser success. `transition_ok=null` is neither success nor uploadable completion.

### 6. Stop, classify, and preserve evidence on failure

On any browser, runner, persistence, sync, or safety failure:

1. stop feed actions immediately;
2. keep the same browser binding and tab;
3. do not retry the failed control, navigate blindly, finish an incomplete session, or create a replacement database;
4. force a sync checkpoint only when the transition audit is settled and the runtime skill permits it;
5. capture the smallest evidence set needed to classify the layer.

Classify the failure before editing:

- source or test-fixture defect;
- staged package or installed-cache mismatch;
- stale or wrong CLI binary;
- authorization or account identity;
- Codex task/plugin activation;
- browser binding, tab ownership, or control transport;
- Douyin page state or DOM extraction;
- runner timing, action, or transition state machine;
- SQLite transaction or outbox eligibility;
- sync process, lock, network, server admission, or ACK;
- workbench read-model visibility.

Do not label a browser-control failure as Douyin risk control without an on-page stop signal. Do not label a local `sent` row as server acceptance without the ACK. Mark evidence that cannot distinguish causes as unknown.

### 7. Fix the source and replay the failure

Fix the root cause in the authoritative repository, add or improve the regression test, and rerun every lower gate affected by the change. Then:

1. stamp a new candidate build ID;
2. restage and reinstall the complete plugin;
3. rerun the candidate verifier;
4. rerun the original minimal failing case;
5. rerun the 1-item, 10-item, and full target gates that the change invalidated.

Never carry a pass from an older build ID into the new cycle. Compare before/after evidence using the same invariant, not merely the final status label.

### 8. Decide candidate status

Use exactly one decision:

- `accepted`: every required automated, package, browser, persistence, upload, and workbench gate passed on the same candidate build ID;
- `rejected`: a reproducible defect remains;
- `blocked`: a required external precondition is unavailable and the missing evidence is named;
- `partial`: the tested layers pass, while untested layers are explicitly excluded from the claim.

Acceptance requires no unexplained anomaly, no transition-pending rows, `pending=0`, `dead=0`, server ACK reconciliation, and a reviewable cycle record. Do not call the Goal complete or the candidate ready because the token/time budget is ending.

## Release is a separate phase

Only after the candidate is accepted and the user explicitly requests release, read the release gates and perform the release workflow. After publication, install the published marketplace version in a clean task and repeat the release smoke gate. Report remote publication and local activation separately.

## Required final report

Lead with the candidate decision, then report this ledger with `pass`, `fail`, `blocked`, or `not run`:

| Layer | Required evidence |
|---|---|
| Source | commit/diff scope and regression test |
| Candidate | build ID and complete tree comparison |
| Installed plugin | enabled version and resolved cache path |
| CLI | version, artifact hash, and build provenance |
| Automated tests | commands and exact pass/fail counts |
| Built-in browser | staged live result and stop signals |
| External browser | staged live result and stop signals |
| Persistence | observations, transition audit, outbox counts |
| Upload | checkpoint result and server ACK reconciliation |
| Workbench | uploaded records visible or explicitly not tested |
| Release | local candidate only, published, or activated locally |

End with the remaining blocker or the next authorized action. Keep internal account references, run IDs, config hashes, and filesystem details out of user-facing prose unless the user asks for the audit-level identifiers.
