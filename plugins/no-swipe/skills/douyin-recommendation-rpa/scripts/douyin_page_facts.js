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
    return Math.round(parseFloat(m[1]) * (m[2] === "万" ? 1e4 : m[2] === "亿" ? 1e8 : 1));
  };

  const active = document.querySelector('[data-e2e="feed-active-video"]');
  if (!active) {
    // Waterfall/discover grid: no active player yet. Click a video card
    // (an element with a data-aweme-id, or a discover-video-card-item)
    // to enter the modal player, then call this extractor again.
    return {
      surface: "no_active_video",
      url: location.href,
      card_count: document.querySelectorAll("[data-aweme-id]").length,
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
    can_switch_next: Boolean(document.querySelector('[data-e2e="video-switch-next-arrow"]')),
    has_login_gate: Boolean(document.querySelector('[class*="login-guide"], [id*="login"], [class*="captcha"]')),
  };
}
