# No Swipe

No Swipe is a Codex plugin for auditable Douyin recommendation-feed testing. It bundles the `douyin-recommendation-rpa` skill, browser runner, quota planner, incremental SQLite/CSV collector, validation tests, and a compact SVG icon.

The default interest profile focuses on technology, 3C devices, and artificial intelligence. Interaction plans and actual UI results are recorded separately, and the workflow stops on verification, rate limits, login failures, or unreliable page state.

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
plugins/no-swipe/skills/douyin-recommendation-rpa/
```

## Safety boundaries

- Operates only on a user-opened and logged-in recommendation feed.
- Does not bypass CAPTCHA, rate limits, login gates, or access controls.
- Comments and follows require explicit authorization for the current run.
- Keeps quota decisions separate from verified action results.
- Does not include collected videos, SQLite databases, CSV exports, cookies, or account credentials.
