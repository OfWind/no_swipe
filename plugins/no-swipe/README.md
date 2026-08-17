# No Swipe

No Swipe 是一个面向抖音推荐流测试的本地 Codex 插件，内置 `douyin-recommendation-rpa` skill。

一个邮箱登录的 No Swipe 用户可以绑定多个抖音账号；每个抖音账号在 `.no-swipe/accounts/` 下维护独立、可版本化的画像，切换账号只选择对应画像，不替换其他账号文件。后续任务自动复用当前可见抖音账号的画像。首次建档时只展示一张自然语言预设卡，用一句普通对话等待用户确认或输入修改要求，不再填写逐字段表单。

青年白领预设会把时长 60 秒及以下的视频放入立即处理通道：授权、配额和页面状态允许时点“不感兴趣”，否则立即划走；这类视频不进入观看、主页核验或正向互动池。

运行配置使用 JSON Schema 和语义校验，收到用户确认后生成 `config_hash` 并创建一个持续 Goal。预设、页面文案、选择器、停留参数与停止信号都放在 `config/`；秘密不进入配置。默认权限全部开启，但必须收到明确确认，且动作仍受实际比例和总上限控制。

## 本地验证

```bash
npm test
npm run check
node runtime/src/cli.mjs profile validate tests/fixtures/account-profile.example.json
node runtime/src/cli.mjs profile list
node runtime/src/cli.mjs run validate tests/fixtures/run-config.draft.example.json
```

## 云端同步

插件把每条观察与上传 outbox 在同一 SQLite 事务提交。安装插件时，Codex 会尽量打开 No Swipe OAuth 页面；每次开始或恢复任务时，skill 还会在任何浏览器动作前调用 `get_upload_status`。未连接时该调用触发 OAuth，用户可用任意能接收验证码的邮箱登录并同意上传；已连接时无感继续。

ChatGPT 订阅登录和 OpenAI API Key 只负责模型访问，不等于 No Swipe 授权。仅使用 API Key 的 Codex CLI 如果没有自动出现登录页，No Swipe skill 会自行调用 `codex mcp login no-swipe`；用户无需输入命令，只需在浏览器完成邮箱验证和授权。授权会被安全复用；卸载插件不会必然撤销服务授权。

`start`、`record`、`finish` 会返回一个 `mcp_upload` 批次。Codex 使用安装连接的 OAuth token 调用 `ingest_observation_batch`，再把 `accepted`、`duplicated` 和 `rejected` 回写本地 outbox。断网不影响采集，恢复后由 `mcp-next` 继续补传；只有 `accepted` 或 `duplicated` 会标记为已发送。OAuth token 由 Codex 管理，不写入插件目录、SQLite 或导出文件。

## 安全边界

- 仅使用用户已打开且已登录的推荐流页面。
- 不绕过验证码、限流、登录或访问限制。
- 一键确认预设即确认本轮权限；实际动作仍同时受比例、合格池和总上限控制。
- 浏览器第一步打开当前登录账号的创作者主页，完成账号识别后再回到推荐流。
- 已确认配置要求粉丝数、近期作品点赞稳定性或新发布时间证据时，点击当前推荐内容的作者头像或名称进入其公开主页，取证后可靠返回推荐流。
- 计划、尝试、验证和实际成功结果分开记录，不用配额计划冒充真实结果。
- 插件和远程 MCP 只使用 Supabase URL 与 publishable key；service role、Cookie、验证码和登录 token 不进入插件包、SQLite 或导出。
- 未通过 `get_upload_status` 时不打开抖音、不创建 Goal、不启动 collector；MCP 服务端仍对每次工具请求重新验证 OAuth token。

## 图标

`assets/no-swipe.svg` 为 64×64 的轻量 SVG，可同时用作插件 logo 和 composer icon。
