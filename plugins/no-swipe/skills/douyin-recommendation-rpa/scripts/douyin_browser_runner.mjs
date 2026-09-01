import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const DEFAULT_SYNC_EVERY = 10;
const DEFAULT_BATCH_BUDGET_MS = 45_000;
const DEFAULT_CLI_TIMEOUT_MS = 30_000;
const ACTION_VERIFY_DELAYS_MS = [750, 1_250, 2_000, 3_000];
const TRANSITION_VERIFY_DELAYS_MS = [750, 1_250, 2_000, 3_000];
const MEDIA_READY_DELAYS_MS = [250, 500, 750, 1_000];
const MAX_CLI_OUTPUT_BYTES = 1_000_000;

function compactError(error) {
  return String(error?.message || error || "unknown error").slice(0, 500);
}

function pageSummary(page) {
  return {
    surface: String(page?.surface || ""),
    aweme_id: String(page?.aweme_id || ""),
  };
}

function isActivePage(page) {
  return page?.surface === "active_video" && String(page?.aweme_id || "") !== "";
}

function isMediaReady(page) {
  return page?.content_type !== "unknown" && page?.media_state !== "loading";
}

async function settleInitialMedia({ tab, page, readFacts }) {
  let latestPage = page;
  if (!isActivePage(latestPage) || isMediaReady(latestPage)) return latestPage;
  for (const waitMs of MEDIA_READY_DELAYS_MS) {
    await tab.playwright.waitForTimeout(waitMs);
    latestPage = await readFacts();
    if (!isActivePage(latestPage) || isMediaReady(latestPage) || latestPage?.stop_text_hit) break;
  }
  return latestPage;
}

function actionState(page, key) {
  return page?.action_state && page.action_state[key];
}

function actionVerified(resultKey, before, after) {
  if (resultKey === "like") return actionState(after, "liked") === true;
  if (resultKey === "favorite") return actionState(after, "favorited") === true;
  if (resultKey === "follow") return actionState(after, "followed") === true;
  if (resultKey === "resumed") return after?.paused === false;
  if (resultKey === "not_interested") {
    return after?.feedback_state?.not_interested === true
      || (String(before?.aweme_id || "") !== "" && String(after?.aweme_id || "") !== String(before.aweme_id));
  }
  return false;
}

async function verifyActionWithPassiveSettle({ tab, resultKey, before, latestPage, readFacts }) {
  if (actionVerified(resultKey, before, latestPage)) {
    return { latestPage, success: true };
  }
  if (resultKey !== "not_interested" || latestPage?.stop_text_hit) {
    return { latestPage, success: false };
  }
  for (const waitMs of ACTION_VERIFY_DELAYS_MS) {
    await tab.playwright.waitForTimeout(waitMs);
    latestPage = await readFacts();
    if (actionVerified(resultKey, before, latestPage)) {
      return { latestPage, success: true };
    }
    if (latestPage?.stop_text_hit) break;
  }
  return { latestPage, success: false };
}

function inferFeedEvidence(page) {
  const published = String(page?.published_text || "").trim();
  const clearlyRecent = /刚刚|分钟前|小时(?:前)?|今天/.test(published);
  return {
    creatorFollowerCount: null,
    creatorRecentLikesStable: null,
    isRecentlyPublished: clearlyRecent ? true : null,
  };
}

function parseJsonOutput(stdout) {
  const lines = String(stdout || "").trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      return JSON.parse(lines[index]);
    } catch {
      // Bootstrap can print more than one JSON line. The command result is
      // always the last parseable JSON object.
    }
  }
  throw new Error("no-swipe CLI returned no JSON result");
}

export function runCliJson(executable, args, payload, options = {}) {
  if (!executable) throw new Error("noSwipePath is required when no injected CLI adapter is provided");
  return new Promise((resolve, reject) => {
    const spawnOptions = {
      cwd: options.cwd,
      stdio: [payload === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    };
    if (options.env) spawnOptions.env = options.env;
    const child = spawn(executable, args, spawnOptions);
    let stdout = "";
    let stderr = "";
    let overflow = false;
    let timedOut = false;
    const timeoutMs = Math.max(1, Number(options.timeoutMs || DEFAULT_CLI_TIMEOUT_MS));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const append = (target, chunk) => {
      const next = target + String(chunk);
      if (Buffer.byteLength(next) > MAX_CLI_OUTPUT_BYTES) {
        overflow = true;
        child.kill();
      }
      return next.slice(-MAX_CLI_OUTPUT_BYTES);
    };
    child.stdout.on("data", (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr = append(stderr, chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`no-swipe CLI timed out after ${timeoutMs}ms`));
        return;
      }
      if (overflow) {
        reject(new Error("no-swipe CLI output exceeded the runner limit"));
        return;
      }
      if (code !== 0) {
        reject(new Error(`no-swipe CLI exited ${code}: ${stderr.trim().slice(-1000) || "no error text"}`));
        return;
      }
      try {
        resolve(parseJsonOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
    if (payload !== undefined) child.stdin.end(JSON.stringify(payload));
  });
}

function locatorFrom(tab, spec) {
  if (!spec || typeof spec !== "object") throw new Error("runner operation is missing a locator");
  if (spec.by === "css") return tab.playwright.locator(spec.selector);
  if (spec.by === "text") {
    const locator = tab.playwright.getByText(spec.text, { exact: spec.exact === true });
    return spec.nth === "last" ? locator.last() : locator;
  }
  throw new Error(`unsupported runner locator: ${spec.by || "unknown"}`);
}

async function locatorCount(locator) {
  if (typeof locator?.count !== "function") return 1;
  return Number(await locator.count());
}

async function clickOperation(tab, operation) {
  let spec = operation.locator;
  let locator = locatorFrom(tab, spec);
  if (await locatorCount(locator) <= 0 && operation.fallback_locator) {
    spec = operation.fallback_locator;
    locator = locatorFrom(tab, spec);
  }
  if (await locatorCount(locator) <= 0) {
    throw new Error(`locator_not_found:${operation.id}`);
  }
  const click = {};
  if (spec.button) click.button = spec.button;
  if (Number.isFinite(Number(spec.timeout_ms))) click.timeoutMs = Number(spec.timeout_ms);
  await locator.click(click);
}

async function waitToEnd(tab, readFacts, initialPage, maximumMs) {
  const started = Date.now();
  let latest = initialPage;
  let maxPosition = Number(initialPage?.current_position_seconds || 0);
  let previousPosition = -1;
  let stationaryReads = 0;
  while (Date.now() - started < maximumMs) {
    const duration = Number(latest?.duration_seconds);
    const position = Number(latest?.current_position_seconds);
    if (Number.isFinite(position)) maxPosition = Math.max(maxPosition, position);
    if (Number.isFinite(duration) && duration > 0 && maxPosition >= duration - 1) {
      return { latest, completion: { actual: true, max_position_seconds: maxPosition } };
    }
    if (latest?.paused === true && maxPosition < duration - 1) {
      return { latest, completion: { actual: false, max_position_seconds: maxPosition } };
    }
    if (position === previousPosition) stationaryReads += 1;
    else stationaryReads = 0;
    if (stationaryReads >= 2) {
      return { latest, completion: { actual: false, max_position_seconds: maxPosition } };
    }
    previousPosition = position;
    await tab.playwright.waitForTimeout(4_500);
    latest = await readFacts();
    if (String(latest?.aweme_id || "") !== String(initialPage?.aweme_id || "")) {
      return { latest, completion: { actual: false, max_position_seconds: maxPosition } };
    }
  }
  return { latest, completion: { actual: false, max_position_seconds: maxPosition } };
}

async function executePlan({ tab, plan, initialPage, readFacts, completionTimeoutMs }) {
  const results = {};
  let latestPage = initialPage;
  let dwellMs = 0;
  let fatal = null;
  let skipNextVerifyRead = false;

  for (const operation of plan || []) {
    if (fatal) break;
    if (operation.op === "wait") {
      const waitMs = Math.max(0, Number(operation.wait_ms) || 0);
      await tab.playwright.waitForTimeout(waitMs);
      if (operation.id === "dwell") dwellMs += waitMs;
      skipNextVerifyRead = false;
      continue;
    }
    if (operation.op === "evaluate_facts") {
      if (operation.id === "watch_to_end") {
        const watched = await waitToEnd(tab, readFacts, latestPage, completionTimeoutMs);
        latestPage = watched.latest;
        results.completion = watched.completion;
      } else if (skipNextVerifyRead && /verify/.test(String(operation.id || ""))) {
        skipNextVerifyRead = false;
      } else {
        latestPage = await readFacts();
      }
      if (latestPage?.stop_text_hit) {
        fatal = {
          status: "stop_required",
          operation: operation.id,
          reason: String(latestPage.stop_text_hit),
        };
      }
      continue;
    }
    if (operation.op === "keypress") {
      try {
        await tab.cua.keypress({ keys: operation.keys || [] });
        if (operation.settle_ms) await tab.playwright.waitForTimeout(Number(operation.settle_ms));
      } catch (error) {
        fatal = { operation: operation.id, reason: compactError(error) };
      }
      continue;
    }
    if (operation.op !== "click") {
      fatal = { operation: operation.id, reason: `unsupported_operation:${operation.op}` };
      continue;
    }

    const resultKey = operation.result_key;
    const skip = operation.skip_if_action_state;
    if (skip && actionState(latestPage, skip.key) === skip.equals) {
      if (resultKey) results[resultKey] = { attempted: false, success: true };
      continue;
    }

    try {
      await clickOperation(tab, operation);
      if (operation.settle_ms) await tab.playwright.waitForTimeout(Number(operation.settle_ms));
      if (resultKey) {
        const before = latestPage;
        latestPage = await readFacts();
        const verified = await verifyActionWithPassiveSettle({
          tab,
          resultKey,
          before,
          latestPage,
          readFacts,
        });
        latestPage = verified.latestPage;
        const success = verified.success;
        results[resultKey] = {
          attempted: true,
          success,
        };
        skipNextVerifyRead = true;
        if (latestPage?.stop_text_hit) {
          fatal = {
            status: "stop_required",
            operation: operation.id,
            reason: String(latestPage.stop_text_hit),
          };
        } else if (!success) {
          fatal = { operation: operation.id, reason: `action_unverified:${resultKey}` };
        }
      }
    } catch (error) {
      if (resultKey) results[resultKey] = { attempted: true, success: false };
      fatal = { operation: operation.id, reason: compactError(error) };
    }
  }

  results.dwell_seconds = Number((dwellMs / 1000).toFixed(3));
  return { results, latestPage, fatal };
}

async function advanceFeed({ tab, plan, initialPage, latestPage, readFacts }) {
  const fromId = String(initialPage?.aweme_id || "");
  if (String(latestPage?.aweme_id || "") && String(latestPage.aweme_id) !== fromId) {
    return {
      ok: true,
      method: "action_transition",
      page: latestPage,
      from_aweme_id: fromId,
      to_aweme_id: String(latestPage.aweme_id),
    };
  }

  const keypress = (plan || []).find((operation) => operation.op === "keypress");
  const fallback = (plan || []).find((operation) => operation.id === "advance_fallback" && operation.op === "scroll");
  if (!keypress) {
    return { ok: false, reason: "advance_plan_missing_keypress", page: latestPage, from_aweme_id: fromId, to_aweme_id: fromId };
  }

  try {
    await tab.cua.keypress({ keys: keypress.keys || ["ARROWDOWN"] });
    if (keypress.settle_ms) await tab.playwright.waitForTimeout(Number(keypress.settle_ms));
    latestPage = await readFacts();
    if (String(latestPage?.aweme_id || "") !== fromId && isActivePage(latestPage)) {
      return { ok: true, method: "ARROWDOWN", page: latestPage, from_aweme_id: fromId, to_aweme_id: String(latestPage.aweme_id) };
    }
    for (const waitMs of TRANSITION_VERIFY_DELAYS_MS) {
      await tab.playwright.waitForTimeout(waitMs);
      latestPage = await readFacts();
      if (String(latestPage?.aweme_id || "") !== fromId && isActivePage(latestPage)) {
        return { ok: true, method: "ARROWDOWN_SETTLED", page: latestPage, from_aweme_id: fromId, to_aweme_id: String(latestPage.aweme_id) };
      }
      if (latestPage?.stop_text_hit) break;
    }
  } catch (error) {
    return { ok: false, reason: compactError(error), page: latestPage, from_aweme_id: fromId, to_aweme_id: String(latestPage?.aweme_id || "") };
  }
  if (!fallback) {
    return {
      ok: false,
      method: null,
      reason: "feed_transition_unverified",
      page: latestPage,
      from_aweme_id: fromId,
      to_aweme_id: String(latestPage?.aweme_id || ""),
      retry_control: { type: "keypress", operation: keypress },
    };
  }
  try {
    await tab.cua.scroll({
      scrollX: Number(fallback.scroll_x) || 0,
      scrollY: Number(fallback.scroll_y) || 740,
      x: Number(fallback.x),
      y: Number(fallback.y),
    });
    if (fallback.settle_ms) await tab.playwright.waitForTimeout(Number(fallback.settle_ms));
    latestPage = await readFacts();
    if (String(latestPage?.aweme_id || "") !== fromId && isActivePage(latestPage)) {
      return { ok: true, method: "CUA_SCROLL", page: latestPage, from_aweme_id: fromId, to_aweme_id: String(latestPage.aweme_id) };
    }
    for (const waitMs of TRANSITION_VERIFY_DELAYS_MS) {
      await tab.playwright.waitForTimeout(waitMs);
      latestPage = await readFacts();
      if (String(latestPage?.aweme_id || "") !== fromId && isActivePage(latestPage)) {
        return { ok: true, method: "CUA_SCROLL_SETTLED", page: latestPage, from_aweme_id: fromId, to_aweme_id: String(latestPage.aweme_id) };
      }
      if (latestPage?.stop_text_hit) break;
    }
  } catch (error) {
    return { ok: false, reason: compactError(error), page: latestPage, from_aweme_id: fromId, to_aweme_id: String(latestPage?.aweme_id || "") };
  }
  return {
    ok: false,
    method: null,
    reason: "feed_transition_unverified",
    page: latestPage,
    from_aweme_id: fromId,
    to_aweme_id: String(latestPage?.aweme_id || ""),
    retry_control: { type: "scroll", operation: fallback },
  };
}

export async function createDouyinRunner(options = {}) {
  const { tab, dbPath, runConfig } = options;
  if (!tab?.playwright || !tab?.cua) throw new Error("runner requires a live Browser tab binding");
  if (!dbPath) throw new Error("runner requires dbPath");
  if (runConfig?.status !== "confirmed" || typeof runConfig?.config_hash !== "string") {
    throw new Error("runner requires a sealed run-config.confirmed.json");
  }

  const factsSource = options.factsSource
    || (options.readFacts ? null : await fs.readFile(new URL("./douyin_page_facts.js", import.meta.url), "utf8"));
  const readFacts = options.readFacts || (() => tab.playwright.evaluate(`(${factsSource})()`));
  const step = options.step || ((payload) => runCliJson(
    options.noSwipePath,
    ["step", "--db", dbPath],
    payload,
    options.cliOptions,
  ));
  const sync = options.sync || (() => runCliJson(
    options.noSwipePath,
    ["sync", "--db", dbPath],
    undefined,
    options.cliOptions,
  ));
  const recordTransition = options.recordTransition || ((payload) => runCliJson(
    options.noSwipePath,
    ["transition", "--db", dbPath],
    payload,
    options.cliOptions,
  ));
  const resolveEvidence = options.resolveEvidence || (async (page) => inferFeedEvidence(page));
  const syncEvery = Math.max(0, Number(options.syncEvery ?? DEFAULT_SYNC_EVERY));
  const completionTimeoutMs = Math.max(5_000, Number(options.completionTimeoutMs || 195_000));
  let committedSinceSync = 0;
  let pendingTransition = null;

  const syncCheckpoint = async ({ force = false } = {}) => {
    if (!force && (syncEvery <= 0 || committedSinceSync < syncEvery)) return null;
    const result = await sync();
    if (["ok", "idle", "deferred"].includes(result?.status)) committedSinceSync = 0;
    return result;
  };

  const finalizePendingTransition = async ({ page, method }) => {
    const pending = pendingTransition;
    const recorded = await recordTransition({
      record_id: pending.record_id,
      transition_ok: true,
      scroll_delta: 1,
      method,
      reason: null,
      from_aweme_id: pending.from_aweme_id,
      to_aweme_id: String(page.aweme_id),
      before_url: pending.before_url,
      after_url: String(page?.url || ""),
    });
    if (recorded?.status !== "transition_recorded") {
      throw new Error(`unexpected transition audit result: ${recorded?.status || "unknown"}`);
    }
    committedSinceSync += 1;
    pendingTransition = null;
    let syncResult = null;
    try {
      syncResult = await syncCheckpoint();
    } catch (error) {
      syncResult = { status: "runner_sync_error", reason: compactError(error) };
    }
    return {
      status: "advanced",
      record_id: pending.record_id,
      progress: pending.progress,
      upload: pending.upload,
      sync: syncResult,
      transition: {
        method,
        from_aweme_id: pending.from_aweme_id,
        to_aweme_id: String(page.aweme_id),
      },
      page: pageSummary(page),
    };
  };

  const reconcilePendingTransition = async () => {
    const pending = pendingTransition;
    let latestPage;
    try {
      latestPage = await readFacts();
    } catch (error) {
      return { status: "browser_error", reason: compactError(error), record_id: pending.record_id, committed: true };
    }
    if (latestPage?.stop_text_hit) {
      return {
        status: "stop_required",
        reason: String(latestPage.stop_text_hit),
        record_id: pending.record_id,
        committed: true,
        page: pageSummary(latestPage),
      };
    }
    if (isActivePage(latestPage) && String(latestPage.aweme_id) !== pending.from_aweme_id) {
      try {
        return await finalizePendingTransition({ page: latestPage, method: "DELAYED_SETTLED" });
      } catch (error) {
        return { status: "transition_audit_failed", reason: compactError(error), record_id: pending.record_id, committed: true };
      }
    }
    if (pending.retry_attempted) {
      return {
        status: "transition_pending",
        reason: "feed_transition_unverified",
        record_id: pending.record_id,
        committed: true,
        retryable: false,
        page: pageSummary(latestPage),
      };
    }

    pending.retry_attempted = true;
    const retry = pending.retry_control;
    const operation = retry?.operation || {};
    const retryMethod = retry?.type === "scroll" ? "CUA_SCROLL_RETRY" : "ARROWDOWN_RETRY";
    try {
      if (retry?.type === "scroll") {
        await tab.cua.scroll({
          scrollX: Number(operation.scroll_x) || 0,
          scrollY: Number(operation.scroll_y) || 740,
          x: Number(operation.x),
          y: Number(operation.y),
        });
      } else {
        await tab.cua.keypress({ keys: operation.keys || ["ARROWDOWN"] });
      }
      if (operation.settle_ms) await tab.playwright.waitForTimeout(Number(operation.settle_ms));
      latestPage = await readFacts();
      if (isActivePage(latestPage) && String(latestPage.aweme_id) !== pending.from_aweme_id) {
        return await finalizePendingTransition({ page: latestPage, method: retryMethod });
      }
      for (const waitMs of TRANSITION_VERIFY_DELAYS_MS) {
        await tab.playwright.waitForTimeout(waitMs);
        latestPage = await readFacts();
        if (isActivePage(latestPage) && String(latestPage.aweme_id) !== pending.from_aweme_id) {
          return await finalizePendingTransition({ page: latestPage, method: `${retryMethod}_SETTLED` });
        }
        if (latestPage?.stop_text_hit) break;
      }
    } catch (error) {
      return { status: "browser_error", reason: compactError(error), record_id: pending.record_id, committed: true };
    }
    return {
      status: "transition_pending",
      reason: "feed_transition_unverified",
      record_id: pending.record_id,
      committed: true,
      retryable: false,
      page: pageSummary(latestPage),
    };
  };

  const processOne = async () => {
    if (pendingTransition) return reconcilePendingTransition();
    let initialPage;
    try {
      initialPage = await readFacts();
      initialPage = await settleInitialMedia({ tab, page: initialPage, readFacts });
    } catch (error) {
      return { status: "browser_error", reason: compactError(error), page: { surface: "", aweme_id: "" } };
    }
    if (initialPage?.stop_text_hit) {
      return { status: "stop_required", reason: String(initialPage.stop_text_hit), page: pageSummary(initialPage) };
    }
    if (!isActivePage(initialPage)) {
      return { status: "no_active_video", reason: "runner requires one active video", page: pageSummary(initialPage) };
    }
    if (!isMediaReady(initialPage)) {
      return {
        status: "media_loading",
        reason: "active media is not ready after the bounded settle window",
        page: pageSummary(initialPage),
      };
    }

    let planned;
    try {
      planned = await step({ runConfig, page: initialPage });
      if (planned?.status === "needs_evidence") {
        const evidence = await resolveEvidence(initialPage, planned);
        planned = await step({
          runConfig,
          page: initialPage,
          record_id: planned.record_id,
          evidence: evidence || inferFeedEvidence(initialPage),
        });
      }
    } catch (error) {
      return { status: "cli_error", reason: compactError(error), page: pageSummary(initialPage) };
    }

    if (!["planned", "committed"].includes(planned?.status)) {
      return { ...planned, page: pageSummary(initialPage) };
    }

    let committed = planned;
    let latestPage = initialPage;
    let fatal = null;
    if (Array.isArray(planned.execution_plan) && planned.execution_plan.length > 0) {
      try {
        const executed = await executePlan({
          tab,
          plan: planned.execution_plan,
          initialPage,
          readFacts,
          completionTimeoutMs,
        });
        latestPage = executed.latestPage;
        fatal = executed.fatal;
        if (planned.status === "planned") {
          committed = await step({
            runConfig,
            page: initialPage,
            record_id: planned.record_id,
            action_results: executed.results,
          });
        }
      } catch (error) {
        return { status: "browser_error", reason: compactError(error), record_id: planned.record_id, page: pageSummary(initialPage) };
      }
    }

    if (committed?.status !== "committed") {
      return {
        status: "commit_failed",
        reason: String(committed?.reason || committed?.status || "unknown commit result"),
        record_id: planned.record_id,
        page: pageSummary(initialPage),
      };
    }
    if (fatal) {
      try {
        await recordTransition({
          record_id: committed.record_id,
          transition_ok: false,
          scroll_delta: 0,
          method: null,
          reason: `advance_not_attempted:${fatal.reason}`,
          from_aweme_id: String(initialPage.aweme_id),
          to_aweme_id: String(latestPage?.aweme_id || initialPage.aweme_id),
          before_url: String(initialPage?.url || ""),
          after_url: String(latestPage?.url || initialPage?.url || ""),
        });
        committedSinceSync += 1;
      } catch (error) {
        return {
          status: "transition_audit_failed",
          reason: compactError(error),
          prior_status: fatal.status || "action_failed",
          record_id: committed.record_id,
          committed: true,
          page: pageSummary(latestPage),
        };
      }
      return {
        status: fatal.status || "action_failed",
        reason: fatal.reason,
        operation: fatal.operation,
        record_id: committed.record_id,
        committed: true,
        page: pageSummary(latestPage),
      };
    }

    const transition = await advanceFeed({
      tab,
      plan: committed.advance_plan || planned.advance_plan,
      initialPage,
      latestPage,
      readFacts,
    });
    if (!transition.ok && transition.reason === "feed_transition_unverified" && !transition.page?.stop_text_hit) {
      pendingTransition = {
        record_id: committed.record_id,
        progress: committed.progress,
        upload: committed.upload,
        from_aweme_id: transition.from_aweme_id,
        before_url: String(initialPage?.url || ""),
        retry_control: transition.retry_control,
        retry_attempted: false,
      };
      return {
        status: "transition_pending",
        reason: transition.reason,
        record_id: committed.record_id,
        committed: true,
        retryable: true,
        transition: {
          from_aweme_id: transition.from_aweme_id,
          to_aweme_id: transition.to_aweme_id,
        },
        page: pageSummary(transition.page),
      };
    }
    try {
      const recorded = await recordTransition({
        record_id: committed.record_id,
        transition_ok: transition.ok,
        scroll_delta: transition.ok ? 1 : 0,
        method: transition.method || null,
        reason: transition.reason || null,
        from_aweme_id: transition.from_aweme_id,
        to_aweme_id: transition.to_aweme_id,
        before_url: String(initialPage?.url || ""),
        after_url: String(transition.page?.url || ""),
      });
      if (recorded?.status !== "transition_recorded") {
        throw new Error(`unexpected transition audit result: ${recorded?.status || "unknown"}`);
      }
      committedSinceSync += 1;
    } catch (error) {
      return {
        status: "transition_audit_failed",
        reason: compactError(error),
        record_id: committed.record_id,
        committed: true,
        transition: {
          from_aweme_id: transition.from_aweme_id,
          to_aweme_id: transition.to_aweme_id,
        },
      };
    }
    if (transition.page?.stop_text_hit) {
      return {
        status: "stop_required",
        reason: String(transition.page.stop_text_hit),
        record_id: committed.record_id,
        committed: true,
        transition: {
          from_aweme_id: transition.from_aweme_id,
          to_aweme_id: transition.to_aweme_id,
        },
      };
    }
    if (!transition.ok) {
      return {
        status: "transition_failed",
        reason: transition.reason,
        record_id: committed.record_id,
        committed: true,
        transition: {
          from_aweme_id: transition.from_aweme_id,
          to_aweme_id: transition.to_aweme_id,
        },
      };
    }
    let syncResult = null;
    try {
      syncResult = await syncCheckpoint();
    } catch (error) {
      syncResult = { status: "runner_sync_error", reason: compactError(error) };
    }
    return {
      status: "advanced",
      record_id: committed.record_id,
      progress: committed.progress,
      upload: committed.upload,
      sync: syncResult,
      transition: {
        method: transition.method,
        from_aweme_id: transition.from_aweme_id,
        to_aweme_id: transition.to_aweme_id,
      },
      page: pageSummary(transition.page),
    };
  };

  const processBatch = async ({ maxItems = 1, maxElapsedMs = DEFAULT_BATCH_BUDGET_MS } = {}) => {
    const limit = Math.max(1, Math.min(25, Number(maxItems) || 1));
    const started = Date.now();
    const results = [];
    while (results.length < limit && Date.now() - started < maxElapsedMs) {
      const result = await processOne();
      results.push(result);
      if (result.status !== "advanced") break;
    }
    return {
      status: results.every((result) => result.status === "advanced") ? "advanced" : results.at(-1)?.status,
      processed: results.filter((result) => result.status === "advanced").length,
      elapsed_ms: Date.now() - started,
      results,
    };
  };

  return {
    readCurrent: async () => settleInitialMedia({ tab, page: await readFacts(), readFacts }),
    processOne,
    processBatch,
    syncCheckpoint,
  };
}
