() => {
  // Douyin PC page-fact extractor for `no-swipe step`.
  // Pass this file's entire text to tab.playwright.evaluate(...) on the
  // Douyin tab. It reads the active slide of the modal/immersive player
  // ([data-e2e="feed-active-video"]) and returns the `page` object for
  // `no-swipe step`. It never clicks and never navigates.
  const text = (el) => (el && (el.innerText || el.textContent) || "").trim();
  const count = (raw) => {
    const t = String(raw || "").trim().replace(/,/g, "");
    const m = t.match(/^([\d.]+)\s*(万|亿)?$/);
    if (!m) return null;
    // The evaluate scope is read-only and strips bare globals; only
    // Number.* namespace functions are guaranteed to exist there.
    return Math.round(Number.parseFloat(m[1]) * (m[2] === "万" ? 1e4 : m[2] === "亿" ? 1e8 : 1));
  };

  // Platform stop signals (from config/platforms/douyin.v1.json): any hit
  // means CAPTCHA/rate-limit/login gates — step will refuse to record.
  const stopSignals = ["验证码", "人机验证", "安全验证", "访问受限", "操作频繁", "请求过于频繁", "登录后继续", "请先登录", "账号异常", "暂时无法访问", "异常访问"];
  const bodyText = (document.body && document.body.innerText || "").slice(0, 8000);
  const stopTextHit = stopSignals.find((signal) => bodyText.includes(signal)) || null;

  const active = document.querySelector('[data-e2e="feed-active-video"]');
  if (!active) {
    // Waterfall/discover grid: no active player yet. Click a video card
    // (an element with a data-aweme-id, or a discover-video-card-item)
    // to enter the modal player, then call this extractor again.
    return {
      surface: "no_active_video",
      url: location.href,
      card_count: document.querySelectorAll("[data-aweme-id]").length,
      stop_text_hit: stopTextHit,
    };
  }

  const q = (sel) => active.querySelector(sel);
  const video = q("video");
  const descEl = q('[data-e2e="video-desc"]');
  const infoText = text(q('[data-e2e="video-info"]'));
  const publishedMatch = infoText.match(/·\s*([^\n]+)/);
  const idMatch = String(active.className || "").match(/video_(\d+)/)
    || location.href.match(/modal_id=(\d+)/)
    || location.pathname.match(/\/video\/(\d+)/);
  const descText = text(descEl).replace(/\n?展开$/, "").trim();
  const titleLine = descText.split("\n")[0] || "";

  return {
    surface: "active_video",
    url: location.href,
    aweme_id: idMatch ? idMatch[1] : "",
    title: titleLine,
    caption: descText,
    author: text(q('[data-e2e="feed-video-nickname"]')).replace(/^@/, ""),
    author_href: q('a[data-e2e="video-avatar"][href*="/user/"]')?.href || "",
    published_text: publishedMatch ? publishedMatch[1].trim() : "",
    duration_seconds: video && Number.isFinite(video.duration) ? Math.round(video.duration) : null,
    current_position_seconds: video ? Math.round(video.currentTime) : null,
    paused: video ? video.paused : null,
    like_count: count(text(q('[data-e2e="video-player-digg"]'))),
    comment_count: count(text(q('[data-e2e="feed-comment-icon"]'))),
    favorite_count: count(text(q('[data-e2e="video-player-collect"]'))),
    share_count: count(text(q('[data-e2e="video-player-share"]'))),
    follow_visible: Boolean(q('[data-e2e="feed-follow-icon"]')),
    // Post-action verification: same data-e2e-state markers the retired
    // runner used. null means the marker is unreadable, not "false".
    action_state: (() => {
      const stateOf = (sel, pattern) => {
        const el = q(sel);
        if (!el) return null;
        return pattern.test(`${el.getAttribute("data-e2e-state") || ""} ${String(el.className || "")}`);
      };
      return {
        liked: stateOf('[data-e2e="video-player-digg"]', /is-digged|digged|liked|active|selected/i),
        favorited: stateOf('[data-e2e="video-player-collect"]', /is-favorited|is-collect|favorited|collected|active|selected/i),
        followed: stateOf('[data-e2e="feed-follow-icon"]', /is-followed|followed|active|selected/i),
      };
    })(),
    can_switch_next: Boolean(document.querySelector('[data-e2e="video-switch-next-arrow"]')),
    stop_text_hit: stopTextHit,
  };
}
