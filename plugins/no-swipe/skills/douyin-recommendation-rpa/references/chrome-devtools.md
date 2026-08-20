---
name: chrome-devtools
description: Uses Chrome DevTools via MCP for No Swipe browser troubleshooting and external Chrome comparison.
upstream: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/skills/chrome-devtools/SKILL.md
upstream_package: chrome-devtools-mcp@1.7.0
---

# Chrome DevTools MCP reference

Read this reference only when the No Swipe browser diagnostic ladder reaches an
external Chrome comparison and the `chrome-devtools` MCP tools are available.
Evidence from this tool belongs to `external_chrome_devtools`, unless the MCP
server is explicitly attached to the exact same browser endpoint under test.

## Core concepts

**Browser lifecycle:** The browser starts automatically on the first tool call
using a persistent, dedicated Chrome profile. CLI arguments are configured by
the plugin's `.mcp.json`; inspect `npx chrome-devtools-mcp@1.7.0 --help` when an
operator needs the version-matched option reference.

Additional tooling can be enabled through MCP configuration:

- extension tooling: `--categoryExtensions`;
- memory tooling: `--memoryDebugging`.

**Page selection:** Tools operate on the currently selected page. Use
`list_pages` to enumerate pages, then `select_page` to switch context.

**Element interaction:** Use `take_snapshot` to obtain page structure and
element `uid` values. Take a fresh snapshot when a prior `uid` disappears after
the page changes.

## Workflow patterns

### Before interacting with a page

1. Navigate with `navigate_page` or `new_page`.
2. Use `wait_for` when a known page condition must load.
3. Use `take_snapshot` to inspect page structure.
4. Interact with the current snapshot's element `uid` values.

The No Swipe diagnostic path is read-only until
[browser-diagnostics.md](browser-diagnostics.md) explicitly permits a later
action. During that path, select the existing comparison page and use snapshot,
script, console, and network reads instead of navigation or interaction.

### Efficient data retrieval

- Use `filePath` for large screenshots, snapshots, or traces.
- Use `pageIdx`, `pageSize`, and `types` filters to bound results.
- Set `includeSnapshot: false` on input actions unless updated page state is
  required.

### Tool selection

- Automation and structure: `take_snapshot`.
- Visual evidence: `take_screenshot`.
- Data outside the accessibility tree: `evaluate_script`.
- Runtime evidence: console and network tools exposed by the MCP server.

### Parallel execution

Independent reads may run in parallel. Preserve causal order for dependent
steps: navigate, wait, snapshot, then interact.

### Testing an extension

Extension tools such as `install_extension` and `list_extensions` are available
only when the MCP server is configured with `--categoryExtensions`. When those
tools are absent, report that capability as disabled. Changing the installed
plugin's MCP configuration and restarting Codex is an operator decision; it is
not part of an automatic No Swipe recovery.

With extension tooling enabled:

1. Use `install_extension` with the unpacked extension path.
2. Obtain its ID from the result or `list_extensions`.
3. Use `trigger_extension_action` for its popup or side panel.
4. Use `evaluate_script` with `serviceWorkerId` to inspect the worker.
5. Navigate to a test page and use `take_snapshot` to verify injected content.

## No Swipe read-only probe

After `list_pages` and `select_page`, collect the smallest evidence that matches
the failing same-surface probe:

1. Snapshot the selected page.
2. Use `evaluate_script` to return only `location.href`,
   `document.readyState`, viewport dimensions, and counts for `video` and
   `[class*="video_"]`.
3. If those counts return, read compact rectangles and media state for visible
   candidates.
4. Read bounded console errors and failed network requests around the failure.
5. Record the first failing tool, elapsed time, and non-secret error text.

Do not retrieve cookies, authorization headers, tokens, OTPs, or reusable
browser-session material. A successful external Chrome probe narrows the fault;
it does not prove that the Codex in-app Browser recovered.

## Troubleshooting

When the MCP server or Chrome fails to launch, use the upstream
[troubleshooting guide](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md).
When MCP diagnostics are insufficient, use the official
[Chrome DevTools documentation](https://developer.chrome.com/docs/devtools) or
[DevTools AI assistance documentation](https://developer.chrome.com/docs/devtools/ai-assistance/).
