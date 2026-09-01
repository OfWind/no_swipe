export const MIN_INTERACTION_DWELL_SECONDS = 5;

export const FEED_PARTS = {
  like: '[data-e2e="video-player-digg"]',
  favorite: '[data-e2e="video-player-collect"]',
  follow: '[data-e2e="feed-follow-icon"]',
  followIcon: '[data-e2e="feed-follow-icon"] span[role="img"]',
  nextArrow: '[data-e2e="video-switch-next-arrow"]',
  video: "video",
} as const;

export function slideScope(page?: Record<string, unknown>): string {
  const id = String(page?.aweme_id || "").replace(/[^\d]/g, "");
  return id ? `.video_${id}` : '[data-e2e="feed-active-video"]';
}

export function feedSelector(
  part: keyof typeof FEED_PARTS,
  page?: Record<string, unknown>,
): string {
  return `${slideScope(page)} ${FEED_PARTS[part]}`;
}

export function contextMenuSelector(page?: Record<string, unknown>): string {
  const contentType = String(page?.content_type ?? page?.contentType ?? "video").toLowerCase();
  return contentType === "video" ? feedSelector("video", page) : slideScope(page);
}

export const FEED_SELECTORS = {
  active: '[data-e2e="feed-active-video"]',
  like: feedSelector("like"),
  favorite: feedSelector("favorite"),
  follow: feedSelector("follow"),
  followIcon: feedSelector("followIcon"),
  nextArrow: feedSelector("nextArrow"),
  card: "[data-aweme-id]",
  video: feedSelector("video"),
} as const;

export type CssLocator = {
  by: "css";
  selector: string;
  button?: "left" | "right";
  timeout_ms: number;
};

export type TextLocator = {
  by: "text";
  text: string;
  exact: true;
  nth: "last";
  timeout_ms: number;
};

export type Locator = CssLocator | TextLocator;

export type ActionStateKey = "liked" | "favorited" | "followed";

export type FeedOp = {
  id: string;
  op: "click" | "wait" | "keypress" | "scroll" | "evaluate_facts";
  locator?: Locator;
  fallback_locator?: Locator;
  wait_ms?: number;
  keys?: string[];
  scroll_x?: number;
  scroll_y?: number;
  x?: number;
  y?: number;
  settle_ms?: number;
  skip_if_action_state?: { key: ActionStateKey; equals: boolean };
  result_key?: "like" | "favorite" | "follow" | "not_interested" | "resumed";
  note?: string;
};

export type PlannedActions = {
  like?: boolean;
  favorite?: boolean;
  follow?: boolean;
  comment?: boolean;
  not_interested?: boolean;
  watch_to_end?: boolean;
  next?: boolean;
};

function css(selector: string, extra: Partial<CssLocator> = {}): CssLocator {
  return { by: "css", selector, timeout_ms: 5000, ...extra };
}

function text(label: string, timeout_ms = 10000): TextLocator {
  return { by: "text", text: label, exact: true, nth: "last", timeout_ms };
}

export function buildExecutionPlan(input: {
  planned: PlannedActions;
  page?: Record<string, unknown>;
  dwellSeconds: number;
}): FeedOp[] {
  const planned = input.planned || {};
  const page = input.page || {};
  const ops: FeedOp[] = [];
  const needsSettledPositiveClick = Boolean(planned.like || planned.favorite || planned.follow);
  const dwellSeconds = needsSettledPositiveClick
    ? Math.max(Number(input.dwellSeconds) || 0, MIN_INTERACTION_DWELL_SECONDS)
    : Math.max(0, Number(input.dwellSeconds) || 0);
  const needsPlayback = dwellSeconds > 0 || planned.watch_to_end === true;

  if (page.paused === true && needsPlayback) {
    ops.push({
      id: "resume",
      op: "click",
      locator: text("继续播放"),
      result_key: "resumed",
      note: "Click the overlay once. Skip if evaluate_facts already shows paused=false.",
    });
  }

  if (dwellSeconds > 0) {
    ops.push({
      id: "dwell",
      op: "wait",
      wait_ms: Math.round(dwellSeconds * 1000),
      note: "Clicks in the first seconds after a slide mounts are swallowed; like/favorite/follow wait at least 5s.",
    });
  }

  if (planned.watch_to_end) {
    ops.push({
      id: "watch_to_end",
      op: "evaluate_facts",
      note: "Re-run facts until current_position_seconds reaches duration_seconds or stalls. Put completion in action_results.",
    });
  }

  if (planned.like) {
    ops.push({
      id: "like",
      op: "click",
      locator: css(feedSelector("like", page)),
      skip_if_action_state: { key: "liked", equals: true },
      settle_ms: 280,
      result_key: "like",
    });
    ops.push({ id: "like_verify", op: "evaluate_facts", note: "action_state.liked true means success. Never click again." });
  }

  if (planned.favorite) {
    ops.push({
      id: "favorite",
      op: "click",
      locator: css(feedSelector("favorite", page)),
      skip_if_action_state: { key: "favorited", equals: true },
      settle_ms: 280,
      result_key: "favorite",
    });
    ops.push({ id: "favorite_verify", op: "evaluate_facts", note: "action_state.favorited true means success. Never click again." });
  }

  if (planned.follow) {
    ops.push({
      id: "follow",
      op: "click",
      locator: css(feedSelector("followIcon", page)),
      fallback_locator: css(feedSelector("follow", page)),
      skip_if_action_state: { key: "followed", equals: true },
      settle_ms: 320,
      result_key: "follow",
      note: "The red + overflows the parent; the outer node can have zero layout height.",
    });
    ops.push({ id: "follow_verify", op: "evaluate_facts", note: "followed true or a 关注成功 toast means success. Never click again." });
  }

  if (planned.not_interested) {
    ops.push({
      id: "not_interested_menu",
      op: "click",
      locator: css(contextMenuSelector(page), { button: "right" }),
      settle_ms: 250,
    });
    ops.push({
      id: "not_interested",
      op: "click",
      locator: text("不感兴趣", 5000),
      settle_ms: 350,
      result_key: "not_interested",
    });
  }

  return ops;
}

export function buildAdvancePlan(page?: Record<string, unknown>): FeedOp[] {
  const plan: FeedOp[] = [
    {
      id: "advance",
      op: "keypress",
      keys: ["ARROWDOWN"],
      settle_ms: 850,
      note: "One ARROWDOWN. The runner verifies the new aweme_id over a bounded multi-stage settle window; do not repeat the keypress.",
    },
    {
      id: "advance_verify",
      op: "evaluate_facts",
      note: "New aweme_id must differ. If unchanged, keep reading during the bounded settle window before permitting the one verified CUA scroll fallback.",
    },
  ];
  const viewport = page?.viewport as { width?: unknown; height?: unknown } | undefined;
  const width = Number(viewport?.width);
  const height = Number(viewport?.height);
  if (Number.isFinite(width) && width >= 200 && Number.isFinite(height) && height >= 200) {
    plan.push({
      id: "advance_fallback",
      op: "scroll",
      scroll_x: 0,
      scroll_y: 740,
      x: Math.round(width / 2),
      y: Math.round(height / 2),
      settle_ms: 850,
      note: "One physical CUA wheel scroll at viewport center, externally verified on the current slider. Use only after the ARROWDOWN passive verification window stays unchanged.",
    });
  }
  return plan;
}

export function buildEntryPlan(): FeedOp[] {
  return [
    {
      id: "open_feed",
      op: "evaluate_facts",
      note: "Navigate the Douyin tab to https://www.douyin.com/?recommend=1. Waterfall grid returns surface=no_active_video with visible_card_count>0. A playing slider returns surface=active_video even without feed-active-video.",
    },
    {
      id: "open_card",
      op: "click",
      locator: css(FEED_SELECTORS.card, { timeout_ms: 10000 }),
      note: "Click only when surface=no_active_video AND visible_card_ids is non-empty. Use [data-aweme-id='<id>'] for visible_card_ids[0]. If playing_video_count>0 or visible_card_count=0, skip this click, wait 1200ms, and re-extract — waterfall cards collapse to 0x0 once the slider mounts.",
    },
    {
      id: "entry_verify",
      op: "evaluate_facts",
      note: "Need surface=active_video. Console React #418/#422 or a 429 log line is not a stop. Recover via /video/<id> then ?recommend=1&v=<epoch> only if playing_video_count is still 0 after one wait. can_switch_next=false is not a block.",
    },
  ];
}
