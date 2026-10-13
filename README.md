# pi-smart-compact

[pi](https://pi.dev) 的状态感知压缩扩展。
上下文快满时，它接管 pi 的压缩，生成有长度上限的结构化摘要，并保留继续工作所需的执行状态：验证记录、最近失败、用户原话、已加载的 skill、文件清单。
压缩后忘了的细节，模型可以用 `recall_history` 工具取回原文。

## 安装

```bash
pi install git:https://github.com/yinziyang/pi-smart-compact.git
```

安装后重启 pi，新开的会话即生效。
扩展运行时只依赖 pi 自带的包，不需要额外安装依赖。

必须用 `pi install` 安装（写进 `settings.json` 的 `packages`），pi-subagents 的子会话才会加载它；用 `-e` 临时加载时子会话不加载。

更新与卸载：

```bash
pi update --extensions
pi remove git:https://github.com/yinziyang/pi-smart-compact.git
```

## 必需的配置：打开 pi 的自动压缩

扩展只负责「压成什么样」，「什么时候压」仍由 pi 自带的触发机制决定。
所以必须在 `~/.pi/agent/settings.json` 中打开自动压缩：

```json
"compaction": {
  "enabled": true,
  "reserveTokens": 32768,
  "keepRecentTokens": 20000
}
```

- `enabled`：必须为 `true`。为 `false` 时 pi 不会自动压缩，溢出恢复也会关闭，扩展不会被调用，只剩手动 `/compact` 可用。
- `reserveTokens`：触发余量，建议 32768。触发点等于模型原生窗口减去它，例如 272k 的模型约在 23.9 万 token 时压缩，1M 的模型约在 96.7 万 token 时压缩。pi 的缺省值 16384 留给单次回复的余量偏小。
- `keepRecentTokens`：压缩后最多保留的近期原文，pi 的缺省值就是 20000。扩展会按窗口大小再算一个可能更小的值，两者取小。

需要让某个模型提前压缩时，用 pi 原生的 `compaction.modelOverrides` 为它单独设置更大的 `reserveTokens`。

## 日常使用

- 自动压缩：什么都不用做，上下文到达触发点时自动进行。
- 手动压缩：用 pi 自带的 `/compact`，后面可以写想重点保留的内容，例如 `/compact 重点保留数据库迁移细节`，它会作为最高优先级进入摘要。
- 看到「自动压缩已停止」的提示时：用提示里给出的交接文档开新会话，或执行 `/smart-compact reset` 在当前会话继续。

## 压缩策略

压缩后的上下文由三部分组成：

1. 近期原文：保留最近一段对话原文，不做摘要。
2. 叙述摘要：更早的内容压成六节结构（目标、约束与偏好、进度、关键决策、下一步、关键上下文），真实 token 有硬上限（最多 8192）。
3. 压缩包：由扩展确定性生成，附在摘要后面，有字节硬上限：
   - 验证记录：测试、构建、lint 等命令与结果。
   - 最近失败：最近 3 次出错的工具结果原文尾部。
   - 用户原话：最早一条（通常是任务的原始需求）优先保留，其余按时间倒序。
   - 已加载的 skill：只列名称与路径，提示模型需要时重新读取。
   - 文件清单：修改过与读取过的文件。
   - 交接文档路径与 `recall_history` 用法。

完整、未裁剪的版本另写成交接文档，可以用它开新会话。
摘要、交接文档与召回结果都会对密钥脱敏。

防止反复压缩：

- 摘要与压缩包都有硬上限，目标是压缩后的上下文不超过触发点的 55%。
- 实测压缩后上下文仍超过这个比例，或两次压缩间隔过短时，逐级收紧预算。
- 同一会话最多自动压缩 6 次，之后停止自动压缩，写交接文档并提示开新会话。
- 摘要生成失败时先走一次受控回退；回退也失败时停止运行，不让请求带着超限的上下文继续发送，也不交给 pi 默认摘要（它没有长度上限）。

## 命令

- `/smart-compact status`（或只输入 `/smart-compact`）：查看是否接管压缩、是否处于停止状态、本会话自动压缩次数，以及各模型的预算级别与估算数据。
- `/smart-compact reset`：解除停止状态，清零自动压缩次数，恢复预算级别。历史被其他扩展修改、且自动重建失败导致的停止不能用它解除，只能用 `/compact` 手动重建或开新会话。

`/smart-compact` 不触发压缩，只管理扩展的状态；压缩用 `/compact`。

## 停止状态

以下情况会停止自动压缩：普通输入不再发给模型，运行在下一个回合开始前中止，只保留 `/compact` 与 `/smart-compact`。

- 压缩后上下文仍然过大，或压缩过密且已在最小预算。
- 两级摘要生成都失败。
- 自动压缩次数达到上限。
- 虚拟模型的窗口声明与实际路由不符。
- 历史被修改且自动重建失败。

进入停止状态时会写一份交接文档，路径在通知里给出。

## 可选配置

配置文件为 `~/.pi/agent/smart-compact.json`，不建也可以，缺失时使用缺省值；格式错误或越界时该项使用缺省值并提示一次。

| 键 | 缺省 | 说明 |
|---|---|---|
| `maxAutoCompactions` | 6 | 同一会话自动压缩次数的上限，范围 1 到 50。 |
| `handoffKeep` | 20 | 每个会话保留的交接文档份数，范围 1 到 200。 |
| `virtualWindowTokens` | `{}` | 键为虚拟模型的 `provider/id`，值为它所有路由目标中最小的原生窗口。 |
| `byteBpeProviders` | `["openai", "openai-codex"]` | 整个 provider 都使用 byte-level BPE 分词器的名单，命中时压缩包按字节上限由扩展生成。 |
| `byteBpeModels` | `[]` | 逐个确认使用 byte-level BPE 的 `provider/id`，精确匹配。 |

只把确认过分词器的模型加入后两项。

环境变量：

- `PI_SMART_COMPACT_SUMMARY=off`：不接管压缩摘要，恢复 pi 默认行为，`recall_history` 仍然可用。
- `PI_SMART_COMPACT_FAULT=main|all`：仅用于测试，让主路径或两级生成都失败。

## 交接文档

写在 `<sessionDir>/smart-compact/<sessionId>/` 下，内容是叙述摘要、未裁剪的压缩包、完整文件清单与本次统计，已脱敏。
没有 session 文件（`--no-session`）时不写。

## 兼容性与限制

- 已验证的 pi 版本为 1.2.0。pi 版本不同时，扩展自动不接管压缩摘要并提示一次，此时 pi 回到默认压缩。
- 与 pi-goal、pi-subagents 兼容：子会话按各自模型的窗口压缩；pi-goal 的评估者只读取最新一份摘要，并能读到其中的验证记录。
- 不要同时安装其他会返回 compaction 的扩展，pi 只采用最后一个结果。
- 限定了工具的子 agent（例如 Explore、Plan）拿不到 `recall_history`，只能依赖压缩摘要。
- pi 溢出恢复省略的执行记录只有在确认来源后才能召回；进程在确认之前退出时，被省略的条目仍在原始会话文件中，可以人工查看。
- 1M 窗口模型在约 96.7 万 token 时才压缩，长上下文下的质量与费用未经实测。

## 测试与评测

```bash
npm ci
npm test
npm run typecheck
```

- `test/`：单元测试，以及用 pi-ai 的 faux provider 在进程内驱动完整 pi 会话的集成测试，不发生真实调用。
- `eval/integration.ts`：真实模型集成测试（自动触发、手动压缩、召回、pi-subagents 子会话、pi-goal 多次压缩后达成目标、约束只在摘要中时不误判达成）。
- `eval/replay.ts`：用真实会话做回放评测，比较不压缩、pi 默认压缩、本扩展与受控回退四组在同样问题上的回答。实测本扩展与 pi 默认压缩的得分在评测噪声范围内持平，压缩后的上下文更小且有硬上限。
- 真实调用都经 `eval/coordinator.ts` 的预算账本与 `eval/budget-guard.ts` 的子进程守卫执行。
