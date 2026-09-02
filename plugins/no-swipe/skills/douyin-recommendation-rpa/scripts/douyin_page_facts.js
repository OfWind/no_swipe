() => {
  // Douyin PC page-fact extractor for `no-swipe step`.
  // Pass this file's entire text to tab.playwright.evaluate(...) on the
  // Douyin tab. It reads the active slide of the modal/immersive player
  // and returns the `page` object for `no-swipe step`. It never clicks
  // and never navigates.
  //
  // Player layouts:
  // - `[data-e2e="feed-active-video"]` (classic modal)
  // - `.sliderVideo` / `.relatedUiAdapter` / class `video_<awemeId>`
  //   (recommend-feed slider; often omits feed-active-video)
  const text = (el) => (el && (el.innerText || el.textContent) || "").trim();
  const count = (raw) => {
    const t = String(raw || "").trim().replace(/,/g, "");
    const m = t.match(/^([\d.]+)\s*(万|亿)?$/);
    if (!m) return null;
    // The evaluate scope is read-only and strips bare globals; only
    // Number.* namespace functions are guaranteed to exist there.
    return Math.round(Number.parseFloat(m[1]) * (m[2] === "万" ? 1e4 : m[2] === "亿" ? 1e8 : 1));
  };

  const visibleArea = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return 0;
    const r = el.getBoundingClientRect();
    const viewportWidth = Math.max(0, Number(window.innerWidth) || 0);
    const viewportHeight = Math.max(0, Number(window.innerHeight) || 0);
    const left = Math.max(0, Number(r.left) || 0);
    const top = Math.max(0, Number(r.top) || 0);
    const right = Math.min(viewportWidth, Number(r.right) || 0);
    const bottom = Math.min(viewportHeight, Number(r.bottom) || 0);
    const w = Math.max(0, right - left);
    const h = Math.max(0, bottom - top);
    if (w < 80 || h < 80) return 0;
    return w * h;
  };

  const pickLargest = (nodes) => {
    let best = null;
    let bestArea = 0;
    for (const el of nodes) {
      const area = visibleArea(el);
      if (area > bestArea) {
        best = el;
        bestArea = area;
      }
    }
    return best;
  };

  const unique = (nodes) => {
    const seen = new Set();
    const out = [];
    for (const el of nodes) {
      if (!el || seen.has(el)) continue;
      seen.add(el);
      out.push(el);
    }
    return out;
  };

  const findActiveSlide = () => {
    const marked = document.querySelector('[data-e2e="feed-active-video"]');
    if (marked && visibleArea(marked) > 0) return marked;

    const sliders = unique(document.querySelectorAll('.sliderVideo, [class*="sliderVideo"], [class*="relatedUiAdapter"]'));
    const bestSlider = pickLargest(sliders);
    if (bestSlider) return bestSlider;

    const withControls = unique(document.querySelectorAll('[class*="video_"]')).filter((el) =>
      (el.querySelector("video") || el.querySelector('img[src*="tplv-dy-aweme-images"], img[src*="aweme-images"]')) && (
        el.querySelector('[data-e2e="video-player-digg"]')
        || el.querySelector('[data-e2e="feed-video-nickname"]')
      )
    );
    const bestWithControls = pickLargest(withControls);
    if (bestWithControls) return bestWithControls;

    const bestVideo = pickLargest(document.querySelectorAll("video"));
    if (!bestVideo) return null;
    return bestVideo.closest('[class*="sliderVideo"]')
      || bestVideo.closest('[class*="relatedUiAdapter"]')
      || bestVideo.closest('[class*="video_"]')
      || bestVideo.parentElement;
  };

  const cardGeometry = () => Array.from(document.querySelectorAll("[data-aweme-id]")).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      id: el.getAttribute("data-aweme-id"),
      w: Math.round(r.width),
      h: Math.round(r.height),
    };
  });

  // Platform stop signals (from config/platforms/douyin.v1.json) only count
  // when they are rendered inside a visible blocking UI. Whole-page text can
  // retain offscreen help copy, stale portals, or video captions containing
  // words such as "验证码"; those are not safety gates.
  // Do not use the bare substring "登录": "保存登录信息" matches it.
  const stopSignals = ["验证码", "人机验证", "安全验证", "访问受限", "操作频繁", "请求过于频繁", "登录后继续", "请先登录", "账号异常", "暂时无法访问", "异常访问"];
  const stopBlockerSelector = [
    '[role="dialog"]',
    '[role="alertdialog"]',
    '[role="alert"]',
    '[aria-modal="true"]',
    '[data-e2e*="captcha" i]',
    '[data-e2e*="verify" i]',
    '[id*="captcha" i]',
    '[id*="verify" i]',
    '[id*="geetest" i]',
    '[class*="captcha" i]',
    '[class*="verify" i]',
    '[class*="verification" i]',
    '[class*="geetest" i]',
    '[class*="rate-limit" i]',
    '[class*="restriction" i]',
    '[class*="login-modal" i]',
    '[class*="login-dialog" i]',
    '[class*="login-mask" i]',
  ].join(", ");
  const active = findActiveSlide();
  const visibleRect = (el) => {
    if (!el || typeof el.getBoundingClientRect !== "function") return null;
    const raw = el.getBoundingClientRect();
    const left = Math.max(0, Number(raw.left) || 0);
    const top = Math.max(0, Number(raw.top) || 0);
    const right = Math.min(Math.max(0, Number(window.innerWidth) || 0), Number(raw.right) || 0);
    const bottom = Math.min(Math.max(0, Number(window.innerHeight) || 0), Number(raw.bottom) || 0);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);
    if (width < 2 || height < 2) return null;
    return {
      left: Math.round(left),
      top: Math.round(top),
      width: Math.round(width),
      height: Math.round(height),
    };
  };
  const stopEvidence = (() => {
    const candidates = unique(document.querySelectorAll(stopBlockerSelector));
    for (const el of candidates) {
      const rect = visibleRect(el);
      if (!rect) continue;
      const marker = [
        el.getAttribute?.("id"),
        el.getAttribute?.("class"),
        el.getAttribute?.("data-e2e"),
      ].filter(Boolean).join(" ").toLowerCase();
      const explicitlyGateLike = /captcha|verify|verification|geetest|rate.?limit|restriction|login.?(modal|dialog|mask)/.test(marker);
      const wrapsActiveFeed = active && (el === active || (typeof el.contains === "function" && el.contains(active)));
      if (wrapsActiveFeed && !explicitlyGateLike) continue;
      const candidateText = text(el).replace(/\s+/g, " ").trim();
      const signal = stopSignals.find((item) => candidateText.includes(item));
      if (!signal) continue;
      return {
        signal,
        source: "visible_blocker",
        text: candidateText.slice(0, 160),
        rect,
      };
    }
    return null;
  })();
  const stopTextHit = stopEvidence?.signal || null;

  const cards = cardGeometry();
  const visibleCards = cards.filter((c) => c.w > 40 && c.h > 40);
  const playingVideoCount = Array.from(document.querySelectorAll("video")).filter((el) => visibleArea(el) > 0).length;

  if (!active) {
    // Waterfall/discover grid, or a player the adapter still cannot bind.
    // Cards often collapse to 0x0 once a slider mounts — do not click them.
    return {
      surface: "no_active_video",
      url: location.href,
      viewport: { width: Number(window.innerWidth) || 0, height: Number(window.innerHeight) || 0 },
      card_count: cards.length,
      visible_card_count: visibleCards.length,
      visible_card_ids: visibleCards.slice(0, 5).map((c) => c.id).filter(Boolean),
      playing_video_count: playingVideoCount,
      stop_text_hit: stopTextHit,
      stop_evidence: stopEvidence,
    };
  }

  const q = (sel) => active.querySelector(sel);
  // A slide can temporarily keep an old/placeholder <video> before the real
  // player finishes mounting. querySelector("video") then returns the hidden
  // node first and incorrectly makes a visible video look like unknown media.
  // Select the largest viewport-intersecting video inside the active slide.
  const video = pickLargest(active.querySelectorAll("video"));
  const galleryImagePaths = Array.from(active.querySelectorAll("img"))
    .map((img) => String(img.currentSrc || img.src || img.getAttribute("src") || ""))
    .filter((src) => /tplv-dy-aweme-images|\/aweme-images\//.test(src))
    .map((src) => src.split("?", 1)[0]);
  const galleryImageCount = new Set(galleryImagePaths).size;
  const contentType = video ? "video" : (galleryImageCount > 0 ? "image_text" : "unknown");
  const descEl = q('[data-e2e="video-desc"]');
  const infoText = text(q('[data-e2e="video-info"]'));
  const publishedMatch = infoText.match(/·\s*([^\n]+)/);
  const idMatch = String(active.className || "").match(/video_(\d+)/)
    || location.href.match(/modal_id=(\d+)/)
    || location.pathname.match(/\/video\/(\d+)/)
    || String((q('a[href*="aweme_id="]') || {}).href || "").match(/aweme_id=(\d+)/)
    || String((q('a[href*="gid="]') || {}).href || "").match(/[?&]gid=(\d+)/);
  const descText = text(descEl).replace(/\n?展开$/, "").trim();
  const titleLine = descText.split("\n")[0] || "";
  const avatarHref = q('a[data-e2e="video-avatar"][href*="/user/"]')?.href || "";
  const userHref = avatarHref || Array.from(active.querySelectorAll('a[href*="/user/"]'))
    .map((a) => a.href)
    .find((href) => /\/user\/MS4wLjAB/.test(href) || (/\/user\/[^/?#]+/.test(href) && !href.includes("/search/")))
    || "";
  const nextArrow = q('[data-e2e="video-switch-next-arrow"]');
  const siblingSlides = unique(document.querySelectorAll('.sliderVideo, [class*="sliderVideo"]'))
    .filter((el) => el !== active && visibleArea(el) > 0).length;

  return {
    surface: "active_video",
    url: location.href,
    viewport: { width: Number(window.innerWidth) || 0, height: Number(window.innerHeight) || 0 },
    aweme_id: idMatch ? idMatch[1] : "",
    title: titleLine,
    caption: descText,
    author: text(q('[data-e2e="feed-video-nickname"]')).replace(/^@/, ""),
    author_href: userHref,
    published_text: publishedMatch ? publishedMatch[1].trim() : "",
    content_type: contentType,
    media_state: contentType === "unknown" ? "loading" : "ready",
    gallery_image_count: galleryImageCount,
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
    // Negative-first state resolution: the resting markers are
    // video-player-no-digged / video-player-no-collect, and their substrings
    // match every positive word, so negatives must win. The follow control
    // carries no state marker at all — only a 关注成功 toast can confirm it,
    // and null stays honest.
    action_state: (() => {
      const stateOf = (sel, negatives, positives) => {
        const el = q(sel);
        if (!el) return null;
        const raw = `${el.getAttribute("data-e2e-state") || ""} ${String(el.className || "")}`.toLowerCase();
        if (negatives.some((token) => raw.includes(token))) return false;
        if (positives.some((token) => raw.includes(token))) return true;
        return null;
      };
      return {
        liked: stateOf('[data-e2e="video-player-digg"]', ["no-digged", "not-digged"], ["is-digged", "digged", " liked ", " selected"]),
        favorited: stateOf('[data-e2e="video-player-collect"]', ["no-collect", "not-collect"], ["is-favorited", "is-collect", "favorited", "collected", " selected"]),
        followed: (() => {
          const control = stateOf('[data-e2e="feed-follow-icon"]', ["no-follow", "not-follow"], ["is-followed", "followed", " selected"]);
          if (control !== null) return control;
          return /关注成功/.test((document.body && document.body.innerText) || "") ? true : null;
        })(),
      };
    })(),
    // A sibling only counts when it intersects the current viewport. Slider
    // layouts keep sized offscreen siblings mounted, which is not evidence
    // that an on-screen fallback control exists.
    can_switch_next: Boolean(nextArrow) || siblingSlides > 0,
    stop_text_hit: stopTextHit,
    stop_evidence: stopEvidence,
  };
}
