import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { smartCompact } from "../index.ts";
import { runCompaction, type CompactInput } from "../compact.ts";
import { freshModelState } from "../budget.ts";
import { parseConfig } from "../state.ts";
import { checkedProjection } from "../host-contract.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;

function fixture(logThrows = false) {
	const handlers = new Map<string, Handler>();
	const commands = new Map<string, { handler: Handler }>();
	let tool: { execute: (...args: any[]) => any };
	const logs: string[] = [];
	let aborts = 0;
	let appends = 0;
	const branch: any[] = [
		{ type: "message", id: "u0", message: { role: "user", content: "旧内容", timestamp: 0 } },
		{ type: "message", id: "u1", message: { role: "user", content: "保留内容", timestamp: 1 } },
	];
	const manager: Record<string, any> = {
		getSessionId: () => "test-session",
		getLeafId: () => "u1",
		getSessionFile: () => undefined,
		getSessionDir: () => "/nonexistent/smart-contract",
		getBranch: () => branch,
		buildSessionProjection: () => ({ entries: branch.map((sourceEntry) => ({ sourceEntry, messages: sourceEntry.message ? [sourceEntry.message] : [] })) }),
	};
	const ctx = {
		sessionManager: manager,
		modelRegistry: { streamSimple: () => { throw new Error("不得调用模型"); }, find: () => undefined, getAll: () => [], hasConfiguredAuth: () => false },
		model: { api: "fake", provider: "fake", id: "m", contextWindow: 60000, maxTokens: 16000 },
		hasUI: false,
		abort: () => { aborts++; },
		getSystemPrompt: () => "测试",
		getContextUsage: () => ({ tokens: 100 }),
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, handler: Handler) => { handlers.set(name, handler); },
		registerCommand: (name: string, command: { handler: Handler }) => { commands.set(name, command); },
		registerTool: (value: typeof tool) => { tool = value; },
		appendEntry: () => { appends++; },
		getSettings: () => ({ compaction: { reserveTokens: 8000, keepRecentTokens: 20000 } }),
		getActiveTools: () => [],
		getAllTools: () => [],
	} as unknown as ExtensionAPI;
	const env: NodeJS.ProcessEnv = {};
	smartCompact(pi, { now: () => 0, randomId: () => "nonce", agentDir: "/nonexistent/smart-contract", env, piVersion: "1.2.0", log: (s) => { if (logThrows) throw new Error("日志通道不可用"); logs.push(s); } });
	const event: any = { type: "session_before_compact", reason: "manual", willRetry: false, signal: new AbortController().signal, branchEntries: branch, preparation: { settings: { reserveTokens: 8000, keepRecentTokens: 20000 }, tokensBefore: 100, firstKeptEntryId: "u1" } };
	const input: CompactInput = {
		event: { reason: "manual", willRetry: false, signal: event.signal, branchEntries: branch, settings: event.preparation.settings, tokensBefore: 100, fallbackFirstKept: "u1" },
		ctx, config: parseConfig(undefined).config,
		choice: { summaryModel: ctx.model!, summaryWindow: 60000, window: 60000, key: "fake/m", mode: "local", declaredWindow: false },
		modelState: freshModelState(), fEst: 100, omitted: null, rebuild: false, handoffPath: undefined, nonce: "nonce", fault: "all", now: () => 0,
	};
	return { handlers, commands, manager, ctx, event, input, branch, env, logs, counts: () => ({ aborts, appends }), recall: () => tool.execute("id", { query: "旧内容" }, undefined, undefined, ctx) };
}

test("主请求已取消但压缩信号尚未取消时明确返回cancel，不能回退原生摘要", async () => {
	const f = fixture();
	f.env.PI_SMART_COMPACT_FAULT = "all";
	f.event.reason = "threshold";
	Object.defineProperty(f.ctx, "signal", { value: AbortSignal.abort(), configurable: true });
	assert.equal(f.event.signal.aborted, false, "必须覆盖两种取消信号尚未同步的窗口");
	assert.deepEqual(await f.handlers.get("session_before_compact")!(f.event, f.ctx), { cancel: true });
	assert.equal(f.counts().aborts, 0, "不能再次模拟用户取消");
});

test("重算剩余限额拒绝畸形数值，零请求或截止时不再发起摘要", async () => {
	for (const limits of [{ maxRequests: Number.NaN, deadline: 1000 }, { maxRequests: -1, deadline: 1000 }, { maxRequests: 1.5, deadline: 1000 }, { maxRequests: 1, deadline: Number.POSITIVE_INFINITY }]) {
		const f = fixture();
		const out = await runCompaction({ ...f.input, limits });
		assert.equal(out.kind, "failed");
		if (out.kind === "failed") assert.match(out.error, /剩余资源限额/);
	}
	for (const limits of [{ maxRequests: 0, deadline: 1000 }, { maxRequests: 3, deadline: 0 }]) {
		const f = fixture();
		const out = await runCompaction({ ...f.input, fault: undefined, limits });
		assert.equal(out.kind, "failed");
		if (out.kind === "failed") assert.equal(out.stats?.requests, 0, "耗尽限额不能再请求模型");
	}
});

for (const method of ["getSessionId", "getLeafId", "getSessionFile", "getSessionDir", "getBranch", "buildSessionProjection"]) {
	test(`缺失 sessionManager.${method} 时所有入口安全拒绝，不由 runner 吞异常`, async () => {
		const f = fixture();
		delete f.manager[method];
		for (const name of ["session_start", "session_tree", "before_agent_start", "model_select", "agent_start", "agent_end", "agent_before_settle", "agent_settled", "turn_start", "turn_end", "message_end", "session_compact", "session_compact_failed"]) {
			await assert.doesNotReject(async () => { await f.handlers.get(name)!({ messages: [] }, f.ctx); }, name);
		}
		assert.deepEqual(await f.handlers.get("session_before_compact")!(f.event, f.ctx), { cancel: true });
		const context = await f.handlers.get("context")!({ messages: [{ role: "compactionSummary", summary: "不可继续发送的旧摘要" }] }, f.ctx);
		assert.deepEqual(context, { messages: [] });
		assert.deepEqual(await f.handlers.get("input")!({ text: "继续" }, f.ctx), { action: "handled" });
		await assert.doesNotReject(async () => { await f.commands.get("smart-compact")!.handler("reset", f.ctx); });
		const recalled = await f.recall();
		assert.match(recalled.content[0].text, /宿主契约/);
		assert.ok(f.logs.some((line) => line.includes(method)), f.logs.join("\n"));
		assert.ok(f.counts().aborts > 0);
		assert.equal(f.counts().appends, 0);
	});
}

for (const [name, mutate] of Object.entries({
	preparation缺失: (e: any) => { delete e.preparation; },
	settings缺失: (e: any) => { delete e.preparation.settings; },
	预算非有限: (e: any) => { e.preparation.settings.reserveTokens = Infinity; },
	预算为NaN: (e: any) => { e.preparation.settings.reserveTokens = NaN; },
	保留预算为负: (e: any) => { e.preparation.settings.keepRecentTokens = -1; },
	保留预算错类型: (e: any) => { e.preparation.settings.keepRecentTokens = "20000"; },
	token数缺失: (e: any) => { delete e.preparation.tokensBefore; },
	分支错类型: (e: any) => { e.branchEntries = {}; },
	signal缺失: (e: any) => { delete e.signal; },
	伪造取消信号: (e: any) => { e.signal = { aborted: true }; },
	未知reason: (e: any) => { e.reason = "future"; },
	重试标志缺失: (e: any) => { delete e.willRetry; },
	切点不属于分支: (e: any) => { e.preparation.firstKeptEntryId = "foreign"; },
})) {
	for (const reason of ["manual", "threshold", "overflow"]) {
		test(`坏压缩事件：${reason} 的 ${name} 明确取消且不追加状态`, async () => {
			const f = fixture();
			f.event.reason = reason;
			mutate(f.event);
			assert.deepEqual(await f.handlers.get("session_before_compact")!(f.event, f.ctx), { cancel: true });
			assert.ok(f.logs.some((s) => s.includes("宿主契约")), f.logs.join("\n"));
			assert.ok(f.counts().aborts > 0);
			assert.equal(f.counts().appends, 0);
		});
	}
}

test("registry 缺少 streamSimple 时明确取消，不交回默认摘要", async () => {
	const f = fixture();
	delete (f.ctx.modelRegistry as any).streamSimple;
	assert.deepEqual(await f.handlers.get("session_before_compact")!(f.event, f.ctx), { cancel: true });
	assert.ok(f.logs.some((s) => s.includes("streamSimple")));
});

for (const reason of ["manual", "threshold", "overflow"]) {
	test(`契约失败后的 ${reason} 保留原有停止策略`, async () => {
		const f = fixture();
		f.event.reason = reason;
		delete (f.ctx.modelRegistry as any).streamSimple;
		assert.deepEqual(await f.handlers.get("session_before_compact")!(f.event, f.ctx), { cancel: true });
		assert.equal(f.counts().appends, 0, "压缩前不能持久化停止状态");
		const next = await f.handlers.get("input")!({ text: "普通输入不能绕过自动压缩失败继续请求" }, f.ctx);
		assert.deepEqual(next, { action: reason === "manual" ? "continue" : "handled" }, "自动失败进入 R5，手动失败仍允许重试");
	});
}

test("用户 off 与已取消 signal 继续保留原来的放行语义", async () => {
	const f = fixture();
	delete f.manager.getBranch;
	f.env.PI_SMART_COMPACT_SUMMARY = "off";
	assert.equal(await f.handlers.get("session_before_compact")!(f.event, f.ctx), undefined);
	delete f.env.PI_SMART_COMPACT_SUMMARY;
	f.event.signal = AbortSignal.abort();
	assert.equal(await f.handlers.get("session_before_compact")!(f.event, f.ctx), undefined);
	assert.equal(f.logs.length, 0);
});

for (const [name, mutate] of Object.entries({
	投影抛异常: (f: ReturnType<typeof fixture>) => { f.manager.buildSessionProjection = () => { throw new Error("坏投影"); }; },
	投影缺少entries: (f: ReturnType<typeof fixture>) => { f.manager.buildSessionProjection = () => ({}); },
	来源ID外来: (f: ReturnType<typeof fixture>) => { f.manager.buildSessionProjection = () => ({ entries: [{ sourceEntry: { type: "message", id: "foreign" }, messages: [] }] }); },
	消息错类型: (f: ReturnType<typeof fixture>) => { f.manager.buildSessionProjection = () => ({ entries: [{ sourceEntry: f.branch[0], messages: [null] }] }); },
	消息content缺失: (f: ReturnType<typeof fixture>) => { f.manager.buildSessionProjection = () => ({ entries: [{ sourceEntry: f.branch[0], messages: [{ role: "user" }] }] }); },
	来源ID重复: (f: ReturnType<typeof fixture>) => { f.manager.buildSessionProjection = () => ({ entries: [0, 1].map(() => ({ sourceEntry: f.branch[0], messages: [f.branch[0].message] })) }); },
	非消息来源夹带内容: (f: ReturnType<typeof fixture>) => { f.branch.push({ type: "custom", id: "metadata" }); f.manager.buildSessionProjection = () => ({ entries: [{ sourceEntry: f.branch.at(-1), messages: [f.branch[0].message] }] }); },
	删除后泄露: (f: ReturnType<typeof fixture>) => { f.branch.push({ type: "context_edit", id: "e", targetId: "u0", replacement: null }); },
	替换后泄露: (f: ReturnType<typeof fixture>) => { f.branch.push({ type: "context_edit", id: "e", targetId: "u0", replacement: { content: "替换内容" } }); },
})) {
	test(`坏投影：${name} 返回 failed，不抛异常也不调用模型`, async () => {
		const f = fixture();
		mutate(f);
		const result = await runCompaction(f.input);
		assert.equal(result.kind, "failed");
		if (result.kind === "failed") assert.match(result.error, /宿主契约/);
	});
}

test("合法的替换、删除及来源投影通过，assistant 字符串替换按宿主规范转为文本块", () => {
	const f = fixture();
	f.branch[0].message = { role: "assistant", content: [{ type: "text", text: "旧内容" }], timestamp: 0 };
	f.branch.push({ type: "context_edit", id: "e0", targetId: "u0", replacement: { content: "替换内容" } }, { type: "context_edit", id: "e1", targetId: "u1", replacement: null });
	f.manager.buildSessionProjection = () => ({ entries: f.branch.map((sourceEntry) => ({ sourceEntry, messages: sourceEntry.id === "u0" ? [{ ...sourceEntry.message, content: [{ type: "text", text: "替换内容" }] }] : [] })) });
	assert.deepEqual(checkedProjection(f.ctx, f.branch), [{ id: "u0", messages: [{ role: "assistant", content: [{ type: "text", text: "替换内容" }], timestamp: 0 }] }]);
});

test("getBranch 抛错或返回坏条目时不泄漏异常，也不产生状态写入", async () => {
	for (const getBranch of [() => { throw new Error("分支读取失败"); }, () => [null], () => [{ id: "bad", type: "context_edit", targetId: "u0" }]]) {
		const f = fixture();
		f.manager.getBranch = getBranch;
		await assert.doesNotReject(async () => { await f.handlers.get("session_start")!({}, f.ctx); });
		assert.deepEqual(await f.handlers.get("session_before_compact")!(f.event, f.ctx), { cancel: true });
		assert.equal(f.counts().appends, 0);
		assert.ok(f.logs.some((s) => s.includes("宿主契约")));
	}
});

test("缺流能力时 status 不宣称成功接管，UI 通知损坏仍可日志诊断", async () => {
	const f = fixture();
	delete (f.ctx.modelRegistry as any).streamSimple;
	Object.assign(f.ctx, { hasUI: true, ui: { notify: () => { throw new Error("UI 不可用"); } } });
	await f.commands.get("smart-compact")!.handler("status", f.ctx);
	assert.ok(f.logs.some((s) => s.includes("streamSimple")));
	assert.ok(!f.logs.some((s) => s.includes("接管摘要：是")));
});

test("诊断通道抛错也不会向 runner 泄漏异常或交回原生摘要", async () => {
	const f = fixture(true);
	delete f.manager.getBranch;
	assert.deepEqual(await f.handlers.get("session_before_compact")!(f.event, f.ctx), { cancel: true });
	assert.ok(f.counts().aborts > 0);
	assert.equal(f.counts().appends, 0);
});

test("streamSimple 存在但返回坏流对象时仍取消压缩，不冒充成功", async () => {
	const f = fixture();
	(f.ctx.modelRegistry as any).streamSimple = () => ({});
	assert.deepEqual(await f.handlers.get("session_before_compact")!(f.event, f.ctx), { cancel: true });
	assert.ok(f.logs.some((s) => s.includes("压缩失败")));
	assert.equal(f.counts().appends, 0);
});

test("宿主未声明 maxTokens 上限时不误判契约失败", async () => {
	const f = fixture();
	f.input.choice.summaryModel.maxTokens = 0;
	const result = await runCompaction(f.input);
	assert.equal(result.kind, "failed");
	if (result.kind === "failed") assert.match(result.error, /故障注入/);
});

test("宿主允许零余量和零保留区，不应被判成契约不兼容", async () => {
	const f = fixture();
	f.input.event.settings = { reserveTokens: 0, keepRecentTokens: 0 };
	const result = await runCompaction(f.input);
	assert.equal(result.kind, "failed");
	if (result.kind === "failed") assert.match(result.error, /故障注入/, "合法的零值应进入压缩流程，而不是被契约门禁误拦");
});

test("直接 runCompaction 收到非有限预算时返回 failed", async () => {
	const f = fixture();
	f.input.event.settings.reserveTokens = NaN;
	const result = await runCompaction(f.input);
	assert.equal(result.kind, "failed");
	if (result.kind === "failed") assert.match(result.error, /宿主契约/);
});
