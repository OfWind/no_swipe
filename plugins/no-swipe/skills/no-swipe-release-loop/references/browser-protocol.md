# Built-in and external browser protocol

Read this reference before any live acceptance. Then read the sibling `douyin-recommendation-rpa/SKILL.md` from the exact candidate plugin root and the available control skill for the selected browser.

## Two independent browser adapters

Treat Codex's built-in browser and external Chrome as independent implementations of the same RPA contract. A pass in one does not prove the other works.

Keep separate browser bindings, tabs, run IDs, SQLite files, and evidence for the two modes.

| Concern | Codex built-in browser | External Chrome |
|---|---|---|
| Activation | Current task must have the candidate Skill loaded | Chrome connector/extension must control the selected tab |
| Ownership | Preserve the built-in browser binding and Douyin tab across turns | Preserve the Chrome session and exact claimed tab across turns |
| Read path | Candidate `douyin_page_facts.js` through read-only evaluate | The same candidate facts source through read-only evaluate |
| Write path | Locator/CUA supported by the live tab | Locator/CUA supported by the external Chrome tab |
| Persistence | Dedicated RunConfig, run ID, and SQLite | Different dedicated RunConfig, run ID, and SQLite |
| Claim | Proves the built-in adapter only | Proves the external adapter only |

Do not use one browser as an automatic fallback for the other. An external Chrome comparison is diagnostic evidence; it does not recover or validate a broken built-in binding.

## Live-test preflight

Before the first feed action:

1. run the exact candidate bootstrap and require `auth.connected=true`;
2. verify machine-level outbox recovery is settled or explicitly preserve the remaining rows;
3. in every new Codex task, open `https://www.douyin.com/user/self` as the first Douyin identity action in the dedicated Douyin tab; the workbench may open concurrently in its separate tab;
4. read the visible nickname and Douyin ID, retry the same fixed self page once when the ID is unavailable, and stop immediately on a login, CAPTCHA, verification, or access-limit blocker;
5. after two blocker-free attempts without an ID, accept only an exact nickname that uniquely matches one startup account; never substitute a feed author's profile or a fuzzy nickname match;
6. validate a confirmed all-zero-interaction RunConfig and its hash;
7. bind the test to one browser mode, one tab, one database, and one Goal;
8. record the current candidate build ID and CLI binary hash.

Stop before feed actions on account mismatch, login gate, CAPTCHA, on-page access limit, unreliable page facts, stale/detached tab, or uncertain control ownership.

## Per-item protocol

Create one runner instance from the exact candidate root and reuse it while the tab, RunConfig, database, and candidate remain unchanged. One `processOne()` call owns one item.

- Read facts with the shipped extractor; do not rediscover selectors from a full-page snapshot.
- Accept a safety phrase only with structured evidence from a viewport-visible blocking container; whole-page text is not a stop detector.
- Keep `evaluate` read-only.
- Execute state changes only through live locator/CUA calls.
- Attempt every planned interaction or transition control at most once.
- Treat an ID observed earlier in the same session as a transition-only duplicate: do not allocate quota, execute interactions, persist it, upload it, or increment progress. Keep duplicate transitions bounded and stop if they do not reach an unobserved ID.
- Record planned, attempted, verified, and actual results separately.
- Commit the observation locally before attempting the transition.
- Verify transition by a changed active `aweme_id` across the runner's bounded staged waits.
- Finalize the transition audit before allowing the outbox row to upload.
- When an interaction such as not interested changes the active ID, finalize that successful transition before applying a destination-page safety stop.
- Stop on any non-advanced terminal status and preserve the tab. Preserve `committed`, `stop_phase`, `progress`, and `transition` in the result so the caller can distinguish an untouched page from a completed current item followed by a blocked destination page.

Do not issue a second click, keypress, scroll, navigation, or reload from a timeout/error catch.

## Controlled transition acceptance

The automated harness and at least one live smoke must cover:

1. ArrowDown changes the ID quickly.
2. ArrowDown changes the ID only during the later passive settle stages.
3. ArrowDown has no effect and no layout arrow exists; one physical wheel action changes the ID.
4. Neither permitted control changes the ID; the runner returns `feed_transition_unverified`.
5. Viewport facts are unreliable; the runner does not guess a fallback.

Record the before/after IDs, exact control count, staged wait sequence, success latency, final reason, and page stop signal. A tool call returning success is not a verified transition.

## Cross-browser comparison

Compare contract outcomes, not feed content:

- fact schema and active-slide selection;
- allowed action methods and attempt counts;
- transition timing/result;
- SQLite/outbox state transitions;
- sync and ACK behavior;
- stop-signal handling.

The two browsers will consume different feed items and change account history. Do not require identical videos, semantic classifications, or timing. Run the least invasive mode first and keep interactions at zero unless the user explicitly confirms an interaction-control test.

## Failure handoff

When a browser test fails, preserve:

- candidate build ID and exact imported runner path;
- browser mode, binding/session identity, and tab identity;
- current URL, surface, active `aweme_id`, and `stop_text_hit`;
- last successful item and database counts;
- one failing control call, its timing, and its verification facts;
- transition/outbox state and sync status.

Then stop. Do not replace the tab or database until the failure has been classified and a new candidate is ready.
