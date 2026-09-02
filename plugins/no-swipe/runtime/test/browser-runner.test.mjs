import assert from "node:assert/strict";
import test from "node:test";

const RUNNER_URL = new URL(
  "../../skills/douyin-recommendation-rpa/scripts/douyin_browser_runner.mjs",
  import.meta.url,
);

function executionPlan() {
  return [
    { id: "dwell", op: "wait", wait_ms: 5000 },
    {
      id: "like",
      op: "click",
      locator: { by: "css", selector: '.video_1 [data-e2e="video-player-digg"]', timeout_ms: 5000 },
      skip_if_action_state: { key: "liked", equals: true },
      settle_ms: 280,
      result_key: "like",
    },
    { id: "like_verify", op: "evaluate_facts" },
  ];
}

function advancePlan({ includeScrollFallback = true } = {}) {
  const plan = [
    { id: "advance", op: "keypress", keys: ["ARROWDOWN"], settle_ms: 850 },
    { id: "advance_verify", op: "evaluate_facts" },
  ];
  if (includeScrollFallback) {
    plan.push({
      id: "advance_fallback",
      op: "scroll",
      scroll_x: 0,
      scroll_y: 740,
      x: 756,
      y: 398,
      settle_ms: 850,
    });
  }
  return plan;
}

function harness({
  commitStatus = "committed",
  initialLiked = false,
  verifyLike = true,
  stopText = null,
  stopAfterLike = null,
  advanceOnKeypress = true,
  transitionDelayMs = 0,
  fallbackAvailable = true,
  includeScrollFallback = true,
  advanceOnScroll = true,
  advanceOnScrollAttempt = advanceOnScroll ? 1 : Number.POSITIVE_INFINITY,
  initialUnknownReads = 0,
} = {}) {
  const events = [];
  let liked = initialLiked;
  let advanced = false;
  let commitPayload = null;
  let transitionPayload = null;
  let stepCalls = 0;
  let keypressStarted = false;
  let transitionElapsedMs = 0;
  let scrollAttempts = 0;
  let reads = 0;

  const page = () => ({
    surface: "active_video",
    aweme_id: advanced ? "2" : "1",
    title: advanced ? "next" : "current",
    content_type: !advanced && reads <= initialUnknownReads ? "unknown" : "video",
    paused: false,
    action_state: { liked, favorited: false, followed: false },
    stop_text_hit: stopText || (liked ? stopAfterLike : null),
  });

  const tab = {
    playwright: {
      locator(selector) {
        return {
          async count() {
            if (selector.includes("video-switch-next-arrow")) return fallbackAvailable ? 1 : 0;
            return 1;
          },
          async click() {
            events.push(`click:${selector}`);
            if (selector.includes("video-player-digg") && verifyLike) liked = true;
            if (selector.includes("video-switch-next-arrow")) advanced = true;
          },
        };
      },
      getByText(text) {
        return {
          last() {
            return {
              async count() {
                return 1;
              },
              async click() {
                events.push(`click-text:${text}`);
              },
            };
          },
        };
      },
      async waitForTimeout(ms) {
        events.push(`wait:${ms}`);
        if (keypressStarted && advanceOnKeypress && transitionDelayMs > 0) {
          transitionElapsedMs += Number(ms);
          if (transitionElapsedMs >= transitionDelayMs) advanced = true;
        }
      },
    },
    cua: {
      async keypress({ keys }) {
        events.push(`key:${keys.join("+")}`);
        keypressStarted = true;
        if (advanceOnKeypress && transitionDelayMs <= 0) advanced = true;
      },
      async scroll(input) {
        events.push(`scroll:${input.scrollX}:${input.scrollY}:${input.x}:${input.y}`);
        scrollAttempts += 1;
        if (scrollAttempts >= advanceOnScrollAttempt) advanced = true;
      },
    },
  };

  const readFacts = async () => {
    reads += 1;
    const current = page();
    events.push(`read:${current.aweme_id}:${current.action_state.liked}`);
    return current;
  };

  const step = async (payload) => {
    stepCalls += 1;
    if (!payload.record_id) {
      events.push("step:plan");
      return {
        status: "planned",
        record_id: "record-1",
        dwell_seconds: 5,
        execution_plan: executionPlan(),
        advance_plan: advancePlan({ includeScrollFallback }),
      };
    }
    events.push("step:commit");
    commitPayload = payload;
    return {
      status: commitStatus,
      record_id: "record-1",
      progress: commitStatus === "committed" ? 1 : 0,
      execution_plan: executionPlan(),
      advance_plan: advancePlan({ includeScrollFallback }),
      upload: { pending: commitStatus === "committed" ? 1 : 0, dead: 0 },
    };
  };

  const recordTransition = async (payload) => {
    events.push(`transition:${payload.transition_ok}`);
    transitionPayload = payload;
    return { ok: true, status: "transition_recorded", record_id: payload.record_id };
  };

  return {
    tab,
    readFacts,
    step,
    recordTransition,
    events,
    get commitPayload() {
      return commitPayload;
    },
    get stepCalls() {
      return stepCalls;
    },
    get transitionPayload() {
      return transitionPayload;
    },
  };
}

function delayedNotInterestedHarness({ transitionDelayMs = 1_600, stopAfterAdvance = null, progress = 1 } = {}) {
  const events = [];
  let clicked = false;
  let advanced = false;
  let elapsedAfterClickMs = 0;
  let commitPayload = null;
  let transitionPayload = null;

  const page = () => ({
    surface: "active_video",
    aweme_id: advanced ? "image-next" : "image-current",
    content_type: advanced ? "video" : "image_text",
    paused: advanced ? false : null,
    action_state: { liked: false, favorited: false, followed: false },
    stop_text_hit: advanced ? stopAfterAdvance : null,
  });

  const tab = {
    playwright: {
      locator(selector) {
        return {
          async count() {
            return 1;
          },
          async click(input = {}) {
            events.push(`click:${selector}:${input.button || "left"}`);
          },
        };
      },
      getByText(text) {
        return {
          last() {
            return {
              async count() {
                return 1;
              },
              async click() {
                events.push(`click-text:${text}`);
                clicked = true;
              },
            };
          },
        };
      },
      async waitForTimeout(ms) {
        events.push(`wait:${ms}`);
        if (clicked && !advanced) {
          elapsedAfterClickMs += Number(ms);
          if (elapsedAfterClickMs >= transitionDelayMs) advanced = true;
        }
      },
    },
    cua: {
      async keypress({ keys }) {
        events.push(`key:${keys.join("+")}`);
      },
      async scroll(input) {
        events.push(`scroll:${input.scrollX}:${input.scrollY}:${input.x}:${input.y}`);
      },
    },
  };

  const readFacts = async () => {
    const current = page();
    events.push(`read:${current.aweme_id}`);
    return current;
  };

  const imageExecutionPlan = [
    {
      id: "not_interested_menu",
      op: "click",
      locator: { by: "css", selector: ".current-slide", button: "right", timeout_ms: 5_000 },
      settle_ms: 120,
    },
    {
      id: "not_interested",
      op: "click",
      locator: { by: "text", text: "不感兴趣", exact: true, nth: "last", timeout_ms: 5_000 },
      settle_ms: 350,
      result_key: "not_interested",
    },
    { id: "not_interested_verify", op: "evaluate_facts" },
  ];
  const imageAdvancePlan = advancePlan({ includeScrollFallback: false });

  const step = async (payload) => {
    if (!payload.record_id) {
      events.push("step:plan");
      return {
        status: "planned",
        record_id: "record-image",
        dwell_seconds: 0,
        execution_plan: imageExecutionPlan,
        advance_plan: imageAdvancePlan,
      };
    }
    events.push("step:commit");
    commitPayload = payload;
    return {
      status: "committed",
      record_id: "record-image",
      progress,
      execution_plan: imageExecutionPlan,
      advance_plan: imageAdvancePlan,
      upload: { pending: 1, dead: 0 },
    };
  };

  const recordTransition = async (payload) => {
    events.push(`transition:${payload.transition_ok}`);
    transitionPayload = payload;
    return { ok: true, status: "transition_recorded", record_id: payload.record_id };
  };

  return {
    tab,
    readFacts,
    step,
    recordTransition,
    events,
    get commitPayload() {
      return commitPayload;
    },
    get transitionPayload() {
      return transitionPayload;
    },
  };
}

test("processOne closes read, act, verify, commit, and advance inside the JS runner", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness();
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "advanced");
  assert.equal(result.record_id, "record-1");
  assert.equal(result.transition.from_aweme_id, "1");
  assert.equal(result.transition.to_aweme_id, "2");
  assert.deepEqual(app.commitPayload.action_results.like, { attempted: true, success: true });
  assert.equal(app.transitionPayload.transition_ok, true);
  assert.equal(app.events.filter((event) => event.includes("video-player-digg")).length, 1);
  assert.ok(app.events.indexOf("step:commit") < app.events.indexOf("key:ARROWDOWN"));
});

test("processOne skips previously observed pages without replanning interactions or increasing progress", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const events = [];
  const ids = ["seen-a", "seen-b", "fresh", "after-fresh"];
  let index = 0;
  const page = () => ({
    surface: "active_video",
    aweme_id: ids[index],
    title: ids[index],
    content_type: "video",
    paused: false,
    action_state: { liked: false, favorited: false, followed: false },
    stop_text_hit: null,
  });
  const tab = {
    playwright: {
      async waitForTimeout(ms) {
        events.push(`wait:${ms}`);
      },
      locator() {
        return { async count() { return 1; }, async click() {} };
      },
      getByText() {
        return { last() { return { async count() { return 1; }, async click() {} }; } };
      },
    },
    cua: {
      async keypress({ keys }) {
        events.push(`key:${keys.join("+")}:${ids[index]}`);
        index += 1;
      },
      async scroll() {
        events.push("scroll");
      },
    },
  };
  const step = async ({ page: current }) => {
    events.push(`step:${current.aweme_id}`);
    if (current.aweme_id.startsWith("seen-")) {
      return {
        status: "duplicate_page",
        aweme_id: current.aweme_id,
        advance_plan: advancePlan({ includeScrollFallback: false }),
      };
    }
    return {
      status: "committed",
      record_id: "record-fresh",
      progress: 1,
      execution_plan: [],
      advance_plan: advancePlan({ includeScrollFallback: false }),
      upload: { pending: 1, dead: 0 },
    };
  };
  let transitionPayload = null;
  const runner = await createDouyinRunner({
    tab,
    dbPath: "/tmp/runner-duplicate-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: async () => page(),
    step,
    recordTransition: async (payload) => {
      transitionPayload = payload;
      return { status: "transition_recorded" };
    },
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "advanced");
  assert.equal(result.progress, 1);
  assert.equal(result.duplicate_skips, 2);
  assert.deepEqual(events.filter((event) => event.startsWith("step:")), ["step:seen-a", "step:seen-b", "step:fresh"]);
  assert.deepEqual(events.filter((event) => event.startsWith("key:")), [
    "key:ARROWDOWN:seen-a",
    "key:ARROWDOWN:seen-b",
    "key:ARROWDOWN:fresh",
  ]);
  assert.equal(transitionPayload.record_id, "record-fresh");
});

test("processOne stops after the bounded number of duplicate-page transitions", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  let index = 0;
  let keypresses = 0;
  const currentPage = () => ({
    surface: "active_video",
    aweme_id: index % 2 === 0 ? "seen-a" : "seen-b",
    content_type: "video",
    paused: false,
    action_state: { liked: false, favorited: false, followed: false },
    stop_text_hit: null,
  });
  const runner = await createDouyinRunner({
    tab: {
      playwright: {
        async waitForTimeout() {},
        locator() { return { async count() { return 1; }, async click() {} }; },
        getByText() { return { last() { return { async count() { return 1; }, async click() {} }; } }; },
      },
      cua: {
        async keypress() {
          keypresses += 1;
          index += 1;
        },
        async scroll() {},
      },
    },
    dbPath: "/tmp/runner-duplicate-limit-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: async () => currentPage(),
    step: async ({ page }) => ({
      status: "duplicate_page",
      aweme_id: page.aweme_id,
      advance_plan: advancePlan({ includeScrollFallback: false }),
    }),
    recordTransition: async () => {
      throw new Error("duplicate pages must not create transition audits");
    },
    maxDuplicateSkips: 2,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "duplicate_loop");
  assert.equal(result.duplicate_skips, 2);
  assert.equal(keypresses, 2);
});

test("processOne never advances when the planned action outcome was not committed", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness({ commitStatus: "stop_required" });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "commit_failed");
  assert.equal(app.events.some((event) => event.startsWith("key:")), false);
  assert.equal(app.events.some((event) => event.includes("video-switch-next-arrow")), false);
});

test("processOne commits an unverified action once and stops before advancing", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness({ verifyLike: false });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "action_failed");
  assert.equal(result.reason, "action_unverified:like");
  assert.deepEqual(app.commitPayload.action_results.like, { attempted: true, success: false });
  assert.equal(app.events.filter((event) => event.includes("video-player-digg")).length, 1);
  assert.equal(app.events.some((event) => event.startsWith("key:")), false);
});

test("processOne runs a synchronous checkpoint only after a committed transition", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness();
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    sync: async () => {
      app.events.push("sync");
      return { status: "ok", pending: 0 };
    },
    syncEvery: 1,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "advanced");
  assert.equal(result.sync.status, "ok");
  assert.ok(app.events.indexOf("step:commit") < app.events.indexOf("key:ARROWDOWN"));
  assert.ok(app.events.indexOf("key:ARROWDOWN") < app.events.indexOf("transition:true"));
  assert.ok(app.events.indexOf("transition:true") < app.events.indexOf("sync"));
  assert.ok(app.events.indexOf("key:ARROWDOWN") < app.events.indexOf("sync"));
});

test("runCliJson bounds a stuck local CLI invocation", async () => {
  const { runCliJson } = await import(RUNNER_URL.href);
  await assert.rejects(
    runCliJson(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      undefined,
      { timeoutMs: 25 },
    ),
    /timed out/,
  );
});

test("runCliJson works when the Chrome control runtime does not expose process", async () => {
  const { runCliJson } = await import(RUNNER_URL.href);
  const executable = process.execPath;
  const savedProcess = globalThis.process;
  try {
    delete globalThis.process;
    const result = await runCliJson(
      executable,
      ["-e", "console.log(JSON.stringify({ok:true}))"],
      undefined,
      { timeoutMs: 1000 },
    );
    assert.deepEqual(result, { ok: true });
  } finally {
    globalThis.process = savedProcess;
  }
});

test("processOne accepts an ARROWDOWN transition that settles after the old 2.35 second window", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness({ transitionDelayMs: 5000, fallbackAvailable: false });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "advanced");
  assert.equal(result.transition.method, "ARROWDOWN_SETTLED");
  assert.equal(app.events.filter((event) => event === "key:ARROWDOWN").length, 1);
  assert.equal(app.events.some((event) => event.includes("video-switch-next-arrow")), false);
});

test("processOne passively verifies a delayed not-interested transition without clicking or advancing twice", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = delayedNotInterestedHarness();
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "advanced");
  assert.equal(result.transition.method, "action_transition");
  assert.deepEqual(app.commitPayload.action_results.not_interested, { attempted: true, success: true });
  assert.equal(app.events.filter((event) => event === "click-text:不感兴趣").length, 1);
  assert.equal(app.events.some((event) => event.startsWith("key:")), false);
  assert.equal(app.events.some((event) => event.startsWith("scroll:")), false);
  assert.equal(app.transitionPayload.transition_ok, true);
});

test("processOne finalizes a not-interested transition before stopping on the destination page", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = delayedNotInterestedHarness({
    transitionDelayMs: 500,
    stopAfterAdvance: "验证码",
    progress: 16,
  });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const batch = await runner.processBatch({ maxItems: 1 });
  const result = batch.results[0];

  assert.equal(batch.status, "stop_required");
  assert.equal(batch.processed, 1);
  assert.equal(result.status, "stop_required");
  assert.equal(result.reason, "验证码");
  assert.equal(result.stop_phase, "next_page_preflight");
  assert.equal(result.committed, true);
  assert.equal(result.progress, 16);
  assert.equal(result.transition.ok, true);
  assert.equal(result.transition.method, "action_transition");
  assert.equal(result.transition.from_aweme_id, "image-current");
  assert.equal(result.transition.to_aweme_id, "image-next");
  assert.equal(app.transitionPayload.transition_ok, true);
  assert.equal(app.transitionPayload.scroll_delta, 1);
  assert.equal(app.events.some((event) => event.startsWith("key:")), false);
  assert.equal(app.events.some((event) => event.startsWith("scroll:")), false);
});

test("processOne waits for a mounting slide to expose its video before planning", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness({ initialUnknownReads: 2 });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "advanced");
  assert.equal(app.events.filter((event) => event === "step:plan").length, 1);
  assert.ok(app.events.some((event) => event === "wait:250"));
  assert.ok(app.events.indexOf("read:1:false") < app.events.indexOf("step:plan"));
});

test("processOne returns media_loading without committing when media never becomes ready", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness({ initialUnknownReads: 99 });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "media_loading");
  assert.equal(app.stepCalls, 0);
  assert.deepEqual(
    app.events.filter((event) => event.startsWith("wait:")),
    ["wait:250", "wait:500", "wait:750", "wait:1000"],
  );
  assert.equal(app.transitionPayload, null);
});

test("processOne keeps an unchanged transition pending instead of recording a false failure", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness({ advanceOnKeypress: false, includeScrollFallback: false });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "transition_pending");
  assert.equal(result.reason, "feed_transition_unverified");
  assert.equal(app.events.filter((event) => event === "key:ARROWDOWN").length, 1);
  assert.equal(app.events.some((event) => event.startsWith("scroll:")), false);
  assert.equal(app.transitionPayload, null);
});

test("processOne uses the externally verified CUA scroll once after ARROWDOWN stays unchanged", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness({ advanceOnKeypress: false, advanceOnScroll: true });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "advanced");
  assert.equal(result.transition.method, "CUA_SCROLL");
  assert.equal(app.events.filter((event) => event === "key:ARROWDOWN").length, 1);
  assert.deepEqual(
    app.events.filter((event) => event.startsWith("scroll:")),
    ["scroll:0:740:756:398"],
  );
});

test("processOne retries one previously ineffective scroll on the pending transition without replanning the item", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness({ advanceOnKeypress: false, advanceOnScrollAttempt: 2 });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const first = await runner.processOne();
  const second = await runner.processOne();

  assert.equal(first.status, "transition_pending");
  assert.equal(second.status, "advanced");
  assert.equal(second.transition.method, "CUA_SCROLL_RETRY");
  assert.equal(app.events.filter((event) => event === "step:plan").length, 1);
  assert.equal(app.events.filter((event) => event.startsWith("scroll:")).length, 2);
  assert.equal(app.transitionPayload.transition_ok, true);
});

test("processOne commits the attempted outcome but does not advance when a safety signal appears", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness({ stopAfterLike: "请求过于频繁" });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.equal(result.status, "stop_required");
  assert.equal(result.reason, "请求过于频繁");
  assert.equal(result.committed, true);
  assert.deepEqual(app.commitPayload.action_results.like, { attempted: true, success: true });
  assert.equal(app.events.some((event) => event.startsWith("key:")), false);
});

test("processOne stops before CLI planning and browser actions on a page safety signal", async () => {
  const { createDouyinRunner } = await import(RUNNER_URL.href);
  const app = harness({ stopText: "验证码" });
  const runner = await createDouyinRunner({
    tab: app.tab,
    dbPath: "/tmp/runner-test.sqlite",
    runConfig: { status: "confirmed", config_hash: "sha256:test" },
    readFacts: app.readFacts,
    step: app.step,
    recordTransition: app.recordTransition,
    syncEvery: 0,
  });

  const result = await runner.processOne();

  assert.deepEqual(result, {
    status: "stop_required",
    reason: "验证码",
    stop_phase: "preflight",
    committed: false,
    page: { surface: "active_video", aweme_id: "1" },
  });
  assert.equal(app.stepCalls, 0);
  assert.equal(app.events.some((event) => event.startsWith("click:")), false);
});
