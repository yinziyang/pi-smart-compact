import assert from "node:assert/strict";
import { test } from "node:test";
import { utf8Bytes } from "../budget.ts";
import { PACK_CLOSE, PACK_OPEN } from "../pack.ts";
import { goodSummary, readNotes, run, say, type Entry } from "./harness.ts";

/** 连续读 notes.md 直到触发阈值压缩，再给出最终回答。 */
const readUntil = (reads: number) => (n: number) => (n < reads ? readNotes() : say("整理完成"));

const own = (e: Entry) => (e.details as { smartCompact?: number } | undefined)?.smartCompact === 1;

test("阈值压缩由本扩展接管：模型输出模式下摘要含完整压缩包，细节字段齐全，任务继续完成", async () => {
	const r = await run({ steps: ["读 notes.md 多次并整理"], chat: readUntil(14) });
	assert.ok(r.compactions.length >= 1, "应发生压缩");
	const c = r.compactions[0];
	assert.ok(own(c));
	const d = c.details as Record<string, unknown>;
	assert.equal(d.reason, "threshold");
	assert.equal(d.mode, "model");
	assert.equal(d.fallback, false);
	const summary = String(c.summary);
	assert.ok(summary.includes("## Goal") && summary.includes(PACK_OPEN) && summary.includes(PACK_CLOSE));
	assert.ok((d.stats as { requests: number }).requests >= 1);
	assert.ok(r.handoffs.length >= 1, "应写交接文档");
	const last = r.entries.filter((e) => e.type === "message" && (e.message as { role?: string }).role === "assistant").at(-1);
	assert.match(JSON.stringify(last?.message), /整理完成/);
	// 摘要请求的思考等级为 off 时，faux 不会收到 reasoning 选项；这里检查请求确实是一次摘要调用。
	assert.ok(r.requests.some((q) => q.summary));
});

test("本地模式：压缩包由扩展追加，字节数不超过 Pb", async () => {
	const r = await run({ steps: ["读 notes.md 多次并整理"], chat: readUntil(14), config: { byteBpeProviders: ["faux"] } });
	const c = r.compactions[0];
	const d = c.details as { mode: string; budget: { Pb: number } };
	assert.equal(d.mode, "local");
	const summary = String(c.summary);
	const pack = summary.slice(summary.indexOf(PACK_OPEN));
	assert.ok(utf8Bytes(pack) <= d.budget.Pb);
	// 本地模式的摘要请求不带压缩包数据。
	assert.ok(r.requests.filter((q) => q.summary).every((q) => !q.text.includes(PACK_OPEN)));
});

test("第一次摘要缺章节时带着说明重试一次", async () => {
	const r = await run({
		steps: ["读 notes.md 多次并整理"],
		chat: readUntil(14),
		summary: (n, req) => (n === 0 ? say("## Goal\n只有目标") : goodSummary(req)),
	});
	const sums = r.requests.filter((q) => q.summary);
	assert.ok(sums.length >= 2);
	assert.match(sums[1].text, /缺少章节/);
	assert.equal((r.compactions[0].details as { fallback: boolean }).fallback, false);
});

test("故障注入 main：走受控回退并标记", async () => {
	const r = await run({ steps: ["读 notes.md 多次并整理"], chat: readUntil(14), env: { PI_SMART_COMPACT_FAULT: "main" }, summary: (_n, req) => say(`回退摘要\n- [h1] 交接文档 ${/交接文档路径 (\S+) 与/.exec(req.text)?.[1] ?? ""}，recall_history 可取回原文`) });
	const c = r.compactions[0];
	assert.ok(own(c));
	assert.equal((c.details as { fallback: boolean }).fallback, true);
});

test("故障注入 all：阈值压缩被取消、运行被中止、进入 R5，之后的普通输入被拦截", async () => {
	const r = await run({ steps: ["读 notes.md 多次并整理", "继续"], chat: readUntil(30), env: { PI_SMART_COMPACT_FAULT: "all" } });
	assert.equal(r.compactions.length, 0);
	const state = r.entries.filter((e) => e.type === "custom" && e.customType === "smart-compact").at(-1);
	assert.equal((state?.data as { r5?: { reason: string } }).r5?.reason, "failed");
	// 第二条输入被拦截，不进入会话。
	assert.ok(!r.entries.some((e) => e.type === "message" && (e.message as { role?: string; content?: unknown }).role === "user" && JSON.stringify((e.message as { content?: unknown }).content).includes("继续")));
	const chatsAfterStop = r.requests.filter((q) => !q.summary).length;
	assert.ok(chatsAfterStop < 30);
});
