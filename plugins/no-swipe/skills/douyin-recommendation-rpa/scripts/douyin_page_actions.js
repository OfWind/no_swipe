(plan) => {
  // Douyin PC action adapter for `no-swipe step` planned_actions.
  // Pass this file's entire text to tab.playwright.evaluate(...) with the
  // `planned_actions` object from `no-swipe step` as the argument. It first
  // resumes a paused player, then executes each planned interaction exactly
  // once and verifies the post-click state; with { "next": true } it clicks
  // the next arrow once and waits out the slide transition. Selectors, menu
  // labels, and settle windows (280/320/350/450ms) are the ones the retired
  // 0.2.x runner used (config/platforms/douyin.v1.json). It never navigates
  // and never retries a click.
  const p = plan || {};
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const slide = () => document.querySelector('[data-e2e="feed-active-video"]');
  const active = slide();
  const out = {
    surface: active ? "active_video" : "no_active_video",
    resumed: false,
    like: { attempted: false, success: false },
    favorite: { attempted: false, success: false },
    follow: { attempted: false, success: false },
    not_interested: { attempted: false, success: false },
  };
  if (!active) return out;

  const stateOf = (el) => `${(el && el.getAttribute("data-e2e-state")) || ""} ${String((el && el.className) || "")}`;
  const isOn = (el, pattern) => Boolean(el) && pattern.test(stateOf(el));
  const idOf = (el) => (String((el && el.className) || "").match(/video_(\d+)/)
    || location.href.match(/modal_id=(\d+)/)
    || location.pathname.match(/\/video\/(\d+)/) || [])[1] || "";
  const tap = (el) => {
    const rect = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, view: window,
      clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2,
    };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      el.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, base) : new MouseEvent(type, base));
    }
  };
  const visibleExact = (label) => {
    const hits = [...document.querySelectorAll("div,span,button,li,p")]
      .filter((el) => el.childElementCount === 0 && (el.innerText || el.textContent || "").trim() === label && el.offsetParent !== null);
    return hits.length ? hits[hits.length - 1] : null;
  };

  const run = async () => {
    const video = active.querySelector("video");

    // Old resumeIfPaused: a prior session can leave the card in Douyin's
    // auto-pause overlay (继续播放). Resume before any interaction.
    if (video && video.paused) {
      try { await video.play(); } catch {}
      await wait(450);
      if (video.paused) {
        const resume = visibleExact("继续播放");
        if (resume) { tap(resume); await wait(450); }
      }
      out.resumed = !video.paused;
    }

    const clickVerified = async (selector, pattern) => {
      const el = active.querySelector(selector);
      if (!el) return { attempted: false, success: false };
      if (isOn(el, pattern)) return { attempted: false, success: true };
      tap(el);
      await wait(280);
      return { attempted: true, success: isOn(active.querySelector(selector), pattern) };
    };
    if (p.like) out.like = await clickVerified('[data-e2e="video-player-digg"]', /is-digged|digged|liked|active|selected/i);
    if (p.favorite) out.favorite = await clickVerified('[data-e2e="video-player-collect"]', /is-favorited|is-collect|favorited|collected|active|selected/i);

    if (p.follow) {
      const follow = active.querySelector('[data-e2e="feed-follow-icon"]');
      if (!follow || isOn(follow, /is-followed|followed|active|selected/i)) {
        out.follow = { attempted: false, success: Boolean(follow) };
      } else {
        out.follow.attempted = true;
        const beforeMarkup = follow.outerHTML;
        // Douyin renders the red '+' as an overflowing child of the follow
        // control; the outer data-e2e node can have zero layout height even
        // while the control is visibly painted, so click the inner icon and
        // verify the post-click state instead.
        const icon = follow.querySelector('span[role="img"]');
        tap(icon || follow);
        await wait(320);
        const after = active.querySelector('[data-e2e="feed-follow-icon"]');
        const afterMarkup = after ? after.outerHTML : "";
        const state = after ? stateOf(after) : "";
        out.follow.success = Boolean(
          /is-followed|followed|following|selected|active/i.test(state)
          || /关注成功|已关注|已跟随/.test((((document.body && document.body.innerText) || "").slice(0, 16000)))
          || (beforeMarkup && afterMarkup && beforeMarkup !== afterMarkup && !/\+/.test(afterMarkup))
        );
        out.follow.verification = { state, markup_changed: beforeMarkup !== afterMarkup };
      }
    }

    if (p.not_interested && video) {
      out.not_interested.attempted = true;
      video.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, view: window }));
      await wait(250);
      const menu = visibleExact("不感兴趣");
      if (menu) {
        tap(menu);
        await wait(350);
        out.not_interested.success = true;
      }
    }

    if (p.next) {
      const currentId = idOf(active);
      const arrow = document.querySelector('[data-e2e="video-switch-next-arrow"]');
      if (!arrow) {
        out.next = { transition_ok: false, aweme_id: currentId, reason: "no_next_arrow" };
      } else {
        tap(arrow);
        // The slider can finish moving slightly after the click settles; give
        // the visible card a second window before reporting a failed move.
        await wait(850);
        let nextId = idOf(slide());
        if (!nextId || nextId === currentId) {
          await wait(1500);
          nextId = idOf(slide());
        }
        out.next = { transition_ok: Boolean(nextId && nextId !== currentId), aweme_id: nextId || currentId };
      }
    }

    return out;
  };
  return run();
}
