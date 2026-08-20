# No Swipe

No Swipe is a Codex plugin for auditable Douyin recommendation-feed testing. It bundles the `douyin-recommendation-rpa` skill, browser runner, quota planner, incremental SQLite collector, on-demand CSV export, validation tests, and a compact SVG icon.

Each Douyin account has one versioned logical interest profile. Runs reuse that profile and separately confirm their targets, rates, caps, and authorizations. The plugin ships no topic persona: technology, 3C, AI, and all other interests are user/account data rather than product defaults.

## Install

Add this Git marketplace:

```bash
codex plugin marketplace add OfWind/no_swipe --ref main
```

Install the plugin:

```bash
codex plugin add no-swipe@no-swipe-marketplace
```

Start a new Codex task after installation so the bundled skill is loaded.

## Browser diagnostics

On macOS, Browser/CDP timeouts, stale tabs, or recommendation-card read failures
can trigger the plugin's lazy diagnostic references and its registered
`npx -y chrome-devtools-mcp@latest` external-Chrome comparison. This optional
path requires Node.js/npm, `npx`, npm-registry network access, and official
Google Chrome; first initialization may download the npm package. Codex may
initialize the MCP server when a new task discovers its tools, while Chrome is
normally deferred until the first browser tool call. The plugin passes
`--isolated`, so the comparison uses a temporary profile without reusing the
user's existing Chrome login. Testing the same logged-in Douyin state requires
the user to explicitly choose to log in within that temporary Chrome. It does
not automatically attach to the Codex in-app Browser.

The comparison is an evidence-gathering route, not a guaranteed repair. If its
tools are unavailable or Chrome cannot launch, No Swipe records the comparison
as unavailable and continues the original Browser diagnostic ladder. The
workflow must not treat this optional comparison as a startup or persistence
gate; the original Browser probe still decides whether feed actions may resume.
Install or update the plugin, then start a new Codex task so the new Skill and
MCP configuration are loaded.

## Update

```bash
codex plugin marketplace upgrade no-swipe-marketplace
codex plugin add no-swipe@no-swipe-marketplace
```

## Repository layout

```text
.agents/plugins/marketplace.json
plugins/no-swipe/.codex-plugin/plugin.json
plugins/no-swipe/assets/no-swipe.svg
plugins/no-swipe/config/
plugins/no-swipe/runtime/
plugins/no-swipe/skills/douyin-recommendation-rpa/
```

## Safety boundaries

- Operates only on a user-opened and logged-in recommendation feed.
- Does not bypass CAPTCHA, rate limits, login gates, or access controls.
- Every state-changing action requires explicit authorization in the confirmed run config.
- Positive comment, follow, not-interested, and profile-visit rates require total caps.
- Keeps planned, attempted, verified, and actual action results separate.
- Does not include account profiles, collected videos, SQLite databases, JSONL/CSV exports, cookies, or account credentials.
