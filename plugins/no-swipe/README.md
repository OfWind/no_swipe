# No Swipe

No Swipe 是一个面向抖音推荐流测试的本地 Codex 插件，内置 `douyin-recommendation-rpa` skill。

每个抖音账号维护一个可版本化画像；后续任务自动复用该画像，只重新确认本轮目标、互动比例、授权与上限。插件不内置 3C、科技、AI 或任何其他主题画像。

运行配置使用 JSON Schema 和语义校验，确认后生成 `config_hash`。浏览器 runner 只接受已确认配置，固定页面文案、选择器、停留参数与停止信号放在 `config/`，账号画像、业务目标、权限和秘密不进入产品默认配置。

## 本地验证

```bash
npm test
npm run check
node runtime/src/cli.mjs profile validate tests/fixtures/account-profile.example.json
node runtime/src/cli.mjs run validate tests/fixtures/run-config.draft.example.json
```

## 安全边界

- 仅使用用户已打开且已登录的推荐流页面。
- 不绕过验证码、限流、登录或访问限制。
- 点赞、收藏、评论、关注、不感兴趣和主页访问都必须在本轮配置中明确授权；正比例动作还必须有相应上限。
- 默认不进入作者主页；只有用户明确要求抽样时，才查看公开简介或标签并立即返回推荐流。
- 计划、尝试、验证和实际成功结果分开记录，不用配额计划冒充真实结果。

## 图标

`assets/no-swipe.svg` 为 64×64 的轻量 SVG，可同时用作插件 logo 和 composer icon。
