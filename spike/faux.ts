// 进程内 faux spike：用 pi-ai 的 faux provider 驱动完整的 pi 会话，确定性地验证真实 provider 难以触发的路径（方案 S12）。
// 不发生任何真实 provider 调用，不经过预算账本。
//
// 用法：node spike/faux.ts <scenario> [<scenario> ...]
// 场景：
//   - S12-length：响应以 length 结束且输出少于 maxTokens，触发长度恢复：省略失败回合、以 overflow 原因压缩、再重试。
//   - S12-retry：连续两次可重试错误（overloaded），触发自动重试前的失败省略，一次顶层运行中出现多个 agent_end。
// 两个场景都加载探针扩展并开启 append-in-settle，同时验证 agent_before_settle 内 appendEntry 早于 boundary 条目。
// 结果归档到 ~/.pi/agent/.collab/smart-compact/spike/<scenario>/。

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { COLLAB_DIR } from "../eval/coordinator.ts";
import probe from "./probe.ts";

type Row = Record<string, unknown> & { ev: string };
type Entry = Record<string, unknown> & { type?: string; id?: string };

interface Scenario {
	id: string;
	title: string;
	settings: Record<string, unknown>;
	model: { contextWindow: number; maxTokens: number };
	/** 依次发送的用户提示词。 */
	prompts: string[];
	/** 按第几次请求（从 0 开始）与上下文决定回复。 */
	route(n: number, lastRole: string | undefined): AssistantMessage;
	check(rows: Row[], entries: Entry[]): { pass: boolean; notes: string[] };
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

function markerOrder(entries: Entry[]): { ok: boolean; note: string } {
	const marker = entries.findIndex((e) => e.type === "custom" && e.customType === "probe-close-marker");
	const draft = entries.findIndex((e) => e.type === "custom" && e.customType === "probe-boundary-draft");
	return { ok: marker >= 0 && draft > marker, note: `appendEntry 条目位置 ${marker}，boundary 草稿位置 ${draft}；前者更早：${marker >= 0 && draft > marker}。` };
}

const SCENARIOS: Scenario[] = [
	{
		id: "S12-length",
		title: "长度恢复：省略编辑在 agent_end 之后、下一次 agent_start 或 agent_before_settle 之前；随后以 overflow 原因压缩并重试",
		settings: { retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 } },
		model: { contextWindow: 20_000, maxTokens: 8_000 },
		// 第一轮完整对话让会话有可压缩的历史；第二轮读文件后以 length 结束。
		prompts: ["读取 notes.md。", "再读一次 notes.md，然后写一篇长文。"],
		route(n) {
			if (n === 0 || n === 2) return fauxAssistantMessage(fauxToolCall("read", { path: "notes.md" }), { stopReason: "toolUse" });
			if (n === 1) return fauxAssistantMessage(fauxText("已读"));
			if (n === 3) return fauxAssistantMessage(fauxText("这是一段被截断的长文……"), { stopReason: "length" });
			return fauxAssistantMessage(fauxText("完成"));
		},
		check(rows, entries) {
			const notes: string[] = [];
			const lengthIdx = entries.findIndex((e) => e.type === "message" && (e.message as { stopReason?: string }).stopReason === "length");
			const edits = nullEdits(entries);
			const ends = rows.filter((r) => r.ev === "agent_end").map((r) => idx(entries, r.leaf));
			const starts = rows.filter((r) => r.ev === "agent_start").map((r) => idx(entries, r.leaf));
			const settle = rows.filter((r) => r.ev === "agent_before_settle").map((r) => idx(entries, r.leaf));
			// 每条编辑都要落在它之前最近的 agent_end 与其后最近的 agent_start 或 agent_before_settle 之间。
			const inWindow =
				edits.length > 0 &&
				edits.every(({ i }) => {
					const prevEnd = Math.max(-1, ...ends.filter((e) => e < i));
					const next = Math.min(...[...starts, ...settle].filter((b) => b > prevEnd));
					return prevEnd >= 0 && i <= next;
				});
			const targetsLength = edits.some(({ e }) => idx(entries, e.targetId) === lengthIdx);
			const bc = rows.filter((r) => r.ev === "session_before_compact").map((r) => `${r.reason}/${r.willRetry}`);
			notes.push(`length 响应位置 ${lengthIdx}；省略编辑位置 ${edits.map((x) => x.i).join("、")}，目标包含该响应：${targetsLength}。`);
			notes.push(`agent_end 时叶子位置 ${ends.join("、")}；agent_start ${starts.join("、")}；agent_before_settle ${settle.join("、")}。省略编辑都落在各自前一个 agent_end 与下一个边界之间：${inWindow}。`);
			notes.push(`压缩事件：${bc.join("、") || "无"}；agent_start 共 ${starts.length} 次。`);
			const m = markerOrder(entries);
			notes.push(m.note);
			return { pass: lengthIdx >= 0 && targetsLength && inWindow && bc.includes("overflow/true") && m.ok, notes };
		},
	},
	{
		id: "S12-retry",
		title: "自动重试：每次失败响应被省略，编辑落在各自的 agent_end 之后、下一次 agent_start 之前；同一次顶层运行中出现多个 agent_end",
		settings: { retry: { enabled: true, maxRetries: 3, baseDelayMs: 10 }, compaction: { enabled: true, reserveTokens: 2000, keepRecentTokens: 1000 } },
		model: { contextWindow: 20_000, maxTokens: 8_000 },
		prompts: ["读取 notes.md，然后写一篇长文。"],
		route(n) {
			if (n < 2) return fauxAssistantMessage([], { stopReason: "error", errorMessage: "overloaded: please retry" });
			return fauxAssistantMessage(fauxText("完成"));
		},
		check(rows, entries) {
			const notes: string[] = [];
			const edits = nullEdits(entries);
			const ends = rows.filter((r) => r.ev === "agent_end").map((r) => idx(entries, r.leaf));
			const starts = rows.filter((r) => r.ev === "agent_start").map((r) => idx(entries, r.leaf));
			const windows = ends.map((end) => [end, starts.find((s) => s > end) ?? Number.POSITIVE_INFINITY] as const);
			const allInWindows = edits.length > 0 && edits.every(({ i }) => windows.some(([a, b]) => i > a && i <= b));
			notes.push(`agent_end ${ends.length} 次，位置 ${ends.join("、")}；agent_start ${starts.length} 次，位置 ${starts.join("、")}。`);
			notes.push(`省略编辑 ${edits.length} 条，位置 ${edits.map((x) => x.i).join("、")}；都落在某个 agent_end 与下一次 agent_start 之间：${allInWindows}。`);
			const m = markerOrder(entries);
			notes.push(m.note);
			return { pass: ends.length >= 3 && starts.length >= 3 && edits.length >= 2 && allInWindows && m.ok, notes };
		},
	},
];

async function runScenario(sc: Scenario): Promise<boolean> {
	const dir = mkdtempSync(join(tmpdir(), `sc-faux-${sc.id}-`));
	const cwd = join(dir, "project");
	const agentDir = join(dir, "agent");
	const sessionsDir = join(agentDir, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(cwd, "notes.md"), "测试用的笔记内容。\n".repeat(200));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(sc.settings));
	const probeLog = join(dir, "probe.jsonl");
	const saved = { PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PROBE_LOG: process.env.PROBE_LOG, PROBE_MODE: process.env.PROBE_MODE };
	process.env.PI_CODING_AGENT_DIR = agentDir;
	process.env.PROBE_LOG = probeLog;
	process.env.PROBE_MODE = "append-in-settle";
	let ok = false;
	try {
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: sc.model.contextWindow, maxTokens: sc.model.maxTokens }] });
		runtime.registerNativeProvider(faux.provider);
		const model = runtime.getModel("faux", "m") ?? faux.getModel();
		let n = 0;
		faux.setResponses(
			Array.from({ length: 50 }, () => (context: { messages: Array<{ role: string }> }) => {
				const last = context.messages[context.messages.length - 1];
				return sc.route(n++, last?.role);
			}),
		);
		const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [probe] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, resourceLoader: loader, sessionManager: SessionManager.create(cwd, sessionsDir) });
		await session.bindExtensions({ mode: "print" });
		for (const p of sc.prompts) {
			await session.prompt(p);
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
		const verdict = sc.check(rows, entries);
		const out = join(COLLAB_DIR, "spike", sc.id);
		rmSync(out, { recursive: true, force: true });
		mkdirSync(out, { recursive: true, mode: 0o700 });
		cpSync(probeLog, join(out, "probe.jsonl"));
		cpSync(sessionsDir, join(out, "sessions"), { recursive: true });
		writeFileSync(join(out, "result.json"), `${JSON.stringify({ id: sc.id, title: sc.title, providerCalls: faux.state.callCount, ...verdict }, null, 2)}\n`);
		process.stdout.write(`\n[${sc.id}] ${sc.title}\n  faux 请求 ${faux.state.callCount} 次（不产生费用）\n`);
		for (const note of verdict.notes) process.stdout.write(`  ${note}\n`);
		process.stdout.write(`  结论：${verdict.pass ? "通过" : "不通过"}\n`);
		ok = verdict.pass;
	} finally {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		rmSync(dir, { recursive: true, force: true });
	}
	return ok;
}

async function main(ids: string[]): Promise<number> {
	let failed = 0;
	for (const id of ids) {
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
