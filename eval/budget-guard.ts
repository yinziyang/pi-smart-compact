// 仅用于测试与评测的 pi 扩展：在子进程内部执行本次预留的请求数与 token 上限（方案第 13 节第 0 步）。
//
// 由协调脚本加载（一般用 `-e eval/budget-guard.ts`；涉及子会话时改为经 packages 或 agentDir/extensions 安装），并通过环境变量传入本次预留：
//   - PI_BUDGET_MAX_REQUESTS：本进程允许的 provider 请求次数上限，正整数。
//   - PI_BUDGET_MAX_BILLED_TOKENS：本进程允许的计费 token 上限，正整数。
//   - PI_BUDGET_GUARD_LOG：可选，每次拦截追加一行 JSON 记录，供协调脚本确认守卫是否触发。
// 两个上限缺任一个或格式不对时，守卫在每个回合开始时都中止，宁可不跑也不越界。
//
// 上限靠「调用前预占」加「超支即停」保证：
//   - 每次 turn_start（位于回合开始前的压缩检查之后、provider 请求之前，方案 S10）先同步预占 1 次请求与该次请求的最坏 token，预占后的合计不超过上限才放行，否则 ctx.abort()。
//   - 单次请求的预占 token = 模型窗口 + 模型的 maxTokens。这两个值来自 pi 的模型元数据，不是服务端的硬限制（实测服务端接受过超过标注窗口的输入），所以它只是预占额度，不是可证明的上界；窗口或 maxTokens 未知时拒绝调用。
//   - 超支即停：任何一次结算发现实际用量超过预占，或用量无法核实，守卫进入「超支」状态，之后所有预占都失败，进程内不再发出任何请求，并在日志中记录。总用量因此最多超出上限一次请求的量。
//   - JS 单线程执行 handler，检查与预占在同一个同步段内完成，并行运行的子会话不会同时通过同一份剩余额度。
//   - 该会话的下一条 assistant 记录（message_end）到达时，用实际用量替换预占；被中止的伪记录同样计 1 次尝试，宁可多算。usage 缺失或任一字段不是有限非负数时，按预占的最坏值结算并进入超支状态。
//   - 压缩内部的请求不经过 turn_start，在 session_before_compact 中按「12 次 × 单次最坏 token」预占，不够时取消该次压缩。压缩成功时，compaction 条目带有完整 usage 与 details.stats.requests 才按实际值结算，否则按预占的最坏值结算并进入超支状态；压缩失败或被取消时按预占的最坏值记账。
//   - 守卫必须先于其他扩展加载（协调脚本把它放在第一个 -e，或 packages 列表的第一项），它的 session_before_compact 才会先于产生摘要调用的 handler 执行。
//   - 不经过上述事件的模型调用（例如 pi-goal 评估者在 agent_end 中的调用）守卫无法事先拦截；它们每次运行结束最多一次，由协调脚本在预留中计入，并由结算时的超支检测兜底。
//   - 虚拟模型的阈值压缩发生在 prepareRequest 中、晚于 turn_start（方案 F2），此时本回合的请求预占已经完成，压缩预占另行计算。
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
	/** 一旦发现实际用量超过预占或无法核实，置为真，此后不再放行任何请求。 */
	overrun: boolean;
}

/** 单次压缩内部的请求次数上限，与方案 5.2 一致。 */
export const COMPACTION_MAX_REQUESTS = 12;

const STATE_KEY = Symbol.for("pi-smart-compact.budget-guard.state");

function sharedState(): GuardState {
	const g = globalThis as { [STATE_KEY]?: GuardState };
	g[STATE_KEY] ??= { requests: 0, billedTokens: 0, pending: new Map(), overrun: false };
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
	if (!limits || tokens === undefined || state.overrun || state.pending.has(key)) return false;
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

/**
 * 结算 key 的预占。actual 为 undefined 表示无法核实，按预占的最坏值结算并进入超支状态。
 * 实际用量超过预占时同样进入超支状态。没有预占时直接累加实际用量（无法核实则无从累加，只进入超支状态）。
 * 返回结算后是否处于超支状态。
 */
export function settle(state: GuardState, key: string, actual: { requests: number; tokens: number } | undefined): boolean {
	const reserved = state.pending.get(key);
	state.pending.delete(key);
	const used = actual ?? reserved;
	if (used) {
		state.requests += used.requests;
		state.billedTokens += used.tokens;
	}
	if (actual === undefined || (reserved && (actual.requests > reserved.requests || actual.tokens > reserved.tokens))) state.overrun = true;
	return state.overrun;
}

/** 完整 usage 的 token 合计；usage 缺失或任一字段不是有限非负数时返回 undefined。 */
export function usageTokens(usage: unknown): number | undefined {
	if (!usage || typeof usage !== "object") return undefined;
	const u = usage as Record<string, unknown>;
	let total = 0;
	for (const f of ["input", "output", "cacheRead", "cacheWrite"]) {
		const v = u[f];
		if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return undefined;
		total += v;
	}
	return total;
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
		if (msg.role !== "assistant") return;
		const tokens = usageTokens(msg.usage);
		if (settle(state, keyOf(ctx, "turn"), tokens === undefined ? undefined : { requests: 1, tokens })) record(ctx, "overrun", { tokens: tokens ?? null });
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
		const tokens = usageTokens(entry.usage);
		const ok = typeof reported === "number" && Number.isInteger(reported) && reported >= 1 && tokens !== undefined;
		if (settle(state, keyOf(ctx, "compact"), ok ? { requests: reported, tokens } : undefined)) record(ctx, "overrun", { compaction: true });
	});

	// 压缩失败或被取消时内部调用的实际用量未知，按预占的最坏值记账。这样记账已经是安全的，不进入超支状态，以免一次正常的取消停掉整个运行。
	pi.on("session_compact_failed", (_event, ctx) => {
		const key = keyOf(ctx, "compact");
		const reserved = state.pending.get(key);
		if (reserved) settle(state, key, reserved);
	});
}
