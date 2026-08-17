# No Swipe 插件重构 Spec v1

- 状态：Accepted / In implementation（v1.1 交互修订）
- 日期：2026-08-13
- 范围：`no_swipe` GitHub 仓库及其中的 `no-swipe` Codex 插件
- 目标版本：`0.2.x` 重构线

## 1. 结论

No Swipe 将从“一个包含大量固定实验参数的单体 Skill”重构为“声明式配置驱动、运行前必须确认、可恢复、可审计、可向自建 Server 同步”的插件。

首个受支持的执行适配器仍是抖音推荐流，但“3C / 科技 / 人工智能”只作为历史测试样例，不再是产品默认画像。每个抖音账号绑定一个独立的逻辑画像；画像跨运行复用并可以版本化演进。每次运行只引用该账号当时生效的画像版本，再收集本次目标口径和互动策略。

首次使用未绑定画像的抖音账号时，Skill 必须完成账号画像建档。后续启动推荐流之前，Skill 自动加载该账号画像，仅询问本次目标和互动策略，并生成一份通过 Schema 校验的 `RunConfig`。账号未绑定画像、目标缺失或互动比例未明确时，执行器必须保持未启动状态。

### v1.1 交互修订

- 浏览器第一步打开当前登录账号的创作者主页，以可见昵称和抖音号识别账号。
- 首次建档不展示字段表单；只展示一张自然语言预设卡，并通过 Codex 结构化问询工具提供“使用预设 / 先不启动 / 自由输入修改要求”。
- 点击“使用预设”是同一会话内的 human-in-the-loop 确认，同时确认画像、运行参数与权限，不再追加第二轮确认。
- 确认必须由 Codex 原生 `request_user_input` 工具完成；线程中应呈现 `tool/requestUserInput` 等待边界。普通聊天选项不构成确认，也不得在等待时结束为一条普通回复。
- 原生确认返回后立即封存 RunConfig，并为该 `run_id` 创建或复用一个 Codex Goal；用户无需手动输入 `/goal`。
- 预设权限默认全部开启；动作仍必须满足正比例、合格池和总上限。评论权限可为开启而评论率为 0，此时不会评论。
- 当前内置的青年白领 / Z世代画像是可替换的 onboarding preset，不是分类器中的硬编码主题；用户自由输入会覆盖它。
- `extend` 只覆盖用户明确修改的字段；`replace` 从中性完整对象创建对应 scope，原预设在该 scope 中零残留。
- 推荐流需要粉丝数、近期作品稳定性或新发布时间证据时，优先点击当前卡片头像/作者名进入主页，主页 URL 仅作为回退；不能依赖右侧栏预先显示作者资料。

## 2. 现状与必须修复的问题

当前发布代码存在以下结构性问题：

1. `douyin_browser_runner.mjs` 引用了未打包的 `douyin_rpa_browser_rules.mjs`，插件包不自洽。
2. Skill 声称关注和评论需要当次授权，但 `createTest6Runner()` / `createTest7Runner()` 会通过预设直接打开部分外部动作。
3. 科技、3C 和 AI 画像，以及点赞、收藏、完播、关注等实验比例散落在 Skill、JS 常量和测试预设中。
4. 浏览器读取、分类、配额、执行动作、恢复与落盘集中在少数大文件中。
5. JSONL、配额状态、SQLite 和 CSV 没有统一提交协议，历史上已经出现恢复后重复导入。
6. SQLite 只支持“最近一个 active session”，不能安全承载多账号、多任务或 Server 同步。
7. 空值、明确失败和数值零在部分字段中被混用，削弱审计可信度。
8. 根目录运行版、旧 Skill、发布源码和构建副本并存，缺少唯一源码来源。

## 3. 产品原则

### 3.1 Skill 与执行能力分层

- Skill 负责运行前问询、工作流、停止条件和交付要求。
- Runtime 负责确定性配置校验、浏览器适配、状态机、持久化和上传。
- Server 负责身份验证、租户授权、接收事件、去重和派生数据。
- Skill 不得通过自然语言或某个“测试预设”隐式扩大执行权限。

这与当前 OpenAI 插件模型一致：Skill 提供可重复流程；需要认证、授权、实时数据或受控动作时，应由 MCP Server 或其他受控服务能力承担。参见 [Plugin architecture](https://developers.openai.com/plugins/concepts/plugins) 与 [Skills](https://developers.openai.com/plugins/concepts/skills)。

### 3.2 安全默认值

- 产品可以提供显式展示、可一键替换的 onboarding preset；分类器不得隐藏硬编码画像。
- 一个抖音账号只绑定一个逻辑画像；画像修改创建新 revision，不创建并行画像。
- 预设可默认开启权限，但在用户点击确认前不得执行推荐流外部动作。
- “未填写比例”与“比例为 0”是两种状态：前者阻止启动，后者表示用户明确选择不执行该动作。
- 评论、关注和“不感兴趣”等显著改变账号或外部状态的动作，除比例外还必须具有显式授权。
- 验证码、登录失效、限流、访问限制或页面不可可靠识别时，立即停止且不自动重试外部动作。

### 3.3 单一事实源

- GitHub 仓库中的 `plugins/no-swipe/` 是插件唯一源码来源。
- 本地 SQLite 事件库是未上传数据的运行时事实源。
- CSV 与 Excel 是派生交付物，可以从事实源重建。
- Server 接收成功后，Server 的原始事件表是组织级事实源；派生业务表可重放生成。

## 4. 运行前问询与启动门

### 4.1 账号画像建档

Skill 先解析当前登录的抖音账号，并使用不含凭据的稳定 `account_ref` 查找绑定画像。

一个通过邮箱认证的 No Swipe 用户可以绑定多个抖音账号。每个 `account_ref` 使用 `.no-swipe/accounts/` 下独立的哈希目录；切换或新增抖音账号只选择或创建对应目录，不覆盖其他账号。登录邮箱只用于 No Swipe 身份认证，不写入 `account_ref` 或本地画像文件。

- 已绑定：加载该账号当前生效的画像 revision，不重新询问正向主题、排除主题或边界规则。
- 未绑定：仅在首次建档时询问画像名称、正向主题、排除主题、边界主题及必要示例；确认后绑定到该账号。
- 用户主动修改画像：创建新 revision 并设为该账号当前版本；旧运行继续引用原 revision。
- 检测到浏览器实际账号与本次 `account_ref` 不一致：在任何外部动作前停止，切换到另一账号已绑定的画像，或为未绑定账号建档。
- 无法可靠识别当前账号：询问用户选择已绑定账号；仍无法确认时不启动。

逻辑关系为：

```text
NoSwipeUser 1 -- N DouyinAccount
DouyinAccount 1 -- 1 AccountProfile
AccountProfile 1 -- N AccountProfileRevision
Run N -- 1 AccountProfileRevisionSnapshot
```

`RunConfig` 保存画像 revision 引用、哈希与不可变快照，使离线执行和历史审计不依赖画像当前值。

### 4.2 单次预设确认

Skill 收到“开始刷推荐流”“采集 N 条”等请求后，先打开当前账号主页并加载账号画像，再展示一张预设卡。预设内部必须完整包含：

1. **运行目标**
   - `observed`：观察到 N 条全部内容。
   - `relevant`：持续观察直到相关内容达到 N 条。
   - 目标数量与最长运行限制。
2. **互动策略**
   - 点赞率。
   - 收藏率。
   - 点赞与收藏重合率。
   - 评论率及评论总数上限。
   - 关注率及关注总数上限。
   - 完播率。
   - “不感兴趣”率或是否完全禁用。
   - 每种比例的合格池，例如“只对高相关内容”或“高、中相关分别配置”。
3. **授权**
   - 预设默认开启点赞、收藏、评论、关注、“不感兴趣”和主页访问权限。
   - 用户点击预设即一次性确认这些权限；自由输入可以关闭或修改任意权限。
4. **运行与交付**
   - 是否允许离线缓存后上传。
   - 输出目录、是否生成 CSV / Excel、数据保留要求。

用户可以用自由输入表达“全部不互动”，系统将所有互动率设置为 `0`。

Skill 不展示多字段模板。结构化问询只提供推荐预设、停止选项，以及客户端自带的自由输入入口；只有实质性歧义才允许追加一个聚焦问题。结构化问询必须直接调用原生 `request_user_input`，不能输出“请回复使用预设”等普通聊天文案作为替代。工具不可用或报错时失败关闭，不绑定画像、不确认配置、不创建 Goal、不操作推荐流。

自由输入必须显式编译为两个独立作用域：

- `profile_mode=preset|extend|replace`：决定账号画像是否采用、补充或完全替换预设。
- `run_mode=preset|extend|replace`：决定本轮目标、比例和权限是否采用、补充或完全替换预设。
- 数组在 `extend` 中按字段整体替换，不隐式拼接；`replace` 必须提供该作用域的完整对象。
- “使用预设，300条”是明确的 `profile_mode=preset + run_mode=extend`，只把目标改为 300，不追加确认。

### 4.3 确认流程

Skill 必须执行以下状态机：

```text
resolving_account
  -> onboarding_account_profile (仅未绑定账号)
  -> collecting_run_inputs
  -> validated
  -> waiting_for_confirmation
  -> confirmed
  -> goal_active
  -> running
```

- `validated` 仅表示 Schema 和约束通过，不表示用户已授权。
- 在 `waiting_for_confirmation` 展示中文摘要：账号、画像名称与 revision、目标、各比例、分母、动作上限、授权范围和停止条件。
- `waiting_for_confirmation` 必须以待返回的原生 `request_user_input` 工具调用呈现；工具返回值是进入 `confirmed` 的唯一交互证据。
- 用户明确确认后写入 `confirmed_at`、`confirmed_by` 与 `config_hash`，随后为同一 `run_id` 创建或复用唯一 Goal。
- Goal 的用户可见目标必须使用中文业务描述，只展示计数口径、目标数、持久化完成条件和安全停止条件；`account_ref`、`run_id`、`profile_id`、`config_hash`、哈希及文件路径只保存在本地配置和状态文件中，用于内部匹配与恢复，不进入 Goal 文案。达到已落盘目标、确认全部上传并通过完整性校验后才完成。
- 执行器只接受 `status=confirmed` 且哈希匹配的配置。
- 配置发生任何实质变化后，状态回到 `waiting_for_confirmation`。
- 画像 revision 在运行准备期间发生变化时，必须重新生成快照和配置哈希；不要求用户重复描述画像。

### 4.4 比例约束

- 所有比例使用 `[0, 1]` 小数，UI 可以同时显示百分比。
- 点赞收藏重合率不得超过点赞率或收藏率。
- 同一合格池内，`like + favorite - overlap <= 1`。
- 关注率以“唯一合格创作者”为分母，不以视频数为分母。
- 评论率以用户确认的合格视频池为分母。
- 完播率只对时长和内容类型满足条件的视频生效。
- 比例大于 `0` 而对应授权为 `false` 时，配置校验失败。
- 评论率或关注率大于 `0` 时，必须同时提供总数上限。

## 5. 配置体系

### 5.1 配置与代码的边界

放入版本化配置文件：

- 比例、阈值、配额块大小和停留区间。
- DOM 选择器候选、可见 UI 文案、停止状态匹配词。
- 平台能力开关与页面适配版本。
- 非敏感的存储、批量上传、退避和保留设置。
- JSON Schema、事件版本和兼容范围。

保留在代码中：

- 动作顺序和运行状态机。
- 授权闸门、幂等与事务边界。
- 失败分类、是否允许重试的判断。
- 浏览器操作实现和验证反馈。
- 配置合并、校验和哈希算法。

不得进入代码或普通配置：

- Supabase refresh token、Server secret、Cookie、Authorization header。
- 平台账号凭据、验证码、设备码。
- 可用于复用登录态的浏览器敏感数据。

开发环境的秘密使用环境变量；用户会话凭据使用 OS Keychain 或等价安全存储。

### 5.2 配置层级与绑定关系

```text
产品安全默认值 < 平台适配器配置 < 本次 RunConfig

DouyinAccount -> 当前 AccountProfileRevision
RunConfig -> 该 revision 的不可变快照
```

- 高优先级只覆盖 Schema 明确允许覆盖的字段。
- 产品安全默认值中，所有外部互动为禁用；兴趣画像为空。
- RunConfig 不得覆盖账号画像内容，只能引用并快照当前 revision。
- 已绑定账号直接复用画像；每次运行只展示账号画像摘要，并确认包含本次目标和互动策略的最终配置。
- 运行配置冻结后不可原地修改；变更产生新的 `config_revision`。

### 5.3 目标配置文件

```text
plugins/no-swipe/config/
├── defaults/
│   └── safe-runtime.json
├── platforms/
│   └── douyin.v1.json
└── schemas/
    ├── account-profile.schema.json
    ├── run-config.schema.json
    ├── runtime-state.schema.json
    └── event-envelope.schema.json
```

运行时生成文件不进入插件源码：

```text
<data-dir>/runs/<run-id>/
├── run-config.json
├── state.sqlite
└── exports/
```

### 5.4 `RunConfig` 示例

以下示例只说明当前 contract 1.0.0 的结构，不是默认画像或默认比例。可运行的完整样例见 `plugins/no-swipe/tests/fixtures/run-config.draft.example.json`。

```json
{
  "schema_version": "1.0.0",
  "run_id": "run-example",
  "status": "confirmed",
  "account_ref": "douyin:local:account-a",
  "interest_profile": {
    "profile_id": "profile-example",
    "account_ref": "douyin:local:account-a",
    "revision": 3,
    "profile_hash": "sha256:...",
    "name": "该抖音账号已绑定的画像",
    "positive_topics": ["首次建档或修改画像时由用户填写"],
    "negative_topics": ["首次建档或修改画像时由用户填写"],
    "boundary_guidance": ["首次建档或修改画像时由用户填写"]
  },
  "goal": {
    "observed_target": 100,
    "relevant_target": null
  },
  "interaction_policy": {
    "rules": [
      {
        "eligible_relevance": ["high"],
        "like_rate": 0.2,
        "favorite_rate": 0.1,
        "like_favorite_overlap_rate": 0.05,
        "comment_rate": 0,
        "completion_rate": 0.1,
        "block_size": 20
      }
    ],
    "comment": {
      "max_total": 0,
      "approval_mode": "per_run",
      "guidance": ""
    },
    "follow": {
      "eligible_relevance": ["high"],
      "rate": 0,
      "max_total": 0,
      "minimum_repeat_creator_count": 2,
      "block_size": 20
    },
    "not_interested": {
      "rate": 0,
      "max_total": 0,
      "block_size": 20
    },
    "profile_sampling": {
      "rate": 0,
      "max_total": 0
    }
  },
  "authorization": {
    "like": true,
    "favorite": true,
    "comment": false,
    "follow": false,
    "not_interested": false,
    "profile_visit": false
  },
  "versions": {
    "adapter": "douyin.v1",
    "classifier": "profile-keyword.v1",
    "policy": "quota.v2",
    "contract": "1.0.0"
  },
  "confirmed_at": "2026-08-13T00:00:00Z",
  "confirmed_by": "user",
  "config_hash": "sha256:..."
}
```

## 6. 目标模块架构

```text
Skill: Prepare / Run / Export
          |
          v
Config compiler + validator
          |
          v
Run orchestrator (state machine)
     |          |          |
     v          v          v
Platform     Policy     Local event store
adapter      engine     + transactional outbox
                              |
                              v
                         Upload client
                              |
                              v
                 Ingestion API / Supabase Auth
                              |
                              v
                  Raw events -> projectors
```

### 6.1 Skill 层

将现有大 Skill 按用户目标拆分为三个聚焦工作流：

1. `manage-account-profile`：首次绑定账号画像，或显式修改画像 revision。
2. `prepare-recommendation-run`：解析账号、加载画像、询问本次目标和互动策略、生成配置并确认。
3. `run-douyin-recommendation`：只执行已确认配置，负责停止与恢复。
4. `export-recommendation-run`：校验事实源并生成 CSV / Excel / 摘要。

插件的默认启动提示必须首先进入 `prepare-recommendation-run`。它只在账号未绑定画像或用户要求修改画像时调用 `manage-account-profile`。直接触发运行 Skill 而没有已确认配置时，应路由回准备流程。

### 6.2 Runtime 层

建议模块边界：

- `contracts`：配置、事件和错误类型。
- `config`：加载、合并、Schema 校验、哈希和兼容检查。
- `profile`：用户画像编译与相关性判断输入。
- `policy`：只产生计划动作，不操作页面。
- `platforms/douyin`：页面识别、读取、动作和动作结果验证。
- `orchestrator`：状态机与调用顺序。
- `storage`：SQLite、迁移、事件和 outbox。
- `uploader`：批量、重试、ack cursor 和死信。
- `exporters`：从事实源构建派生交付物。

具体使用 TypeScript 单栈，还是保留 Node + Python 双栈，需在实施 Phase 0 通过 ADR 决定。重构不得先做无行为收益的大爆炸语言迁移。

## 7. 运行可靠性与审计契约

### 7.1 事件 Envelope

每条事件至少包含：

```text
schema_version
event_id
idempotency_key
plugin_id / plugin_version
install_id
account_ref
run_id
sequence
event_type
occurred_at / recorded_at
config_hash
payload
privacy_flags
```

- `event_id` 全局唯一。
- Server 对 `event_id` 和 `idempotency_key` 去重。
- 本地以 `(run_id, sequence)` 建立唯一约束。
- 客户端提交的 `workspace_id` / `user_id` 不作为授权事实。

### 7.2 外部动作状态机

```text
planned -> authorized -> attempted -> succeeded | failed | unknown_after_attempt
```

- `planned` 不得写入事实结果字段。
- 崩溃发生在点击之后、结果持久化之前时，记录 `unknown_after_attempt`。
- `unknown_after_attempt` 不自动重试，避免重复点赞、评论或关注。
- 每次动作保存页面前态、尝试时间、验证方式、页面反馈和失败类别。

### 7.3 本地提交协议

- SQLite 使用单写者和 WAL。
- 观察事件、策略状态推进和待上传 outbox 在同一事务提交。
- CSV 不参与事务；只从 SQLite 重建。
- 运行恢复必须显式指定 `run_id`，不得使用“最近一个 active session”。
- 所有内存状态，包括随机数、配额袋、创作者计数、评论计数和抽样集合，都必须进入可恢复状态。

## 8. Supabase 与自建 Server

### 8.1 信任边界

```text
不可信客户端
  -> Supabase Auth 登录/刷新
  -> Bearer access token
自建 Server
  -> 验证 JWT
  -> 查询 workspace membership
  -> 执行业务授权
Supabase Postgres / Storage
  -> RLS 与约束作为第二道防线
```

- Supabase Auth 证明用户身份；自建 Server 决定用户可操作的 workspace、project、install 和 run。
- Server 验证签名、`iss`、`aud`、`exp`、`sub` 和必要的 `session_id`。
- refresh token 不发送到数据摄取 API。
- `service_role` / secret key 只存在于受信 Server，绝不进入插件包。
- 不使用用户可编辑的 `user_metadata` 做授权。
- 客户端传来的租户、角色和套餐字段均视为不可信。

### 8.2 最小多租户模型

```text
User -> Workspace -> Project -> PluginInstall -> PlatformAccount -> AccountProfile -> Run
```

`PlatformAccount` 与逻辑 `AccountProfile` 为一对一关系；`AccountProfile` 通过 revisions 保存历史，Run 引用一个不可变 revision 快照。

核心实体：

- `workspace_memberships`
- `projects`
- `plugin_installs`
- `platform_accounts`
- `account_profiles`
- `account_profile_revisions`
- `runs`
- `raw_events`
- `observations`
- `action_attempts`
- `upload_cursors`

任何暴露给 Supabase Data API 的表必须同时具有显式 `GRANT` 与匹配业务模型的 RLS。后台投影任务使用独立的受限凭据；不要让所有组件共享一个全权 key。

### 8.3 摄取 API

首版契约：

```http
POST /v1/ingestion/events:batch
Authorization: Bearer <supabase-access-token>
Content-Type: application/json
Idempotency-Key: <batch-id>
```

响应：

```json
{
  "accepted": 42,
  "duplicate": 3,
  "rejected": [],
  "ack_cursor": "run-id:sequence"
}
```

Server 先验证并持久化原始 Envelope，再异步更新派生业务表。第一版不引入 ClickHouse、Kafka 或 Kubernetes；只有经过容量数据证明后再扩展基础设施。

## 9. 目标仓库结构

```text
no_swipe/
├── .agents/plugins/marketplace.json
├── docs/
│   ├── no-swipe-refactor-spec-v1.md
│   ├── no-swipe-refactor-plan-v1.md
│   └── adr/
├── plugins/no-swipe/
│   ├── .codex-plugin/plugin.json
│   ├── assets/
│   ├── config/
│   ├── runtime/
│   │   ├── src/
│   │   ├── migrations/
│   │   └── package metadata + lockfile
│   └── skills/
│       ├── manage-account-profile/
│       ├── prepare-recommendation-run/
│       ├── run-douyin-recommendation/
│       └── export-recommendation-run/
└── tests/
    ├── contract/
    ├── fixtures/
    ├── integration/
    └── packaging/
```

插件运行所需的所有非秘密文件必须位于 `plugins/no-swipe/` 内，或在构建时由可复现流程产出并通过自包含测试。仓库不得再维护手工同步的源码副本。

## 10. 兼容与版本规则

- Plugin 使用 SemVer。
- 配置和事件分别带 `schema_version`，不能只依赖 Plugin 版本。
- Platform adapter、classifier 和 policy 独立版本化并写入每次运行。
- 只在明确声明的兼容范围内自动迁移配置。
- 遇到不支持的主版本时失败关闭，并提示用户升级客户端；不得静默猜测字段。
- 旧 SQLite / JSONL 通过一次性导入器迁移，不在新 Runtime 中长期保留兼容分支。

## 11. 验收标准

重构 v1 完成必须同时满足：

1. 插件包从干净 checkout 安装后不存在缺失 import。
2. 仓库中不再存在产品级默认的 3C / 科技 / AI 用户画像。
3. 已绑定账号再次“开始刷 100 条”时自动加载画像，不重复询问画像主题；未绑定账号或缺少比例时只进入问询，不操作页面。
4. “全部不互动”会生成所有互动率为 `0` 的已确认配置。
5. 任何正比例动作都同时要求对应授权；否则配置校验失败。
6. Test 编号或 preset 名称不能改变授权范围。
7. 两次提交相同事件不会产生重复 observation。
8. 任意进程中断后，恢复不会重置配额、创作者计数或评论上限。
9. 外部动作结果区分 `succeeded`、`failed` 与 `unknown_after_attempt`。
10. CSV / Excel 可完全从 SQLite 重建，且空值语义正确。
11. Server 从认证上下文推导租户，不能信任 body 中的租户 ID。
12. 插件、Skill、Schema、配置示例和 package 均通过自动化校验。
13. 同一抖音账号只能有一个当前逻辑画像；修改画像产生 revision，历史 Run 的画像快照不变化。
14. 检测到实际登录账号与 RunConfig 不一致时，在任何外部动作前停止。

## 12. 本 Spec 的显式假设

- 首版只允许运行仓库内的第一方插件代码；第三方插件沙箱不在本轮范围。
- 首版可先服务单个内部 workspace，但数据模型从第一天保留 `workspace_id` / `project_id`。
- 本地离线采集必须可用，Server 恢复后异步上传。
- 默认上传结构化观察与动作证据，不默认上传完整 DOM、Cookie 或完整网络响应。
- Supabase 计划用于 Auth，并优先复用 Postgres / Storage；最终部署拓扑在 Server Phase 前单独 ADR 确认。

如果这些假设发生变化，应先更新本 Spec，再修改实现。
