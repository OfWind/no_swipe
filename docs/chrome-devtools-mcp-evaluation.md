# Chrome DevTools MCP 用于 No Swipe 故障诊断的评估

- 评估日期：2026-08-20
- 上游项目：[ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- 评估快照：上游 `main` 的 `package.json` 为 `1.7.0`；本机 `npx -y chrome-devtools-mcp@latest --version` 同样返回 `1.7.0`
- 评估范围：判断官方 `chrome-devtools` Skill、`chrome-devtools-mcp` 服务以及 Codex 内置 Browser 之间的能力边界，不把外部 Chrome 成功误判成内置 Browser 已恢复

## 结论

用户给出的 [`skills/chrome-devtools/SKILL.md`](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/skills/chrome-devtools/SKILL.md) 是官方 Skill，但它只是指导 Agent 如何调用 `list_pages`、`select_page`、`take_snapshot`、`evaluate_script` 等 MCP 工具的工作流说明；它本身不会安装或启动 MCP Server，也不会自动执行 No Swipe 诊断。

`npx chrome-devtools-mcp@latest` 启动的是一个 MCP stdio Server，不是“一键诊断命令”。单独在终端运行时，它主要是在等待 MCP 客户端发来协议调用；连接 MCP Server 本身也不会立刻启动浏览器。只有 MCP 客户端第一次调用需要浏览器的工具时，服务才会按配置连接或启动 Chrome。[README：Getting started / Your first prompt](https://github.com/ChromeDevTools/chrome-devtools-mcp#your-first-prompt)

默认情况下，它会启动一个新的 Google Chrome stable，使用独立且持久化的 profile，而不是连接 Codex 内置 Browser。macOS/Linux 默认 profile 为 `$HOME/.cache/chrome-devtools-mcp/chrome-profile`；Windows 为 `%USERPROFILE%\.cache\chrome-devtools-mcp\chrome-profile`。[README：User data directory](https://github.com/ChromeDevTools/chrome-devtools-mcp#user-data-directory)

因此，对 No Swipe 的建议是：

1. **不要把上游 `SKILL.md` 复制到 No Swipe references 后就期待它修复故障。** references 适合保存 No Swipe 自己的分层诊断流程和上游链接，不提供底层工具能力。
2. **将 `chrome-devtools-mcp` 作为可选的外部 Chrome 对照诊断工具，不作为 No Swipe Runtime 的必需依赖。** 它很适合判断抖音 DOM、网络请求、控制台错误和脚本执行是否在一个干净的官方 Chrome 中正常。
3. **内置 Browser 必须优先用 Codex 自带 Browser 控制路径诊断。** 只有当 Codex 内置 Browser 明确暴露可访问的 CDP HTTP/WebSocket endpoint 时，才能再讨论让外部 Chrome DevTools MCP 接入同一个实例。当前官方资料没有提供这条 Codex 内置 Browser 接入方式。
4. **不要用 `@latest` 作为可复现的产品依赖。** 临时人工排障可以用 `@latest`；若团队决定标准化安装，应固定经过验证的版本，并在诊断记录中保存版本号。

## 1. Skill 和 MCP Server 是两件事

官方 Skill 的 frontmatter 将自己描述为“通过 MCP 使用 Chrome DevTools 进行调试、排障和浏览器自动化”。正文说明：浏览器在第一次工具调用时启动，生命周期参数由 MCP Server 的 CLI 配置提供；随后给出页面选择、快照、脚本执行和扩展测试的使用模式。[官方 Skill](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/skills/chrome-devtools/SKILL.md)

这意味着：

| 组件 | 作用 | 是否提供 DevTools 能力 | 是否自动诊断 No Swipe |
|---|---|---:|---:|
| `SKILL.md` | 给 Agent 的操作说明和工作流 | 否，依赖已注册的 MCP tools | 否 |
| `chrome-devtools-mcp` | 提供浏览器控制、DOM、网络、控制台和性能工具的 MCP Server | 是 | 否，需要 MCP 客户端调用 tools |
| No Swipe 诊断 reference | 规定针对抖音与 No Swipe 的检查顺序、判定条件和停止条件 | 否，可编排已有工具 | 只有我们明确写出流程并由 Agent 执行时 |

上游也明确区分了 “MCP only” 和 “MCP + Skills”：例如 Claude Code 的 CLI 安装只装 MCP，而插件安装同时提供 MCP 与 Skills；Codex 的官方示例是注册 MCP Server。[README：MCP client configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp#codex)

## 2. `npx chrome-devtools-mcp@latest` 实际做什么

上游 `package.json` 把 `chrome-devtools-mcp` 映射到 Server 可执行入口，并将包描述为 “MCP server for Chrome DevTools”。截至本次评估，上游版本为 `1.7.0`，Node 要求为 `^20.19.0 || ^22.12.0 || >=23`。[官方 package.json](https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/package.json)

官方给 Codex 的注册方式是：

```bash
codex mcp add chrome-devtools -- npx chrome-devtools-mcp@latest
```

注册后应重启或新开 Codex 任务，使 MCP 工具进入该任务的工具列表；再由 Agent 调用 `list_pages`、`take_snapshot`、`evaluate_script` 等工具完成诊断。单独运行：

```bash
npx -y chrome-devtools-mcp@latest --help
```

只能验证 npm/Node 能否拉起 Server 并打印参数。官方 troubleshooting 也把它定义为“测试 MCP Server 能否在本机运行”，不是页面诊断。[Troubleshooting：General tips](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md#general-tips)

需要 MCP 自身日志时，官方建议：

```bash
DEBUG=* npx -y chrome-devtools-mcp@latest \
  --log-file=/tmp/chrome-devtools-mcp.log
```

但这仍需要一个 MCP 客户端与其通信，日志反映的是该 MCP 实例的启动和控制链路，不是 Codex 内置 Browser 原有链路。[Troubleshooting：Debugging](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md#debugging)

## 3. 默认浏览器与已有浏览器连接方式

默认行为是：第一次需要浏览器的 MCP tool 被调用时，服务启动新的 Google Chrome stable，并复用专用 profile。它不会默认附着到用户当前的普通 Chrome，更不会根据“都是 Chromium 内核”自动附着到另一个应用嵌入的浏览器。[README：Your first prompt](https://github.com/ChromeDevTools/chrome-devtools-mcp#your-first-prompt)、[README：User data directory](https://github.com/ChromeDevTools/chrome-devtools-mcp#user-data-directory)

连接已有浏览器只有三种受支持的显式入口：

- `--auto-connect`：Chrome 144+，用户先在 `chrome://inspect/#remote-debugging` 开启远程调试并允许连接；
- `--browser-url=http://127.0.0.1:9222`：连接已开放远程调试 HTTP endpoint 的 Chrome；
- `--ws-endpoint=ws://.../devtools/browser/...`：连接已知 WebSocket endpoint，可选自定义 headers。

详细要求见 [README：Configuration](https://github.com/ChromeDevTools/chrome-devtools-mcp#configuration) 和 [README：Connecting to a running Chrome instance](https://github.com/ChromeDevTools/chrome-devtools-mcp#connecting-to-a-running-chrome-instance)。

## 4. 能否直接连接 Codex 内置 Browser

**当前不能依据官方资料声称可以。**

“使用 Chromium 内核”只是渲染引擎层面的相似性；外部工具要附着到一个具体 Browser 实例，仍需要可访问的远程调试入口、匹配的 endpoint 和权限。Chrome DevTools MCP 官方文档只说明如何连接：

- 它自己启动的 Chrome；
- 用户明确开启远程调试的 Google Chrome；
- 一个显式提供 `browser-url` 或 `ws-endpoint` 的现有浏览器。

官方 README 对 Antigravity 的内置浏览器给出了明确的 `--browser-url=http://127.0.0.1:9222` 示例，但 Codex 部分只给出标准 MCP 注册命令，没有 Codex 内置 Browser 的 endpoint 或接管说明。这正说明“内置浏览器能否接入”取决于宿主是否专门暴露调试端口，而不是取决于它是不是 Chromium。[README：Antigravity 与 Codex 配置](https://github.com/ChromeDevTools/chrome-devtools-mcp#MCP-Client-configuration)

此外，本机当前 OpenAI bundled Browser skill 明确要求：Codex 内置 Browser 通过该插件的 `browser-client` 和其 Node runtime 控制，不得用外部 MCP browser-control server 替代该 surface。此项是本机安装版本 `browser/26.814.41407` 的产品运行约束，文件位于：

```text
/Users/zz/.codex/plugins/cache/openai-bundled/browser/26.814.41407/
skills/control-in-app-browser/SKILL.md
```

所以在当前 No Swipe 排障中，Chrome DevTools MCP 能建立一个很有价值的**外部 Chrome 对照组**，但不能验证原内置 Browser 的 Browser Client、tab/session 绑定、pipe 或 CDP transport 是否健康。

## 5. No Swipe 应如何使用它

### 推荐架构

```text
No Swipe 主诊断
  ├─ A. Codex 内置 Browser 原路径
  │    ├─ browser-client 是否可获得 iab binding
  │    ├─ tab/session 是否有效
  │    ├─ 简单页面读取是否成功
  │    ├─ 简单 JS/DOM 是否成功
  │    └─ getActiveCard() 是否成功
  └─ B. Chrome DevTools MCP 外部对照路径（可选）
       ├─ 新的官方 Chrome stable + 独立 profile
       ├─ 同一抖音页面的 DOM / console / network / evaluate
       └─ 判断页面适配问题，或缩小到 Codex 内置控制链路
```

建议在 `plugins/no-swipe/skills/douyin-recommendation-rpa/references/` 增加一份 **No Swipe 专用浏览器诊断流程**，引用本评估和上游官方 Skill，而不是原样复制上游 Skill。该 reference 应输出至少以下分类：

| 内置 Browser | 外部 Chrome 对照 | 更可能的故障层 |
|---|---|---|
| 简单 JS 已失败 | 正常 | 内置 Browser 的 binding/session/transport |
| 简单 JS 正常，No Swipe DOM 读取失败 | 相同 DOM 读取也失败 | 抖音页面状态、DOM 变化或脚本成本 |
| 简单 JS 正常，No Swipe DOM 读取失败 | 外部 Chrome 正常 | 内置 Browser 兼容性或该 session 状态 |
| 两边都正常，仅 `getActiveCard()` 失败 | 正常 | No Swipe Runner 实现或超时边界 |

这份 reference 是可审阅的运行手册；`chrome-devtools-mcp` 则保持为诊断人员按需安装的外部工具。不要把它加入 No Swipe Runtime 的生产 dependencies，否则会扩大安装面、版本面和浏览器权限面，却仍不能保证接管内置 Browser。

### 建议的最小外部对照测试

1. 注册 MCP，并新开 Codex 任务：

   ```bash
   codex mcp add chrome-devtools -- npx -y chrome-devtools-mcp@1.7.0 \
     --isolated \
     --no-usage-statistics \
     --no-performance-crux
   ```

2. 让 Agent 在该独立 Chrome 中按顺序调用 `list_pages`、打开测试页、`take_snapshot`、`evaluate_script`。
3. 先用无登录、无敏感数据的普通页面验证工具链，再进入抖音。
4. 对抖音只做只读诊断：标题、正文长度、`video` 数量、候选卡片数量、元素尺寸、控制台错误和关键网络失败。
5. 将结果标记为 `external_chrome_control`，不得写成 `codex_iab_control`。

`--isolated` 使用临时 profile，更适合做无账号的控制链路测试；如必须复用登录态，应改用一个专门的诊断 profile，并明确接受该 profile 内容暴露给 MCP 客户端的风险。

## 6. 安全、版本和可移植性

### 浏览器与账号数据

Chrome DevTools MCP 能让 MCP 客户端读取、调试和修改它所控制 Browser 中的数据。官方明确提示不要在该实例中打开不希望暴露给 MCP 客户端的敏感或个人信息。[README：Disclaimers](https://github.com/ChromeDevTools/chrome-devtools-mcp#disclaimers)

开启 `--remote-debugging-port` 后，本机其他应用也可能连接并控制 Browser。官方要求使用非默认 `--user-data-dir`，并提示端口开放时不要浏览敏感网站。[README：Manual connection using port forwarding](https://github.com/ChromeDevTools/chrome-devtools-mcp#manual-connection-using-port-forwarding)

不要在 No Swipe 文档、日志或工单中记录 Cookie、Authorization header、完整 WebSocket credential 或账号密钥。不要为了排障使用 `--accept-insecure-certs`、`--no-sandbox` 或 `--allow-unrestricted-paths` 作为默认参数。

### 遥测与 CrUX

用量统计默认开启；性能工具可能把 trace URL 发给 Google CrUX API。敏感诊断环境建议增加：

```text
--no-usage-statistics --no-performance-crux
```

具体行为见 [README：Usage statistics](https://github.com/ChromeDevTools/chrome-devtools-mcp#usage-statistics) 和 [README：Disclaimers](https://github.com/ChromeDevTools/chrome-devtools-mcp#disclaimers)。

### 官方支持范围

上游只正式支持 Google Chrome 和 Chrome for Testing；其他 Chromium 浏览器可能工作，但不保证。因此不能因为 360、Codex 内置 Browser 或其他浏览器使用 Chromium 内核，就把它们视为官方支持目标。[README：Disclaimers](https://github.com/ChromeDevTools/chrome-devtools-mcp#disclaimers)

### `@latest` 与版本固定

官方明确说明 `@latest` 会让 MCP 客户端持续使用最新版。这适合临时获得修复，但会导致不同电脑、不同日期运行不同实现。[README：Getting started](https://github.com/ChromeDevTools/chrome-devtools-mcp#getting-started)

建议：

- 临时人工排障：允许 `@latest`，但先记录 `npx -y chrome-devtools-mcp@latest --version`；
- 团队复现和标准诊断：固定经过验证的版本，例如本次的 `chrome-devtools-mcp@1.7.0`；
- 升级：先在无敏感数据的独立 profile 上通过基本工具链测试，再更新团队 pin；
- Windows：官方对 Codex 建议通过 `cmd /c npx` 并适当提高 `startup_timeout_ms`；不同系统不要假定同一 shell 启动方式。[README：Codex on Windows 11](https://github.com/ChromeDevTools/chrome-devtools-mcp#codex)

## 7. 对当前问题的判定边界

如果外部 Chrome DevTools MCP 的 `evaluate_script` 能稳定读取抖音，而 No Swipe 在 Codex 内置 Browser 的 `getActiveCard()` 仍超时，只能得出：

> 抖音页面在外部官方 Chrome 的 DevTools 路径可读，故障范围缩小到内置 Browser 环境、其控制会话或 No Swipe 在该路径上的调用。

不能得出“内置 Browser 已修复”。

如果两条路径都在同一个只读 DOM 操作上超时，则应继续检查页面主线程、选择器规模、脚本实现、账号 A/B 页面和资源占用。Chrome DevTools MCP 此时能提供 console/network/trace 证据，帮助修改 No Swipe Runner。

如果 `npx ... --help` 成功但 Codex 中没有 MCP tools，只能说明 Node/npm 能启动程序；需要检查 Codex MCP 注册、重启/新任务以及 MCP Server 日志，不能据此判断浏览器或 No Swipe 正常。

## 官方资料

- [Chrome DevTools MCP README](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/README.md)
- [官方 chrome-devtools Skill](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/skills/chrome-devtools/SKILL.md)
- [官方 package.json](https://raw.githubusercontent.com/ChromeDevTools/chrome-devtools-mcp/main/package.json)
- [官方 troubleshooting](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/troubleshooting.md)
