# 抖音推荐流配额随机策略

## 用途

这套脚本用于下一轮推荐流测试的实验分配和结果审计。它不负责点击页面，也不用于规避验证码、访问限制或任何平台安全措施。页面出现验证、限制、登录失效或无法可靠识别时，策略直接返回“停止”。

## 默认配额

### 高度相关内容

每完整100条高度相关内容包含：

- 23条仅点赞
- 8条仅收藏
- 7条点赞并收藏
- 62条不互动

因此点赞率为30%，收藏率为15%，点赞与收藏同时发生的比例为7%，发生任一互动的比例为38%。

### 中等相关内容

每完整20条中等相关内容包含3条仅点赞，对应点赞率15%；其余不互动。

### 完播

仅将“高度相关、视频类型、时长大于0且不超过180秒”的内容放入完播池。每完整10条合格候选中随机分配1条完播，对应10%。实际完播必须在播放器回环验证成功后才能写入事实记录。

### 关注与评论

- 关注按唯一创作者计数，不按视频计数。只有重复出现不少于2次、高度相关、推荐流页直接显示关注按钮且尚未关注的创作者，才进入候选池。每完整20位合格创作者随机产生1位关注候选，对应5%。脚本不会自动关注，实际操作仍需当次确认。
- 评论默认比例为0，不自动生成或发布评论。

## 为什么使用“配额随机”

纯概率抽样只能在期望上接近目标，有限样本可能波动较大。配额随机先为完整分组准备固定数量的动作，再用带种子的随机数打乱顺序：

- 完整分组内比例准确；
- 同一种子和同一输入顺序可以复现；
- 最后未满一个分组的尾段保留真实随机结果，不为凑比例补动作；
- 每次决策都能输出所在配额池、分组位置和目标数量，便于写入RPA反馈。

## 使用示例

```js
import { createDouyinQuotaPolicy } from "./scripts/douyin_quota_randomizer.mjs";

const policy = createDouyinQuotaPolicy({
  config: { seed: "下一轮测试会话ID" },
});

const decision = policy.decide({
  awemeId: "视频ID",
  relevance: "high",
  contentType: "video",
  durationSeconds: 88,
  author: "创作者名",
  repeatHighCreatorCount: 2,
  feedFollowVisible: true,
  pageState: "ok",
});

if (decision.stopRequired) throw new Error(`必须停止：${decision.stopReason}`);

// 只执行当次已经授权的动作，再把页面返回的实际结果写入SQLite/CSV。
// plannedActions只表示计划，不能直接当作动作成功结果。
const observation = {
  rpa_feedback: {
    quota_decision: decision,
  },
  user_action_result: {},
};

// 每条内容处理完成后保存状态，支持中断恢复。
await policy.saveState("outputs/下一轮测试/quota_policy_state.json");
```

运行验证：

```bash
node scripts/douyin_quota_randomizer.test.mjs
```
