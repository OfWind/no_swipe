---
name: douyin-recommendation-rpa
description: Prepare, run, resume, or audit a Douyin recommendation-feed session for the currently logged-in account. Reuse one versioned interest profile per Douyin account, ask for explicit per-run targets and interaction rates, seal a confirmed RunConfig, execute only authorized actions, and persist auditable observations. Use when the user asks to 刷抖音推荐流、训练或检查账号画像、采集推荐视频、设置点赞收藏评论关注率、恢复推荐流任务、审计 RPA 结果，or export the resulting dataset.
---

# Douyin Recommendation RPA

Treat the logged-in Douyin account, its interest profile, and a run as three different objects:

- One Douyin account has one current logical `AccountProfile`.
- Updating that profile creates a new revision; never rewrite the revision used by an old run.
- Every run embeds an immutable profile snapshot and separately records that run's goals, rates, limits, and authorizations.

Do not assume any built-in topic persona. Examples such as 3C, technology, or AI are test data, not defaults.

## 1. Bind or reuse the account profile

Identify the active logged-in account using visible, non-secret account information. Use a stable `account_ref`; never store cookies, tokens, authorization headers, or browser session material.

Look for the workspace-local account profile under `.no-swipe/accounts/`. The exact directory name may be a safe hash or stable alias of `account_ref`.

- If a matching active profile exists, load it and tell the user which profile name and revision will be reused. Do not ask the profile questions again.
- If the account is unbound, ask once for the intended account persona: positive topics, high-priority topics if any, exclusions, and boundary guidance. Create revision 1 only after the user confirms the summary.
- If the user explicitly asks to change the persona, create revision N+1 and keep prior revisions.
- If the visible account does not match the selected `account_ref`, stop before any page action.

Resolve the current revision without asking the profile questions again:

```bash
node ../../runtime/src/cli.mjs profile resolve <account-ref> --data-dir .no-swipe
```

For a first binding or explicit revision update, validate the JSON and then use exactly one of:

```bash
node ../../runtime/src/cli.mjs profile bind <account-profile.json> --data-dir .no-swipe
node ../../runtime/src/cli.mjs profile update <account-profile.json> --data-dir .no-swipe
```

`bind` rejects an already-bound account. `update` requires the same `profile_id` and exactly the next revision, so a new run cannot accidentally create a second persona for one account.

Validate an account profile with:

```bash
node ../../runtime/src/cli.mjs profile validate <account-profile.json>
```

Use `../../config/schemas/account-profile.schema.json` as the durable contract. Generate the immutable run snapshot with:

```bash
node ../../runtime/src/cli.mjs profile snapshot <account-profile.json>
```

## 2. Prepare every run

Ask for the following run-scoped decisions even when the profile is reused:

1. Stop target: observed item count, and optional relevant-item target. Keep the two denominators distinct.
2. Explicit rates for each requested relevance tier: like, favorite, like-and-favorite overlap, comment, and completion.
3. Follow rate and total cap; not-interested rate and total cap; optional profile-sampling rate and total cap.
4. Explicit authorization for every state-changing action: like, favorite, comment, follow, not-interested, and profile visit.
5. For a positive comment rate: total cap, per-run or per-item approval mode, and comment guidance. Comment text must be created from the current item and the user's guidance; there is no built-in fixed copy.

Missing is not zero. Never silently replace an unanswered rate with `0`. If the user asks for a read-only run, record explicit zeros and all authorizations as `false`.

Check these semantic constraints before confirmation:

- All rates are between 0 and 1.
- `like_favorite_overlap_rate <= min(like_rate, favorite_rate)`.
- `like_rate + favorite_rate - like_favorite_overlap_rate <= 1`.
- Every positive state-changing rate has matching authorization `true`.
- Positive comment, follow, not-interested, or profile-visit rates have a positive total cap.
- Contract 1.0.0 only assigns comments, completion, and follow candidates to high-relevance content.

Write a draft `RunConfig` using `../../config/schemas/run-config.schema.json`, validate it, and present a compact confirmation summary containing:

- account and profile revision;
- observed/relevant targets;
- each eligibility denominator and rate;
- overlap semantics;
- each total cap;
- every authorized action;
- adapter, classifier, policy, and contract versions.

Do not start browsing from `draft` or `waiting_for_confirmation`. After the user explicitly confirms that exact summary, seal the config:

```bash
node ../../runtime/src/cli.mjs run confirm <draft.json> --confirmed-by user --output <confirmed.json>
node ../../runtime/src/cli.mjs run validate <confirmed.json> --require-confirmed
```

Any edit after confirmation invalidates `config_hash` and requires a new confirmation.

## 3. Run safely

Use the browser skill only with the user's already-open, logged-in tab. Do not ask for credentials. Do not bypass CAPTCHA, verification, rate limits, login gates, or access restrictions.

The browser module entry is:

```javascript
import { createDouyinRunner } from "./scripts/douyin_browser_runner.mjs";
```

Create it with the confirmed `runConfig`, verified `activeAccountRef`, output paths, and—only when comments are enabled—a contextual `createCommentText` callback. Per-item comment approval also requires an `approveComment` callback. Legacy `createTest5Runner`, `createTest6Runner`, and `createTest7Runner` are compatibility aliases and must receive the same confirmed configuration; their names grant no permission and change no rate.

At runtime:

- Validate `status=confirmed` and `config_hash` before touching the page.
- Stop on account mismatch before any action.
- Classify only from the embedded profile snapshot; never add product-topic defaults.
- Separate planned, attempted, verified, and actual action fields.
- Enforce authorization and total caps even when a quota candidate is assigned.
- Mark profile navigation accurately.
- Stop immediately when the page is unreliable, verification appears, account state changes, or the next card cannot be verified. A stopped or failed item must not consume a future quota position.

The human-readable browser selectors, visible UI copy, dwell parameters, and stop signals live in `../../config/platforms/douyin.v1.json`. Product goals, topic personas, permissions, and user secrets do not belong there.

## 4. Persist and resume

SQLite is the local fact source; JSONL/CSV are exchange or mirror formats. Persist every observation before moving on, and use the confirmed `run_id`, `account_ref`, `config_hash`, profile revision/hash, and feed sequence in records.

The current collector commands remain:

```bash
python3 scripts/douyin_rpa_collector.py start --db <db> --output-dir <dir> --session-name <name> --goal <count> --interest-profile <profile-name>
python3 scripts/douyin_rpa_collector.py record --db <db> --output-dir <dir> --payload '<json>'
python3 scripts/douyin_rpa_collector.py status --db <db> --output-dir <dir>
python3 scripts/douyin_rpa_collector.py finish --db <db> --output-dir <dir>
```

Until the collector is migrated to explicit `run_id` routing and idempotency constraints, do not run multiple active sessions against one database. After interruption, resume only when the saved quota state's `runConfigHash` matches the confirmed config.

## 5. Audit and export

Read [references/data-contract.md](references/data-contract.md) before changing observation semantics, and [references/quota-policy.md](references/quota-policy.md) before changing allocation behavior.

Reports must distinguish observed, relevant, planned, attempted, verified, and actual. Never infer missing values. Blank means not observed; `false` means explicitly observed false; `0` means an observed numeric zero.

For spreadsheet delivery, preserve at least:

- session summary;
- real per-batch detail;
- relevant-item records;
- field definitions and version metadata.

Do not bundle runtime data, account profiles, cookies, credentials, SQLite files, JSONL queues, CSV exports, or workbooks in the plugin package.
