# No Swipe browser diagnostics

Read this reference after a page/CDP anomaly, including a timed-out read,
`browser unavailable`, a stale or detached tab, an unrecognized recommendation
card, or an unverified feed transition. Stop feed actions first and preserve the
SQLite/outbox state before diagnosing.

The objective is to locate the failing boundary. A working page is not evidence
that its control transport works, and a working external Chrome is not evidence
that the Codex in-app Browser recovered.

## 1. Name the controlled surface

Record exactly one surface before probing it:

- `codex_iab`: the Codex in-app Browser selected through its bundled Browser
  control path;
- `external_extension`: a user-owned Chrome/Edge tab connected through the
  ChatGPT browser extension;
- `external_chrome_devtools`: a Chrome instance controlled by
  `chrome-devtools-mcp`.

Reuse the current browser binding. Obtain a fresh tab from that binding when the
tab is stale or missing. Do not make a second tab to hide a session-ownership or
transport failure. When the user identified a specific new Douyin tab, diagnose
only the currently enumerated matching tab and do not reuse a historical tab ID.

## 2. Run the same-surface ladder

Run one bounded, read-only probe at a time on the failing surface and capture
the first failing boundary:

1. **Discovery:** the browser binding exists and the exact tab can be obtained.
2. **Tab metadata:** read the current URL and title.
3. **Plain DOM:** read a bounded prefix of `body.innerText`.
4. **Simple JavaScript:** return `location.href`, `document.readyState`, viewport
   dimensions, and `document.querySelectorAll("video").length`.
5. **Douyin adapter DOM:** return the count and visible rectangles for `video`
   and `[class*="video_"]`; return only compact primitives, not the full DOM.
6. **Card projection:** on the single most-visible candidate, read its class,
   bounded text, media state, links, and controls using the same assumptions as
   `getActiveCard()`.
7. **Runner seam:** call `getActiveCard()` once only after probes 1-6 succeed.

Do not retry an identical timed-out probe. Narrow it or move to the diagnosis
table. Do not click, press a key, reload, close, claim, or navigate while running
this read-only ladder.

| First failing boundary | Classification | Next action |
| --- | --- | --- |
| Browser discovery | `browser_backend_unavailable` | Inspect the Codex Browser backend and current task binding. |
| Tab acquisition or ownership | `tab_session_mismatch` | Reuse the browser binding and reacquire the exact current tab. |
| Metadata, plain DOM, or simple JavaScript | `control_transport_failure` | Preserve the page and inspect Browser pipe/CDP/runtime evidence. |
| Adapter selectors return quickly with no visible candidate | `douyin_dom_adapter_mismatch` | Capture compact selector evidence and update the adapter/runner with a regression fixture. |
| Adapter probe itself times out | `page_or_runtime_evaluate_timeout` | Compare a smaller JavaScript probe and inspect page main-thread/runtime health. |
| Probes 1-6 pass but `getActiveCard()` fails | `no_swipe_runner_failure` | Minimize the projection that fails and add a runner regression test before changing code. |
| Card reads succeed but the ID does not change after the initial ARROWDOWN and CUA verification stages | `transition_pending` | Keep `transition_ok=null`; call the same runner once more. It first accepts a delayed change, otherwise retries only the last transition control once without replanning. |
| The same pending record remains unchanged after its single recovery retry | `feed_transition_unverified` | Preserve the last card and focus evidence. Do not issue further blind controls. A missing next-arrow is normal on this layout and is not a locator failure. |

CAPTCHA copy, access-restriction text, and rate-limit wording are overlay
signals: dismiss, reopen the recommendation feed, and keep swiping. They are
not Goal halts. Enter this diagnostic ladder only after `feed_stuck`.

## 3. Use Chrome DevTools MCP only as an external comparison

The upstream [Chrome DevTools skill](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/skills/chrome-devtools/SKILL.md)
describes how an agent uses tools supplied by `chrome-devtools-mcp`; the Skill
does not install or start that MCP server. Upstream normally starts a separate
Google Chrome; this plugin also passes `--isolated` so the diagnostic instance
uses a temporary profile and does not reuse the user's existing Chrome login.
Label all its evidence `external_chrome_devtools`.

The installed plugin registers this as a macOS-first, opportunistic diagnostic
path through `npx -y chrome-devtools-mcp@latest`. Use it only when its tools are
available in the current task. If the tools are absent, `npx` or Node.js is
unavailable, official Google Chrome is missing, or the server cannot start,
record `external_comparison_unavailable` and finish the same-surface ladder.
That result must not become an additional No Swipe startup or persistence gate;
the original surface still decides whether feed actions may safely resume. Do
not start an unregistered `npx chrome-devtools-mcp` process and treat its
waiting stdio server as a page test.

When the `chrome-devtools` MCP tools are available, read
[chrome-devtools.md](chrome-devtools.md) before using them. Record the resolved
server version with the diagnostic evidence because `@latest` can change between
installations.

For a standalone macOS installation outside the plugin, use the same rolling
diagnostic route:

```bash
codex mcp add chrome-devtools -- \
  npx -y chrome-devtools-mcp@latest \
  --isolated --no-usage-statistics --no-performance-crux
```

After registration, start a new Codex task and run the same compact DOM probes
in that external Chrome. `--isolated` has no existing Douyin login; use it first
for a non-sensitive control-path check. If the same logged-in Douyin state is
required, the user must explicitly choose whether to log in within that
temporary diagnostic profile because the MCP client can inspect all data
available in the controlled browser.

Interpret the comparison narrowly:

| Failing surface | External Chrome comparison | Supported conclusion |
| --- | --- | --- |
| Simple JavaScript fails | Passes | The failure is scoped toward the original Browser binding/session/transport. |
| Simple JavaScript passes; adapter DOM fails | Fails the same way | The Douyin page state, DOM variant, or probe cost is implicated. |
| Simple JavaScript passes; adapter DOM fails | Passes | The original Browser environment or session remains implicated. |
| Adapter DOM passes; only `getActiveCard()` fails | Passes | The No Swipe step/projection is implicated. |

An external pass never means `codex_iab` recovered. Chrome DevTools MCP can
attach to the same browser only when that browser explicitly exposes a supported
CDP HTTP/WebSocket endpoint and grants access. Do not guess an endpoint or treat
a proxy port as CDP.

## 4. Report and preserve

Report:

- surface and current URL class (profile, recommendation, verification, other);
- first failing probe and elapsed time;
- normalized error class and exact non-secret error text;
- selector counts and compact rectangles when available;
- whether the external comparison was not run, unavailable, passed, or failed;
- persisted, pending, and dead observation counts.

Redact cookies, tokens, authorization headers, WebSocket credentials, OTPs, and
reusable browser-session material. At the anomaly boundary, drain the existing
outbox according to the main Skill, then leave the task resumable. Resume feed
actions only after the original surface passes the failed probe and account,
config, and page-state gates are revalidated.
