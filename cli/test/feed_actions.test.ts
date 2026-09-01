import { expect, test } from "bun:test";
import {
  FEED_SELECTORS,
  MIN_INTERACTION_DWELL_SECONDS,
  buildAdvancePlan,
  buildEntryPlan,
  buildExecutionPlan,
  contextMenuSelector,
  feedSelector,
} from "../src/feed_actions.ts";

test("execution plan skips dwell/clicks when nothing is planned", () => {
  const plan = buildExecutionPlan({
    planned: {},
    page: { paused: false },
    dwellSeconds: 1.2,
  });
  expect(plan.some((op) => op.op === "click")).toBe(false);
  expect(plan.find((op) => op.id === "dwell")?.wait_ms).toBe(1200);
});

test("zero-dwell direct skip does not try to resume a paused video", () => {
  const plan = buildExecutionPlan({
    planned: {},
    page: { paused: true },
    dwellSeconds: 0,
  });

  expect(plan).toEqual([]);
});

test("execution plan resumes, floors dwell, and pins locators for planned clicks", () => {
  const plan = buildExecutionPlan({
    planned: { like: true, favorite: true, follow: true, not_interested: true },
    page: { paused: true },
    dwellSeconds: 3,
  });
  const ids = plan.map((op) => op.id);
  expect(ids[0]).toBe("resume");
  expect(plan.find((op) => op.id === "dwell")?.wait_ms).toBe(MIN_INTERACTION_DWELL_SECONDS * 1000);
  expect(plan.find((op) => op.id === "like")?.locator).toEqual({
    by: "css",
    selector: FEED_SELECTORS.like,
    timeout_ms: 5000,
  });
  const follow = plan.find((op) => op.id === "follow");
  expect(follow?.locator && follow.locator.by === "css" ? follow.locator.selector : null).toBe(FEED_SELECTORS.followIcon);
  expect(follow?.fallback_locator && follow.fallback_locator.by === "css" ? follow.fallback_locator.selector : null).toBe(FEED_SELECTORS.follow);
  expect(plan.find((op) => op.id === "not_interested_menu")?.locator).toMatchObject({
    by: "css",
    button: "right",
  });
  expect(plan.find((op) => op.id === "not_interested")?.locator).toMatchObject({
    by: "text",
    text: "不感兴趣",
    nth: "last",
  });
  expect(plan.find((op) => op.id === "like")?.skip_if_action_state).toEqual({ key: "liked", equals: true });
});

test("advance plan uses one ARROWDOWN without the incompatible fixed-arrow fallback", () => {
  const plan = buildAdvancePlan();
  expect(plan[0]).toMatchObject({ op: "keypress", keys: ["ARROWDOWN"] });
  expect(plan.filter((op) => op.op === "keypress")).toHaveLength(1);
  expect(plan.some((op) => op.id === "advance_fallback")).toBe(false);
});

test("slider aweme_id scopes clicks to .video_<id> instead of feed-active-video", () => {
  const page = { aweme_id: "7677131709351070991", paused: false };
  const plan = buildExecutionPlan({
    planned: { like: true, follow: true },
    page,
    dwellSeconds: 5,
  });
  expect(plan.find((op) => op.id === "like")?.locator).toEqual({
    by: "css",
    selector: feedSelector("like", page),
    timeout_ms: 5000,
  });
  expect(feedSelector("like", page)).toBe(".video_7677131709351070991 [data-e2e=\"video-player-digg\"]");
  expect(buildAdvancePlan(page).some((op) => op.id === "advance_fallback")).toBe(false);
});

test("image-text not-interested uses the active slide and adds no dwell", () => {
  const page = { aweme_id: "7677131709351070992", content_type: "image_text", paused: null };
  const plan = buildExecutionPlan({
    planned: { not_interested: true },
    page,
    dwellSeconds: 0,
  });

  expect(plan.some((op) => op.id === "dwell")).toBe(false);
  expect(contextMenuSelector(page)).toBe(".video_7677131709351070992");
  expect(plan.find((op) => op.id === "not_interested_menu")?.locator).toEqual({
    by: "css",
    selector: ".video_7677131709351070992",
    button: "right",
    timeout_ms: 5000,
  });
});

test("advance plan adds the externally verified one-time CUA scroll when viewport facts are available", () => {
  const plan = buildAdvancePlan({ viewport: { width: 1512, height: 796 } });
  expect(plan.find((op) => op.id === "advance_fallback")).toMatchObject({
    op: "scroll",
    scroll_x: 0,
    scroll_y: 740,
    x: 756,
    y: 398,
  });
});

test("entry plan clicks a waterfall card rather than inventing a player URL", () => {
  const plan = buildEntryPlan();
  expect(plan.some((op) => op.locator && op.locator.by === "css" && op.locator.selector === FEED_SELECTORS.card)).toBe(true);
  expect(plan.some((op) => /#418\/#422/.test(op.note || ""))).toBe(true);
  expect(plan.some((op) => /visible_card_ids/.test(op.note || ""))).toBe(true);
  expect(plan.some((op) => /can_switch_next=false is not a block/.test(op.note || ""))).toBe(true);
});
