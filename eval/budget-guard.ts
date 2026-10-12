// 仅用于测试与评测的 pi 扩展：在子进程内部执行本次预留的请求数与 token 上限（方案第 13 节第 0 步）。
//
// 由协调脚本加载（一般用 `-e eval/budget-guard.ts`；涉及子会话时改为经 packages 或 agentDir/extensions 安装），并通过环境变量传入本次预留：
//   - PI_BUDGET_MAX_REQUESTS：本进程允许的 provider 请求次数上限，正整数。
//   - PI_BUDGET_MAX_BILLED_TOKENS：本进程允许的计费 token 上限，正整数。
//   - PI_BUDGET_GUARD_LOG：可选，每次拦截追加一行 JSON 记录，供协调脚本确认守卫是否触发。
// 两个上限缺任一个或格式不对时，守卫在每个回合开始时都中止，宁可不跑也不越界。
//
// 硬上限靠「调用前预占」保证：
//   - 每次 turn_start（位于回合开始前的压缩检查之后、provider 请求之前，方案 S10）先同步预占 1 次请求与该次请求的最坏 token，预占后的合计不超过上限才放行，否则 ctx.abort()。
//   - 单次请求的最坏 token = 模型窗口 + 模型的 maxTokens。模型的 maxTokens 是它自身的输出上限，即使 provider 不执行请求参数里的 maxTokens（方案 F8 实测修正），实际输出也不会超过它；窗口或 maxTokens 未知时拒绝调用。
//   - JS 单线程执行 handler，检查与预占在同一个同步段内完成，并行运行的子会话不会同时通过同一份剩余额度。
//   - 该会话的下一条 assistant 记录（message_end）到达时，用实际用量替换预占；被中止的伪记录同样计 1 次尝试，宁可多算。
//   - 压缩内部的请求不经过 turn_start，在 session_before_compact 中按「12 次 × 单次最坏 token」预占，不够时取消该次压缩；压缩结束后按 compaction 条目的实际用量结算。
// 计数挂在 globalThis 上，同一进程内父会话与 pi-subagents 子会话的多个守卫实例共享同一份状态。
// 子会话只加载 packages 或 agentDir/extensions 中的扩展，不加载 -e 指定的扩展（方案 F49）。

import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export interface GuardLimits {
	maxRequests: number;
	maxBilledTokens: number;
}

/** 已结算的用量与在途预占。预占按会话 id 记录，每个会话同一时刻最多一笔普通请求预占和一笔压缩预占。 */
export interface GuardState {
	requests: number;
	billedTokens: number;
	pending: Map<string, { requests: number; tokens: number }>;
}

/** 单次压缩内部的请求次数上限，与方案 5.2 一致。 */
export const COMPACTION_MAX_REQUESTS = 12;

const STATE_KEY = Symbol.for("pi-smart-compact.budget-guard.state");

function sharedState(): GuardState {
	const g = globalThis as { [STATE_KEY]?: GuardState };
	g[STATE_KEY] ??= { requests: 0, billedTokens: 0, pending: new Map() };
	return g[STATE_KEY];
}

/** 清空进程内共享计数，仅供测试使用。 */
export function resetGuardState(): void {
	delete (globalThis as { [STATE_KEY]?: GuardState })[STATE_KEY];
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

/** 单次请求的最坏 token；模型信息不足以给出上界时返回 undefined。 */
export function worstTokensPerRequest(model: { contextWindow?: number; maxTokens?: number } | undefined): number | undefined {
	const w = model?.contextWindow ?? 0;
	const o = model?.maxTokens ?? 0;
	return w > 0 && o > 0 ? w + o : undefined;
}

/**
 * 尝试为 key 预占 requests 次请求与 tokens 个 token。
 * 预占后的「已结算 + 全部在途 + 本次」不超过上限才成功；成功时写入 state.pending，失败时不改状态。
 */
export function tryReserve(state: GuardState, limits: GuardLimits | undefined, key: string, requests: number, tokens: number | undefined): boolean {
	if (!limits || tokens === undefined || state.pending.has(key)) return false;
	let pendingRequests = 0;
	let pendingTokens = 0;
	for (const p of state.pending.values()) {
		pendingRequests += p.requests;
		pendingTokens += p.tokens;
	}
	if (state.requests + pendingRequests + requests > limits.maxRequests) return false;
	if (state.billedTokens + pendingTokens + tokens > limits.maxBilledTokens) return false;
	state.pending.set(key, { requests, tokens });
	return true;
}

/** 用实际用量结算 key 的预占；没有预占时直接累加实际用量。 */
export function settle(state: GuardState, key: string, requests: number, tokens: number): void {
	state.pending.delete(key);
	state.requests += requests;
	state.billedTokens += tokens;
}

function usageTokens(usage: unknown): number {
	const u = (usage ?? {}) as Record<string, unknown>;
	const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
	return n(u.input) + n(u.output) + n(u.cacheRead) + n(u.cacheWrite);
}

export default function budgetGuard(pi: ExtensionAPI): void {
	const limits = readGuardLimits(process.env);
	const logFile = process.env.PI_BUDGET_GUARD_LOG;
	const state = sharedState();
	const keyOf = (ctx: ExtensionContext, kind: "turn" | "compact") => `${ctx.sessionManager.getSessionId()}:${kind}`;

	const record = (ctx: ExtensionContext, at: string, extra: Record<string, unknown> = {}) => {
		if (!logFile) return;
		try {
			const pendingRequests = [...state.pending.values()].reduce((a, p) => a + p.requests, 0);
			const row = { at, time: new Date().toISOString(), session: ctx.sessionManager.getSessionId(), requests: state.requests, billedTokens: state.billedTokens, pendingRequests, limits: limits ?? null, ...extra };
			appendFileSync(logFile, `${JSON.stringify(row)}\n`, { mode: 0o600 });
		} catch {
			// 日志只是辅助诊断，写失败不能影响拦截本身。
		}
	};

	pi.on("turn_start", (_event, ctx) => {
		const worst = worstTokensPerRequest(ctx.model);
		if (tryReserve(state, limits, keyOf(ctx, "turn"), 1, worst)) return;
		record(ctx, "turn_start", { worst: worst ?? null });
		ctx.abort();
	});

	pi.on("message_end", (event, ctx) => {
		const msg = event.message as { role?: string; usage?: unknown };
		if (msg.role !== "assistant" || !msg.usage) return;
		settle(state, keyOf(ctx, "turn"), 1, usageTokens(msg.usage));
	});

	pi.on("session_before_compact", (_event, ctx) => {
		const worst = worstTokensPerRequest(ctx.model);
		const tokens = worst === undefined ? undefined : worst * COMPACTION_MAX_REQUESTS;
		if (tryReserve(state, limits, keyOf(ctx, "compact"), COMPACTION_MAX_REQUESTS, tokens)) return undefined;
		record(ctx, "session_before_compact", { worst: tokens ?? null });
		return { cancel: true };
	});

	pi.on("session_compact", (event, ctx) => {
		const entry = event.compactionEntry as { usage?: unknown; details?: { stats?: { requests?: unknown } } };
		const reported = entry.details?.stats?.requests;
		settle(state, keyOf(ctx, "compact"), typeof reported === "number" && reported >= 1 ? reported : 1, usageTokens(entry.usage));
	});

	// 压缩失败时内部调用的实际用量未知，按预占的最坏值结算，宁可多算。
	pi.on("session_compact_failed", (_event, ctx) => {
		const key = keyOf(ctx, "compact");
		const p = state.pending.get(key);
		if (p) settle(state, key, p.requests, p.tokens);
	});
}
