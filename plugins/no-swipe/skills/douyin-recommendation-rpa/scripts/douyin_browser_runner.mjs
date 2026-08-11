import fs from "node:fs/promises";
import { classifyRecommendation, chooseDwellSeconds, sampleTruncatedNormal } from "./douyin_rpa_browser_rules.mjs";
import { createDouyinQuotaPolicy, loadDouyinQuotaPolicy } from "./douyin_quota_randomizer.mjs";

const sleep = (tab, ms) => tab.playwright.waitForTimeout(ms);

function makeRng(seed) {
  let state = 2166136261;
  for (const char of String(seed)) {
    state ^= char.charCodeAt(0);
    state = Math.imul(state, 16777619);
  }
  state >>>= 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function parseCount(value) {
  const text = String(value || "").trim().replace(/,/g, "");
  if (!text) return null;
  const match = text.match(/^([\d.]+)\s*([万亿千])?$/);
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  const factor = { "万": 10000, "亿": 100000000, "千": 1000 }[match[2]] || 1;
  return Math.round(number * factor);
}

function toIso() {
  return new Date().toISOString();
}

function isStopText(text) {
  return /验证码|人机验证|安全验证|访问受限|操作频繁|请求过于频繁|登录后继续|请先登录|账号异常|暂时无法访问|异常访问/i.test(text || "");
}

function cleanLine(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function isTimeLine(line) {
  return /^\d{1,3}:\d{2}\s*\/\s*\d{1,3}:\d{2}$/.test(line);
}

function findTitleAndCaption(lines, authorLine) {
  const authorIndex = authorLine ? lines.indexOf(authorLine) : -1;
  let dateIndex = -1;
  for (let index = Math.max(0, authorIndex); index < lines.length; index += 1) {
    if (/^·\s*/.test(lines[index])) {
      dateIndex = index;
      break;
    }
  }
  let start = dateIndex >= 0 ? dateIndex + 1 : Math.max(0, authorIndex + 1);
  while (start < lines.length && ["点击推荐", "听抖音"].includes(lines[start])) start += 1;
  const endMarkers = new Set(["展开", "倍速", "详情", "TA的作品", "评论", "合集", "AI抖音", "相关推荐"]);
  let end = start;
  while (end < lines.length) {
    const line = lines[end];
    if (end > start && (endMarkers.has(line) || isTimeLine(line) || /^汽水音乐\s*:/i.test(line))) break;
    end += 1;
  }
  const contentLines = lines.slice(start, end).filter((line) => line && !/^作者声明/.test(line));
  let title = contentLines[0] || "";
  if (/^第\d+集[:：]?$/.test(title) && contentLines[1]) title = `${title}${contentLines[1]}`;
  return { title, caption: contentLines.join("\n") };
}

async function getActiveCard(tab) {
  const videos = tab.playwright.locator("video");
  const states = await videos.evaluateAll((elements) => {
    const rects = elements.map((video) => video.getBoundingClientRect());
    const fallbackWidth = Math.max(1, ...rects.map((rect) => rect.width));
    const fallbackHeight = Math.max(1, ...rects.map((rect) => rect.height));
    const viewportWidth = innerWidth || document.body?.clientWidth || outerWidth || fallbackWidth;
    const viewportHeight = innerHeight || document.body?.clientHeight || outerHeight || fallbackHeight;
    return elements.map((video, index) => {
      const rect = rects[index];
    const overlap = Math.max(0, Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top))
      * Math.max(0, Math.min(viewportWidth, rect.right) - Math.max(0, rect.left));
    return { index, overlap, x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      currentTime: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended, hasVideo: true };
    });
  });
  let active = states.filter((state) => state.overlap > 2000 && state.width > 200 && state.height > 200)
    .sort((left, right) => right.overlap - left.overlap)[0];
  let activeCardIndex = null;
  const cards = tab.playwright.locator('[class*="video_"]');
  const cardStates = await cards.evaluateAll((elements) => {
    const rects = elements.map((card) => card.getBoundingClientRect());
    const fallbackWidth = Math.max(1, ...rects.map((rect) => rect.width));
    const fallbackHeight = Math.max(1, ...rects.map((rect) => rect.height));
    const viewportWidth = innerWidth || document.body?.clientWidth || outerWidth || fallbackWidth;
    const viewportHeight = innerHeight || document.body?.clientHeight || outerHeight || fallbackHeight;
    return elements.map((card, index) => {
      const rect = rects[index];
    const overlap = Math.max(0, Math.min(viewportHeight, rect.bottom) - Math.max(0, rect.top))
      * Math.max(0, Math.min(viewportWidth, rect.right) - Math.max(0, rect.left));
    const id = String(card.className || "").match(/video_(\d+)/)?.[1] || "";
    return { index, id, overlap, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });
  });
  const visibleCard = cardStates.filter((state) => state.id && state.overlap > 2000 && state.width > 200 && state.height > 200)
    .sort((left, right) => right.overlap - left.overlap)[0];
  if (visibleCard) {
    let activeCardId = "";
    if (active) {
      activeCardId = await videos.nth(active.index).evaluate((element) => {
        let card = element;
        for (let depth = 0; depth < 12 && card; depth += 1, card = card.parentElement) {
          const match = String(card.className || "").match(/video_(\d+)/);
          if (match) return match[1];
        }
        return "";
      });
    }
    if (!active || activeCardId !== visibleCard.id) {
    const mediaState = await cards.nth(visibleCard.index).evaluate((card) => {
      const video = card.querySelector("video");
      return video
          ? { currentTime: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended, hasVideo: true }
          : { currentTime: 0, duration: null, paused: false, ended: false, hasVideo: false };
      });
      active = { index: -1, cardIndex: visibleCard.index, ...mediaState };
      activeCardIndex = visibleCard.index;
    }
  }
  if (!active) {
    // Douyin recommendation feeds can surface a visible photo/text card with
    // no in-card <video>. Treat the visible card container as the media
    // surface so it remains an observable `photo` sample, not an error.
    if (!visibleCard) return null;
    const mediaState = await cards.nth(visibleCard.index).evaluate((card) => {
      const video = card.querySelector("video");
      return video
        ? { currentTime: video.currentTime, duration: video.duration, paused: video.paused, ended: video.ended, hasVideo: true }
        : { currentTime: 0, duration: null, paused: false, ended: false, hasVideo: false };
    });
    active = { index: -1, cardIndex: visibleCard.index, ...mediaState };
    activeCardIndex = visibleCard.index;
  }
  const video = active.index >= 0 ? videos.nth(active.index) : null;
  const cardLocator = activeCardIndex !== null
    ? tab.playwright.locator('[class*="video_"]').nth(activeCardIndex)
    : video;
  const page = await cardLocator.evaluate((element) => {
    let card = element;
    for (let depth = 0; depth < 12 && card; depth += 1, card = card.parentElement) {
      if (String(card.className || "").match(/video_\d+/)) break;
    }
    if (!card) return null;
    const rect = card.getBoundingClientRect();
    const text = card.innerText || "";
    const links = [...card.querySelectorAll("a[href]")].map((anchor) => {
      const linkRect = anchor.getBoundingClientRect();
      return { href: anchor.getAttribute("href") || "", text: (anchor.innerText || anchor.textContent || "").trim(),
        x: linkRect.x, y: linkRect.y, width: linkRect.width, height: linkRect.height };
    });
    const controls = [...card.querySelectorAll("[data-e2e],button,[role=button]")].map((node) => ({
      dataE2e: node.getAttribute("data-e2e") || "", state: node.getAttribute("data-e2e-state") || "",
      text: (node.innerText || node.textContent || "").trim(), role: node.getAttribute("role") || "",
    }));
    return { className: String(card.className || ""), text, links, controls, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  if (!page) return null;
  const lines = page.text.split(/\n+/).map(cleanLine).filter(Boolean);
  const listenIndex = lines.indexOf("听抖音");
  const preListen = listenIndex >= 0 ? lines.slice(0, listenIndex) : [];
  const counts = preListen.filter((line) => /^[\d.]+(?:万|亿|千)?$/.test(line)).slice(0, 4).map(parseCount);
  const authorLink = page.links.find((link) => /\/user\//.test(link.href) && link.y >= page.y && link.y <= page.y + 260);
  let authorLine = lines.find((line) => /^@/.test(line));
  if (!authorLine && listenIndex >= 0) authorLine = lines.slice(listenIndex + 1).find((line) => line && !/^·/.test(line) && line !== "点击推荐");
  const author = cleanLine(authorLine).replace(/^@/, "");
  const { title, caption } = findTitleAndCaption(lines, authorLine);
  const hashtags = [...new Set(page.links.filter((link) => /^#/.test(link.text)).map((link) => link.text))];
  const fallbackHashtags = [...new Set((caption.match(/#[\w\u4e00-\u9fff.]+/g) || []))];
  const classMatch = page.className.match(/video_(\d+)/);
  const cardText = page.text;
  const contentType = /正在直播|直播中|直播间/.test(cardText) ? "live"
    : (/广告|推广/.test(cardText) ? "ad" : ((!active.hasVideo || /图文/.test(cardText)) ? "photo" : "video"));
  const followVisible = page.controls.some((control) => control.dataE2e === "feed-follow-icon");
  const alreadyFollowed = /已关注/.test(cardText);
  return {
    id: classMatch?.[1] || "",
    title,
    caption,
    text: cardText,
    author,
    authorHref: authorLink?.href || "",
    hashtags: hashtags.length ? hashtags : fallbackHashtags,
    duration: Number.isFinite(active.duration) ? active.duration : null,
    currentTime: Number.isFinite(active.currentTime) ? active.currentTime : 0,
    paused: active.paused,
    ended: active.ended,
    counts: { like: counts[0] ?? null, comment: counts[1] ?? null, favorite: counts[2] ?? null, share: counts[3] ?? null },
    contentType,
    followVisible,
    alreadyFollowed,
    className: page.className,
  };
}

async function readSafety(tab) {
  const url = await tab.url();
  const body = (await tab.playwright.locator("body").innerText({ timeoutMs: 5000 })).slice(0, 16000);
  const pageState = isStopText(body) ? "verification" : "ok";
  return { pageState, url, body, stopRequired: pageState !== "ok" };
}

async function resumeIfPaused(tab, card) {
  if (!card?.paused || !/继续播放/.test(card.text)) return false;
  const resume = tab.playwright.getByText("继续播放", { exact: true }).filter({ visible: true });
  const count = await resume.count();
  if (!count) return false;
  try {
    await resume.last().click({ timeoutMs: 10000 });
  } catch {
    // A prior session can leave an old card in Douyin's auto-pause overlay.
    // If it is irrelevant, preserving the observation and skipping is safe.
    return false;
  }
  await sleep(tab, 450);
  return true;
}

async function getControlState(tab, cardId, type) {
  const selector = type === "like" ? "[data-e2e=\"video-player-digg\"]" : "[data-e2e=\"video-player-collect\"]";
  const locator = tab.playwright.locator(`.video_${cardId} ${selector}`);
  if (!(await locator.count())) return { locator, exists: false, active: false };
  const state = await locator.getAttribute("data-e2e-state");
  const text = await locator.innerText();
  return { locator, exists: true, active: /is-digged|is-favorited|is-collect|liked|favorited|collected|selected|active/i.test(`${state} ${text}`), state, text };
}

async function clickPlannedActions(tab, card, decision) {
  const result = { like: { attempted: false, success: false }, favorite: { attempted: false, success: false } };
  for (const [type, planned] of [["like", decision.plannedActions.like], ["favorite", decision.plannedActions.favorite]]) {
    if (!planned) continue;
    const control = await getControlState(tab, card.id, type);
    if (!control.exists || control.active) {
      result[type] = { attempted: false, success: control.active };
      continue;
    }
    result[type] = { attempted: true, success: false };
    try {
      await control.locator.click({ timeoutMs: 5000 });
      await sleep(tab, 280);
      const after = await getControlState(tab, card.id, type);
      result[type].success = after.active;
    } catch (error) {
      result[type].error = `click_failed:${String(error?.message || error).slice(0, 160)}`;
    }
  }
  return result;
}

async function clickPlannedFollow(tab, card, decision) {
  const result = { attempted: false, success: false };
  if (!decision.followCandidate || card.alreadyFollowed) return result;
  const cardLocator = tab.playwright.locator(`.video_${card.id}`);
  // Douyin renders the red '+' as an overflowing child of the follow control;
  // the outer data-e2e node can have zero layout height even while the control
  // is visibly painted. Do not use the generic visible filter here; use the
  // control's presence and verify the post-click state instead.
  const follow = cardLocator.locator('[data-e2e="feed-follow-icon"]');
  if (!(await follow.count())) return result;
  result.attempted = true;
  try {
    const beforeMarkup = await follow.last().evaluate((element) => element.outerHTML).catch(() => "");
    const icon = follow.last().locator('span[role="img"]');
    const clickTarget = (await icon.count()) ? icon.first() : follow.last();
    await clickTarget.click({ timeoutMs: 5000 });
    await sleep(tab, 320);
    const refreshed = await getActiveCard(tab);
    const followState = await cardLocator.locator('[data-e2e="feed-follow-icon"]').getAttribute("data-e2e-state").catch(() => "");
    const afterMarkup = await follow.last().evaluate((element) => element.outerHTML).catch(() => "");
    const bodyText = await tab.playwright.locator("body").innerText({ timeoutMs: 5000 }).catch(() => "");
    result.success = Boolean(
      refreshed?.alreadyFollowed
      || /已关注|已跟随|following|followed/i.test(refreshed?.text || "")
      || /followed|following|selected|active/i.test(followState || "")
      || /关注成功|已关注|已跟随/i.test(bodyText)
      || (beforeMarkup && afterMarkup && beforeMarkup !== afterMarkup && !/\+/.test(afterMarkup)),
    );
    result.verification = { state: followState, markup_changed: beforeMarkup !== afterMarkup };
  } catch {
    result.success = false;
  }
  return result;
}

function profileTagSignals(text) {
  const source = String(text || "");
  const signals = [
    "科技", "数码", "3c", "手机", "电脑", "相机", "镜头", "芯片", "显卡", "gpu", "cpu",
    "人工智能", "大模型", "智能体", "机器人", "ai", "提示词", "鸿蒙", "安卓", "iphone",
  ];
  return [...new Set(signals.filter((signal) => source.toLowerCase().includes(signal.toLowerCase())))];
}

async function inspectAuthorProfile(tab, card) {
  const result = {
    attempted: true,
    sampled: true,
    profile_url: "",
    visible_labels: [],
    matched_keywords: [],
    tag_hit: false,
    page_state: "unknown",
    return_url: "",
    return_ok: false,
    stop_required: false,
    reason: "",
  };
  const feedUrl = await tab.url();
  if (!card.authorHref) {
    result.reason = "推荐流卡片没有可见作者主页链接";
    return result;
  }
  const profileUrl = new URL(card.authorHref, feedUrl).href;
  result.profile_url = profileUrl;
  try {
    await tab.goto(profileUrl);
    await sleep(tab, 850);
    const body = await tab.playwright.locator("body").innerText({ timeoutMs: 5000 });
    result.page_state = isStopText(body) ? "verification" : "ok";
    result.visible_labels = profileTagSignals(body);
    result.matched_keywords = result.visible_labels;
    result.tag_hit = result.visible_labels.length > 0;
    result.reason = result.tag_hit ? "公开主页可见昵称/简介/标签命中画像信号" : "公开主页可见文本未命中画像信号";
    result.stop_required = result.page_state !== "ok";
  } catch (error) {
    result.reason = `主页抽样读取失败：${String(error?.message || error).slice(0, 160)}`;
    result.stop_required = true;
  } finally {
    try {
      await tab.back();
      await sleep(tab, 900);
      result.return_url = await tab.url();
      let returnedCard = await getActiveCard(tab);
      const returnedToRecommendation = String(result.return_url || "").includes("douyin.com")
        && !/\/user\//.test(String(result.return_url || ""))
        && String(result.return_url || "").includes("recommend");
      if (!returnedToRecommendation || !returnedCard?.id) {
        // Douyin can resolve browser history to the精选 landing route after a
        // profile visit. Re-open the original recommendation URL once and
        // require a fresh visible card before resuming the feed.
        await tab.goto(feedUrl);
        await sleep(tab, 1000);
        if (!String(await tab.url()).includes("recommend")) {
          // The visible navigation href is used directly because a background
          // tab can report a zero viewport and reject an otherwise valid click.
          await tab.goto("https://www.douyin.com/?recommend=1&from_nav=1");
          await sleep(tab, 1600);
        }
        result.return_url = await tab.url();
        returnedCard = await getActiveCard(tab);
      }
      for (let attempt = 0; attempt < 4 && !returnedCard?.id; attempt += 1) {
        await sleep(tab, 1000);
        returnedCard = await getActiveCard(tab);
      }
      result.returned_card_id = returnedCard?.id || "";
      result.return_ok = Boolean(
        result.return_url && String(result.return_url).includes("recommend") && returnedCard?.id,
      );
      if (!result.return_ok) result.stop_required = true;
    } catch (error) {
      result.return_ok = false;
      result.stop_required = true;
      result.reason = `${result.reason || "主页抽样完成"}；返回推荐流失败：${String(error?.message || error).slice(0, 120)}`;
    }
  }
  return result;
}

async function waitToEnd(tab, cardId, maxWaitMs = 195000) {
  const started = Date.now();
  let last = { currentTime: 0, duration: null, ended: false };
  while (Date.now() - started < maxWaitMs) {
    const locator = tab.playwright.locator(`.video_${cardId} video`).filter({ visible: true });
    if (!(await locator.count())) break;
    const states = await locator.evaluateAll((elements) => elements.map((video) => {
      const rect = video.getBoundingClientRect();
      const overlap = Math.max(0, Math.min(innerHeight, rect.bottom) - Math.max(0, rect.top))
        * Math.max(0, Math.min(innerWidth, rect.right) - Math.max(0, rect.left));
      return { overlap, currentTime: video.currentTime, duration: video.duration, ended: video.ended, paused: video.paused };
    }));
    last = states.sort((left, right) => right.overlap - left.overlap)[0] || last;
    if (last.ended || (Number.isFinite(last.duration) && last.duration > 0 && last.currentTime >= last.duration - 0.45)) {
      return { actual: true, verification: "player_reached_end", max_position_seconds: last.currentTime, duration_seconds: last.duration };
    }
    if (last.paused && last.currentTime < (last.duration || Infinity) - 1) {
      return { actual: false, verification: "player_paused_before_end", max_position_seconds: last.currentTime, duration_seconds: last.duration };
    }
    await sleep(tab, 4500);
  }
  return { actual: false, verification: "completion_timeout_or_unreliable", max_position_seconds: last.currentTime, duration_seconds: last.duration };
}

async function chooseNotInterested(tab, card) {
  const result = { attempted: false, success: false };
  const video = tab.playwright.locator(`.video_${card.id} video`);
  if (!(await video.count())) return result;
  result.attempted = true;
  try {
    await video.click({ button: "right", timeoutMs: 5000 });
    await sleep(tab, 250);
    const menu = tab.playwright.getByText("不感兴趣", { exact: true }).filter({ visible: true });
    if (await menu.count()) {
      await menu.last().click({ timeoutMs: 5000 });
      await sleep(tab, 350);
      result.success = true;
    }
  } catch {
    result.success = false;
  }
  return result;
}

async function moveNext(tab, currentId) {
  await tab.cua.keypress({ keys: ["ARROWDOWN"] });
  await sleep(tab, 850);
  let next = await getActiveCard(tab);
  // At natural video end Douyin can settle the next card slightly after the
  // first keypress acknowledgement. Recheck once before declaring a stop.
  if (next?.id === currentId) {
    await sleep(tab, 1500);
    next = await getActiveCard(tab);
  }
  if (next?.id === currentId) {
    await tab.cua.keypress({ keys: ["ARROWDOWN"] });
    await sleep(tab, 1100);
    next = await getActiveCard(tab);
  }
  // The slider can finish moving just after the second acknowledgement. Give
  // the visible card one final settle window before recording a transition
  // failure; this avoids treating a real move as a false stop.
  if (next?.id === currentId) {
    await sleep(tab, 1600);
    next = await getActiveCard(tab);
  }
  if (!next?.id) {
    // Background tabs can leave the feed slider translated outside the
    // visible area after a key transition. Recover through the visible
    // recommendation route once, then require a fresh readable card.
    const safety = await readSafety(tab);
    if (safety.stopRequired) return { next: null, transitionOk: false, recovered: false };
    await tab.goto("https://www.douyin.com/?recommend=1&from_nav=1");
    await sleep(tab, 1800);
    for (let attempt = 0; attempt < 4 && !next?.id; attempt += 1) {
      next = await getActiveCard(tab);
      if (!next?.id) await sleep(tab, 900);
    }
    return { next, transitionOk: Boolean(next && next.id && next.id !== currentId), recovered: Boolean(next?.id) };
  }
  return { next, transitionOk: Boolean(next && next.id && next.id !== currentId), recovered: false };
}

function relevanceText(classification) {
  return classification.high ? "high" : (classification.relevant ? "medium" : "none");
}

function classifyReason(classification, card) {
  if (card.contentType === "live") return "直播内容快速跳过";
  if (card.contentType === "ad") return "广告/推广内容快速跳过";
  if (classification.high) return "命中高相关科技/3C/AI信号";
  if (classification.relevant) return "命中一般相关信号";
  return "未命中科技/3C/AI或命中排除项";
}

function commentTextFor(card) {
  const source = `${card.title} ${card.caption}`;
  if (/comfyui|本地部署|工作流/i.test(source)) return "对低显存用户很实用，环境依赖的顺序讲得比较清楚。";
  if (/手机|iphone|华为|小米|荣耀|oppo|vivo|一加|折叠屏/i.test(source)) return "这个点很有参考价值，实际体验和参数放在一起看更清楚。";
  if (/相机|镜头|影像|摄影|长焦|富士|索尼|佳能|尼康/i.test(source)) return "这个细节对实际拍摄很有帮助，画面和使用场景结合得不错。";
  if (/ai|大模型|智能体|agent|提示词|模型/i.test(source)) return "把使用场景讲清楚了，比只看功能列表更容易判断是否适合自己。";
  return "这个角度挺有启发，关键点讲得比较清楚。";
}

async function openAndPostComment(tab, card, commentText) {
  const result = {
    planned: true,
    attempted: false,
    panel_opened: false,
    input_visible: false,
    submit_attempted: false,
    success: false,
    error: "",
  };
  const cardLocator = tab.playwright.locator(`.video_${card.id}`);
  const buttonSelectors = [
    '[data-e2e="feed-comment-icon"]',
    '[data-e2e="video-player-comment"]',
    '[data-e2e="video-comment-icon"]',
    'button[aria-label*="评论"]',
    '[role="button"][aria-label*="评论"]',
  ];
  let button = null;
  for (const selector of buttonSelectors) {
    const candidate = cardLocator.locator(selector).filter({ visible: true });
    if (await candidate.count()) {
      button = candidate.last();
      break;
    }
  }
  if (!button) {
    result.error = "comment_button_not_visible";
    return result;
  }
  result.attempted = true;
  try {
    await button.click({ timeoutMs: 5000 });
    await sleep(tab, 500);
    result.panel_opened = true;
  } catch (error) {
    result.error = `comment_button_click_failed:${String(error?.message || error).slice(0, 160)}`;
    return result;
  }

  const inputCandidates = [
    tab.playwright.getByPlaceholder("留下你的精彩评论吧", { exact: true }).filter({ visible: true }),
    tab.playwright.locator('textarea').filter({ visible: true }),
    tab.playwright.locator('[contenteditable="true"]').filter({ visible: true }),
  ];
  let input = null;
  for (const candidate of inputCandidates) {
    if (await candidate.count()) {
      input = candidate.last();
      break;
    }
  }
  if (!input) {
    result.error = "comment_input_not_visible";
    return result;
  }
  result.input_visible = true;
  try {
    await input.fill(commentText, { timeoutMs: 5000 });
    const publish = tab.playwright.getByText("发布", { exact: true }).filter({ visible: true });
    if (await publish.count()) {
      await publish.last().click({ timeoutMs: 5000 });
    } else {
      await input.press("Enter", { timeoutMs: 5000 });
    }
    result.submit_attempted = true;
    await sleep(tab, 650);
    const body = await tab.playwright.locator("body").innerText({ timeoutMs: 5000 }).catch(() => "");
    const value = await input.getAttribute("value").catch(() => null);
    const textContent = await input.textContent({ timeoutMs: 3000 }).catch(() => "");
    result.success = body.includes(commentText) || (value === "" && textContent === "");
    if (!result.success) result.error = "comment_post_unverified";
  } catch (error) {
    result.error = `comment_submit_failed:${String(error?.message || error).slice(0, 160)}`;
  }
  return result;
}

async function loadOrCreateTest5QuotaPolicy(quotaPath, sessionId, options = {}) {
  const completionRate = Number(options.completionRate ?? 0.15);
  const completionBlockSize = Number(options.completionBlockSize ?? 20);
  const followRate = Number(options.followRate ?? 0.05);
  const followBlockSize = Number(options.followBlockSize ?? 20);
  const commentRate = Number(options.commentRate ?? 0);
  const commentBlockSize = Number(options.commentBlockSize ?? 50);
  const minimumRepeatHighCreatorCount = Number(options.minimumRepeatHighCreatorCount ?? 2);
  const enforceConfig = options.enforceConfig === true;
  try {
    const policy = await loadDouyinQuotaPolicy(quotaPath);
    const savedSeed = String(policy.config?.seed || "");
    if (savedSeed && savedSeed !== String(sessionId)) {
      throw new Error(`配额状态种子${savedSeed}与当前会话${sessionId}不一致；请为新会话使用新的quota_policy_state.json。`);
    }
    if (enforceConfig) {
      const savedCompletionRate = Number(policy.config?.completion?.rates?.complete);
      const savedFollowRate = Number(policy.config?.follow?.rates?.candidate);
      const savedCommentRate = Number(policy.config?.comment?.rates?.comment ?? policy.config?.commentRate ?? 0);
      const savedMinimumRepeat = Number(policy.config?.minimumRepeatHighCreatorCount ?? 2);
      if (
        savedCompletionRate !== completionRate
        || savedFollowRate !== followRate
        || savedCommentRate !== commentRate
        || savedMinimumRepeat !== minimumRepeatHighCreatorCount
      ) {
        throw new Error(`配额状态与当前测试配置不一致：完播${savedCompletionRate}、关注${savedFollowRate}、评论${savedCommentRate}、创作者门槛${savedMinimumRepeat}；期望完播${completionRate}、关注${followRate}、评论${commentRate}、创作者门槛${minimumRepeatHighCreatorCount}。请使用新的quota_policy_state.json。`);
      }
    }
    return policy;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // A fresh session can override the generic policy. Existing state is loaded
    // unchanged for resumability, so a resumed session never silently changes
    // its experimental denominator or rates.
    const policy = createDouyinQuotaPolicy({
      config: {
        seed: String(sessionId),
        completion: {
          blockSize: completionBlockSize,
          rates: { complete: completionRate, not_complete: 1 - completionRate },
        },
        follow: {
          blockSize: followBlockSize,
          rates: { candidate: followRate, not_candidate: 1 - followRate },
        },
        comment: {
          blockSize: commentBlockSize,
          rates: { comment: commentRate, not_comment: 1 - commentRate },
        },
        commentRate,
        minimumRepeatHighCreatorCount,
      },
    });
    await policy.saveState(quotaPath);
    return policy;
  }
}

export async function createTest5Runner({
  tab,
  sessionId,
  outputDir,
  quotaPath,
  queuePath,
  followRate = 0.05,
  followBlockSize = 20,
  executeFollow = false,
  profileSampleRate = 0,
  commentRate = 0,
  commentBlockSize = 50,
  executeComments = false,
  commentLimit = 3,
  minimumRepeatHighCreatorCount = 2,
  enforceQuotaConfig = false,
}) {
  const policy = await loadOrCreateTest5QuotaPolicy(quotaPath, sessionId, {
    completionRate: 0.15,
    completionBlockSize: 20,
    followRate,
    followBlockSize,
    commentRate,
    commentBlockSize,
    minimumRepeatHighCreatorCount,
    enforceConfig: enforceQuotaConfig,
  });
  const rng = makeRng(sessionId);
  const comments = { count: 0 };
  const creatorCounts = new Map();
  const state = {
    tab,
    sessionId,
    outputDir,
    quotaPath,
    queuePath,
    policy,
    rng,
    comments,
    creatorCounts,
    executeFollow: Boolean(executeFollow),
    executeComments: Boolean(executeComments),
    commentLimit: Math.max(0, Number(commentLimit) || 0),
    profileSampleRate: Math.max(0, Math.min(1, Number(profileSampleRate) || 0)),
    profileCheckedAuthors: new Set(),
    profileSampledAuthors: new Set(),
    queueCommitted: false,
  };
  await fs.mkdir(outputDir, { recursive: true });

  async function processOneOnce(feedIndex) {
    state.queueCommitted = false;
    const before = await readSafety(tab);
    const card = await getActiveCard(tab);
    if (before.stopRequired || !card || !card.id) {
      return { feed_index: feedIndex, stop: true, stop_reason: before.pageState === "ok" ? "无法可靠识别当前推荐卡片" : before.pageState };
    }
    await resumeIfPaused(tab, card);
    const refreshed = await getActiveCard(tab);
    const effectiveCard = refreshed || card;
    const raw = {
      title: effectiveCard.title,
      caption: effectiveCard.caption,
      text: effectiveCard.text,
      author: effectiveCard.author,
      live: effectiveCard.contentType === "live",
    };
    const classification = classifyRecommendation(raw);
    const forceSkip = effectiveCard.contentType === "live" || effectiveCard.contentType === "ad";
    const observedRelevant = classification.relevant && !forceSkip;
    const authorKey = effectiveCard.author || "";
    const repeatHighCreatorCount = creatorCounts.get(authorKey) || 0;
    if (classification.high && authorKey) creatorCounts.set(authorKey, repeatHighCreatorCount + 1);
    const decision = state.policy.decide({
      awemeId: effectiveCard.id,
      relevance: forceSkip ? "none" : relevanceText(classification),
      contentType: effectiveCard.contentType,
      durationSeconds: effectiveCard.duration,
      author: effectiveCard.author,
      repeatHighCreatorCount,
      feedFollowVisible: effectiveCard.followVisible,
      alreadyFollowed: effectiveCard.alreadyFollowed,
      pageState: before.pageState,
    });
    if (decision.stopRequired) return { feed_index: feedIndex, stop: true, stop_reason: decision.stopReason };

    const userActionResult = observedRelevant
      ? await clickPlannedActions(tab, effectiveCard, decision)
      : { like: { attempted: false, success: false }, favorite: { attempted: false, success: false } };
    userActionResult.follow = observedRelevant && state.executeFollow
      ? await clickPlannedFollow(tab, effectiveCard, decision)
      : { attempted: false, success: false };
    const completion = { planned: Boolean(decision.plannedActions.watchToEnd), actual: false, verification: "未分配完播" };
    let action = "watch_then_next";
    let dwellSeconds;
    let notInterested = null;
    let userCommented = false;
    let userCommentText = "";

    if (observedRelevant && decision.plannedActions.watchToEnd && effectiveCard.duration <= 180) {
      action = "watch_to_end_then_next";
      const verified = await waitToEnd(tab, effectiveCard.id);
      completion.actual = verified.actual;
      completion.verification = verified.verification;
      completion.max_position_seconds = verified.max_position_seconds;
      completion.duration_seconds = verified.duration_seconds;
      dwellSeconds = Number(verified.max_position_seconds || effectiveCard.currentTime || 0);
    } else if (observedRelevant) {
      const sampled = chooseDwellSeconds(raw, classification, rng);
      dwellSeconds = Number(sampled.toFixed(3));
      await sleep(tab, Math.max(350, Math.round(dwellSeconds * 1000)));
    } else {
      const liveOrAd = effectiveCard.contentType === "live" || effectiveCard.contentType === "ad";
      const sampled = liveOrAd ? sampleTruncatedNormal(0.65, 0.12, 0.4, 0.9, rng) : sampleTruncatedNormal(0.9, 0.45, 0.35, 2.2, rng);
      dwellSeconds = Number(sampled.toFixed(3));
      if (liveOrAd || rng() < 0.68) {
        notInterested = liveOrAd ? null : await chooseNotInterested(tab, effectiveCard);
        action = notInterested?.success ? "not_interested" : "direct_skip";
      } else {
        action = "direct_skip";
      }
    }

    let commentResult = {
      planned: Boolean(decision.commentCandidate),
      attempted: false,
      panel_opened: false,
      input_visible: false,
      submit_attempted: false,
      success: false,
      error: decision.commentCandidate ? "评论名额已分配，等待页面入口执行" : "本条未分配评论名额",
    };
    if (
      observedRelevant
      && classification.high
      && state.executeComments
      && decision.commentCandidate
      && state.comments.count < state.commentLimit
    ) {
      userCommentText = commentTextFor(effectiveCard);
      commentResult = await openAndPostComment(tab, effectiveCard, userCommentText);
      userCommented = Boolean(commentResult.success);
      if (userCommented) state.comments.count += 1;
    }

    let profileCheck = {
      enabled: state.profileSampleRate > 0,
      sampled: false,
      attempted: false,
      reason: state.profileSampleRate > 0 ? "本条未抽中主页核验" : "未启用主页抽样",
    };
    if (
      observedRelevant
      && classification.high
      && authorKey
      && effectiveCard.authorHref
      && state.profileSampleRate > 0
      && !state.profileCheckedAuthors.has(authorKey)
    ) {
      state.profileCheckedAuthors.add(authorKey);
      if (rng() < state.profileSampleRate) {
        state.profileSampledAuthors.add(authorKey);
        profileCheck = await inspectAuthorProfile(tab, effectiveCard);
      }
    }

    const beforePosition = await tab.playwright.locator(`.video_${effectiveCard.id} video`).evaluate((video) => ({ currentTime: video.currentTime, duration: video.duration, paused: video.paused })).catch(() => ({ currentTime: effectiveCard.currentTime, duration: effectiveCard.duration, paused: false }));
    const transitionBaseId = profileCheck.returned_card_id || effectiveCard.id;
    const transition = profileCheck.stop_required
      ? { next: null, transitionOk: false }
      : await moveNext(tab, transitionBaseId);
    const afterUrl = await tab.url();
    const feedback = {
      content_type: effectiveCard.contentType,
      page_state: before.pageState,
      no_profile_navigation: true,
      classification_reason: classifyReason(classification, effectiveCard),
      relevance_level: forceSkip ? "none" : relevanceText(classification),
      interaction_mode: "quota_randomized",
      interaction_attempted: userActionResult.like.attempted || userActionResult.favorite.attempted || userActionResult.follow.attempted || commentResult.attempted || userCommented,
      interactions_while_playing: true,
      skip_without_pause: !observedRelevant,
      not_interested: notInterested,
      completion,
      quota_decision: decision,
      creator_repeat_high_count: repeatHighCreatorCount,
      feed_follow_visible: effectiveCard.followVisible,
      follow_candidate: Boolean(decision.followCandidate),
      follow_executed: Boolean(userActionResult.follow.success),
      comment_candidate: Boolean(decision.commentCandidate),
      comment_executed: Boolean(userCommented),
      comment: commentResult,
      profile_check: profileCheck,
      visible_fields_only: true,
      stop_required: Boolean(profileCheck.stop_required || !transition.transitionOk),
      stop_reason: profileCheck.stop_required ? (profileCheck.reason || "主页抽样后未能可靠返回") : (transition.transitionOk ? "" : "推荐流切换未可靠确认"),
      page_transition: { before_aweme_id: effectiveCard.id, after_aweme_id: transition.next?.id || "", success: transition.transitionOk },
    };
    const observation = {
      observed_at: toIso(),
      feed_index: feedIndex,
      is_relevant: Boolean(observedRelevant),
      decision: observedRelevant ? "keep" : "skip",
      action,
      dwell_seconds: dwellSeconds,
      interest_score: classification.high ? 9 : (classification.relevant ? 6 : 1),
      title: effectiveCard.title,
      caption: effectiveCard.caption,
      author: effectiveCard.author,
      author_href: effectiveCard.authorHref,
      aweme_id: effectiveCard.id,
      hashtags: effectiveCard.hashtags,
      matched_keywords: classification.matched,
      duration_seconds: effectiveCard.duration,
      current_position_seconds: beforePosition.currentTime,
      like_count: effectiveCard.counts.like,
      comment_count: effectiveCard.counts.comment,
      share_count: effectiveCard.counts.share,
      favorite_count: effectiveCard.counts.favorite,
      before_url: before.url,
      after_url: afterUrl,
      scroll_delta: 1,
      transition_ok: transition.transitionOk,
      user_liked: Boolean(userActionResult.like.success),
      user_favorited: Boolean(userActionResult.favorite.success),
      user_followed: Boolean(userActionResult.follow.success),
      comment_candidate: Boolean(decision.commentCandidate),
      comment_open_attempted: Boolean(commentResult.attempted),
      comment_input_visible: Boolean(commentResult.input_visible),
      comment_submit_attempted: Boolean(commentResult.submit_attempted),
      comment_post_success: Boolean(commentResult.success),
      profile_check_attempted: profileCheck.attempted === true ? 1 : null,
      profile_tag_hit: profileCheck.attempted === true && "tag_hit" in profileCheck ? (profileCheck.tag_hit ? 1 : 0) : null,
      profile_visible_labels: profileCheck.visible_labels || [],
      profile_check_url: profileCheck.profile_url || "",
      profile_return_ok: profileCheck.attempted === true && "return_ok" in profileCheck ? (profileCheck.return_ok ? 1 : 0) : null,
      user_commented: userCommented,
      user_comment_text: userCommentText,
      user_action_reason: observedRelevant ? "按相关性进入正向反馈配额池。" : "非相关或直播/广告内容快速跳过。",
      user_action_result: userActionResult,
      rpa_feedback: feedback,
    };
    await fs.appendFile(queuePath, `${JSON.stringify(observation)}\n`, "utf8");
    state.queueCommitted = true;
    // Commit policy state only after the observation is durable. If the RPA
    // process is interrupted before the queue append, the in-memory allocation
    // disappears with the process and cannot consume a future quota slot.
    await state.policy.saveState(quotaPath);
    return { ...observation, next_id: transition.next?.id || "", stop: Boolean(profileCheck.stop_required || !transition.transitionOk) };
  }

  async function processOne(feedIndex) {
    const policyCheckpoint = state.policy.snapshot();
    const creatorCheckpoint = new Map(state.creatorCounts);
    const profileCheckedCheckpoint = new Set(state.profileCheckedAuthors);
    const profileSampledCheckpoint = new Set(state.profileSampledAuthors);
    try {
      return await processOneOnce(feedIndex);
    } catch (error) {
      if (!state.queueCommitted) {
        state.policy = createDouyinQuotaPolicy({ snapshot: policyCheckpoint });
        state.creatorCounts.clear();
        for (const [author, count] of creatorCheckpoint) state.creatorCounts.set(author, count);
        state.profileCheckedAuthors = profileCheckedCheckpoint;
        state.profileSampledAuthors = profileSampledCheckpoint;
      }
      throw error;
    }
  }

  async function completeCurrent(cardId) {
    return waitToEnd(tab, cardId);
  }

  return { processOne, completeCurrent, getActiveCard: () => getActiveCard(tab), state };
}

export async function createTest6Runner(args) {
  return createTest5Runner({
    ...args,
    followRate: 0.10,
    followBlockSize: 10,
    executeFollow: true,
    profileSampleRate: 0.10,
    enforceQuotaConfig: true,
  });
}

export async function createTest7Runner(args) {
  return createTest5Runner({
    ...args,
    followRate: 0.10,
    followBlockSize: 10,
    executeFollow: true,
    profileSampleRate: 0.10,
    commentRate: 0.02,
    commentBlockSize: 50,
    executeComments: true,
    commentLimit: 5,
    minimumRepeatHighCreatorCount: 0,
    enforceQuotaConfig: true,
  });
}
