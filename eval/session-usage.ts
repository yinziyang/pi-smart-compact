// 从 pi 会话文件（jsonl）汇总一次子进程运行的实际用量，供账本结算使用。
//
// 统计口径：
//   - 每条带 usage 的 assistant 消息计 1 次 provider 请求。
//   - compaction 与 branch_summary 条目的 usage 计入 token 与费用；请求次数取 details.stats.requests，没有时按单次压缩的上限 12 次计，宁可多算。
//   - inputTokens 为输入侧合计（input + cacheRead + cacheWrite），outputTokens 为 output，billedTokens 为两者之和。
//   - 费用取 usage.cost.total；provider 未返回费用时按 0 计，由调用方决定是否视为「未知」。
// 任何一行无法解析，或任何一条 assistant、compaction 记录的 usage 缺失或有字段不是有限非负数时，返回 null，表示用量不可信，账本按最坏值计。

import { existsSync, readFileSync } from "node:fs";
import type { Amounts } from "./ledger.ts";

interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown };
}

/** 单次压缩内部的请求次数上限，与方案 5.2 一致；压缩记录缺少统计时按此计。 */
const COMPACTION_MAX_REQUESTS = 12;

function valid(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/** 累加一条 usage；有字段缺失或非法时返回 false，调用方据此判定整次用量不可信。 */
function addUsage(acc: Omit<Amounts, "wallMs">, usage: UsageLike | undefined, requests: number): boolean {
	if (!usage || !valid(usage.input) || !valid(usage.output) || !valid(usage.cacheRead) || !valid(usage.cacheWrite)) return false;
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	const output = usage.output;
	acc.requests += requests;
	acc.inputTokens += input;
	acc.outputTokens += output;
	acc.billedTokens += input + output;
	acc.costUsd += valid(usage.cost?.total) ? usage.cost.total : 0;
	return true;
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
			if (msg?.role === "assistant" && !addUsage(acc, msg.usage, 1)) return null;
		} else if (entry.type === "compaction" || entry.type === "branch_summary") {
			const reported = (entry.details as { stats?: { requests?: unknown } } | undefined)?.stats?.requests;
			const requests = typeof reported === "number" && Number.isInteger(reported) && reported >= 1 ? reported : COMPACTION_MAX_REQUESTS;
			if (!addUsage(acc, entry.usage as UsageLike | undefined, requests)) return null;
		}
	}
	return acc;
}

/** 读取会话文件并汇总；文件不存在或内容损坏时返回 null。 */
export function usageFromSessionFile(file: string): Omit<Amounts, "wallMs"> | null {
	if (!existsSync(file)) return null;
	return usageFromSessionText(readFileSync(file, "utf8"));
}
