// 仅用于测试与评测的 pi 扩展：在子进程内部执行本次预留的请求数与 token 上限（方案第 13 节第 0 步）。
//
// 由协调脚本以 `-e eval/budget-guard.ts` 加载，并通过环境变量传入本次预留：
//   - PI_BUDGET_MAX_REQUESTS：本进程允许的 provider 请求次数上限，正整数。
//   - PI_BUDGET_MAX_BILLED_TOKENS：本进程允许的计费 token 上限，正整数。
//   - PI_BUDGET_GUARD_LOG：可选，中止时追加一行 JSON 记录，供协调脚本确认守卫是否触发。
// 两个上限缺任一个或格式不对时，守卫在每个回合开始时都中止，宁可不跑也不越界。
//
// 计数口径与 session-usage.ts 一致：每条带 usage 的 assistant 消息计 1 次请求；
// 压缩的请求数取 details.stats.requests（smart-compact 写入），没有时按 1 次计。
// 判定时机是 turn_start：它在回合开始前的压缩检查之后、provider 请求之前（方案 S10），在这里中止可以阻止该回合的请求。
// 单次压缩内部的请求无法逐个拦截，由预留时按每次压缩 12 次计入兜底。

import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export interface GuardLimits {
	maxRequests: number;
	maxBilledTokens: number;
}

export interface GuardState {
	requests: number;
	billedTokens: number;
}

function positiveInt(v: string | undefined): number | undefined {
	if (!v || !/^\d+$/.test(v)) return undefined;
	const n = Number(v);
	return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** 从环境变量读取上限；任一项缺失或非法时返回 undefined。 */
export function readGuardLimits(env: NodeJS.ProcessEnv): GuardLimits | undefined {
	const maxRequests = positiveInt(env.PI_BUDGET_MAX_REQUESTS);
	const maxBilledTokens = positiveInt(env.PI_BUDGET_MAX_BILLED_TOKENS);
	return maxRequests && maxBilledTokens ? { maxRequests, maxBilledTokens } : undefined;
}

/** 下一次请求是否可能越界：再发一次就超过请求上限，或计费 token 已经用满。 */
export function shouldBlock(state: GuardState, limits: GuardLimits | undefined): boolean {
	if (!limits) return true;
	return state.requests + 1 > limits.maxRequests || state.billedTokens >= limits.maxBilledTokens;
}

function usageTokens(usage: unknown): number {
	const u = (usage ?? {}) as Record<string, unknown>;
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
	return n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite);
}

export default function budgetGuard(pi: ExtensionAPI): void {
	const limits = readGuardLimits(process.env);
	const logFile = process.env.PI_BUDGET_GUARD_LOG;
	const state: GuardState = { requests: 0, billedTokens: 0 };

	pi.on("message_end", (event) => {
		const msg = event.message as { role?: string; usage?: unknown };
		if (msg.role !== "assistant" || !msg.usage) return;
		state.requests += 1;
		state.billedTokens += usageTokens(msg.usage);
	});

	pi.on("session_compact", (event) => {
		const entry = event.compactionEntry as { usage?: unknown; details?: { stats?: { requests?: unknown } } };
		const reported = entry.details?.stats?.requests;
		state.requests += typeof reported === "number" && reported >= 1 ? reported : 1;
		state.billedTokens += usageTokens(entry.usage);
	});

	pi.on("turn_start", (_event, ctx) => {
		if (!shouldBlock(state, limits)) return;
		if (logFile) {
			try {
				appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), state, limits: limits ?? null })}\n`, { mode: 0o600 });
			} catch {
				// 日志只是辅助诊断，写失败不能影响中止本身。
			}
		}
		ctx.abort();
	});
}
