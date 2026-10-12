import assert from "node:assert/strict";
import { test } from "node:test";
import { utf8Bytes } from "../budget.ts";
import { PACK_CLOSE, PACK_OPEN } from "../pack.ts";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
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

const userTexts = (entries: Entry[]) => entries.filter((e) => e.type === "message" && (e.message as { role?: string }).role === "user").map((e) => JSON.stringify((e.message as { content?: unknown }).content));
const toolResults = (entries: Entry[], name: string) => entries.filter((e) => e.type === "message" && (e.message as { role?: string; toolName?: string }).role === "toolResult" && (e.message as { toolName?: string }).toolName === name).map((e) => JSON.stringify((e.message as { content?: unknown }).content));

test("手动 /compact：参数作为最高优先级侧重点进入唯一一次摘要调用", async () => {
	const r = await run({
		steps: ["读 notes.md 几次", async (s) => void (await s.compact("重点保留数据库迁移细节"))],
		chat: (n) => (n < 6 ? readNotes() : say("好的")),
	});
	const c = r.compactions.at(-1)!;
	assert.equal((c.details as { reason: string }).reason, "manual");
	const sums = r.requests.filter((q) => q.summary);
	assert.equal(sums.length, 1);
	assert.match(sums[0].text, /最高优先级（用户 \/compact 指定）：重点保留数据库迁移细节/);
});

test("recall_history：压缩后能按关键词与 entryId 取回被摘要部分的原文", async () => {
	const r = await run({
		steps: ["暗号是 ZEBRA42，先读 notes.md 多次"],
		chat: (n) => {
			if (n < 14) return readNotes();
			if (n === 14) return fauxAssistantMessage(fauxToolCall("recall_history", { query: "zebra42" }), { stopReason: "toolUse" });
			return say("暗号是 ZEBRA42");
		},
	});
	assert.ok(r.compactions.length >= 1);
	const out = toolResults(r.entries, "recall_history");
	assert.equal(out.length, 1);
	assert.match(out[0], /ZEBRA42/);
	assert.match(out[0], /\[[0-9a-f]+\] user/);
});

test("溢出恢复（length）：被省略的执行记录写进 details.omittedAttempt，并能经 recall_history 取回", async () => {
	const r = await run({ steps: ["读 notes.md 多次", "写一篇长文"], chat: (n) => {
			if (n < 6) return readNotes();
			if (n === 6) return say("已读");
			if (n === 7) return fauxAssistantMessage(fauxText("这是一段被截断的长文 OMEGA77"), { stopReason: "length" });
			if (n === 8) return fauxAssistantMessage(fauxToolCall("recall_history", { query: "OMEGA77" }), { stopReason: "toolUse" });
			return say("完成");
		} });
	const c = r.compactions.find((x) => (x.details as { reason?: string }).reason === "overflow");
	assert.ok(c, `应有 overflow 压缩，实际 ${r.compactions.map((x) => (x.details as { reason?: string }).reason).join(",")}；${r.logs.join(" | ")}`);
	const om = (c.details as { omittedAttempt?: { records: unknown[] } }).omittedAttempt;
	assert.ok(om && om.records.length >= 1);
	const out = toolResults(r.entries, "recall_history");
	assert.match(out[0] ?? "", /OMEGA77/);
	assert.match(out[0] ?? "", /溢出恢复省略/);
});

test("溢出恢复但 pi 没有可压缩的内容：agent_settled 写入恢复条目，带开窗与关窗标记，之后可召回", async () => {
	const r = await run({ steps: ["读 notes.md 多次", "写一篇长文", "找回刚才的长文"], chat: (n) => {
			if (n < 2) return readNotes();
			if (n === 2) return say("已读");
			if (n === 3) return fauxAssistantMessage(fauxText("这是一段被截断的长文 OMEGA77"), { stopReason: "length" });
			if (n === 4) return fauxAssistantMessage(fauxToolCall("recall_history", { query: "OMEGA77" }), { stopReason: "toolUse" });
			return say("完成");
		} });
	assert.equal(r.compactions.length, 0);
	assert.ok(r.entries.some((e) => e.type === "custom" && e.customType === "smart-compact-window"));
	assert.ok(r.entries.some((e) => e.type === "custom" && e.customType === "smart-compact-window-close"));
	const recov = r.entries.filter((e) => e.type === "custom" && e.customType === "smart-compact-recovery");
	assert.equal(recov.length, 1);
	assert.match(toolResults(r.entries, "recall_history")[0] ?? "", /OMEGA77/);
});

test("R3：自动压缩次数达上限后进入 R5，之后的普通输入被拦截", async () => {
	const r = await run({ steps: ["读 notes.md 多次", "第二个问题"], chat: readUntil(14), config: { maxAutoCompactions: 1 } });
	assert.equal(r.compactions.length, 1);
	const state = r.entries.filter((e) => e.type === "custom" && e.customType === "smart-compact").at(-1);
	assert.equal((state?.data as { r5?: { reason: string } }).r5?.reason, "count");
	assert.ok(!userTexts(r.entries).some((t) => t.includes("第二个问题")));
	// 进入 R5 时立即中止当前运行：压缩之后不再有发给主模型的请求。
	const sumAt = r.requests.findIndex((q) => q.summary);
	assert.equal(r.requests.slice(sumAt + 1).filter((q) => !q.summary).length, 0);
});

test("历史被修改：发现失效的那次请求前立即重建，模型看到的是新摘要，重建结果以 compaction 落盘，被删除的内容不进入新摘要", async () => {
	let edited = false;
	const editor: ExtensionFactory = (pi) => {
		pi.on("turn_end", (_e, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			if (edited || !branch.some((x) => x.type === "compaction")) return undefined;
			const first = branch.find((x) => x.type === "message" && (x as { message: { role: string } }).message.role === "user");
			if (!first) return undefined;
			edited = true;
			return { entries: [{ type: "context_edit", targetId: first.id, replacement: null }] };
		});
	};
	const r = await run({ steps: ["机密词 SECRETWORD9，读 notes.md 多次"], chat: readUntil(16), factories: [editor] });
	assert.ok(edited, "测试扩展应已追加 context_edit");
	assert.ok(r.entries.some((e) => e.type === "custom" && e.customType === "smart-compact-invalidated"));
	const rebuilt = r.compactions.find((c) => (c.details as { rebuild?: boolean }).rebuild);
	assert.ok(rebuilt, r.logs.join(" | "));
	assert.ok(!String(rebuilt.summary).includes("SECRETWORD9"));
	const sums = r.requests.filter((q) => q.summary);
	assert.ok(!sums.at(-1)!.text.includes("SECRETWORD9"), "重建请求不应包含被删除的内容");
	const state = r.entries.filter((e) => e.type === "custom" && e.customType === "smart-compact").at(-1);
	assert.equal((state?.data as { r5?: unknown }).r5 ?? null, null);
	const recs = (state?.data as { records: Record<string, { reason: string }[]> }).records["faux/m"];
	assert.equal(recs.at(-1)?.reason, "rebuild");
	// 重建之后发给主模型的请求都不含被删除的内容，也不含旧摘要。
	const rebuildAt = r.requests.lastIndexOf(sums.at(-1)!);
	const after = r.requests.slice(rebuildAt + 1).filter((q) => !q.summary);
	assert.ok(after.length >= 1);
	assert.ok(after.every((q) => !q.all.includes("SECRETWORD9")));
});

test("历史被修改且重建失败：进入 R5，模型只看到固定短通知，之后的输入被拦截", async () => {
	let edited = false;
	const editor: ExtensionFactory = (pi) => {
		pi.on("turn_end", (_e, ctx) => {
			const branch = ctx.sessionManager.getBranch();
			if (edited || !branch.some((x) => x.type === "compaction")) return undefined;
			const first = branch.find((x) => x.type === "message" && (x as { message: { role: string } }).message.role === "user");
			if (!first) return undefined;
			edited = true;
			return { entries: [{ type: "context_edit", targetId: first.id, replacement: null }] };
		});
	};
	let sums = 0;
	const r = await run({ steps: ["机密词 SECRETWORD9，读 notes.md 多次", "继续"], chat: readUntil(16), factories: [editor], summary: (_n, req) => (sums++ === 0 ? goodSummary(req) : say("坏")) });
	const state = r.entries.filter((e) => e.type === "custom" && e.customType === "smart-compact").at(-1);
	assert.equal((state?.data as { r5?: { reason: string } }).r5?.reason, "history");
	assert.ok(!userTexts(r.entries).some((t) => t.includes("继续")));
	assert.equal(r.compactions.filter((c) => (c.details as { rebuild?: boolean }).rebuild).length, 0);
});

test("被 context_edit 删除的工具结果不进入摘要请求、压缩包、交接文档与召回结果", async () => {
	const deleter: ExtensionFactory = (pi) => {
		pi.on("turn_end", (e) => {
			const text = JSON.stringify(e.toolResults);
			if (!text.includes("DELETEME")) return undefined;
			return { entries: e.toolResultEntryIds.map((id) => ({ type: "context_edit" as const, targetId: id, replacement: null })) };
		});
	};
	const r = await run({
		steps: ["先执行 echo，再读 notes.md 多次"],
		chat: (n) => {
			if (n === 0) return fauxAssistantMessage(fauxToolCall("bash", { command: "echo DELETEME" }), { stopReason: "toolUse" });
			if (n < 15) return readNotes();
			if (n === 15) return fauxAssistantMessage(fauxToolCall("recall_history", { query: "DELETEME" }), { stopReason: "toolUse" });
			return say("完成");
		},
		factories: [deleter],
	});
	assert.ok(r.compactions.length >= 1);
	assert.ok(r.entries.some((e) => e.type === "context_edit"), "测试扩展应已删除 echo 的结果");
	assert.ok(r.requests.some((q) => !q.summary && q.all.includes("DELETEME")), "删除之前模型应见过它，否则本用例不成立");
	// 命令本身在 assistant 的工具调用里，只检查被删除的输出行（echo 的结果原文以换行结尾）。
	const leaked = (s: string) => /DELETEME\\n|"text":"DELETEME/.test(s) || s.split("\n").some((l) => l.trim() === "DELETEME");
	assert.ok(r.requests.filter((q) => q.summary).every((q) => !leaked(q.text)));
	assert.ok(r.handoffTexts.every((t) => !t.split("\n").some((l) => l.trim() === "│ DELETEME" || l.trim() === "DELETEME")));
	assert.ok(!toolResults(r.entries, "recall_history").some((t) => /toolResult\(bash\)/.test(t)));
});

test("脱敏：送给摘要模型的输入、交接文档与召回结果都不含密钥原文", async () => {
	const key = ["sk-", "abcdefghijklmnop1234"].join("");
	const r = await run({
		steps: [`配置里的密钥是 ${key}，读 notes.md 多次`],
		chat: (n) => {
			if (n < 14) return readNotes();
			if (n === 14) return fauxAssistantMessage(fauxToolCall("recall_history", { query: "密钥" }), { stopReason: "toolUse" });
			return say("完成");
		},
	});
	assert.ok(r.compactions.length >= 1);
	assert.ok(r.requests.filter((q) => q.summary).every((q) => !q.text.includes(key)));
	assert.ok(r.handoffTexts.every((t) => !t.includes(key)));
	assert.ok(r.compactions.every((c) => !JSON.stringify(c).includes(key)));
	const out = toolResults(r.entries, "recall_history");
	assert.match(out[0] ?? "", /已脱敏/);
	assert.ok(!out[0]?.includes(key));
});

test("虚拟模型：声明窗口大于实际路由的物理窗口时，即使响应失败也进入 R5 并拦截后续输入", async () => {
	const virtual: ExtensionFactory = (pi) => {
		pi.registerVirtualModel({
			provider: "v",
			id: "auto",
			name: "V Auto",
			route(_req, ctx) {
				const model = ctx.modelRegistry.find("faux", "small");
				if (!model) throw new Error("找不到 faux/small");
				return { model, thinkingLevel: "off" };
			},
		});
	};
	const r = await run({
		steps: ["你好", "第二个问题"],
		extraModels: [{ id: "small", contextWindow: 30_000, maxTokens: 8_000 }],
		config: { virtualWindowTokens: { "v/auto": 60_000 } },
		factories: [virtual],
		setup: async (session, runtime) => {
			const v = runtime.getModel("v", "auto");
			if (!v) throw new Error("虚拟模型未注册");
			await session.setModel(v);
		},
		chat: () => fauxAssistantMessage(fauxText(""), { stopReason: "error", errorMessage: "boom" }),
	});
	const state = r.entries.filter((e) => e.type === "custom" && e.customType === "smart-compact").at(-1);
	assert.equal((state?.data as { r5?: { reason: string } }).r5?.reason, "virtual", r.logs.join(" | "));
	assert.ok(!userTexts(r.entries).some((t) => t.includes("第二个问题")));
});

test("recall_history 的参数校验错误与找不到条目的回显都经脱敏并限长", async () => {
	const key = ["sk-", "abcdefghijklmnop1234"].join("");
	const r = await run({
		steps: ["试试召回"],
		chat: (n) => {
			if (n === 0) return fauxAssistantMessage(fauxToolCall("recall_history", { entryId: "x".repeat(20000) }), { stopReason: "toolUse" });
			if (n === 1) return fauxAssistantMessage(fauxToolCall("recall_history", { query: "", entryId: key }), { stopReason: "toolUse" });
			return say("完成");
		},
	});
	const outs = r.entries.filter((e) => e.type === "message" && (e.message as { role?: string; toolName?: string }).role === "toolResult" && (e.message as { toolName?: string }).toolName === "recall_history").map((e) => (e.message as { content: { text: string }[] }).content.map((c) => c.text).join(""));
	assert.equal(outs.length, 2);
	assert.ok(outs[0].length <= 10000, String(outs[0].length));
	assert.ok(!outs[1].includes(key));
});

test("recall_history：校验错误不回显 JSON 参数里的秘密，历史工具参数按键名脱敏后才进入召回结果", async () => {
	const r = await run({
		steps: ["登录后再召回"],
		chat: (n) => {
			if (n === 0) return fauxAssistantMessage(fauxToolCall("bash", { command: "echo hi", password: ["alpha beta", "gamma"] }), { stopReason: "toolUse" });
			if (n === 1) return fauxAssistantMessage(fauxToolCall("recall_history", { entryId: 'password="alpha beta"' }), { stopReason: "toolUse" });
			if (n === 2) return fauxAssistantMessage(fauxToolCall("recall_history", { query: "echo" }), { stopReason: "toolUse" });
			return say("完成");
		},
	});
	const outs = r.entries.filter((e) => e.type === "message" && (e.message as { toolName?: string; role?: string }).role === "toolResult" && (e.message as { toolName?: string }).toolName === "recall_history").map((e) => JSON.stringify((e.message as { content: unknown }).content));
	assert.equal(outs.length, 2);
	for (const o of outs) assert.ok(!o.includes("alpha beta") && !o.includes("gamma"), o);
	assert.match(outs[1], /echo hi/);
});
