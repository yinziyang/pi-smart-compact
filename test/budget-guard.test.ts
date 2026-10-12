import assert from "node:assert/strict";
import { test } from "node:test";
import budgetGuard, { COMPACTION_MAX_REQUESTS, type GuardState, readGuardLimits, resetGuardState, settle, tryReserve, usageTokens, worstTokensPerRequest } from "../eval/budget-guard.ts";

const fresh = (): GuardState => ({ requests: 0, billedTokens: 0, pending: new Map(), overrun: false });

test("readGuardLimits：两项都是正整数才有效", () => {
	assert.deepEqual(readGuardLimits({ PI_BUDGET_MAX_REQUESTS: "3", PI_BUDGET_MAX_BILLED_TOKENS: "1000" }), { maxRequests: 3, maxBilledTokens: 1000 });
	assert.equal(readGuardLimits({ PI_BUDGET_MAX_REQUESTS: "3" }), undefined);
	assert.equal(readGuardLimits({ PI_BUDGET_MAX_REQUESTS: "0", PI_BUDGET_MAX_BILLED_TOKENS: "1" }), undefined);
	assert.equal(readGuardLimits({ PI_BUDGET_MAX_REQUESTS: "1.5", PI_BUDGET_MAX_BILLED_TOKENS: "1" }), undefined);
	assert.equal(readGuardLimits({ PI_BUDGET_MAX_REQUESTS: "-1", PI_BUDGET_MAX_BILLED_TOKENS: "1" }), undefined);
});

test("worstTokensPerRequest：窗口加 maxTokens，任一未知时无法给出上界", () => {
	assert.equal(worstTokensPerRequest({ contextWindow: 20_000, maxTokens: 8_000 }), 28_000);
	assert.equal(worstTokensPerRequest({ contextWindow: 20_000 }), undefined);
	assert.equal(worstTokensPerRequest({ contextWindow: 0, maxTokens: 8_000 }), undefined);
	assert.equal(worstTokensPerRequest(undefined), undefined);
});

test("tryReserve：并发的两个会话只能有一个拿到最后一份请求额度", () => {
	const s = fresh();
	const limits = { maxRequests: 2, maxBilledTokens: 1_000_000 };
	assert.equal(tryReserve(s, limits, "parent:turn", 1, 100), true);
	assert.equal(tryReserve(s, limits, "childA:turn", 1, 100), true);
	assert.equal(tryReserve(s, limits, "childB:turn", 1, 100), false);
	settle(s, "childA:turn", { requests: 1, tokens: 10 });
	assert.equal(tryReserve(s, limits, "childB:turn", 1, 100), false, "已结算的请求仍占用请求数");
});

test("tryReserve：单次最坏 token 超出剩余额度时拒绝，结算后按实际值释放", () => {
	const s = fresh();
	const limits = { maxRequests: 100, maxBilledTokens: 50_000 };
	assert.equal(tryReserve(s, limits, "a:turn", 1, 28_000), true);
	assert.equal(tryReserve(s, limits, "b:turn", 1, 28_000), false, "在途预占合计 56000 超过 50000");
	settle(s, "a:turn", { requests: 1, tokens: 2_000 });
	assert.equal(tryReserve(s, limits, "b:turn", 1, 28_000), true);
	assert.equal(s.billedTokens, 2_000);
});

test("tryReserve：没有上限、无法给出最坏值、同一会话重复预占都拒绝", () => {
	const s = fresh();
	assert.equal(tryReserve(s, undefined, "a", 1, 1), false);
	assert.equal(tryReserve(s, { maxRequests: 9, maxBilledTokens: 9 }, "a", 1, undefined), false);
	assert.equal(tryReserve(s, { maxRequests: 9, maxBilledTokens: 99 }, "a", 1, 1), true);
	assert.equal(tryReserve(s, { maxRequests: 9, maxBilledTokens: 99 }, "a", 1, 1), false);
});

type Handler = (event: unknown, ctx: unknown) => unknown;

function load(env: Record<string, string | undefined>, opts: { fresh?: boolean; session?: string; model?: { contextWindow: number; maxTokens: number } } = {}) {
	if (opts.fresh !== false) resetGuardState();
	const handlers = new Map<string, Handler>();
	const saved = { ...process.env };
	// process.env 会把 undefined 转成字符串 "undefined"，所以 undefined 的项要删除而不是赋值。
	for (const [k, v] of Object.entries(env)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	try {
		budgetGuard({ on: (name: string, h: Handler) => handlers.set(name, h) } as never);
	} finally {
		for (const k of Object.keys(env)) {
			if (saved[k] === undefined) delete process.env[k];
			else process.env[k] = saved[k];
		}
	}
	let aborted = 0;
	const ctx = {
		abort: () => void aborted++,
		model: opts.model ?? { contextWindow: 1_000, maxTokens: 100 },
		sessionManager: { getSessionId: () => opts.session ?? "s" },
	};
	return {
		emit: (name: string, event: unknown) => handlers.get(name)?.(event, ctx),
		aborted: () => aborted,
	};
}

const FULL = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0 };
const ENV = { PI_BUDGET_MAX_REQUESTS: "3", PI_BUDGET_MAX_BILLED_TOKENS: "1000000", PI_BUDGET_GUARD_LOG: undefined };

test("扩展：每个回合开始前预占，响应后结算，到上限后中止", () => {
	const g = load(ENV);
	for (let i = 0; i < 3; i++) {
		g.emit("turn_start", {});
		g.emit("message_end", { message: { role: "assistant", usage: FULL } });
	}
	assert.equal(g.aborted(), 0);
	g.emit("turn_start", {});
	assert.equal(g.aborted(), 1);
});

test("扩展：父子会话共享计数，并发的两个子会话不能同时用掉最后一份额度", () => {
	const parent = load(ENV, { session: "p" });
	const childA = load(ENV, { fresh: false, session: "a" });
	const childB = load(ENV, { fresh: false, session: "b" });
	parent.emit("turn_start", {});
	parent.emit("message_end", { message: { role: "assistant", usage: FULL } });
	childA.emit("turn_start", {});
	childB.emit("turn_start", {});
	assert.equal(childA.aborted(), 0);
	assert.equal(childB.aborted(), 0);
	parent.emit("turn_start", {});
	assert.equal(parent.aborted(), 1, "在途的 childA 与 childB 已占满剩余额度");
});

test("扩展：压缩按 12 次最坏值预占，不够时取消；失败后按最坏值结算", () => {
	const g = load({ PI_BUDGET_MAX_REQUESTS: "20", PI_BUDGET_MAX_BILLED_TOKENS: String(13 * 1_100), PI_BUDGET_GUARD_LOG: undefined });
	assert.equal(g.emit("session_before_compact", {}), undefined);
	g.emit("session_compact_failed", {});
	assert.deepEqual(g.emit("session_before_compact", {}), { cancel: true }, `已按 ${COMPACTION_MAX_REQUESTS} 次最坏值结算，剩余额度不足`);
});

test("扩展：环境变量缺失或模型窗口未知时第一个回合就中止", () => {
	const g1 = load({ PI_BUDGET_MAX_REQUESTS: undefined, PI_BUDGET_MAX_BILLED_TOKENS: undefined });
	g1.emit("turn_start", {});
	assert.equal(g1.aborted(), 1);
	const g2 = load(ENV, { model: { contextWindow: 0, maxTokens: 0 } });
	g2.emit("turn_start", {});
	assert.equal(g2.aborted(), 1);
});

test("usageTokens：缺失、缺字段、NaN、Infinity、负数都无法核实", () => {
	assert.equal(usageTokens({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }), 10);
	assert.equal(usageTokens(undefined), undefined);
	assert.equal(usageTokens({ input: 1, output: 2, cacheRead: 3 }), undefined);
	assert.equal(usageTokens({ input: Number.NaN, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
	assert.equal(usageTokens({ input: Number.POSITIVE_INFINITY, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
	assert.equal(usageTokens({ input: -1, output: 0, cacheRead: 0, cacheWrite: 0 }), undefined);
});

test("settle：实际超过预占或无法核实时进入超支状态，此后一律拒绝预占", () => {
	const limits = { maxRequests: 100, maxBilledTokens: 1_000_000 };
	const s1 = fresh();
	tryReserve(s1, limits, "a", 1, 100);
	assert.equal(settle(s1, "a", { requests: 1, tokens: 101 }), true);
	assert.equal(tryReserve(s1, limits, "b", 1, 1), false);
	const s2 = fresh();
	tryReserve(s2, limits, "a", 1, 100);
	assert.equal(settle(s2, "a", undefined), true);
	assert.equal(s2.billedTokens, 100, "无法核实时按预占的最坏值记账");
	const s3 = fresh();
	tryReserve(s3, limits, "a", 1, 100);
	assert.equal(settle(s3, "a", { requests: 1, tokens: 100 }), false, "恰好等于预占不算超支");
});

test("扩展：usage 不完整的响应按最坏值结算并停止后续请求", () => {
	const g = load(ENV);
	g.emit("turn_start", {});
	g.emit("message_end", { message: { role: "assistant", usage: { input: 1 } } });
	g.emit("turn_start", {});
	assert.equal(g.aborted(), 1);
});

test("扩展：压缩成功但缺少 stats.requests 或 usage 不完整时按最坏值结算并停止；压缩失败只按最坏值记账、不停止", () => {
	const big = { PI_BUDGET_MAX_REQUESTS: "100", PI_BUDGET_MAX_BILLED_TOKENS: "100000000", PI_BUDGET_GUARD_LOG: undefined };
	const g1 = load(big);
	g1.emit("session_before_compact", {});
	g1.emit("session_compact", { compactionEntry: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } });
	g1.emit("turn_start", {});
	assert.equal(g1.aborted(), 1);
	const g2 = load(big);
	g2.emit("session_before_compact", {});
	g2.emit("session_compact", { compactionEntry: { usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, details: { stats: { requests: 2 } } } });
	g2.emit("turn_start", {});
	assert.equal(g2.aborted(), 0);
	const g3 = load(big);
	g3.emit("session_before_compact", {});
	g3.emit("session_compact_failed", {});
	g3.emit("turn_start", {});
	assert.equal(g3.aborted(), 0);
});
