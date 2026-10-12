import assert from "node:assert/strict";
import { test } from "node:test";
import budgetGuard, { readGuardLimits, shouldBlock } from "../eval/budget-guard.ts";

test("readGuardLimits：两项都是正整数才有效", () => {
	assert.deepEqual(readGuardLimits({ PI_BUDGET_MAX_REQUESTS: "3", PI_BUDGET_MAX_BILLED_TOKENS: "1000" }), { maxRequests: 3, maxBilledTokens: 1000 });
	assert.equal(readGuardLimits({ PI_BUDGET_MAX_REQUESTS: "3" }), undefined);
	assert.equal(readGuardLimits({ PI_BUDGET_MAX_REQUESTS: "0", PI_BUDGET_MAX_BILLED_TOKENS: "1" }), undefined);
	assert.equal(readGuardLimits({ PI_BUDGET_MAX_REQUESTS: "1.5", PI_BUDGET_MAX_BILLED_TOKENS: "1" }), undefined);
	assert.equal(readGuardLimits({ PI_BUDGET_MAX_REQUESTS: "-1", PI_BUDGET_MAX_BILLED_TOKENS: "1" }), undefined);
});

test("shouldBlock：再发一次会超请求数、或 token 已用满时中止；没有上限时一律中止", () => {
	const limits = { maxRequests: 2, maxBilledTokens: 100 };
	assert.equal(shouldBlock({ requests: 0, billedTokens: 0 }, limits), false);
	assert.equal(shouldBlock({ requests: 1, billedTokens: 99 }, limits), false);
	assert.equal(shouldBlock({ requests: 2, billedTokens: 0 }, limits), true);
	assert.equal(shouldBlock({ requests: 0, billedTokens: 100 }, limits), true);
	assert.equal(shouldBlock({ requests: 0, billedTokens: 0 }, undefined), true);
});

type Handler = (event: unknown, ctx: { abort(): void }) => void;

function load(env: Record<string, string | undefined>) {
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
	const ctx = { abort: () => void aborted++ };
	return {
		emit: (name: string, event: unknown) => handlers.get(name)?.(event, ctx),
		aborted: () => aborted,
	};
}

test("扩展：按 assistant 与压缩计数，达到上限后在 turn_start 中止", () => {
	const g = load({ PI_BUDGET_MAX_REQUESTS: "3", PI_BUDGET_MAX_BILLED_TOKENS: "1000000", PI_BUDGET_GUARD_LOG: undefined });
	g.emit("turn_start", {});
	assert.equal(g.aborted(), 0);
	g.emit("message_end", { message: { role: "user" } });
	g.emit("message_end", { message: { role: "assistant", usage: { input: 10, output: 10 } } });
	g.emit("turn_start", {});
	assert.equal(g.aborted(), 0);
	g.emit("session_compact", { compactionEntry: { usage: { input: 5 }, details: { stats: { requests: 2 } } } });
	g.emit("turn_start", {});
	assert.equal(g.aborted(), 1);
});

test("扩展：环境变量缺失时第一个回合就中止", () => {
	const g = load({ PI_BUDGET_MAX_REQUESTS: undefined, PI_BUDGET_MAX_BILLED_TOKENS: undefined });
	g.emit("turn_start", {});
	assert.equal(g.aborted(), 1);
});
