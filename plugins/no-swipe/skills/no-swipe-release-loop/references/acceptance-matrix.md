# Acceptance matrix

Read this reference for every candidate cycle. Select the smallest set that proves the user's claim; all rows are required for a formal release candidate.

## Gate sequence

| Gate | Scope | Pass evidence | Failure action |
|---|---|---|---|
| A0 Baseline | Repository, versions, binary, installed state | Cycle record contains source commit/diff, candidate build ID, CLI version/hash, installed path/version | Stop; facts are not attributable to one build |
| A1 Static | Plugin and CLI syntax, schemas, metadata | Repository checks exit 0 | Fix source and add a regression test |
| A2 Unit/contract | CLI, runner, facts, Skill contract | All applicable suites pass with exact counts | Reduce to the failing test; do not package |
| A3 Package | Complete staged tree and version pairing | Candidate verifier returns `ok=true` | Rebuild the candidate from source |
| A4 Activation | Codex install/cache/task loading | Plugin is installed/enabled at exact build ID; clean task sees the Skill | Reinstall or start a clean task; do not test stale context |
| A5 CLI/local data | Start, step, transition, status, sync, finish, recovery | SQLite and outbox invariants hold without browser assumptions | Fix CLI/persistence before live RPA |
| A6 One-item live | One zero-interaction item in each required browser | Observation durable, transition verified, audit finalized, no stop signal | Freeze the tab and diagnose the layer |
| A7 Checkpoint live | Ten items in each required browser | Continuous indices, expected unique IDs, checkpoint sync accepted, no pending/dead | Stop at checkpoint; do not scale |
| A8 Full live | Agreed target, normally 100 for candidate acceptance | Target complete, finish once, local/server counts reconcile | Candidate rejected or blocked |
| A9 Workbench | Uploaded records in user-facing read model | Expected authors/observations are visible and attributable to the run | Diagnose ingest/read-model layer separately |
| A10 Release smoke | Published plugin installed in a clean task | Published version, binary, one-item run, persistence and ACK all verified | Roll back activation; do not rewrite artifacts |

## Mandatory regression scenarios

Run the scenarios affected by the change. A formal release candidate covers all of them through automated tests, controlled live tests, or both.

### Packaging and runtime identity

- Every new Codex task opens `https://www.douyin.com/user/self` as its first Douyin identity action while the workbench stays in a separate tab; a same-task resume reuses the settled identity unless visible evidence contradicts it.
- The self page receives at most two bounded attempts. A blocker stops the run; a blocker-free missing ID may fall back only to one unique exact visible nickname match.
- Source, staged candidate, and installed cache contain the same shipped files.
- Semantic version and plugin build ID are unique for every changed shipped file set; base plugin and CLI versions are paired.
- The running task imports the exact candidate root under test.
- Browser-hosted modules work when `process` is absent.
- A Skill-only candidate does not silently replace the CLI binary; a CLI candidate proves the binary SHA-256.

### Page facts and controls

- The active slide is selected by viewport intersection, not positive dimensions alone.
- Safety text triggers only from a viewport-visible blocking container and returns structured evidence; identical words in whole-page text, offscreen help copy, stale portals, or content captions do not stop the run.
- A gallery resource in the active slide yields `content_type=image_text`, null video timing, a zero-dwell direct-skip classification, and an image-compatible one-time not-interested menu target.
- Waterfall, mounted-player, active-slider, login, CAPTCHA, and access-limit states are distinct.
- State-changing actions never occur inside read-only `evaluate`.
- Each planned interaction control is attempted at most once and verified separately.
- Missing layout-specific arrows are normal page facts, not locator failures.
- A keypress that has no immediate effect remains observable through the bounded passive settle window.
- If the ID remains unchanged and viewport facts are reliable, one physical CUA wheel fallback is attempted; no fixed-arrow fallback is used.
- A hidden placeholder video cannot override a viewport-visible video in the same active slide.
- A mounting active slide is passively reread before planning; unresolved media returns `media_loading` without creating an observation.
- An unchanged ID after the initial stages returns `transition_pending` with `transition_ok=null`, not a false failure.
- The next call on the same runner first reconciles a delayed change, then may retry only the last transition control once without replanning or duplicating the observation.
- Re-visiting an ID observed earlier in the same session performs no dwell, interaction, persistence, upload, or progress increment; duplicate-page transitions are bounded and only an unobserved ID may become the next observation.
- If a verified not-interested action changes the active ID before a safety signal is observed, the current transition is finalized as successful and the stop is attributed to the destination page preflight. Structured output preserves `committed`, `stop_phase`, `progress`, and the transition result.

### Persistence and upload

- The observation is first committed with `scroll_delta=null` and `transition_ok=null`.
- Transition finalization updates the observation and corresponding outbox payload atomically to the actual result.
- Rows with `transition_ok=null` are never uploaded.
- The browser loop can advance after local durability without waiting for a remote request.
- The 10-item checkpoint returns only `ok`, `idle`, or the intentionally supported `deferred` state.
- Sync failures are visible in structured output and failure exit semantics; stdout/stderr are not the only evidence channel.
- Lock contention cannot let `finish` report success while pending rows remain.
- Startup recovery scans every run database under the machine data directory.
- Duplicate upload retries reconcile by record identity and do not create duplicate observations.
- Completion requires `pending=0`, `transition_pending=0`, `dead=0`, and local sent counts reconciled to server ACKs.

## Progressive live targets

Use separate RunConfigs and databases per browser mode.

| Stage | Target | Purpose | Promotion rule |
|---|---:|---|---|
| Smoke | 1 | Prove one complete state transition and durable record | Every field and ACK reconciles |
| Checkpoint | 10 | Prove runner reuse and automatic checkpoint behavior | Continuous indices, no drift, no pending/dead |
| Acceptance | 100 | Prove bounded stability across realistic feed variation | Finish once and pass full integrity audit |

Start with all interaction rates, caps, and permissions at zero. Test likes, favorites, follows, comments, or not-interested only in a separate explicitly confirmed RunConfig. A zero-interaction pass proves observation/transition/persistence/upload mechanics; it does not prove positive interaction controls.

## Cycle evidence record

Keep a structured record outside the browser page containing:

```text
candidate_build_id
source_commit_and_dirty_scope
cli_version_and_sha256
installed_plugin_version_and_path
browser_mode_and_binding_identity
account_display_identity
run_config_status_and_hash
database_identity
test_stage_and_item_count
before_and_after_aweme_ids
control_attempt_counts_and_transition_timing
sqlite_observed_relevant_progress
outbox_pending_transition_pending_dead_sent
sync_status_and_server_ack
stop_signal
decision_and_remaining_gap
```

Do not store secrets or reusable browser-session material in this record.
