import assert from "node:assert/strict";
import { test } from "node:test";
import { usageFromSessionText } from "../eval/session-usage.ts";

const line = (o: unknown) => JSON.stringify(o);

test("汇总 assistant 与 compaction 的用量，忽略其他条目", () => {
	const text = [
		line({ type: "session", id: "s" }),
		line({ type: "message", message: { role: "user", content: "hi" } }),
		line({ type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 100, cacheWrite: 2, cost: { total: 0.5 } } } }),
		line({ type: "message", message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } } }),
		line({ type: "compaction", usage: { input: 50, output: 20, cost: { total: 0.25 } }, details: { stats: { requests: 3 } } }),
		line({ type: "branch_summary", usage: { input: 5, output: 5 } }),
	].join("\n");
	assert.deepEqual(usageFromSessionText(text), {
		requests: 6,
		inputTokens: 112 + 1 + 50 + 5,
		outputTokens: 5 + 1 + 20 + 5,
		billedTokens: 112 + 1 + 50 + 5 + 5 + 1 + 20 + 5,
		costUsd: 0.75,
	});
});

test("任何一行无法解析时返回 null", () => {
	assert.equal(usageFromSessionText(`${line({ type: "session" })}\n{坏`), null);
});

test("字段缺失或为负数时按 0 计", () => {
	const text = line({ type: "message", message: { role: "assistant", usage: { input: -5, output: "x" } } });
	assert.deepEqual(usageFromSessionText(text), { requests: 1, inputTokens: 0, outputTokens: 0, billedTokens: 0, costUsd: 0 });
});
