---
name: douyin-recommendation-rpa
description: Configure, run, resume, or audit a Douyin recommendation-feed session for the logged-in account. Verify No Swipe upload authorization before every browser action, then open the account's creator profile, reuse its versioned persona, offer a compact natural-language preset or free-form customization, wait for the user's chat confirmation, create a durable Goal, and execute the confirmed rates and permissions. Use for 刷抖音推荐流、训练账号画像、采集推荐视频、设置点赞收藏关注率、恢复任务 or audit/export results.
---

# Douyin Recommendation RPA

Use one compact human-in-the-loop decision. Keep schemas, CLI details, and field-by-field forms out of the user-facing conversation.

Resolve `NO_SWIPE_PLUGIN_ROOT` as this plugin's root (the directory that contains `.codex-plugin/` and `config/`; from this skill file it is `../..`). Resolve `NO_SWIPE` as `~/.config/no-swipe/bin/<cli-version>/no-swipe` after the matching bootstrap script succeeds. Never call Python, the old Node CLI, Codex MCP helpers, or the retired MCP upload tools.

After bootstrap, set these once in the same shell that will run later commands:

```bash
export NO_SWIPE_PLUGIN_ROOT="<absolute plugin root>"
export NO_SWIPE="$HOME/.config/no-swipe/bin/<cli-version>/no-swipe"
```

Prefix every later invocation as `"$NO_SWIPE" …`. Examples below write `no-swipe` for readability; substitute `$NO_SWIPE` and keep `NO_SWIPE_PLUGIN_ROOT` exported.

The compiled `no-swipe` binary does not contain this skill and does not open a browser. You open workbench and Douyin pages yourself.

Unless the user explicitly asks for another browser (system Chrome, Safari, or chrome-devtools), use the Codex built-in browser for pairing, Douyin, and the workbench.

## 0. Authorize data upload before browser access

This authorization gate is mandatory for every new or resumed run. Stop before all Douyin, collector, Goal, and upload actions unless `auth status` returns `connected=true`.

1. Run the host bootstrap script from the plugin root: `scripts/bootstrap.sh` on macOS, `scripts/bootstrap.ps1` on Windows. It downloads only this machine's binary. Linux is not a release target.
2. Run `no-swipe auth status`.
3. When `connected=true`, continue to account resolution.
4. When not connected, run `no-swipe auth login`. It prints `pair_url` (`https://whislte.cc.cd/pair?code=…`). Open that exact URL with the Codex built-in browser. Do not only paste the link into chat. The pair page auto-approves the moment the user is signed in: a browser with a live workbench session authorizes with zero clicks, and a first-time user only completes email OTP once before auto-approval fires. Do not ask the user whether they clicked anything; the 同意授权 button is only a fallback when auto-approval reports an error. Wait until login prints `status=approved`, then retry `auth status` once.
5. Accept any email that can receive and verify the No Swipe OTP. Never ask for or handle the user's OpenAI API key, device token, OTP, or email password.

Do not tell the user to re-enable the plugin, install Codex CLI, Node, Python, or uv. If the binary is missing after bootstrap, start a **new Codex task** after plugin upgrade. On Windows, an unsigned `no-swipe.exe` may be blocked by SmartScreen or 360; treat that as a local trust prompt, not an install failure, and do not switch to a Node or Python workaround.

## 1. Open the account profile after upload authorization

Attach to the user's logged-in Douyin tab. The first browser action is to open the current logged-in account's own creator homepage when it is not already open:

1. Use the visible account/avatar/profile entry; do not guess a private URL.
2. Read the visible nickname and Douyin ID from that homepage.
3. Build `account_ref` from the visible Douyin ID and resolve only that account under `.no-swipe/accounts/`.
4. Stay on the homepage until account resolution and preset confirmation finish.

Stop before feed actions when identity is unreliable, the resolved account differs from the visible account, or a verification/access-limit page appears.

Treat the authenticated No Swipe user and Douyin accounts as a 1:n relationship: one email-authenticated No Swipe user may bind multiple Douyin accounts. Keep one hashed account directory and one logical `AccountProfile` per `account_ref`; binding or selecting another Douyin account creates or resolves its sibling directory and never replaces, renames, or deletes an existing account directory. Run `no-swipe config profile list --data-dir .no-swipe` when the local bindings need auditing. Do not put the login email in `account_ref` or local profile files.

Reuse the current revision for the visible Douyin account without asking the persona again. A user-requested persona change creates the next revision under that account's same `profile_id`. Switching Douyin accounts selects another stored profile; it is not a profile update.

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

This one confirmation is also the run-scoped, action-time authorization for every interaction in the sealed config: like, favorite, not interested, profile visits, and follow/comment candidates up to their confirmed rates and caps. During the feed loop, execute `plannedActions` (including `follow` when the quota marks that creator as a candidate) without any further chat question. Pause for a new chat question only when an action would exceed the sealed config, evidence is contradictory, or a safety stop triggers. Report executed interactions in Goal status updates instead of asking per item.

For an already-bound account, replace the onboarding copy with one line naming the reused profile and revision, then ask for `沿用并开始`、修改要求或`先不启动`. Free-form text creates a profile revision only for durable persona changes; target and interaction edits remain run-scoped.

## 3. Materialize and seal the decision

Materialize deterministic files from the returned tool result. For an unchanged first-time preset:

```bash
no-swipe config preset materialize ../../config/presets/douyin-youth-white-collar.v1.json \
  --account-ref <account-ref> --profile-id <profile-id> --run-id <run-id> \
  --output-dir .no-swipe/drafts/<run-id>
```

Bind revision 1 only after the structured confirmation. For an existing account, pass `--profile-mode replace --profile-input <that account's current.json>`: materialize preserves the input profile's `revision` and `created_at`, so the embedded snapshot matches the bound revision without a manual snapshot step. `--revision <n>` is available to pin the revision explicitly. Apply the confirmed run overrides without replacing the profile.

For free-form input, select `profile-mode` and `run-mode` independently:

```bash
no-swipe config preset materialize ../../config/presets/douyin-youth-white-collar.v1.json \
  --account-ref <account-ref> --profile-id <profile-id> --run-id <run-id> \
  --profile-mode <preset|extend|replace> [--profile-input <profile-input.json>] \
  --run-mode <preset|extend|replace> [--run-input <run-input.json>] \
  --output-dir .no-swipe/drafts/<run-id>
```

`replace` requires a complete input object for that scope and never merges the preset into it. `extend` performs a field override; arrays replace arrays rather than concatenate implicitly.

Seal the exact run config immediately after the human-in-the-loop answer:

```bash
no-swipe config run confirm <draft.json> --confirmed-by user --output <confirmed.json>
no-swipe config run validate <confirmed.json> --require-confirmed
```

The preset intentionally sets all action permissions to `true`. Rates and caps still control execution. In particular, comment permission is enabled while comment rate and cap are `0`, so no comment is posted. Any later configuration edit invalidates `config_hash` and returns to the compact chat confirmation.

## 4. Create one durable Goal

After confirmation and validation, inspect the active Goal and the current confirmed RunConfig. Continue the active Goal only when the persisted runtime state matches that config internally by `run_id`, `account_ref`, and `config_hash`; otherwise call `create_goal` exactly once. The user's chat answer above is the explicit request that authorizes Goal creation.

内部运行标识只保存在本地配置和状态文件中。Write the user-facing Goal objective and every Goal status update in natural Chinese business language. Include the confirmed count mode, target count, persistence requirement, completion validation, and safety stops while keeping UUIDs, `run_id`, `account_ref`, `profile_id`, `config_hash`, hashes, and filesystem paths out of user-visible text.

For an observation-count target, use an objective in this form:

```text
为当前已确认的抖音账号执行推荐流采集，持续完成并验证 <目标数> 条推荐内容观察。每条观察须先持久化再继续，任务完成前确认全部数据已上传并通过完整性校验；如遇账号不一致、验证码、访问限制、页面状态不可靠，或无法安全返回推荐流，立即停止并保留恢复进度。
```

For a relevant-content target, replace `完成并验证 <目标数> 条推荐内容观察` with `识别并验证 <目标数> 条符合画像的推荐内容`.

Do not ask the user to type `/goal`. If Goal tools are unavailable, do not claim durable execution and do not start the feed. Mark the Goal complete only after the persisted target and integrity checks pass; preserve it for recovery while an in-scope retry remains possible.

## 5. Apply the configured feed rules

Return to the recommendation feed only after confirmation. Follow the versioned profile snapshot:

- Apply a configured short-video rule before topic, like-count, creator-profile, completion, or positive-interaction handling. For the preset, a reliably measured video duration of 60 seconds or less enters the immediate lane: attempt not interested only when the confirmed authorization, quota, cap, and page state all allow it; otherwise swipe immediately. Do not wait, visit the creator homepage, or allocate like, favorite, comment, follow, or completion actions. When duration is missing or unreliable, continue through the ordinary rules rather than inferring a short video.
- Negative lane or excluded creator type: click not interested only when the classification is reliable.
- Other lanes: treat as watchable without requiring a positive keyword hit.
- Visible likes below the configured threshold: swipe directly unless visible feed time or the creator's work list confirms the video is newly published.
- High relevance: open that video's creator homepage when follower count or recent-like stability evidence is missing. Require the configured follower range and a relatively stable recent-like pattern before high-tier like, favorite, or follow allocation.
- Evidence missing or ambiguous: keep observing; do not infer high relevance or click not interested.

Profile inspection is evidence collection, not a quota action. Return to the same feed item or a reliably identified next item before continuing.

Drive the Codex built-in browser yourself unless the user explicitly asked for another browser. For each item, send visible page facts to `no-swipe step --db <sqlite> --json-file <payload.json>`. `no-swipe step` commits each observation to SQLite and its durable outbox before returning `status=committed`. When it returns `status=needs_evidence`, open the author homepage, collect `creatorFollowerCount`, `creatorRecentLikesStable`, and `isRecentlyPublished` (use `null` rather than guessing), and recall `step` with the same `record_id`. Do not call collector `record` during the feed loop.

Runtime gates remain mandatory:

- validate `status=confirmed` and `config_hash` before feed actions;
- enforce rates, caps, and permissions together;
- record planned, attempted, verified, and actual separately;
- do not pause the loop for per-item chat confirmation; the sealed confirmation from section 2 is the action-time authorization;
- stop on account mismatch, CAPTCHA, rate limits, login gates, unreliable DOM, or failed feed transition.

On a timed-out page read, `browser unavailable`, stale/detached tab, unreliable
card, or failed transition, stop feed actions and read
[references/browser-diagnostics.md](references/browser-diagnostics.md). Run its
bounded same-surface ladder before forming a root-cause claim. An external
Chrome comparison is optional and never proves that the Codex in-app Browser recovered.

## 6. Persist and audit

Persist each observation with `run_id`, `account_ref`, `config_hash`, profile revision/hash, and feed sequence before moving on. Resume only when the saved state's config hash matches.

Every observation must first be committed to SQLite and its durable outbox; the
browser loop must not wait for a remote request before moving to the next
feed item. Do not write CSV or Excel during collection. When the user asks
to inspect or deliver data, export from SQLite with `no-swipe export`.

At pause, page/CDP anomaly, handoff, or finish, run `no-swipe sync --db <sqlite>`.
Require `local.pending=0` at those lifecycle boundaries and before completing the Goal; review every `dead` record explicitly before completing the Goal.

When the task finishes and `pending=0`, run `no-swipe finish --db <sqlite>` once to close the active session.

After a successful run, open the workbench URL from `auth status` / credentials with the Codex built-in browser so the user can see uploaded authors. The pairing session already signed them in.

Read [references/data-contract.md](references/data-contract.md) when recording/exporting observations and [references/quota-policy.md](references/quota-policy.md) when changing allocations. Keep SQLite as the local fact source. CSV and Excel are on-demand exports, not live copies.

Never store or export cookies, tokens, authorization headers, credentials, or reusable browser-session material.
