# 字段与交付规范

## 账户作用域

No Swipe 认证用户与抖音账号是 1:n。服务端用认证后的用户 ID 隔离数据；本地用稳定 `account_ref` 为每个抖音账号保存独立画像目录。邮箱不进入 `account_ref`、观察记录或画像文件。切换账号不修改其他账号的当前画像或历史 revision。

## 单条观察 JSON

浏览器层每次至少提供以下结构。无法从推荐流页获得的字段使用空值，不进入账号主页补采。

```json
{
  "contract_version": 2,
  "record_id": "018f...",
  "run_id": "run-001",
  "account_ref": "douyin:local:account-a",
  "config_hash": "sha256:...",
  "profile_id": "profile-a",
  "profile_revision": 2,
  "profile_hash": "sha256:...",
  "observed_at": "2026-08-07T08:29:23Z",
  "feed_index": 1,
  "is_relevant": true,
  "decision": "keep",
  "action": "watch_then_next",
  "dwell_seconds": 7.4,
  "interest_score": 8.2,
  "title": "视频标题",
  "caption": "推荐流文案",
  "author": "作者名",
  "author_href": "推荐流中可见的链接",
  "aweme_id": "视频ID",
  "hashtags": ["主题A", "主题B"],
  "content_type": "video",
  "duration_seconds": 46.0,
  "current_position_seconds": 7.4,
  "like_count": 10000,
  "comment_count": 230,
  "share_count": 88,
  "favorite_count": 560,
  "before_url": "https://www.douyin.com/?recommend=1",
  "after_url": "https://www.douyin.com/?recommend=1",
  "scroll_delta": 1,
  "transition_ok": true,
  "user_liked": false,
  "user_favorited": false,
  "user_commented": false,
  "user_comment_text": "",
  "user_action_reason": "",
  "user_action_result": {},
  "rpa_feedback": {
    "content_type": "video",
    "no_profile_navigation": true,
    "classification_reason": "命中账号画像的高相关信号：主题A、主题B",
    "quota_decision": {
      "policyVersion": "2.0.0",
      "pageState": "ok",
      "relevance": "high",
      "interactionBucket": "like_only",
      "plannedActions": {
        "like": true,
        "favorite": false,
        "watchToEnd": false,
        "comment": false,
        "follow": false,
        "notInterested": false
      },
      "completionEligible": true,
      "followCandidate": false,
      "quotaFeedback": {
        "actualActionsMustBeRecordedAfterExecution": true
      }
    },
    "completion_verified": false
  }
}
```

`author` 与 `author_href` 必须取自当前活跃 slide 内同一个 `a[href*='/user/']` 锚点的 text 与 href。`author` 在写入观察前必须经过 `normalizeAuthorName`（去掉开头连续 `@`、折叠空白）。取不到成对值时 `author_href` 留空并如实上报，不得回退到页面上第一个 `/user/` 链接。

`contract_version` 固定为 `2`。`record_id` 由客户端生成，并与当前用户和会话共同构成服务端幂等键。上传不校验时间戳时区或格式；时区转换和展示在数据库到前端完成。客户端默认仍发送 UTC `Z`。

`quota_decision.plannedActions` 只表示实验计划。点赞、收藏、评论、关注、不感兴趣和完播的实际结果必须在页面操作或播放器状态得到可靠反馈后，写入对应事实字段或 `user_action_result`。候选不等于已执行；没有对应授权时不得尝试。

`content_type` 使用 `video`、`image_text`、`live`、`ad` 或 `unknown`。`unknown` 只表示当前读取尚无可验证媒体，不是最终内容分类；活跃 slide 在网络加载期间同时返回 `media_state=loading`，Runner 先执行有界被动复读，仍未就绪时返回 `media_loading` 且不创建观察。活跃 slide 内存在多个视频节点时，以 viewport 相交面积最大的节点为视频事实来源，不能让较早挂载的隐藏占位节点覆盖可见视频。图文/图片卡片只有在当前活跃 slide 内发现平台图集资源时才写为 `image_text`；此时 `duration_seconds` 与 `current_position_seconds` 保持空值，不得伪造视频时长。图文进入零停留立即处理通道：已授权且配额分配成功时尝试一次不感兴趣，否则直接转场。

## Excel 中文字段顺序

1. 记录ID
2. 会话ID
3. 观察时间
4. 会话已用秒
5. 刷流序号
6. 相关内容序号
7. 是否相关
8. 推荐决策
9. 刷流动作
10. 用户点赞
11. 用户收藏
12. 用户评论成功
13. 用户评论内容
14. 用户动作原因
15. 用户动作结果(JSON)
16. 停留秒数
17. 兴趣评分
18. 标题
19. 文案
20. 作者
21. 作者主页链接（未访问，仅页面字段）
22. 视频ID
23. 话题标签
24. 命中关键词
25. 内容类型
26. 视频时长秒
27. 当前播放位置秒
28. 点赞数
29. 评论数
30. 分享数
31. 收藏数
32. 刷前页面
33. 刷后页面
34. 滚动步数
35. 跳转成功
36. 无主页导航
37. RPA反馈(JSON)
38. 原始记录(JSON)

`相关视频记录` 在最前面额外增加“测试批次”。

启用配额策略的批次，在 `RPA反馈(JSON)` 中至少保留：配额策略版本、相关性层级、互动分组、计划动作、完播资格、关注候选、各配额池位置、停止状态和实际动作待回填标记。如需把这些值展开为Excel列，保持“计划”与“实际”两组字段，不要相互覆盖。

## 空值语义

- 空白：未采集、页面未展示或该批次不支持该字段。
- 否：明确观察或执行后确认结果为否。
- 0：页面明确展示数值0，或确认动作成功数为0。

不得将这三种语义混用。

## 上传语义

SQLite 是本地事实源；Runner 在每条 `processOne` 内先把观察与对应 outbox 项以 `scroll_delta=null`、`transition_ok=null` 同事务提交，页面转场得到验证结论后，再用 `no-swipe transition` 同事务更新观察与 outbox payload。一次控制后 ID 未变化不会立刻写 `transition_ok=false`：Runner 保持 transition-pending，先在下一次同实例调用中接受延迟变化；仍未变化时仅重试最后一种转场控制一次。转场审计仍为空的 outbox 项不会进入上传批次。`media_loading` 不创建观察。本地完整观察即上传内容，不另做脱敏投影。CSV 和 Excel 只在用户要求查看或交付时从 SQLite 导出，不进入采集热路径。刷流循环不调用 collector `record`，也不根据 `mcp_upload` 做批次判断。payload 递归出现 `cookie`、`authorization`、`access_token`、`refresh_token`、`password`、`secret` 等凭据字段时，服务端拒绝该记录。

上传请求最多包含 100 条：

```json
{
  "contract_version": 2,
  "session_id": "客户端会话 UUID",
  "client": {
    "plugin_version": "x.y.z",
    "host_fingerprint": "不可逆短哈希"
  },
  "task_config": {},
  "started_at": "2026-08-07T08:20:00Z",
  "finished_at": null,
  "stats": {},
  "heartbeat": {"counters": {}},
  "records": []
}
```

服务端逐条确认：

```json
{
  "accepted": ["首次写入的 record_id"],
  "duplicated": ["服务端已有的 record_id"],
  "rejected": [{"id": "record_id", "reason": "拒绝原因"}]
}
```

- `accepted` 和 `duplicated` 都将本地 outbox 标记为 `sent`。
- 断网、超时、`429` 和 `5xx` 保留记录并指数退避；达到重试上限进入 `dead`。
- 契约错误和其他永久 `4xx` 直接进入 `dead`，等待人工检查。
- 已上传观察不可原地修订；纠错使用新的 correction record，避免本地与服务端事实分叉。
- 服务端在 `(user_id, session_id, record_id)` 上去重；同一批重放不会增加观察记录。

## 会话摘要最低指标

| 指标 | 计算规则 |
|---|---|
| 完整记录数 | 明细记录ID非空数量 |
| 相关视频数 | 是否相关=是 |
| 非相关视频数 | 是否相关=否 |
| 直播记录数 | 内容类型=直播 |
| 用户点赞数 | 用户点赞=是；空值不计入 |
| 用户收藏数 | 用户收藏=是；空值不计入 |
| 成功评论数 | 用户评论成功=是；空值不计入 |
| 会话时长 | 每个会话的最大“会话已用秒” |

## 配额策略汇总最低指标

| 指标 | 计算规则 |
|---|---|
| 高度相关计划点赞率 | 高度相关池内计划点赞数 / 高度相关合格数 |
| 高度相关计划收藏率 | 高度相关池内计划收藏数 / 高度相关合格数 |
| 点赞收藏重合率 | 高度相关池内同时计划点赞收藏数 / 高度相关合格数 |
| 中等相关计划点赞率 | 中等相关池内计划点赞数 / 中等相关合格数 |
| 合格短视频计划完播率 | 高度相关、视频类型且不超过180秒的计划完播数 / 该合格池数量 |
| 唯一关注候选率 | 关注候选创作者数 / 重复高相关且推荐流可直接关注的唯一创作者数 |
| 实际动作成功率 | 对应动作成功数 / 对应动作尝试数；不使用计划动作作分母 |
