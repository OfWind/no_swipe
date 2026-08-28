import assert from "node:assert/strict";
import {
  normalizeAuthorName,
  selectAuthorProfileHref,
} from "./douyin_rpa_browser_rules.mjs";

assert.equal(normalizeAuthorName("@懒猫徒手健身"), "懒猫徒手健身");
assert.equal(normalizeAuthorName("@@@熊曼玉"), "熊曼玉");
assert.equal(normalizeAuthorName("  地球  饲养员  "), "地球 饲养员");
assert.equal(normalizeAuthorName(""), "");

const matched = selectAuthorProfileHref(
  [
    { href: "/hashtag/food", text: "#美食" },
    { href: "/user/MS4wLjABAAAAxiongmanyu", text: "@熊曼玉" },
    { href: "/user/MS4wLjABAAAAlancat", text: "@懒猫徒手健身" },
  ],
  "熊曼玉",
);
assert.equal(matched, "/user/MS4wLjABAAAAxiongmanyu");

assert.equal(
  selectAuthorProfileHref(
    [
      { href: "/user/MS4wLjABAAAAwrong", text: "@地球饲养员" },
      { href: "/user/MS4wLjABAAAAalso", text: "@美速游戏" },
    ],
    "@懒猫徒手健身",
  ),
  "",
);

assert.equal(
  selectAuthorProfileHref(
    [{ href: "/user/MS4wLjABAAAAfirst", text: "@别人" }],
    "",
  ),
  "",
);
