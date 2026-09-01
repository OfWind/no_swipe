import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const FACTS_URL = new URL(
  "../../skills/douyin-recommendation-rpa/scripts/douyin_page_facts.js",
  import.meta.url,
);

class FakeElement {
  constructor({ rect, className = "", attrs = {}, one = {}, many = {} }) {
    this.rect = rect;
    this.className = className;
    this.attrs = attrs;
    this.one = one;
    this.many = many;
    this.innerText = "";
    this.textContent = "";
    this.src = attrs.src || "";
    this.currentSrc = attrs.currentSrc || this.src;
    this.parentElement = null;
  }

  getBoundingClientRect() {
    return this.rect;
  }

  getAttribute(name) {
    return this.attrs[name] ?? null;
  }

  querySelector(selector) {
    return this.one[selector] ?? null;
  }

  querySelectorAll(selector) {
    if (this.many[selector]) return this.many[selector];
    return this.one[selector] ? [this.one[selector]] : [];
  }

  closest() {
    return null;
  }
}

test("offscreen sibling slides do not claim the current viewport can switch next", async () => {
  const video = new FakeElement({ rect: { left: 0, top: 0, right: 800, bottom: 700, width: 800, height: 700 } });
  video.duration = 120;
  video.currentTime = 10;
  video.paused = false;
  const active = new FakeElement({
    rect: { left: 0, top: 0, right: 800, bottom: 700, width: 800, height: 700 },
    className: "sliderVideo video_1",
    one: { video },
    many: { 'a[href*="/user/"]': [] },
  });
  const offscreen = new FakeElement({
    rect: { left: 1600, top: 0, right: 2400, bottom: 700, width: 800, height: 700 },
    className: "sliderVideo video_2",
  });
  const document = {
    body: { innerText: "" },
    querySelector(selector) {
      return selector === '[data-e2e="feed-active-video"]' ? active : null;
    },
    querySelectorAll(selector) {
      if (selector === '.sliderVideo, [class*="sliderVideo"], [class*="relatedUiAdapter"]') return [active, offscreen];
      if (selector === '.sliderVideo, [class*="sliderVideo"]') return [active, offscreen];
      if (selector === "video") return [video];
      return [];
    },
  };
  const source = await fs.readFile(FACTS_URL, "utf8");
  const facts = vm.runInNewContext(`(${source})()`, {
    document,
    location: { href: "https://www.douyin.com/?recommend=1", pathname: "/" },
    window: { innerWidth: 1280, innerHeight: 720 },
  });

  assert.equal(facts.surface, "active_video");
  assert.equal(facts.aweme_id, "1");
  assert.equal(facts.content_type, "video");
  assert.equal(facts.gallery_image_count, 0);
  assert.equal(facts.viewport.width, 1280);
  assert.equal(facts.viewport.height, 720);
  assert.equal(facts.can_switch_next, false);
});

test("active gallery cards are classified as image_text without inventing a video duration", async () => {
  const image = new FakeElement({
    rect: { left: 120, top: 40, right: 920, bottom: 700, width: 800, height: 660 },
    attrs: {
      src: "https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/~tplv-dy-aweme-images:q75.webp?x-signature=test",
    },
  });
  const duplicateImage = new FakeElement({
    rect: { left: 120, top: 40, right: 920, bottom: 700, width: 800, height: 660 },
    attrs: {
      src: "https://p3-pc-sign.douyinpic.com/tos-cn-i-0813/~tplv-dy-aweme-images:q75.webp?x-signature=other",
    },
  });
  const active = new FakeElement({
    rect: { left: 0, top: 0, right: 1000, bottom: 720, width: 1000, height: 720 },
    className: "sliderVideo video_3",
    many: {
      img: [image, duplicateImage],
      'a[href*="/user/"]': [],
    },
  });
  const document = {
    body: { innerText: "" },
    querySelector(selector) {
      return selector === '[data-e2e="feed-active-video"]' ? active : null;
    },
    querySelectorAll(selector) {
      if (selector === '.sliderVideo, [class*="sliderVideo"], [class*="relatedUiAdapter"]') return [active];
      if (selector === '.sliderVideo, [class*="sliderVideo"]') return [active];
      return [];
    },
  };
  const source = await fs.readFile(FACTS_URL, "utf8");
  const facts = vm.runInNewContext(`(${source})()`, {
    document,
    location: { href: "https://www.douyin.com/?recommend=1", pathname: "/" },
    window: { innerWidth: 1280, innerHeight: 720 },
  });

  assert.equal(facts.surface, "active_video");
  assert.equal(facts.aweme_id, "3");
  assert.equal(facts.content_type, "image_text");
  assert.equal(facts.gallery_image_count, 1);
  assert.equal(facts.duration_seconds, null);
  assert.equal(facts.current_position_seconds, null);
});

test("a visible video wins over an earlier hidden video while the slide is still mounting", async () => {
  const hiddenVideo = new FakeElement({
    rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
  });
  hiddenVideo.duration = Number.NaN;
  hiddenVideo.currentTime = 0;
  hiddenVideo.paused = true;
  const visibleVideo = new FakeElement({
    rect: { left: 100, top: 40, right: 1100, bottom: 700, width: 1000, height: 660 },
  });
  visibleVideo.duration = 76;
  visibleVideo.currentTime = 12;
  visibleVideo.paused = false;
  const active = new FakeElement({
    rect: { left: 0, top: 0, right: 1200, bottom: 720, width: 1200, height: 720 },
    className: "sliderVideo video_4",
    one: { video: hiddenVideo },
    many: {
      video: [hiddenVideo, visibleVideo],
      'a[href*="/user/"]': [],
    },
  });
  const document = {
    body: { innerText: "" },
    querySelector(selector) {
      return selector === '[data-e2e="feed-active-video"]' ? active : null;
    },
    querySelectorAll(selector) {
      if (selector === '.sliderVideo, [class*="sliderVideo"], [class*="relatedUiAdapter"]') return [active];
      if (selector === '.sliderVideo, [class*="sliderVideo"]') return [active];
      if (selector === "video") return [hiddenVideo, visibleVideo];
      return [];
    },
  };
  const source = await fs.readFile(FACTS_URL, "utf8");
  const facts = vm.runInNewContext(`(${source})()`, {
    document,
    location: { href: "https://www.douyin.com/?recommend=1", pathname: "/" },
    window: { innerWidth: 1280, innerHeight: 720 },
  });

  assert.equal(facts.content_type, "video");
  assert.equal(facts.duration_seconds, 76);
  assert.equal(facts.current_position_seconds, 12);
  assert.equal(facts.paused, false);
});
