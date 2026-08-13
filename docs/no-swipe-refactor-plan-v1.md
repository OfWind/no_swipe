# No Swipe 插件重构执行 Plan v1

- 状态：In progress
- 日期：2026-08-13
- 依据：[No Swipe 插件重构 Spec v1](./no-swipe-refactor-spec-v1.md)
- 执行原则：小步提交、保持可回滚、先建立契约与安全门，再移动实现

## 1. 交付策略

重构采用增量替换，不在一个提交中同时迁移语言、改变行为、修改数据模型和接入 Server。

每个 Phase 都必须满足：

1. 修改范围有自动化验证。
2. 插件目录仍可独立打包。
3. 事实语义和外部动作权限不倒退。
4. 新旧路径并存时只有一个写入事实源。
5. Phase 验收后再开始下一阶段。

### 当前进度（2026-08-13）

第一安全切片已进入验证阶段：插件包补齐依赖契约和缺失模块；四个 Schema、安全默认值、抖音平台配置、配置校验/确认/哈希 CLI 已实现；现有 Skill 已改为“一账号一画像、每轮单独确认策略”；runner 已统一消费 confirmed RunConfig，Test5/6/7 不再携带权限或比例。旧 collector 的事务、显式 run routing 与完整恢复仍属于 Phase 3，尚未宣称完成。

## 2. Phase 0：仓库卫生与发布包自洽

目标：建立唯一源码来源，让当前插件从干净 checkout 可验证。

### 2.1 工作项

- [x] 将 `plugins/no-swipe/` 定为唯一插件源码来源。
- [ ] 删除或归档所有依赖手工同步的运行版、旧 Skill 和构建副本；归档前记录来源 commit。
- [x] 补齐当前 runner 缺失的 `douyin_rpa_browser_rules.mjs`，或暂时移除无效入口。
- [x] 确保所有运行时 import 都落在插件包内部。
- [x] 增加依赖清单与 lockfile；不再依赖工作区根目录的隐式 `node_modules`。
- [x] 扩充 `.gitignore`：运行数据库、WAL、JSONL、导出、临时配置和本地凭据全部排除。
- [x] 新增 packaging smoke test：验证 manifest、Skill、import 和必要资源。
- [ ] 用 ADR 决定重构期 Runtime 策略：
  - 方案 A：先保留 Node + Python，以 JSON 契约解耦。
  - 方案 B：迁移为单一 TypeScript Runtime。
  - 决策标准：打包自洽、SQLite 支持、测试成本、迁移风险，而非语言偏好。

### 2.2 预计文件

```text
docs/adr/0001-runtime-language.md
tests/packaging/plugin-self-contained.*
plugins/no-swipe/runtime/package metadata
.gitignore
README.md
```

### 2.3 验收

- 从干净 checkout 运行插件校验，不出现缺失文件或依赖。
- `rg` 只能找到一份可编辑的 runner、policy 和 collector 源码。
- 当前 quota 单测继续通过。

## 3. Phase 1：配置契约与运行前问询门

目标：先消除固定画像、固定比例和预设授权，再继续模块重构。

### 3.1 Schema 与配置文件

- [x] 新增 `account-profile.schema.json`。
- [x] 在 Schema 中要求稳定 `account_ref`、`profile_id` 和 revision 标识；一对一绑定由后续存储层唯一约束保证。
- [x] 新增 `run-config.schema.json`。
- [x] 新增 `runtime-state.schema.json`。
- [x] 新增 `event-envelope.schema.json`。
- [x] 新增 `defaults/safe-runtime.json`，所有外部互动关闭且不含兴趣主题。
- [x] 新增 `platforms/douyin.v1.json`，迁入：
  - DOM selector 候选。
  - 中文 UI 标签和结束标记。
  - 验证码、限流、登录失效等停止状态匹配。
  - 页面适配能力开关。
- [ ] 将停留区间、配额块大小和非敏感运行阈值迁入版本化配置。
- [x] 保持授权闸门、状态机和重试判定在代码中。

### 3.2 配置编译器

- [x] 实现 `config validate <file>`。
- [x] 拒绝契约未声明字段。
- [x] 实现规范化 JSON 与 SHA-256 `config_hash`。
- [x] 实现版本兼容检查；未知 contract 版本失败关闭。
- [ ] 输出用户可读的中文配置摘要。
- [x] 验证比例、重合率、总数上限与授权的一致性。

### 3.3 Skill 重写

- [ ] 新建 `manage-account-profile`，只负责未绑定账号首次建档和用户主动修改画像。
- [ ] 新建 `prepare-recommendation-run`。
- [x] 将默认提示改为“先准备并确认运行配置”。
- [ ] 准备运行时先解析 `account_ref` 并自动加载该账号当前画像 revision。
- [x] 只有账号未绑定画像、用户主动要求修改或账号不一致时，进入画像建档/修改流程。
- [x] 每轮强制收集目标、点赞率、收藏率、重合率、评论率、关注率、完播率和“不感兴趣”策略，不重复询问已绑定画像内容。
- [x] 支持“全部不互动”快捷回答，但仍生成明确的零比例。
- [x] 展示账号、画像名称/revision 和本次策略摘要并等待明确确认。
- [x] 改造运行入口，缺少 confirmed 配置时拒绝启动并回到准备流程。
- [ ] 将导出流程拆到 `export-recommendation-run`。
- [x] 更新现有 Skill 的 `agents/openai.yaml`，确保默认 prompt 与新行为一致。

### 3.4 移除硬编码

- [x] 删除 Skill 中的默认 3C / 科技 / AI 画像。
- [x] 删除 `DEFAULT_QUOTA_CONFIG` 中的产品级互动比例，改为读取已确认 RunConfig。
- [x] 将 `createTest5Runner()` / `createTest6Runner()` / `createTest7Runner()` 降为无行为差异的兼容别名；后续版本移除。
- [x] 删除固定评论模板；评论内容遵循本次配置与批准模式生成并记录。
- [ ] 在代码审查中逐项分类剩余字面量：协议常量、平台配置、产品配置或测试 fixture。

### 3.5 测试

- [ ] 未绑定账号缺少画像时不能开始。
- [ ] 已绑定账号第二次运行自动加载画像，不再次询问画像主题。
- [ ] 两个不同账号分别加载自己的唯一画像。
- [ ] 检测到实际登录账号与 RunConfig 不一致时，在动作前停止。
- [x] 缺少任一要求比例时不能开始。
- [x] 全部比例为零可以确认并执行观察模式。
- [x] 比例大于零但未授权时校验失败。
- [x] overlap 超限时校验失败。
- [ ] 账号画像自动复用后仍要求确认本次目标、互动策略和授权构成的有效配置。
- [ ] 修改账号画像产生新 revision，已完成和进行中的 Run 快照保持不变。
- [x] 修改 confirmed 配置后确认状态失效。
- [ ] Skill forward test A：未绑定账号请求“刷 100 条推荐流”，必须先完成账号画像建档和本次策略问询。
- [ ] Skill forward test B：已绑定账号再次请求运行，只询问本次目标与策略，不重复询问画像。

### 3.6 验收

- 仓库中搜索不到作为默认行为的 `科技、3C数码、人工智能`。
- 任意启动入口都必须消费同一种 `RunConfig`。
- 测试编号、文件名和自然语言不能绕过授权。
- 账号画像保持一账号一画像，并且可以追溯 revision。

## 4. Phase 2：Runtime 模块化

目标：把浏览器适配、策略、编排、存储和导出从大文件拆成稳定边界。

### 4.1 Contracts

- [ ] 定义 `RunConfig`、`Observation`、`PlannedAction`、`ActionAttempt`、`RuntimeState`、`EventEnvelope`。
- [ ] 每个 public contract 带独立 `schema_version`。
- [ ] 生成或共享 Node / Python 类型，避免双手维护字段表。

### 4.2 Platform adapter

- [ ] 提取 `readActiveCard()`。
- [ ] 提取 `detectPageState()`。
- [ ] 提取 `executeAction()` 与 `verifyActionResult()`。
- [ ] 使用 DOM fixture 测试选择器，不依赖真实账号执行 CI。
- [ ] 页面结构无法可靠识别时返回 typed stop reason。

### 4.3 Profile 与 classifier

- [ ] 将历史关键词规则改成 `AccountProfile` 的输入，不保留产品默认主题。
- [ ] 通过 `platform_account_id` 加载唯一画像；Run 使用不可变 revision 快照。
- [ ] 输出 `high | medium | low | none | uncertain`、理由和 classifier 版本。
- [ ] `uncertain` 默认不进入任何正向互动池。
- [ ] 浏览器观察覆盖自动分类时保留两份结果与覆盖理由。

### 4.4 Policy engine

- [ ] Policy 只计算计划，不接触浏览器。
- [ ] 以 `run_id + sequence + policy_version` 产生可复现决策。
- [ ] 使用明确合格池和分母。
- [ ] 支持按相关性层级配置不同规则。
- [ ] 输出计划、配额位置和决策理由。

### 4.5 Orchestrator

- [ ] 实现单一 `processOne()` 状态机。
- [ ] 所有外部动作经过授权闸门。
- [ ] 将 `planned`、`attempted` 和验证结果分开。
- [ ] 崩溃窗口使用 `unknown_after_attempt`，不自动重试。

### 4.6 验收

- Browser adapter、policy 和 storage 可以分别使用 fixture 单测。
- Runner 不再包含画像关键词、产品比例和 SQL schema。
- Policy 测试不需要浏览器；Storage 测试不需要策略实现。

## 5. Phase 3：本地事实源、幂等与完整恢复

目标：消除 JSONL / SQLite / CSV 漂移和重复导入。

### 5.1 数据库迁移

- [ ] 引入正式 migration 文件，不在启动函数中持续追加 ad-hoc `ALTER TABLE`。
- [ ] 建立 `platform_accounts`、`account_profiles`、`account_profile_revisions`、`runs`、`events`、`observations`、`action_attempts`、`runtime_state`、`outbox`。
- [ ] 为 `account_profiles.platform_account_id` 建立唯一约束；每个画像只允许一个 current revision。
- [ ] `events.event_id` 唯一。
- [ ] `(run_id, sequence)` 唯一。
- [ ] `runs` 以显式 `run_id` 路由，不再读取最近 active session。
- [ ] Boolean 事实使用 nullable 字段或显式状态枚举，保留未知语义。

### 5.2 提交与恢复

- [ ] 观察、策略推进、运行状态和 outbox 在同一事务提交。
- [ ] 持久化 RNG、配额袋、创作者计数、评论计数和主页抽样集合。
- [ ] 删除 queue -> DB 的人工同步脚本路径。
- [ ] CSV / Excel 只通过 exporter 重建。
- [ ] 增加断电/崩溃 fault-injection 测试。

### 5.3 Legacy importer

- [ ] 只读导入旧 SQLite / JSONL。
- [ ] 生成导入报告：成功、重复、冲突、无法判定。
- [ ] 导入后不修改旧文件。
- [ ] 导入器完成稳定期后单独归档，不把旧 schema 分支留在主流程。

### 5.4 验收

- 相同 batch 重放 10 次仍只有一份 observation。
- 在每个状态机节点模拟中断后恢复，配额和动作上限不漂移。
- CSV 删除后可以无损重建。

## 6. Phase 4：Server 摄取与 Supabase Auth

目标：在不牺牲离线能力的前提下，把数据可靠传到自建 Server。

### 6.1 先写 ADR

- [ ] `0002-server-runtime-and-deployment.md`
- [ ] `0003-supabase-auth-flow.md`
- [ ] `0004-data-retention-and-privacy.md`
- [ ] 明确 Cloud Supabase 与自托管 Supabase，不把“自建业务 Server”误写为“自托管 Supabase”。

### 6.2 Supabase

- [ ] 建立 `workspace_memberships` 等最小租户表。
- [ ] 为暴露表配置显式 GRANT 与 RLS。
- [ ] RLS 使用 membership 真相源，不使用 `user_metadata` 授权。
- [ ] 前端只使用 publishable key；Server secret 不进入插件。
- [ ] 用越权测试覆盖猜 ID、替换 tenant、修改归属等 BOLA 场景。

### 6.3 Ingestion API

- [ ] 实现 `POST /v1/ingestion/events:batch`。
- [ ] 验证 Supabase JWT 的签名、issuer、audience、expiry 和 subject。
- [ ] 从认证与 membership 推导 workspace / project。
- [ ] 按 event 和 batch 幂等。
- [ ] 返回 accepted / duplicate / rejected / ack cursor。
- [ ] 原始事件先持久化，再异步投影业务表。

### 6.4 Upload client

- [ ] 本地 outbox 批量上传。
- [ ] 实现带抖动的指数退避和最大并发限制。
- [ ] 401 进入认证恢复；4xx schema 错误进入死信；5xx 保留重试。
- [ ] 凭据进入 OS Keychain 或等价安全存储。
- [ ] 日志统一脱敏 Authorization、Cookie 和 token。

### 6.5 验收

- 断网时采集继续，本地恢复网络后补传。
- Server 暂时失败不会丢事件。
- 用户 A 无法读取或写入用户 B 的 project / run。
- token、Cookie 和 Server secret 不出现在日志、SQLite payload、导出或插件包中。

## 7. Phase 5：交付、兼容与发布

目标：形成可维护的 `0.2.x` 发布线。

### 7.1 插件与文档

- [ ] 更新 `.codex-plugin/plugin.json` 的描述、默认 prompts 和真实开发者信息。
- [ ] 在实际接入 MCP / App 之前，不声明不存在的 `mcpServers` 或 `apps`。
- [ ] README 只保留安装、核心能力、安全边界和最短使用路径。
- [ ] 详细 Schema 与策略只放 references / docs，避免 Skill 膨胀。
- [ ] 用官方 plugin validator 与 skill validator 校验。

### 7.2 兼容测试

- [ ] 当前 RunConfig 主版本。
- [ ] 可迁移的旧次版本。
- [ ] 不支持主版本的失败提示。
- [ ] 当前 Server 接受的 event 版本范围。
- [ ] 插件升级新增权限时要求重新确认。

### 7.3 发布门

- [ ] 干净 checkout packaging smoke test。
- [ ] 单测、集成测试、契约测试全部通过。
- [ ] 运行前问询 forward test 通过。
- [ ] 隐私与秘密扫描通过。
- [ ] 从旧数据导入到新事实源的演练通过。
- [ ] 发布说明明确 breaking changes 与回滚方式。

## 8. 推荐提交序列

每项单独提交，方便审查和回滚：

1. `docs: add refactor spec and execution plan`
2. `chore: make plugin package self-contained`
3. `test: add packaging and import smoke tests`
4. `feat: add versioned config schemas and safe defaults`
5. `feat: add run config compiler and confirmation gate`
6. `refactor: split preparation, execution, and export skills`
7. `refactor: extract platform adapter and policy engine`
8. `feat: introduce transactional event store and outbox`
9. `feat: add legacy read-only importer`
10. `feat: add authenticated ingestion client and server`
11. `release: prepare no-swipe 0.2.0`

## 9. 第一批立即执行的文件级任务

Spec 通过评审后，下一轮直接执行以下最小切片：

1. 新增四个 JSON Schema 和 `safe-runtime.json`。
2. 新增配置校验 CLI 与测试，不连接浏览器。
3. 更新现有 Skill：移除默认画像和固定比例；首次账号建档画像，后续自动复用画像；每轮只问目标、互动策略并确认。
4. 移除 Test6 / Test7 对关注和评论的隐式授权；所有动作读取 RunConfig。
5. 补齐缺失 import 并增加 plugin self-contained smoke test。

该切片完成标准是“未绑定账号只建档一次画像，已绑定账号自动加载画像，所有启动路径都先得到可验证、可确认的 RunConfig”，暂不改变旧 SQLite 的内部结构。这样可以先关闭最高风险的产品行为，再安全推进持久化与 Server 改造。

## 10. 计划完成定义

当且仅当 Spec 第 11 节的全部验收标准都有自动化或可复核证据，并且 Phase 0–5 的验收项全部完成，本 Plan 才标记为 Done。
