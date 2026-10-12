import assert from "node:assert/strict";
import { test } from "node:test";
import { utf8Bytes } from "../budget.ts";
import { checkStructure, checkUsage, reserveFor, summarize, type GenerateArgs, type GenerateResult, type SummarizeOptions } from "../narrative.ts";

const GOOD = "## Goal\n修复登录 bug 并补测试\n## Constraints & Preferences\n(none)\n## Progress\n### Done\n- [x] 定位到 auth.ts\n## Key Decisions\n(none)\n## Next Steps\n1. 修改 auth.ts 并运行 npm test\n## Critical Context\n(none)";
const MISSING = "## Goal\n修复登录 bug 并补测试\n## Progress\n略";

type Item = string;

function opts(gen: (a: GenerateArgs<Item>, n: number) => GenerateResult, o: Partial<SummarizeOptions<Item>> = {}) {
	const calls: GenerateArgs<Item>[] = [];
	const options: SummarizeOptions<Item> = {
		items: ["消息一", "消息二"],
		itemText: (t) => t,
		truncate: (t, max) => t.slice(0, max),
		note: (t) => t,
		measure: utf8Bytes,
		windowTokens: 272000,
		N: 8192,
		Pt: 9000,
		mode: "local",
		maxRequests: 12,
		deadline: 1e15,
		now: () => 0,
		generate: async (a) => {
			calls.push(a);
			return gen(a, calls.length);
		},
		...o,
	};
	return { options, calls };
}

const ok = (text: string, output = 100): GenerateResult => ({ ok: true, text, usage: { input: 10, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } }, requests: 1 });

test("合格与不合格样例", () => {
	assert.deepEqual(checkStructure(GOOD), []);
	assert.deepEqual(checkStructure(MISSING).sort(), ["## Constraints & Preferences", "## Critical Context", "## Key Decisions", "## Next Steps", "## Progress"].sort());
});

test("usage.output 校验的反例都判为不合格", () => {
	assert.equal(checkUsage({ output: 10 }, "x", 100), null);
	assert.equal(checkUsage({ output: 0 }, "", 100), null);
	for (const u of [undefined, {}, { output: Number.NaN }, { output: Number.POSITIVE_INFINITY }, { output: -1 }, { output: 1.5 }, { output: 101 }]) assert.notEqual(checkUsage(u, "x", 100), null, JSON.stringify(u));
	assert.notEqual(checkUsage({ output: 0 }, "非空", 100), null);
});

test("第一次缺章节、第二次合格；思考等级为字面量 off；reserveTokens 推出的 maxTokens 不超过 N", async () => {
	const { options, calls } = opts((_a, n) => ok(n === 1 ? MISSING : GOOD));
	const r = await summarize(options);
	assert.equal(r.ok, true);
	assert.equal(calls.length, 2);
	assert.match(calls[1].focus!, /缺少章节/);
	for (const c of calls) {
		assert.equal(c.thinkingLevel, "off");
		assert.ok(Math.floor(0.8 * c.reserveTokens) <= 8192);
	}
	assert.equal(reserveFor(4285), 5357);
	assert.ok(r.ok && r.stats.calls === 2 && r.stats.cost === 0.02);
});

test("超长输出重试时追加长度要求；两次都不合格时走受控回退", async () => {
	const { options, calls } = opts((_a, n) => (n <= 2 ? ok(GOOD, 9000) : ok("回退摘要", 50)));
	const r = await summarize(options);
	assert.ok(r.ok && r.fallback);
	assert.match(calls[1].focus!, /上次输出超长/);
	assert.equal(calls.length, 3);
});

test("主路径与受控回退都失败时返回失败；含密钥的输出判为不合格", async () => {
	const key = ["sk-", "abcdefghijklmnop1234"].join("");
	const { options } = opts(() => ok(`${GOOD}\n${key}`));
	const r = await summarize(options);
	assert.equal(r.ok, false);
});

test("故障注入：main 只让主路径失败，all 让两级都失败", async () => {
	const a = await summarize(opts(() => ok(GOOD), { fault: "main" }).options);
	assert.ok(a.ok && a.fallback);
	const b = await summarize(opts(() => ok(GOOD), { fault: "all" }).options);
	assert.equal(b.ok, false);
});

test("待摘要内容超过输入上限时滚动分块，每次调用的输入都不超过上限，单条超长消息被截断", async () => {
	const items = [..."abcdefgh"].map((c) => c.repeat(9000));
	items.push("z".repeat(40000));
	const W = 30000;
	const { options, calls } = opts(() => ok(GOOD), { items, windowTokens: W, N: 4096 });
	const r = await summarize(options);
	assert.ok(r.ok && !r.fallback, JSON.stringify(r));
	assert.ok(calls.length >= 3);
	for (const c of calls) {
		const input = c.items.reduce((a, t) => a + utf8Bytes(t) + 8, 0);
		const limit = W - 4096 - 4096 - 1500 - utf8Bytes(c.focus ?? "") - utf8Bytes(c.previousSummary ?? "") - 1000;
		assert.ok(input <= limit, `${input} > ${limit}`);
	}
	assert.equal(calls[1].previousSummary, GOOD);
});

test("输入上限小于等于 2000 时按失败处理，回退只取最近部分并注明", async () => {
	const { options, calls } = opts(() => ok("回退"), { items: ["a".repeat(20000), "b".repeat(100)], windowTokens: 13000, N: 4096 });
	const r = await summarize(options);
	assert.ok(r.ok && r.fallback);
	assert.match(calls.at(-1)!.items[0], /更早的历史未纳入/);
	assert.equal(calls.at(-1)!.items.at(-1), "b".repeat(100));
});

test("请求数达到上限时停止调用", async () => {
	const { options, calls } = opts(() => ({ ok: true, text: MISSING, usage: { output: 1 }, requests: 3 }), { maxRequests: 6 });
	const r = await summarize(options);
	assert.equal(r.ok, false);
	assert.equal(calls.length, 2);
	assert.ok(!r.ok && r.stats.requests <= 6);
});

test("模型输出模式的受控回退要求 [h1] 行包含交接路径与 recall_history", async () => {
	const { options } = opts((_a, n) => ok(n === 1 ? "无 h1" : "摘要\n- [h1] 交接文档 /tmp/h.md，recall_history 取回"), { mode: "model", fault: "main", handoffPath: "/tmp/h.md" });
	const r = await summarize(options);
	assert.ok(r.ok && r.fallback);
});

test("重试说明计入输入上限：放不下时不发送重试，转入受控回退", async () => {
	const W = 30000;
	const limitFor = (focus: string | undefined) => W - 4096 - 4096 - 1500 - utf8Bytes(focus ?? "") - 1000;
	// 先探测主路径最终调用的侧重点，再把正文调到恰好填满该调用的输入上限，任何重试说明都会让它超限。
	const dry = opts(() => ok(GOOD), { windowTokens: W, N: 4096, items: ["x"] });
	await summarize(dry.options);
	const fill = limitFor(dry.calls[0].focus) - 8;
	const { options, calls } = opts((_a, n) => (n === 1 ? ok(MISSING) : ok("回退")), { windowTokens: W, N: 4096, items: ["a".repeat(fill)] });
	const r = await summarize(options);
	assert.ok(r.ok && r.fallback, JSON.stringify(r));
	assert.equal(calls.length, 2, "不合格之后不应再发送带重试说明的主路径请求");
	assert.ok(!calls[1].focus?.includes("上次输出不合格"));
	for (const c of calls) {
		const input = c.items.reduce((x, t) => x + utf8Bytes(t) + 8, 0);
		assert.ok(input <= limitFor(c.focus));
	}
});
