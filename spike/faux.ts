// 进程内 faux spike：用 pi-ai 的 faux provider 驱动完整的 pi 会话，确定性地验证真实 provider 难以触发或难以计数的路径（方案 S10、S12、S13）。
// 不发生任何真实 provider 调用，不经过预算账本。
//
// 探针事件与 faux 的每次 provider 调用写进同一条进程内时间线（globalThis.__probeSeq），所以「中止之后还有几次 provider 调用」是直接计数，不依赖 assistant 记录的 usage 推断。
//
// 用法：node spike/faux.ts <scenario> [<scenario> ...]
// 结果归档到 ~/.pi/agent/.collab/smart-compact/spike/<scenario>/。

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionFactory, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { COLLAB_DIR } from "../eval/coordinator.ts";
import probe from "./probe.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD_SOURCE = join(HERE, "..", "eval", "budget-guard.ts");
const PI_SUBAGENTS_SRC = join(process.env.HOME ?? "", ".pi", "agent", "git", "github.com", "yinziyang", "pi-subagents");
// pi-subagents 的安装目录里没有 node_modules，直接导入会找不到 pi 的包。复制一份到本项目内（不纳入 git），让它沿用本项目的依赖解析。
const VENDOR_SUBAGENTS = join(HERE, ".vendor", "pi-subagents");

function vendorSubagents(): string {
	rmSync(VENDOR_SUBAGENTS, { recursive: true, force: true });
	cpSync(PI_SUBAGENTS_SRC, VENDOR_SUBAGENTS, { recursive: true, filter: (src) => !/[/\\](node_modules|\.git|test)([/\\]|$)/.test(src) });
	return join(VENDOR_SUBAGENTS, "extensions", "subagents", "index.ts");
}

type Row = Record<string, unknown> & { ev: string };
type Entry = Record<string, unknown> & { type?: string; id?: string };
type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

interface RouteInfo {
	n: number;
	lastRole: string | undefined;
	system: string;
	model: string;
}

interface Scenario {
	id: string;
	title: string;
	settings: Record<string, unknown>;
	models: Array<{ id: string; contextWindow: number; maxTokens: number }>;
	probeMode: string;
	env?: Record<string, string>;
	/** 写进 agentDir/extensions/ 的扩展文件（父会话与子会话都会加载），键为文件名，值为源文件路径。 */
	extensionFiles?: Record<string, string>;
	/** 额外的扩展工厂，例如 pi-subagents。 */
	factories?: () => Promise<ExtensionFactory[]>;
	/** 绑定扩展之后、发送提示词之前执行，例如切换到虚拟模型。 */
	setup?: (session: Session, runtime: ModelRuntime) => Promise<void>;
	steps: Array<{ prompt: string; autoCompaction?: boolean }>;
	route(info: RouteInfo): AssistantMessage;
	check(ctx: { rows: Row[]; entries: Entry[]; seq: string[]; calls: number; guard: Record<string, unknown>[]; childRequests: number; childSessions: number }): { pass: boolean; notes: string[] };
}

function readJsonl(file: string): Record<string, unknown>[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const idx = (entries: Entry[], id: unknown) => entries.findIndex((e) => e.id === id);
const nullEdits = (entries: Entry[]) => entries.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "context_edit" && e.replacement === null);
const read = () => fauxAssistantMessage(fauxToolCall("read", { path: "notes.md" }), { stopReason: "toolUse" });
const done = () => fauxAssistantMessage(fauxText("完成"));

function markerOrder(entries: Entry[]): { ok: boolean; note: string } {
	const marker = entries.findIndex((e) => e.type === "custom" && e.customType === "probe-close-marker");
	const draft = entries.findIndex((e) => e.type === "custom" && e.customType === "probe-boundary-draft");
	return { ok: marker >= 0 && draft > marker, note: `appendEntry 条目位置 ${marker}，boundary 草稿位置 ${draft}；前者更早：${marker >= 0 && draft > marker}。` };
}

/** 时间线上第一次出现 ev 之后的 provider 调用次数；没有出现时返回 undefined。 */
function callsAfter(seq: string[], ev: string): number | undefined {
	const i = seq.indexOf(ev);
	return i < 0 ? undefined : seq.slice(i + 1).filter((x) => x === "provider_call").length;
}

/** 窗口 20000、余量 2000、触发点 18000 的小窗口配置；notes.md 每次读取约 3000 token，读 6～7 次即触发。 */
const SMALL_SETTINGS = { retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 } };
const SMALL_MODEL = [{ id: "m", contextWindow: 20_000, maxTokens: 8_000 }];

function abortCheck(label: string) {
	return ({ seq, calls }: { seq: string[]; calls: number }) => {
		const after = callsAfter(seq, "probe_abort");
		return {
			pass: after === 0,
			notes: [`${label}：探针中止 ${after === undefined ? "未触发" : "已触发"}，中止之后 faux provider 调用 ${after ?? "-"} 次（直接计数），全程调用 ${calls} 次。`],
		};
	};
}

const SCENARIOS: Scenario[] = [
	{
		id: "S12-length",
		title: "长度恢复：省略编辑在 agent_end 之后、下一次 agent_start 或 agent_before_settle 之前；随后以 overflow 原因压缩并重试",
		settings: SMALL_SETTINGS,
		models: SMALL_MODEL,
		probeMode: "append-in-settle",
		steps: [{ prompt: "读取 notes.md。" }, { prompt: "再读一次 notes.md，然后写一篇长文。" }],
		route({ n }) {
			if (n === 0 || n === 2) return read();
			if (n === 1) return fauxAssistantMessage(fauxText("已读"));
			if (n === 3) return fauxAssistantMessage(fauxText("这是一段被截断的长文……"), { stopReason: "length" });
			return done();
		},
		check({ rows, entries }) {
			const notes: string[] = [];
			const lengthIdx = entries.findIndex((e) => e.type === "message" && (e.message as { stopReason?: string }).stopReason === "length");
			const lengthId = entries[lengthIdx]?.id;
			const edits = nullEdits(entries);
			const ends = rows.filter((r) => r.ev === "agent_end").map((r) => idx(entries, r.leaf));
			const starts = rows.filter((r) => r.ev === "agent_start").map((r) => idx(entries, r.leaf));
			const settle = rows.filter((r) => r.ev === "agent_before_settle").map((r) => idx(entries, r.leaf));
			const inWindow =
				edits.length > 0 &&
				edits.every(({ i }) => {
					const prevEnd = Math.max(-1, ...ends.filter((e) => e < i));
					const next = Math.min(...[...starts, ...settle].filter((b) => b > prevEnd));
					return prevEnd >= 0 && i <= next;
				});
			// 逐项关联：每条省略编辑的目标都必须是这次 length 响应本身。
			const targetsExact = edits.length > 0 && edits.every(({ e }) => e.targetId === lengthId);
			const bc = rows.filter((r) => r.ev === "session_before_compact").map((r) => `${r.reason}/${r.willRetry}`);
			notes.push(`length 响应位置 ${lengthIdx}；省略编辑位置 ${edits.map((x) => x.i).join("、")}，目标逐项等于该响应：${targetsExact}。`);
			notes.push(`agent_end 时叶子位置 ${ends.join("、")}；agent_start ${starts.join("、")}；agent_before_settle ${settle.join("、")}。省略编辑都落在各自前一个 agent_end 与下一个边界之间：${inWindow}。`);
			notes.push(`压缩事件：${bc.join("、") || "无"}；agent_start 共 ${starts.length} 次。`);
			const m = markerOrder(entries);
			notes.push(m.note);
			return { pass: lengthIdx >= 0 && targetsExact && inWindow && bc.includes("overflow/true") && m.ok, notes };
		},
	},
	{
		id: "S12-retry",
		title: "自动重试：每次失败响应被省略，编辑落在各自的 agent_end 之后、下一次 agent_start 之前；同一次顶层运行中出现多个 agent_end",
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 10 }, compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 } },
		models: SMALL_MODEL,
		probeMode: "append-in-settle",
		steps: [{ prompt: "读取 notes.md，然后写一篇长文。" }],
		route({ n }) {
			if (n < 2) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded: please retry" });
			return done();
		},
		check({ rows, entries }) {
			const notes: string[] = [];
			const edits = nullEdits(entries);
			const failedIds = entries.filter((e) => e.type === "message" && (e.message as { stopReason?: string }).stopReason === "error").map((e) => e.id);
			const ends = rows.filter((r) => r.ev === "agent_end").map((r) => idx(entries, r.leaf));
			const starts = rows.filter((r) => r.ev === "agent_start").map((r) => idx(entries, r.leaf));
			const windows = ends.map((end) => [end, starts.find((s) => s > end) ?? Number.POSITIVE_INFINITY] as const);
			const allInWindows = edits.length > 0 && edits.every(({ i }) => windows.some(([a, b]) => i > a && i <= b));
			const targetsExact = edits.length === failedIds.length && edits.every(({ e }, k) => e.targetId === failedIds[k]);
			notes.push(`agent_end ${ends.length} 次，位置 ${ends.join("、")}；agent_start ${starts.length} 次，位置 ${starts.join("、")}。`);
			notes.push(`省略编辑 ${edits.length} 条，位置 ${edits.map((x) => x.i).join("、")}；目标逐项等于失败响应：${targetsExact}；都落在某个 agent_end 与下一次 agent_start 之间：${allInWindows}。`);
			const m = markerOrder(entries);
			notes.push(m.note);
			return { pass: ends.length >= 3 && starts.length >= 3 && targetsExact && allInWindows && m.ok, notes };
		},
	},
	{
		id: "S10-mid",
		title: "运行中途（工具续轮）压缩时，处理器内中止加下一次 turn_start 中止后，provider 调用不再增加",
		settings: SMALL_SETTINGS,
		models: SMALL_MODEL,
		probeMode: "abort-in-compact",
		steps: [{ prompt: "反复读取 notes.md。" }],
		route: ({ n }) => (n < 30 ? read() : done()),
		check: abortCheck("工具续轮"),
	},
	{
		id: "S10-preflight",
		title: "发送新提示词前的压缩检查：处理器内中止无效，由随后的 turn_start 中止阻止请求，provider 调用不再增加",
		settings: SMALL_SETTINGS,
		models: SMALL_MODEL,
		probeMode: "abort-in-compact",
		steps: [
			{ prompt: "反复读取 notes.md，读满四次。", autoCompaction: false },
			{ prompt: "只回复好。", autoCompaction: true },
		],
		// faux 的 usage 把 cacheWrite 也计入输入，每读一次约增加 2864 token；读 4 次后约 19517，落在触发点 18000 与窗口 20000 之间，所以这里是阈值压缩而不是溢出。
		route: ({ n }) => (n < 4 ? read() : done()),
		check(ctx) {
			const r = abortCheck("新提示词前")(ctx);
			const reason = ctx.rows.find((x) => x.ev === "session_before_compact")?.reason;
			r.notes.push(`压缩原因：${reason}（应为 threshold）。`);
			const i = ctx.seq.indexOf("probe_abort");
			const order = ctx.seq.slice(Math.max(0, i - 3), i + 6).join(" → ");
			r.notes.push(`中止前后的时间线：${order}。`);
			const atTurn = ctx.rows.some((x) => x.ev === "probe_abort" && x.at === "turn_start");
			r.notes.push(`由 turn_start 补中止：${atTurn}。`);
			return { pass: r.pass && atTurn && reason === "threshold", notes: r.notes };
		},
	},
	{
		id: "S10-turn",
		title: "在第 2 个 turn_start 调用 ctx.abort() 后，provider 调用不再增加",
		settings: SMALL_SETTINGS,
		models: SMALL_MODEL,
		probeMode: "abort-turn-start:2",
		steps: [{ prompt: "反复读取 notes.md。" }],
		route: ({ n }) => (n < 30 ? read() : done()),
		check: abortCheck("turn_start"),
	},
	{
		id: "S10-virtual",
		title: "虚拟模型：在 prepareRequest 中触发的压缩里中止后，provider 调用不再增加；阈值按路由到的物理窗口判断",
		settings: SMALL_SETTINGS,
		models: [
			{ id: "m", contextWindow: 20_000, maxTokens: 8_000 },
			{ id: "m2", contextWindow: 40_000, maxTokens: 8_000 },
		],
		probeMode: "virtual,abort-in-compact",
		env: { PROBE_VIRTUAL_TARGETS: "faux/m,faux/m2" },
		setup: async (session, runtime) => {
			const v = runtime.getModel("probe", "auto");
			if (!v) throw new Error("虚拟模型 probe/auto 未注册");
			await session.setModel(v);
		},
		steps: [{ prompt: "反复读取 notes.md。" }],
		route: ({ n }) => (n < 30 ? read() : done()),
		check(ctx) {
			const r = abortCheck("虚拟模型")(ctx);
			const bc = ctx.rows.find((x) => x.ev === "session_before_compact");
			const i = ctx.rows.indexOf(bc as Row);
			const route = [...ctx.rows.slice(0, i)].reverse().find((x) => x.ev === "probe_route");
			const ok = bc !== undefined && Number(bc.tokensBefore) >= Number(route?.window ?? 0) - 2000;
			r.notes.push(`触发压缩时路由窗口 ${route?.window ?? "无"}，tokensBefore ${bc?.tokensBefore ?? "无"}，触发点 ${route ? Number(route.window) - 2000 : "-"}：${ok}。`);
			return { pass: r.pass && ok, notes: r.notes };
		},
	},
	{
		id: "S13-guard",
		title: "预算守卫经 agentDir/extensions 安装时在子会话中生效，父子共享计数，超过上限后 provider 调用不再增加",
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
		models: SMALL_MODEL,
		probeMode: "",
		env: { PI_BUDGET_MAX_REQUESTS: "3", PI_BUDGET_MAX_BILLED_TOKENS: "100000000", PI_FORK_SUBAGENT: "0", PI_BUDGET_GUARD_LOG: "{dir}/guard.jsonl" },
		extensionFiles: { "budget-guard.ts": GUARD_SOURCE },
		factories: async () => [(await import(vendorSubagents())).default as ExtensionFactory],
		steps: [{ prompt: "派一个 subagent 去读文件。" }],
		route({ n, system }) {
			if (n === 0) return fauxAssistantMessage(fauxToolCall("agent", { description: "读文件", prompt: "反复读取 notes.md", subagent_type: "general-purpose", run_in_background: false }), { stopReason: "toolUse" });
			// 子会话一直读文件，永不结束，只能靠守卫停下。父会话收到结果后也继续请求，同样应被守卫拦下。
			return system.includes("委派任务的子 agent") ? read() : read();
		},
		check({ calls, guard, childRequests }) {
			const notes = [
				`faux provider 全程调用 ${calls} 次，上限 3。`,
				`子会话文件中的 assistant 记录 ${childRequests} 条（子会话确实运行并发出了请求）。`,
				`守卫拦截记录 ${guard.length} 条：${guard.map((g) => `已结算 ${g.requests} 次、在途 ${g.pendingRequests} 次`).join("、") || "无"}。`,
			];
			return { pass: calls <= 3 && childRequests >= 1 && guard.length >= 1, notes };
		},
	},
	{
		id: "S13-guard-concurrent",
		title: "两个子会话并发、请求数只剩一份时，只有一个能发出请求（调用前预占）",
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
		models: SMALL_MODEL,
		probeMode: "",
		env: { PI_BUDGET_MAX_REQUESTS: "2", PI_BUDGET_MAX_BILLED_TOKENS: "100000000", PI_FORK_SUBAGENT: "0", PI_BUDGET_GUARD_LOG: "{dir}/guard.jsonl" },
		extensionFiles: { "budget-guard.ts": GUARD_SOURCE },
		factories: async () => [(await import(vendorSubagents())).default as ExtensionFactory],
		steps: [{ prompt: "同时派两个 subagent 去读文件。" }],
		route: ({ n }) => (n === 0 ? twoAgents() : read()),
		check({ calls, guard, childRequests, childSessions }) {
			const overlapped = guard.some((g) => Number(g.pendingRequests) >= 1);
			return {
				pass: calls === 2 && childSessions === 2 && guard.length >= 1 && overlapped,
				notes: [`faux provider 全程调用 ${calls} 次，请求上限 2；子会话 ${childSessions} 个，assistant 记录 ${childRequests} 条；守卫拦截 ${guard.length} 次，拦截时有在途预占：${overlapped}。`],
			};
		},
	},
	{
		id: "S13-guard-tokens",
		title: "两个子会话并发时，在途的单次最坏 token（窗口 20000 + maxTokens 8000）合计超过余额，后到者被拦下",
		settings: { retry: { enabled: false }, compaction: { enabled: false } },
		models: SMALL_MODEL,
		probeMode: "",
		env: { PI_BUDGET_MAX_REQUESTS: "100", PI_BUDGET_MAX_BILLED_TOKENS: "50000", PI_FORK_SUBAGENT: "0", PI_BUDGET_GUARD_LOG: "{dir}/guard.jsonl" },
		extensionFiles: { "budget-guard.ts": GUARD_SOURCE },
		factories: async () => [(await import(vendorSubagents())).default as ExtensionFactory],
		steps: [{ prompt: "同时派两个 subagent 去读文件。" }],
		route: ({ n }) => (n === 0 ? twoAgents() : read()),
		check({ calls, guard, childSessions }) {
			const worst = guard.map((g) => g.worst).filter((w) => w !== undefined);
			const overlapped = guard.some((g) => Number(g.pendingRequests) >= 1);
			return {
				pass: calls === 2 && childSessions === 2 && guard.length >= 1 && overlapped,
				notes: [`faux provider 全程调用 ${calls} 次；子会话 ${childSessions} 个；守卫拦截 ${guard.length} 次，拦截时的单次最坏 token ${worst.join("、") || "无"}，拦截时有在途预占：${overlapped}；token 上限 50000。`],
			};
		},
	},
];

/** 一条 assistant 消息里同时发起两个前台 subagent 调用，pi 会并行执行它们。 */
function twoAgents(): AssistantMessage {
	const call = (k: string) => fauxToolCall("agent", { description: `读文件${k}`, prompt: "反复读取 notes.md", subagent_type: "general-purpose", run_in_background: false }, { id: `call-${k}` });
	return fauxAssistantMessage([call("a"), call("b")], { stopReason: "toolUse" });
}

async function runScenario(sc: Scenario): Promise<boolean> {
	const dir = mkdtempSync(join(tmpdir(), `sc-faux-${sc.id}-`));
	const cwd = join(dir, "project");
	const agentDir = join(dir, "agent");
	const sessionsDir = join(agentDir, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(cwd, "notes.md"), "测试用的笔记内容，用来让上下文增长。\n".repeat(600));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(sc.settings));
	// faux provider 本身不校验凭据，但虚拟模型路由要求目标 provider 已配置凭据；这里写一个测试用的假值，不是真实密钥。
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-test-key" } }), { mode: 0o600 });
	for (const [name, src] of Object.entries(sc.extensionFiles ?? {})) {
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		cpSync(src, join(agentDir, "extensions", name));
	}
	const probeLog = join(dir, "probe.jsonl");
	const env: Record<string, string> = { PI_CODING_AGENT_DIR: agentDir, PROBE_LOG: probeLog, PROBE_MODE: sc.probeMode };
	for (const [k, v] of Object.entries(sc.env ?? {})) env[k] = v.replaceAll("{dir}", dir);
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(env)) {
		saved[k] = process.env[k];
		process.env[k] = v;
	}
	const seq: string[] = [];
	const g = globalThis as { __probeSeq?: string[] };
	g.__probeSeq = seq;
	delete (globalThis as Record<symbol, unknown>)[Symbol.for("pi-smart-compact.budget-guard.state")];
	let ok = false;
	try {
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({ provider: "faux", models: sc.models });
		runtime.registerNativeProvider(faux.provider);
		// 凭据快照在创建 runtime 时生成，faux 注册在其后；刷新该 provider，让 auth.json 中的测试凭据进入快照（虚拟路由会检查）。
		await runtime.refresh({ providers: ["faux"] });
		// 可用性检查在后台异步完成，最多等 3 秒。
		for (let i = 0; i < 300 && !runtime.hasConfiguredAuth("faux"); i++) await new Promise((r) => setTimeout(r, 10));
		process.stdout.write(`  （faux 凭据已进入快照：${runtime.hasConfiguredAuth("faux")}）\n`);
		const model = runtime.getModel("faux", sc.models[0].id) ?? faux.getModel();
		let n = 0;
		faux.setResponses(
			Array.from({ length: 200 }, () => (context: { messages: Array<{ role: string; content?: unknown }> }, _o: unknown, _s: unknown, m: { id: string }) => {
				seq.push("provider_call");
				const last = context.messages[context.messages.length - 1];
				const sys = context.messages.find((x) => x.role === "system");
				return sc.route({ n: n++, lastRole: last?.role, system: sys ? JSON.stringify(sys.content) : "", model: m.id });
			}),
		);
		const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [probe, ...((await sc.factories?.()) ?? [])] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, resourceLoader: loader, sessionManager: SessionManager.create(cwd, sessionsDir) });
		await session.bindExtensions({ mode: "print" });
		await sc.setup?.(session, runtime);
		for (const step of sc.steps) {
			if (step.autoCompaction !== undefined) session.setAutoCompactionEnabled(step.autoCompaction);
			await session.prompt(step.prompt);
			await session.agent.waitForIdle();
		}
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();

		const entries: Entry[] = [];
		const walk = (d: string) => {
			if (!existsSync(d)) return;
			for (const x of readdirSync(d, { withFileTypes: true })) {
				if (x.isDirectory()) walk(join(d, x.name));
				else if (x.name.endsWith(".jsonl")) entries.push(...(readJsonl(join(d, x.name)) as Entry[]));
			}
		};
		walk(sessionsDir);
		const rows = readJsonl(probeLog) as Row[];
		const childEntries: Entry[] = [];
		let childSessions = 0;
		const walkChild = (d: string) => {
			if (!existsSync(d)) return;
			for (const x of readdirSync(d, { withFileTypes: true })) {
				if (x.isDirectory()) walkChild(join(d, x.name));
				else if (x.name.endsWith(".jsonl")) {
					childSessions++;
					childEntries.push(...(readJsonl(join(d, x.name)) as Entry[]));
				}
			}
		};
		walkChild(join(agentDir, "subagent-sessions"));
		const childRequests = childEntries.filter((e) => e.type === "message" && (e.message as { role?: string }).role === "assistant").length;
		const guard = readJsonl(join(dir, "guard.jsonl"));
		const verdict = sc.check({ rows, entries, seq, calls: faux.state.callCount, guard, childRequests, childSessions });
		const out = join(COLLAB_DIR, "spike", sc.id);
		rmSync(out, { recursive: true, force: true });
		mkdirSync(out, { recursive: true, mode: 0o700 });
		if (existsSync(probeLog)) cpSync(probeLog, join(out, "probe.jsonl"));
		if (existsSync(sessionsDir)) cpSync(sessionsDir, join(out, "sessions"), { recursive: true });
		if (existsSync(join(agentDir, "subagent-sessions"))) cpSync(join(agentDir, "subagent-sessions"), join(out, "subagent-sessions"), { recursive: true });
		if (existsSync(join(dir, "guard.jsonl"))) cpSync(join(dir, "guard.jsonl"), join(out, "guard.jsonl"));
		writeFileSync(join(out, "timeline.json"), `${JSON.stringify(seq)}\n`);
		writeFileSync(join(out, "result.json"), `${JSON.stringify({ id: sc.id, title: sc.title, providerCalls: faux.state.callCount, ...verdict }, null, 2)}\n`);
		process.stdout.write(`\n[${sc.id}] ${sc.title}\n  faux 请求 ${faux.state.callCount} 次（不产生费用）\n`);
		for (const note of verdict.notes) process.stdout.write(`  ${note}\n`);
		process.stdout.write(`  结论：${verdict.pass ? "通过" : "不通过"}\n`);
		ok = verdict.pass;
	} finally {
		delete g.__probeSeq;
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	}
	return ok;
}

async function main(ids: string[]): Promise<number> {
	const list = ids.length ? ids : SCENARIOS.map((s) => s.id);
	let failed = 0;
	for (const id of list) {
		const sc = SCENARIOS.find((s) => s.id === id);
		if (!sc) throw new Error(`未知场景：${id}，可选：${SCENARIOS.map((s) => s.id).join("、")}`);
		if (!(await runScenario(sc))) failed++;
	}
	return failed === 0 ? 0 : 1;
}

main(process.argv.slice(2)).then(
	(code) => process.exit(code),
	(err: unknown) => {
		process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
		process.exit(1);
	},
);
