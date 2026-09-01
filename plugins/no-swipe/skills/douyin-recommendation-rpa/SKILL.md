---
name: douyin-recommendation-rpa
description: Configure, run, resume, or audit a Douyin recommendation-feed session for the logged-in account. Verify No Swipe upload authorization before every browser action, then read the visible logged-in Douyin identity on the current page, reuse its versioned persona, offer a compact natural-language preset or free-form customization, wait for the user's chat confirmation, create a durable Goal, and execute the confirmed rates and permissions. Open the logged-in account's own profile only when its Douyin ID is not visible on the current surface; never open another creator's homepage. Use for 刷抖音推荐流、训练账号画像、采集推荐视频、设置点赞收藏关注率、恢复任务 or audit/export results.
---

# Douyin Recommendation RPA

Use one compact human-in-the-loop decision. Keep schemas, CLI details, and field-by-field forms out of the user-facing conversation.

Resolve `NO_SWIPE_PLUGIN_ROOT` as this plugin's root (the directory that contains `.codex-plugin/` and `config/`; from this skill file it is `../..`). Read every shipped file — this skill, the scripts it references, and the presets — from this same root; when the marketplace cache holds several plugin versions, mixing them runs stale guidance against a new binary. For an ordinary installed release, resolve `NO_SWIPE` as `~/.config/no-swipe/bin/<cli-version>/no-swipe`, where `<cli-version>` is the `version` inside `$NO_SWIPE_PLUGIN_ROOT/config/cli-version.json`; read it after bootstrap succeeds and never hardcode a version remembered from an earlier task. When this Skill is invoked by `no-swipe-release-loop` for a candidate whose CLI changed, use the candidate-specific binary and test data directory recorded by that cycle instead; never overwrite or invoke the formal pinned binary for candidate evidence. Never call Python, the old Node CLI, Codex MCP helpers, or the retired MCP upload tools.

After bootstrap, set these once in the same shell that will run later commands:

```bash
export NO_SWIPE_PLUGIN_ROOT="<absolute plugin root>"
export NO_SWIPE="$HOME/.config/no-swipe/bin/<cli-version>/no-swipe"
```

Prefix every later invocation as `"$NO_SWIPE" …`. Examples below write `no-swipe` for readability; substitute `$NO_SWIPE` and keep `NO_SWIPE_PLUGIN_ROOT` exported.

The compiled `no-swipe` binary does not contain this skill and does not open a browser. You open workbench and Douyin pages yourself.

Unless the user explicitly asks for another browser (system Chrome, Safari, or chrome-devtools), use the Codex built-in browser for pairing, Douyin, and the workbench.

Douyin and the workbench live in two dedicated tabs that coexist. Opening one surface never navigates the other's tab: when the tab you need does not exist yet, create a new one, and when both are needed open both. Never `goto` a workbench URL in the Douyin tab or a Douyin URL in the workbench/pairing tab. Keep the Douyin tab available across turns (mark it for handoff) and mark the workbench tab as a deliverable whenever it is shown to the user.

## 0. One startup call, then authorize only if needed

This authorization gate is mandatory for every new or resumed run. Stop before all Douyin, collector, Goal, and upload actions unless startup reports `auth.connected=true`.

1. Run the host bootstrap script from the plugin root: `scripts/bootstrap.sh` on macOS, `scripts/bootstrap.ps1` on Windows. It is the only update step (downloads this machine's binary when the pinned version is missing and prunes older versions), and it chains `no-swipe up` before exiting. Its final JSON line carries everything startup needs: `auth.connected`, `next`, the machine-level `data_dir` (substitute it for `<data_dir>` in later commands), locally bound `accounts`, and `workbench_url`. After a successful bootstrap, do not run separate `auth status` or `config profile list` calls. Linux is not a release target.
   During a release-loop candidate test with changed CLI bytes, do not run bootstrap: run the exact candidate binary as `"$NO_SWIPE" up --data-dir <candidate-test-data-dir>`, require the same `auth.connected=true` gate, and keep every draft, account binding, run database, outbox, and export inside that candidate test directory. This candidate-only branch must not prune or replace the formal binary or scan formal run databases.
2. When `next=resolve_account`, continue straight to account resolution and reuse the returned `accounts` list.
3. When `next=auth_login`, run `no-swipe auth login`. It prints `pair_url` (`https://whislte.cc.cd/pair?code=…`). Open that exact URL with the Codex built-in browser in its own tab. Do not only paste the link into chat. The pair page auto-approves the moment the user is signed in: a browser with a live workbench session authorizes with zero clicks, and a first-time user only completes email OTP once before auto-approval fires. Do not ask the user whether they clicked anything; the 同意授权 button is only a fallback when auto-approval reports an error. `status=approved` already persists credentials; keep that signed-in workbench tab open, and continue to account resolution in a separate Douyin tab.
4. Accept any email that can receive and verify the No Swipe OTP. Never ask for or handle the user's OpenAI API key, device token, OTP, or email password.

Keep plugin and binary updates inside bootstrap. Talk to the user only about the run, the preset, or the email OTP. Do not tell the user to re-enable the plugin, install Codex CLI, Node, Python, or uv. If the binary is missing after bootstrap, tell them a **new Codex task** will finish activating the plugin, and keep any local outbox. On Windows, an unsigned `no-swipe.exe` may be blocked by SmartScreen or 360; treat that as a local trust prompt, not an install failure, and do not switch to a Node or Python workaround.

## 1. Resolve the logged-in account after upload authorization

Identity comes from the logged-in account's own canonical profile URL, never from feed content: the active feed card's author avatar is not an identity source, and another creator's homepage must never be opened because leaving the feed for a creator profile can bias later recommendations toward that person.

1. The first browser action of a **new** session, or of a resume whose Douyin tab is new/stale, is opening `https://www.douyin.com/user/self` in the Douyin tab. This fixed self-referential URL always shows the logged-in account; it is not a guessed creator URL and never construct `/user/<id>` for anyone else. If this same browser binding already showed the matching `抖音号：…` on the current Douyin surface earlier in the task, do not navigate to `/user/self` again — extra profile/feed round-trips are a common 429 trigger.
2. Read the visible nickname and Douyin ID (`抖音号：…`) from the current page. A login gate or verification page here means the account is not usable: show the browser to the user, ask them to log in, and do not proceed. Do not treat the substring `登录` inside `保存登录信息` as a login gate. Only `douyin_page_facts.js` `stop_text_hit`, or the exact phrases `登录后继续` / `请先登录`, count.
3. Build `account_ref` from the visible Douyin ID and resolve only that account under the machine-level data dir (the `data_dir` in the startup output; account bindings, runs, and drafts all live there and survive across Codex task workspaces). A resolved ID that differs from a previously bound `account_ref` means the Douyin account was switched: select or create its sibling account directory, never update the old account's profile. When the startup output reports `legacy_workspace_data`, an older workspace-local copy exists: pass `--data-dir <that path>` to keep using it, or simply re-confirm once and the account re-binds under the machine-level dir.
4. Record the nickname for audit: `no-swipe config profile identity <account-ref> --nickname <可见昵称>`.
5. Identity is now settled; go straight to the compact confirmation below. Navigate to the recommendation feed (`https://www.douyin.com/?recommend=1`) only after the run is confirmed.

Treat Douyin as a SPA. Outside the feed runner, perform at most one browser action per call and verify the resulting URL or visible state in a separate bounded call. Inside the feed, one bounded `runner.processOne()` call owns the complete current-item state machine; it may execute several independently authorized controls, but clicks each planned control at most once and verifies it before continuing. On both paths, never use `expectNavigation` on Douyin or issue a second click from a timeout/error catch. If a click or read times out, stop feed actions, reuse the same browser binding and current tab, and run the bounded same-surface diagnostics below.

Stop before feed actions when identity is unreliable, the resolved account differs from the visible account, or a verification/access-limit page appears.

Treat the authenticated No Swipe user and Douyin accounts as a 1:n relationship: one email-authenticated No Swipe user may bind multiple Douyin accounts. Keep one hashed account directory and one logical `AccountProfile` per `account_ref`; binding or selecting another Douyin account creates or resolves its sibling directory and never replaces, renames, or deletes an existing account directory. The startup `up` output already lists local bindings; run `no-swipe config profile list` only for a deeper audit. Do not put the login email in `account_ref` or local profile files.

Reuse the current revision for the visible Douyin account without asking the persona again. A user-requested persona change creates the next revision under that account's same `profile_id`. Switching Douyin accounts selects another stored profile; it is not a profile update.

## 2. Ask for one compact confirmation

Read `../../config/presets/douyin-youth-white-collar.v1.json`. Show only:

- its `display_name`;
- its single-paragraph `user_facing_copy`;
- its single-sentence `confirmation_notice`.

End the current turn with this one compact chat question:

> 回复 1 使用该画像并开始，或直接写修改要求。

Keep the browser on the current Douyin surface and perform no feed action while waiting. Treat the next user message as the answer and resume preparation from it. `1`、`使用预设并开始`、`沿用并开始` are all explicit confirmation; a user message that declines or asks to hold means no binding, no Goal, and no feed action—do not advertise that option in the question.

Free-form text is the customization path:

- Clear partial edits such as `使用预设，300条` use `extend`: retain unmentioned values and change the stated fields without another question.
- `补充`、`沿用`、`保留` mean `extend` for the named profile or run fields.
- `完全修改`、`完全替换`、`不要原预设` mean `replace` for the named scope. Build that profile or run scope from a neutral complete object; copy no value from the preset into the replaced scope.
- Ask one additional focused chat question only when the difference between `extend` and `replace`, or another ambiguity, would materially change an external action. Wait for that answer before continuing.

Explicit confirmation (`1` / `使用预设并开始` / `沿用并开始`) binds the profile, confirms the run, creates a durable Goal, and executes.

This one confirmation is also the run-scoped, action-time authorization for like, favorite, not interested, and follow/comment candidates up to their confirmed rates and caps. When the in-app browser's safety or Agent Confirmations Policy asks for user confirmation before a state-changing page action, this sealed confirmation is that confirmation for in-quota feed interactions; cite it and continue instead of asking again. Never open a creator homepage, even when the sealed config sets `profile_visit` or `profile_sampling`. During the feed loop, execute `plannedActions` (including `follow` when the quota marks that creator as a candidate) without any further chat question. Pause for a new chat question only when an action would exceed the sealed config, evidence is contradictory, or a safety stop triggers. Report executed interactions in Goal status updates instead of asking per item.

For an already-bound account, replace the onboarding copy with one line naming the reused profile and revision, then ask: 回复 1 沿用并开始，或直接写修改要求。 Free-form text creates a profile revision only for durable persona changes; target and interaction edits remain run-scoped.

## 3. Materialize and seal the decision

Materialize deterministic files from the returned tool result. For an unchanged first-time preset:

```bash
no-swipe config preset materialize ../../config/presets/douyin-youth-white-collar.v1.json \
  --account-ref <account-ref> --profile-id <profile-id> --run-id <run-id> \
  --output-dir <data_dir>/drafts/<run-id>
```

Bind revision 1 only after the structured confirmation. For an existing account, pass `--profile-mode replace --profile-input <that account's current.json>`: materialize preserves the input profile's `revision` and `created_at`, so the embedded snapshot matches the bound revision without a manual snapshot step. `--revision <n>` is available to pin the revision explicitly. Apply the confirmed run overrides without replacing the profile.

For free-form input, select `profile-mode` and `run-mode` independently:

```bash
no-swipe config preset materialize ../../config/presets/douyin-youth-white-collar.v1.json \
  --account-ref <account-ref> --profile-id <profile-id> --run-id <run-id> \
  --profile-mode <preset|extend|replace> [--profile-input <profile-input.json>] \
  --run-mode <preset|extend|replace> [--run-input <run-input.json>] \
  --output-dir <data_dir>/drafts/<run-id>
```

`replace` requires a complete input object for that scope and never merges the preset into it. `extend` performs a field override; arrays replace arrays rather than concatenate implicitly.

Seal the exact run config immediately after the human-in-the-loop answer:

```bash
no-swipe config run confirm <draft.json> --confirmed-by user --output <confirmed.json>
no-swipe config run validate <confirmed.json> --require-confirmed
```

The preset intentionally sets the executable interaction permissions—`like`, `favorite`, `comment`, `follow`, and `not_interested`—to `true`, while `profile_visit` is `false` and `profile_sampling` has rate and cap `0`. Rates and caps still control execution. In particular, comment permission is enabled while comment rate and cap are `0`, so no comment is posted. Any later configuration edit invalidates `config_hash` and returns to the compact chat confirmation.

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

Return to the recommendation feed only after confirmation. Start the counting session before the first `step`, reusing the confirmed `run_id` (the default target is 1000 observed items; `--relevant` switches the target to relevant-only):

```bash
no-swipe start --db <data_dir>/runs/<run-id>/douyin_rpa_session.sqlite --target <目标数> --new
```

Pass that same `--db` path to every later `step`, `status`, and `finish` call. Follow the versioned profile snapshot:

- Apply a configured short-video rule before topic, like-count, creator-profile, completion, or positive-interaction handling. For the preset, a reliably measured video duration of 60 seconds or less enters the immediate lane: attempt not interested only when the confirmed authorization, quota, cap, and page state all allow it; otherwise swipe immediately. Do not wait, visit the creator homepage, or allocate like, favorite, comment, follow, or completion actions. When duration is missing or unreliable, continue through the ordinary rules rather than inferring a short video.
- A reliably identified image-text/gallery post enters the same zero-dwell immediate lane before topic, like-count, creator-profile, completion, or positive-interaction handling. Attempt not interested once only when the confirmed authorization, quota, cap, and current image-post menu target all allow it; otherwise swipe immediately. Never invent a video duration for image content.
- Negative lane or excluded creator type: click not interested only when the classification is reliable.
- Other lanes: treat as watchable without requiring a positive keyword hit.
- Visible likes below the configured threshold: swipe directly unless the visible feed timestamp confirms the video is newly published. Do not open a creator homepage to inspect the work list.
- Interaction eligibility: profiles with positive topics reach the high lane through keyword matches; exclusion-only profiles without positive topics (the shipped preset) treat every watchable item as interaction-eligible, and the confirmed rates and caps do the throttling. Do not open a creator homepage for extra evidence.
- Evidence missing or ambiguous: keep observing; do not infer high relevance or click not interested.

Drive the Codex built-in browser yourself unless the user explicitly asked for another browser. Do not rediscover the page: `up.feed.entry_plan` and the shipped JS runner are the known-good mechanics, so no full-page DOM snapshots, no selector archaeology, and no reading CLI source code during the loop.

The Codex `evaluate` scope is read-only. The runner reads facts through the shipped `douyin_page_facts.js`, then performs every state-changing action with the live tab's `tab.playwright.locator(...).click(...)` or `tab.cua.keypress`. It never places clicks, timers, or event dispatch inside `evaluate`.

- Follow `up.feed.entry_plan`. After `?recommend=1`, call `runner.readCurrent()` **before** any card click. `surface=active_video` is the stable historical surface name for an active feed slider and may contain either a visible video or `content_type=image_text`; `.sliderVideo` / `.video_<aweme_id>` can therefore be active without a `<video>`. The extractor selects the largest viewport-intersecting video inside that slide rather than the first mounted `<video>`. The runner passively rereads `media_state=loading` / `content_type=unknown` for a bounded 2.5-second readiness window before planning. If `processOne()` still returns `media_loading`, no observation or transition was committed; reuse the same runner and read later instead of classifying the card or advancing blindly. Skip the card click and call `runner.processOne()`. `surface=no_active_video` with `playing_video_count>0` or `visible_card_count=0` means waterfall cards collapsed to 0×0 because the player mounted; wait 1200ms and read once more, and do **not** click `[data-aweme-id] >> visible=true`. Click a card only when `visible_card_ids` is non-empty, using `[data-aweme-id="<that id>"]` once.
- Console `React #418/#422` and a `429` **log line** are not safety stops. Stop only when `stop_text_hit` is set (on-page 验证码 / 请求过于频繁 / 登录后继续). If the extractor already returns `active_video`, continue; do not enter the recovery ladder.
- Recover one rung at a time only when `surface` is still `no_active_video` **and** `playing_video_count` is 0 after that wait: first `https://www.douyin.com/video/<visible id>`; if that also fails, re-enter once with `https://www.douyin.com/?recommend=1&v=<epoch-seconds>` and click one **visible** card once. If neither mounts the player, stop and report the page blocked.
- `can_switch_next=false` is **not** a collection gate. `runner.processOne()` sends ARROWDOWN once, then passively verifies `aweme_id` over a bounded multi-stage settle window. If the ID remains unchanged and viewport facts are reliable, it performs one physical CUA wheel scroll at viewport center and runs the same bounded verification. It never uses the layout-specific next-arrow. If both initial stages remain unchanged, the committed observation stays `transition_ok=null` and the runner returns `transition_pending` instead of writing a false failure. Call the same runner's `processOne()` once more: it first accepts a delayed ID change without a new control; if the ID is still unchanged, it retries only the last transition control once and verifies again. It never replans the item or creates another observation.

After obtaining the live Douyin `tab`, import the runner from this exact plugin root and keep one runner instance for the session. `runConfig` is the parsed whole confirmed file, `dbPath` is the exact path passed to `start`, and `noSwipePath` is the bootstrapped `$NO_SWIPE` path:

```js
const { createDouyinRunner } = await import(
  "<NO_SWIPE_PLUGIN_ROOT>/skills/douyin-recommendation-rpa/scripts/douyin_browser_runner.mjs"
);
const runner = await createDouyinRunner({
  tab,
  runConfig,
  dbPath,
  noSwipePath,
  syncEvery: 10,
});
```

Do not recreate the runner between items while the browser binding, tab, RunConfig, and database are unchanged. The runner reads [scripts/douyin_page_facts.js](scripts/douyin_page_facts.js) once, invokes `no-swipe step` internally, executes the returned `execution_plan`, verifies every attempted action, commits its `action_results`, and advances only after `status=committed`. Do not call collector `record` or replay `step` yourself during the feed loop.

Call `await runner.processOne()` once per item. One call owns this complete order:

```text
read facts → plan → dwell/actions → verify → commit transition-pending SQLite/outbox → bounded transition controls/verification → finalize transition audit
```

- `status=advanced`: the observation is durable and the next `aweme_id` is verified; continue with the same runner.
- `status=media_loading`: the active slide has an ID but its video/gallery media is still mounting after the readiness window. Nothing was committed; reuse the same runner and reread later. Do not persist `unknown` as though it were a final content classification.
- `status=transition_pending`: the observation is durable with `transition_ok=null`, so it is intentionally ineligible for upload. When `retryable=true`, call the same runner's `processOne()` once to reconcile a delayed transition or perform the single recovery retry; the retry call never replans the item. When `retryable=false`, keep the row and page for diagnostics and issue no further blind controls.
- `status=no_active_video`: run only the bounded entry/recovery rule above; do not invent selectors.
- `status=action_failed`, `browser_error`, or `transition_failed`: stop feed actions and run same-surface diagnostics. A failed interaction control is committed as attempted/unsuccessful, never clicked again, and never followed by a blind transition. An unchanged feed ID follows the `transition_pending` recovery path; a missing next-arrow is normal and is not a locator error.
- `status=transition_audit_failed`: stop immediately. The observation remains local with `transition_ok=null` and is not eligible for upload until the runner records the verified transition result.
- `status=cli_error` or `status=commit_failed`: stop without advancing; preserve the current page and SQLite.
- `status=stop_required`: stop immediately for the reported on-page safety signal.
- When the returned `sync` is non-null and its status is not `ok`, `idle`, or `deferred`, pause at that checkpoint and report the visible status; the outbox remains the recovery source.

Use `runner.processBatch({ maxItems: 1 })` only when a caller needs the structured batch envelope. Keep `maxItems: 1` for ordinary Codex turns so one slow watch-to-end item cannot exceed the browser execution budget.

Runtime gates remain mandatory:

- validate `status=confirmed` and `config_hash` before feed actions;
- enforce rates, caps, and permissions together;
- record planned, attempted, verified, and actual separately;
- execute each planned interaction control at most once inside `runner.processOne()`; feed transition recovery is the sole exception and may retry the last transition control once on the next call while the same runner owns the pending record;
- do not pause the loop for per-item chat confirmation; the sealed confirmation from section 2 is the action-time authorization;
- never open a creator homepage;
- stop on account mismatch, CAPTCHA, on-page rate-limit copy (`stop_text_hit`), login gates, or unreliable DOM. An unchanged `aweme_id` after the initial ARROWDOWN and CUA stages becomes `transition_pending`; reconcile it once with the same runner before diagnosing it as unresolved. Do not stop because `can_switch_next` is false, because console logs mention 429, or because React hydration errors appear while `surface=active_video`.

On a timed-out click or page read, `browser unavailable`, stale/detached tab,
unreliable card, or failed transition, stop feed actions and keep the same
browser binding and current tab. Do not repeat the click or load the full browser
documentation. Read
[references/browser-diagnostics.md](references/browser-diagnostics.md). Run its
bounded same-surface ladder before forming a root-cause claim. An external
Chrome comparison is optional and never proves that the Codex in-app Browser recovered.

## 6. Persist and audit

Persist each observation with `run_id`, `account_ref`, `config_hash`, profile revision/hash, and feed sequence before moving on. Resume only when the saved state's config hash matches.

Every observation must first be committed to SQLite and its durable outbox with
`scroll_delta=null` and `transition_ok=null`. After the one permitted transition
action, the runner records success or failure through `no-swipe transition`,
updating the observation and its outbox payload in one local transaction. Rows
whose transition audit is still null are never eligible for upload. The browser
loop must not wait for a remote request before moving to the next feed item.
Do not write CSV or Excel during collection. When the user asks
to inspect or deliver data, export from SQLite with `no-swipe export`.

Uploads are automatic and never an agent scheduling decision: the runner performs a bounded synchronous checkpoint every 10 committed observations, `finish` drains before returning, and the next session's startup (`up`) drains leftovers from every sqlite under `data_dir/runs/` (not only `runs/current`). The browser hot path never starts a detached fire-and-forget uploader and never performs one HTTP request per observation. Use `runner.syncCheckpoint({ force: true })` at a deliberate pause or handoff. `no-swipe sync --all --data-dir <data_dir>` remains the explicit recovery command for all run databases.

When the target is reached, run `no-swipe finish --db <sqlite>` once: it closes the active session and uploads everything pending. Before completing the Goal, its output must show `upload.pending=0`, and review every `dead` record explicitly.

After a successful run, show the workbench in its own tab so the user can see uploaded authors: reuse the signed-in workbench tab from pairing when it still exists, otherwise open a new tab, and never navigate the Douyin tab away from Douyin. The pairing session already signed them in.

The step payload above is the whole recording contract—do not read references or CLI sources to record. Read [references/data-contract.md](references/data-contract.md) only when exporting or debugging schema questions, and [references/quota-policy.md](references/quota-policy.md) only when changing allocations. Keep SQLite as the local fact source. CSV and Excel are on-demand exports, not live copies.

Never store or export cookies, tokens, authorization headers, credentials, or reusable browser-session material.
