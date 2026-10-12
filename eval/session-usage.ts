// 从 pi 会话文件（jsonl）汇总一次子进程运行的实际用量，供账本结算使用。
//
// 统计口径：
//   - 每条带 usage 的 assistant 消息计 1 次 provider 请求。
//   - compaction 与 branch_summary 条目的 usage 计入 token 与费用；请求次数取 details.stats.requests，没有时按 1 次计。
//   - inputTokens 为输入侧合计（input + cacheRead + cacheWrite），outputTokens 为 output，billedTokens 为两者之和。
//   - 费用取 usage.cost.total；provider 未返回费用时按 0 计，由调用方决定是否视为「未知」。
// 任何一行无法解析时返回 null，表示用量不可信，账本会按最坏值计。

import { existsSync, readFileSync } from "node:fs";
import type { Amounts } from "./ledger.ts";

interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown };
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function addUsage(acc: Omit<Amounts, "wallMs">, usage: UsageLike, requests: number): void {
	const input = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
	const output = num(usage.output);
	acc.requests += requests;
	acc.inputTokens += input;
	acc.outputTokens += output;
	acc.billedTokens += input + output;
	acc.costUsd += num(usage.cost?.total);
}

/** 汇总会话文本中的用量；wallMs 由调用方填写。有无法解析的行时返回 null。 */
export function usageFromSessionText(text: string): Omit<Amounts, "wallMs"> | null {
	const acc = { requests: 0, inputTokens: 0, outputTokens: 0, billedTokens: 0, costUsd: 0 };
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		let entry: Record<string, unknown>;
		try {
			entry = JSON.parse(line) as Record<string, unknown>;
		} catch {
			return null;
		}
		if (entry.type === "message") {
			const msg = entry.message as { role?: unknown; usage?: UsageLike } | undefined;
			if (msg?.role === "assistant" && msg.usage) addUsage(acc, msg.usage, 1);
		} else if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage) {
			const stats = (entry.details as { stats?: { requests?: unknown } } | undefined)?.stats;
			addUsage(acc, entry.usage as UsageLike, Math.max(1, num(stats?.requests)));
		}
	}
	return acc;
}

/** 读取会话文件并汇总；文件不存在或内容损坏时返回 null。 */
export function usageFromSessionFile(file: string): Omit<Amounts, "wallMs"> | null {
	if (!existsSync(file)) return null;
	return usageFromSessionText(readFileSync(file, "utf8"));
}
