# pi-smart-compact

pi 的状态感知压缩扩展。

- 何时压：沿用 pi 内置触发器，触发点为模型原生窗口减去 `compaction.reserveTokens`，不缩小任何模型的窗口。
- 压成什么：接管 `session_before_compact`，自选保留原文的范围，生成有长度上限的叙述摘要，并附上压缩包（验证记录、最近失败、用户原话、已加载的 skill、文件清单、交接与召回说明）。
- 忘了怎么办：注册 `recall_history` 工具，按关键词或条目 id 取回压缩前的原文。
- 防循环：压缩后基线超标逐级收紧预算，压缩过密进入最小模式，同一会话自动压缩次数有上限，超出后停止自动压缩并写交接文档。

设计与依据见 `~/.pi/agent/.collab/smart-compact/plan.md`。

## 安装

必须通过 `settings.json` 的 `packages` 安装，pi-subagents 的子会话才会加载它；用 `-e` 临时加载时子会话不加载。

pi 从本地路径加载包时不复制，直接读取原目录，所以要放在不会被系统清理的位置（不要用 `/tmp`）。
本扩展运行时只依赖 pi 自带的包，不需要 `npm install`。

```bash
git clone /tmp/pi-smart-compact ~/.pi/agent/.collab/smart-compact/pi-smart-compact
pi install ~/.pi/agent/.collab/smart-compact/pi-smart-compact
```

更新时在该目录执行 `git pull`，再重启 pi。

同时在 `settings.json` 中打开 pi 的自动压缩，建议值如下：

```json
{ "compaction": { "enabled": true, "reserveTokens": 32768, "keepRecentTokens": 20000 } }
```

需要让某个模型提前压缩时，用 pi 原生的 `compaction.modelOverrides` 为它单独设置更大的 `reserveTokens`。

## 配置

配置文件为 `~/.pi/agent/smart-compact.json`，缺失时使用缺省值，格式错误或越界时该项使用缺省值并提示一次。

| 键 | 缺省 | 说明 |
|---|---|---|
| `maxAutoCompactions` | 6 | 同一会话自动压缩次数的上限，范围 1 到 50，达到后停止自动压缩。 |
| `handoffKeep` | 20 | 每个会话保留的交接文档份数，范围 1 到 200。 |
| `virtualWindowTokens` | `{}` | 键为虚拟模型的 `provider/id`，值为它所有路由目标中最小的原生窗口。 |
| `byteBpeProviders` | `["openai", "openai-codex"]` | 整个 provider 都使用 byte-level BPE 分词器的名单，命中时压缩包由本扩展按字节上限生成。 |
| `byteBpeModels` | `[]` | 逐个确认使用 byte-level BPE 的 `provider/id`，精确匹配。 |

只把确认过分词器的模型加入后两项。

## 命令与开关

- `/smart-compact status`：查看是否接管、停止状态、本会话自动压缩次数与各模型的预算级别。
- `/smart-compact reset`：解除停止状态，清零自动压缩次数，恢复预算级别。历史被修改导致的停止不能用它解除。
- `PI_SMART_COMPACT_SUMMARY=off`：不接管压缩摘要，恢复 pi 默认行为，`recall_history` 仍然可用。
- `PI_SMART_COMPACT_FAULT=main|all`：仅用于测试，让主路径或两级生成都失败。

pi 版本不等于已验证的 1.1.0 时，本扩展自动不接管压缩摘要并提示一次。

## 停止状态

以下情况会停止自动压缩：普通输入不再发给模型，运行在下一个回合开始前中止，只保留 `/compact` 与 `/smart-compact`。

- 压缩后基线过高，或压缩过密且已在最小模式。
- 两级摘要生成都失败。
- 自动压缩次数达上限。
- 虚拟模型的窗口声明与实际路由不符。
- 历史被修改且自动重建失败。

进入停止状态时会写一份交接文档，路径在通知里给出，可以用它开新会话。

## 交接文档

写在 `<sessionDir>/smart-compact/<sessionId>/` 下，内容是叙述摘要、未裁剪的压缩包、完整文件清单与本次统计，已脱敏。
没有 session 文件（`--no-session`）时不写。

## 限制

- 不要同时安装其他会返回 compaction 的扩展，pi 只采用最后一个结果。
- 限定了工具的子 agent（例如 Explore、Plan）拿不到 `recall_history`，只能依赖压缩摘要。
- pi 溢出恢复省略的执行记录只有在确认来源后才能召回。进程在确认之前退出时，该窗口不建立召回例外，被省略的条目仍在原始会话文件中，可以人工查看。
- 1M 窗口模型在约 96.7 万 token 时才压缩，长上下文下的质量与费用未经本扩展实测。

## 开发

```bash
npm ci
npm test
npm run typecheck
```

`test/faux.test.ts` 用 pi-ai 的 faux provider 在进程内驱动完整会话，不发生真实调用。
