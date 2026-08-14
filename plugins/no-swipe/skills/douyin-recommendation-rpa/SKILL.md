---
name: douyin-recommendation-rpa
description: Configure, run, resume, or audit a Douyin recommendation-feed session for the logged-in account. Open the account's creator profile first, reuse its versioned persona, offer a compact natural-language preset or free-form customization, wait for the user's chat confirmation, then create a durable Goal and execute the confirmed rates and permissions. Use for 刷抖音推荐流、训练账号画像、采集推荐视频、设置点赞收藏关注率、恢复任务 or audit/export results.
---

# Douyin Recommendation RPA

Use one compact human-in-the-loop decision. Keep schemas, CLI details, and field-by-field forms out of the user-facing conversation.

## 1. Open the account profile first

Attach to the user's logged-in Douyin tab. The first browser action is to open the current logged-in account's own creator homepage when it is not already open:

1. Use the visible account/avatar/profile entry; do not guess a private URL.
2. Read the visible nickname and Douyin ID from that homepage.
3. Build `account_ref` from the visible Douyin ID and resolve `.no-swipe/accounts/`.
4. Stay on the homepage until account resolution and preset confirmation finish.

Stop before feed actions when identity is unreliable, the resolved account differs from the visible account, or a verification/access-limit page appears.

One Douyin account has one logical `AccountProfile`. Reuse its current revision without asking the persona again. A user-requested persona change creates the next revision under the same `profile_id`.

## 2. Ask for one compact confirmation

Read `../../config/presets/douyin-youth-white-collar.v1.json`. Show only:

- its `display_name`;
- its single-paragraph `user_facing_copy`;
- its single-sentence `confirmation_notice`.

End the current turn with this one compact chat question:

> 请回复“使用预设并开始”，或直接写修改要求；回复“先不启动”则保持账号画像、运行配置和推荐流不变。

Keep the browser on the account homepage and perform no feed action while waiting. Treat the next user message as the answer and resume preparation from it.

Free-form text is the customization path:

- Clear partial edits such as `使用预设，300条` use `extend`: retain unmentioned values and change the stated fields without another question.
- `补充`、`沿用`、`保留` mean `extend` for the named profile or run fields.
- `完全修改`、`完全替换`、`不要原预设` mean `replace` for the named scope. Build that profile or run scope from a neutral complete object; copy no value from the preset into the replaced scope.
- Ask one additional focused chat question only when the difference between `extend` and `replace`, or another ambiguity, would materially change an external action. Wait for that answer before continuing.

`使用预设并开始` is explicit confirmation to bind the profile, confirm the run, create a durable Goal, and execute. `先不启动` ends without binding, confirming, creating a Goal, or operating the feed.

For an already-bound account, replace the onboarding copy with one line naming the reused profile and revision, then ask for `沿用并开始`、修改要求或`先不启动`. Free-form text creates a profile revision only for durable persona changes; target and interaction edits remain run-scoped.

## 3. Materialize and seal the decision

Materialize deterministic files from the returned tool result. For an unchanged first-time preset:

```bash
node ../../runtime/src/cli.mjs preset materialize ../../config/presets/douyin-youth-white-collar.v1.json \
  --account-ref <account-ref> --profile-id <profile-id> --run-id <run-id> \
  --output-dir .no-swipe/drafts/<run-id>
```

Bind revision 1 only after the structured confirmation. For an existing account, embed its current profile snapshot and apply the confirmed run overrides without replacing the profile.

For free-form input, select `profile-mode` and `run-mode` independently:

```bash
node ../../runtime/src/cli.mjs preset materialize ../../config/presets/douyin-youth-white-collar.v1.json \
  --account-ref <account-ref> --profile-id <profile-id> --run-id <run-id> \
  --profile-mode <preset|extend|replace> [--profile-input <profile-input.json>] \
  --run-mode <preset|extend|replace> [--run-input <run-input.json>] \
  --output-dir .no-swipe/drafts/<run-id>
```

`replace` requires a complete input object for that scope and never merges the preset into it. `extend` performs a field override; arrays replace arrays rather than concatenate implicitly.

Seal the exact run config immediately after the human-in-the-loop answer:

```bash
node ../../runtime/src/cli.mjs run confirm <draft.json> --confirmed-by user --output <confirmed.json>
node ../../runtime/src/cli.mjs run validate <confirmed.json> --require-confirmed
```

The preset intentionally sets all action permissions to `true`. Rates and caps still control execution. In particular, comment permission is enabled while comment rate and cap are `0`, so no comment is posted. Any later configuration edit invalidates `config_hash` and returns to the compact chat confirmation.

## 4. Create one durable Goal

After confirmation and validation, inspect the active Goal. Continue a compatible Goal for the same `run_id`; otherwise call `create_goal` exactly once. The user's chat answer above is the explicit request that authorizes Goal creation. Use an objective with the confirmed values, for example:

```text
Execute Douyin run <run_id> for <account_ref> under config <config_hash>. Continue until <observed_target or relevant_target> is durably recorded and validated. Persist every observation before advancing; stop on account mismatch, CAPTCHA, access limits, unreliable page state, or an unrecoverable failure to return from a creator profile.
```

Do not ask the user to type `/goal`. If Goal tools are unavailable, do not claim durable execution and do not start the feed. Mark the Goal complete only after the persisted target and integrity checks pass; preserve it for recovery while an in-scope retry remains possible.

## 5. Apply the configured feed rules

Return to the recommendation feed only after confirmation. Follow the versioned profile snapshot:

- Negative lane or excluded creator type: click not interested only when the classification is reliable.
- Other lanes: treat as watchable without requiring a positive keyword hit.
- Visible likes below the configured threshold: swipe directly unless visible feed time or the creator's work list confirms the video is newly published.
- High relevance: open that video's creator homepage when follower count or recent-like stability evidence is missing. Require the configured follower range and a relatively stable recent-like pattern before high-tier like, favorite, or follow allocation.
- Evidence missing or ambiguous: keep observing; do not infer high relevance or click not interested.

Profile inspection is evidence collection, not a quota action. Return to the same feed item or a reliably identified next item before continuing.

Use `createDouyinRunner()` from `scripts/douyin_browser_runner.mjs` with the confirmed `runConfig`, verified `activeAccountRef`, and a `resolveProfileEvidence` callback. While the author homepage is visible, that callback must return visible `creatorFollowerCount`, `creatorRecentLikesStable`, and `isRecentlyPublished` evidence; use `null` rather than guessing. Legacy Test5/6/7 names carry no behavior or permission.

Runtime gates remain mandatory:

- validate `status=confirmed` and `config_hash` before feed actions;
- enforce rates, caps, and permissions together;
- record planned, attempted, verified, and actual separately;
- stop on account mismatch, CAPTCHA, rate limits, login gates, unreliable DOM, or failed feed transition.

## 6. Persist and audit

Persist each observation with `run_id`, `account_ref`, `config_hash`, profile revision/hash, and feed sequence before moving on. Resume only when the saved state's config hash matches.

After every collector `start`, `record`, and `finish` result, inspect `mcp_upload`:

1. When `status=ready`, call the plugin's `ingest_observation_batch` MCP tool with `mcp_upload.arguments` exactly.
2. On a successful tool result, run collector `mcp-ack` with one JSON object containing the emitted `batch_record_ids` and the tool's structured response under `response`.
3. Run collector `mcp-next` and repeat until it returns `status=idle` or no batch is currently due.

The MCP connection owns authentication; keep OAuth tokens out of local commands and files. A tool failure leaves the outbox pending for retry. Treat synchronization as complete only when the durable queue reports `pending=0`; review every `dead` record explicitly before completing the Goal. The legacy direct `auth-login` and `upload` commands are compatibility-only and are not part of the installed-plugin flow.

Read [references/data-contract.md](references/data-contract.md) when recording/exporting observations and [references/quota-policy.md](references/quota-policy.md) when changing allocations. Keep SQLite as the local fact source and JSONL/CSV/Excel as exchange or derived outputs.

Never store or export cookies, tokens, authorization headers, credentials, or reusable browser-session material.
