# 抖音推荐流配额策略

## 不提供业务默认比例

配额模块只负责可复现的实验分配和审计，不决定账号画像、业务目标、互动比例或权限。`DEFAULT_QUOTA_CONFIG` 是全零安全配置；实际比例必须来自用户确认且带哈希的 `RunConfig`。

页面出现验证、限制、登录失效或无法可靠识别时，策略直接返回停止，不分配或消耗新名额。

## 分母与比例

`RunConfig.interaction_policy.rules` 分别定义 high 和 medium 相关性池。点赞率、收藏率和二者重合率的换算为：

```text
like_only = like_rate - overlap_rate
favorite_only = favorite_rate - overlap_rate
like_and_favorite = overlap_rate
none = 1 - like_rate - favorite_rate + overlap_rate
```

因此必须满足：

- `overlap_rate <= min(like_rate, favorite_rate)`；
- `like_rate + favorite_rate - overlap_rate <= 1`；
- 未填写不是 0，所有比例必须显式存在。

Contract 1.0.0 中：

- 已确认画像配置短视频立即处理规则时，可靠时长不超过上限的内容先强制进入 none 池；`not_interested_or_skip` 使其成为不感兴趣候选，未获授权、未分配名额、达到总上限或页面操作失败时立即划走；
- 完播候选来自 high、视频类型、时长大于 0 且不超过平台配置上限的内容；
- 评论候选来自 high 内容；
- 关注按唯一创作者计数，来自 high、达到重复出现门槛、推荐流显示关注入口且尚未关注的创作者；
- 不感兴趣候选来自 none 内容；
- profile sampling 已退役；`profile_visit` / `profile_sampling` 仅保留旧配置审计语义，配额映射和每条 `plannedActions.profileVisit` 固定为 false/0，runner 不进入任何主页。

## 配额随机

纯概率抽样只能在期望上接近目标，有限样本可能波动较大。配额随机先按 `block_size` 计算各动作数量，再用运行 ID 作为种子打乱顺序：

- 完整分组内比例准确；
- 同一种子、同一输入顺序可复现；
- 未满分组的尾段保留真实随机结果，不为凑比例补动作；
- 每次决策输出配额池、分组位置和目标数量。

配额计划不等于执行许可。Runner 还必须检查：

1. RunConfig 状态和哈希有效；
2. 当前账号与 `account_ref` 匹配；
3. 对应 action authorization 为 `true`；
4. 总上限尚未达到；
5. 页面操作后的结果可以验证。

## 使用

优先从已确认配置构造策略，不要直接手写业务比例：

```js
import { quotaConfigFromRunConfig } from "../../../runtime/src/config.mjs";
import { createDouyinQuotaPolicy } from "./douyin_quota_randomizer.mjs";

const policy = createDouyinQuotaPolicy({
  config: quotaConfigFromRunConfig(confirmedRunConfig),
});
```

每条观察持久化后再保存策略状态。恢复时，状态内的 `runConfigHash` 必须与已确认配置一致。

运行验证：

```bash
node --test
```
