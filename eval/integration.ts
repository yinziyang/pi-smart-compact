// 真实模型集成测试（方案 12.4 中必须由真实模型参与的用例）：在隔离配置中用 openai-codex/gpt-6-luna 运行，每一步都经预算协调脚本执行。
//
// 用法：node eval/integration.ts <用例> [<用例> ...]，可选 T-native、T-trigger、T-manual、T-sub、T-goal、T-goal-constraint。
// T-trigger 同时覆盖 T-recall：压缩之后提问一个只在被压缩部分出现的细节。
// 结果归档到 ~/.pi/agent/.collab/smart-compact/integration/<用例>/，判定只读归档内容。
// 涉及 pi-subagents 或 pi-goal 的用例经隔离配置的 packages 加载扩展，预算守卫作为 packages 的第一项（方案 F49）。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { COLLAB_DIR, GUARD_PATH, type RpcIo, type StepResult, withCoordinator } from "./coordinator.ts";
import { assertAuthFresh, createIsolatedEnv } from "./isolate.ts";
import type { Amounts } from "./ledger.ts";
import { collectEntries, rpcCommand, rpcPrompt } from "../spike/run.ts";
import { HEADINGS, PACK_OPEN } from "../pack.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SOURCE_AGENT_DIR = join(homedir(), ".pi", "agent");
const PI_SUBAGENTS = join(homedir(), ".pi", "agent", "git", "github.com", "yinziyang", "pi-subagents");
const PI_GOAL_SRC = "/tmp/pi-goal";
const ARCHIVE_DIR = join(COLLAB_DIR, "integration");
const MODEL = { provider: "openai-codex", id: "gpt-6-luna" };
const FLAGS = ["-nc", "-ns", "-np", "--no-themes", "--no-mcp"];
const RESERVE = 32768;
/** gpt-6-luna 的 maxTokens 与价目（models-store.json），单位 token 与美元每百万 token。 */
const MAX_TOKENS = 128_000;
const PRICE = { input: 0.1, output: 0.5 };

/**
 * 一个步骤的预留额度。守卫对每次请求按「窗口 + maxTokens」预占计费 token（方案第 13 节第 0 步），所以 billedTokens 必须按这个口径给足，否则第一个回合就会被中止。
 * 输入、输出与费用按窗口与每次 8000 输出 token 估算（实测单次输出只有几百 token），用于账本的分项上限；超支由守卫与结算兜底。
 */
function worstFor(requests: number, window: number): Amounts {
	const out = 8_000;
	return {
		requests,
		inputTokens: requests * window,
		outputTokens: requests * out,
		billedTokens: requests * (window + MAX_TOKENS),
		costUsd: (requests * (window * PRICE.input + out * PRICE.output)) / 1e6 + 0.01,
		wallMs: requests * 90_000,
	};
}

type Entry = Record<string, unknown> & { type?: string; id?: string; customType?: string; details?: Record<string, unknown>; message?: Record<string, unknown>; data?: unknown };

/**
 * 一个约 48KB 的合成文本文件：read 工具单次最多返回 50KB，pi 文档大多较小，用它们读到触发点需要的请求数会超过预留。
 * 内容由序号确定，每行带文件号与行号，便于核对。
 */
function fillerText(n: number): string {
	const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar", "papa"];
	const lines: string[] = [];
	for (let i = 0; lines.join("\n").length < 48_000; i++) {
		const w = Array.from({ length: 10 }, (_, k) => words[(n * 31 + i * 7 + k * 3) % words.length]).join(" ");
		lines.push(`file ${n} line ${i}: ${w} ${(n * 1000003 + i * 7919) % 100000}`);
	}
	return `${lines.join("\n")}\n`;
}

/** 隔离项目里的测试材料：合成文本文件、带大量键值的 secret.txt、可以 npm test 的最小项目、test/ 目录。返回合成文件的路径列表。 */
function prepareProject(project: string): string[] {
	const docs = join(project, "docs");
	mkdirSync(docs, { recursive: true });
	for (let i = 1; i <= 30; i++) writeFileSync(join(docs, `part-${String(i).padStart(2, "0")}.txt`), fillerText(i));
	const lines = Array.from({ length: 300 }, (_, i) => `key_${i} = ${((i * 7919 + 104729) % 900000) + 100000}`);
	writeFileSync(join(project, "secret.txt"), `${lines.join("\n")}\n`);
	writeFileSync(join(project, "package.json"), JSON.stringify({ name: "it-project", private: true, scripts: { test: "node -e \"console.log('all tests passed')\"" } }, null, 2));
	mkdirSync(join(project, "test"), { recursive: true });
	writeFileSync(join(project, "test", "a.txt"), "original\n");
	mkdirSync(join(project, "notes"), { recursive: true });
	return readdirSync(docs)
		.filter((f) => f.endsWith(".txt"))
		.sort()
		.map((f) => join(docs, f));
}

/** 隔离配置里使用的 pi-goal 副本：不带 node_modules，扩展的 pi 依赖由宿主 pi 提供。 */
function copyPiGoal(root: string): string {
	const dest = join(root, "pi-goal");
	cpSync(PI_GOAL_SRC, dest, { recursive: true, filter: (src) => !/[/\\](node_modules|\.git)([/\\]|$)/.test(src) });
	return dest;
}

const secretValue = (i: number) => String(((i * 7919 + 104729) % 900000) + 100000);

const own = (e: Entry) => e.type === "compaction" && (e.details as { smartCompact?: number } | undefined)?.smartCompact === 1;
const compactions = (entries: Entry[]) => entries.filter((e) => e.type === "compaction");
const lastAssistantText = (entries: Entry[]) => {
	const m = entries.filter((e) => e.type === "message" && e.message?.role === "assistant").at(-1)?.message;
	return JSON.stringify(m?.content ?? "");
};
const toolResultsOf = (entries: Entry[], name: string) => entries.filter((e) => e.type === "message" && e.message?.role === "toolResult" && e.message?.toolName === name);

/** 每次读一个文件，直到会话里出现 compaction 或读完；返回读了几个。 */
async function readUntilCompaction(io: RpcIo, files: string[], sessionDir: string, prefix: string, maxCompactions = 1): Promise<number> {
	let n = 0;
	for (const f of files) {
		await rpcPrompt(io, `${prefix}${n}`, `用 read 工具读取 ${f}，读完只回复「已读」两个字。`);
		n++;
		if (compactions(collectEntries([sessionDir]) as Entry[]).length >= maxCompactions) break;
	}
	return n;
}

/** 本扩展已进入 R5（停止自动压缩）时，运行不会再推进，等待应提前结束。 */
const stopped = (entries: Entry[]) => {
	const st = entries.filter((e) => e.type === "custom" && e.customType === "smart-compact").at(-1);
	return !!(st?.data as { r5?: unknown } | undefined)?.r5;
};

/** 轮询会话文件直到 pred 成立、本扩展进入 R5 或超时。 */
async function waitSession(sessionDir: string, pred: (entries: Entry[]) => boolean, timeoutMs: number): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	while (Date.now() < end) {
		const entries = collectEntries([sessionDir]) as Entry[];
		if (pred(entries)) return true;
		if (stopped(entries)) return false;
		await new Promise((r) => setTimeout(r, 3000));
	}
	return false;
}

interface Ctx {
	root: string;
	project: string;
	docs: string[];
	sessionDir: string;
	agentDir: string;
	extra: Record<string, unknown>;
}

interface CaseDef {
	id: string;
	title: string;
	window?: number;
	/** packages 加载的扩展（守卫自动放在第一项）；为空时用 -ne 加 -e 加载本扩展。 */
	packages?: (root: string) => string[];
	worst: Amounts;
	unobservableCalls?: boolean;
	args?: (c: Ctx) => string[];
	rpc?: (io: RpcIo, c: Ctx) => Promise<void>;
	check(c: Ctx, entries: Entry[], result: StepResult): { pass: boolean; notes: string[] };
}

const CASES: CaseDef[] = [
	{
		id: "T-native",
		title: "原生窗口不被改写：ctx.getContextUsage().contextWindow 与模型原生窗口相等",
		worst: worstFor(3, 272_000),
		args: () => ["-e", join(ROOT, "spike", "probe.ts"), "-p", "只回复 ok 两个字母。"],
		check(c) {
			const rows = existsSync(join(c.root, "probe.jsonl"))
				? readFileSync(join(c.root, "probe.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
				: [];
			const start = rows.find((r) => r.ev === "session_start");
			const windows = [...new Set(rows.map((r) => r.ctxWindow).filter((x) => typeof x === "number"))];
			const native = start?.modelWindow;
			return { pass: typeof native === "number" && native > 0 && windows.length === 1 && windows[0] === native, notes: [`模型原生窗口 ${native}，运行中 getContextUsage 的窗口 ${windows.join("、") || "无"}。`] };
		},
	},
	{
		id: "T-trigger",
		title: "测试窗口 120000、余量 32768，在触发点 87232 附近由本扩展接管阈值压缩，压缩后任务继续；随后用 recall_history 取回被压缩部分的细节（T-recall）",
		window: 120_000,
		worst: worstFor(40, 120_000),
		async rpc(io, c) {
			await rpcPrompt(io, "s", `用 read 工具读取 ${join(c.project, "secret.txt")}，读完只回复「已读」两个字。`);
			c.extra.reads = await readUntilCompaction(io, c.docs, c.sessionDir, "r");
			await rpcPrompt(io, "q", "secret.txt 中 key_137 的值是多少？当前上下文里如果没有 secret.txt 的原文，先调用 recall_history 工具（query 用 key_137）取回原文再回答。最后只回复这个数字。");
		},
		check(c, entries) {
			const cs = compactions(entries);
			const first = cs[0];
			const d = (first?.details ?? {}) as { reason?: string; mode?: string; stats?: { requests?: number } };
			const T = 120_000 - RESERVE;
			const tb = Number(first?.tokensBefore ?? 0);
			const answer = lastAssistantText(entries);
			const recalled = toolResultsOf(entries, "recall_history").length > 0;
			const summary = String(first?.summary ?? "");
			const notes = [
				`读了 ${c.extra.reads} 个文档后发生压缩；compaction 共 ${cs.length} 条，首条来自本扩展：${first ? own(first) : false}，原因 ${d.reason}，模式 ${d.mode}，摘要请求 ${d.stats?.requests}。`,
				`tokensBefore ${tb}，触发点 ${T}。`,
				`压缩包完整：${summary.includes(PACK_OPEN) && HEADINGS.every((h) => summary.includes(h))}。`,
				`召回：调用 recall_history ${recalled}，回答 ${answer.slice(0, 80)}，期望 ${secretValue(137)}。`,
			];
			const pass = !!first && own(first) && d.reason === "threshold" && tb >= T && summary.includes(PACK_OPEN) && HEADINGS.every((h) => summary.includes(h)) && recalled && answer.includes(secretValue(137));
			return { pass, notes };
		},
	},
	{
		id: "T-manual",
		title: "手动压缩带侧重点（RPC compact 命令）：侧重点作为最高优先级进入摘要，压缩包完整",
		window: 120_000,
		worst: worstFor(20, 120_000),
		async rpc(io, c) {
			for (const [i, f] of c.docs.slice(0, 3).entries()) await rpcPrompt(io, `r${i}`, `用 read 工具读取 ${f}，读完只回复「已读」两个字。`);
			// RPC 的 prompt 不执行 pi 自带的 /compact（会当作普通文本发给模型），手动压缩走 RPC 的 compact 命令，同样是 reason 为 manual 的路径。
			const resp = await rpcCommand(io, "c", { type: "compact", customInstructions: "重点保留 part-02.txt 的文件名与它的行号范围" }, 600_000);
			c.extra.compactOk = resp.success === true;
		},
		check(_c, entries) {
			const first = compactions(entries)[0];
			const d = (first?.details ?? {}) as { reason?: string; narrative?: string };
			const summary = String(first?.summary ?? "");
			const focus = (d.narrative ?? "").includes("part-02");
			const notes = [`compaction ${first ? "已生成" : "未生成"}，来自本扩展：${first ? own(first) : false}，原因 ${d.reason}。`, `叙述体现侧重点（含 part-02）：${focus}。`, `压缩包完整：${summary.includes(PACK_OPEN) && HEADINGS.every((h) => summary.includes(h))}。`];
			return { pass: !!first && own(first) && d.reason === "manual" && focus && HEADINGS.every((h) => summary.includes(h)), notes };
		},
	},
	{
		id: "T-sub",
		title: "pi-subagents 子会话加载本扩展，并在子会话内由本扩展接管压缩，subagent 正常返回",
		window: 120_000,
		packages: () => [ROOT, PI_SUBAGENTS],
		worst: worstFor(50, 120_000),
		args: (c) => [
			"-p",
			`使用 agent 工具派一个 subagent_type 为 general-purpose 的 subagent，run_in_background 为 false。让它依次用 read 工具读取下面这些文件，每次调用只读一个，读的过程中不输出文字，全部读完后只回复「子已读」：${c.docs.slice(0, 10).join("、")}。你收到它的结果后只回复「完成」。`,
		],
		check(c, entries) {
			const child = collectEntries([join(c.agentDir, "subagent-sessions")]) as Entry[];
			const childOwn = compactions(child).filter(own);
			const parentText = lastAssistantText(entries);
			const notes = [`子会话条目 ${child.length} 条，其中本扩展的 compaction ${childOwn.length} 条。`, `父会话最后回复：${parentText.slice(0, 60)}。`];
			return { pass: childOwn.length >= 1 && parentText.includes("完成"), notes };
		},
	},
	{
		id: "T-goal",
		title: "pi-goal：多轮任务累计压缩两次以上，目标仍有效，评估者输入含压缩包的验证记录且不超过整体上限，最终达成",
		window: 160_000,
		packages: (root) => [ROOT, copyPiGoal(root)],
		worst: worstFor(75, 160_000),
		unobservableCalls: true,
		async rpc(io, c) {
			const list = c.docs.slice(0, 24);
			c.extra.list = list.map((f) => f.split("/").at(-1));
			await rpcPrompt(io, "g", `/goal 已在 ${c.project} 运行过 npm test 且看到 all tests passed；并且已经用 read 工具逐个读过下面全部 ${list.length} 个文件（每次只读一个）：${list.join("、")}；最后一条回复按顺序列出这 ${list.length} 个文件名。`);
			c.extra.ended = await waitSession(c.sessionDir, (e) => e.some((x) => x.customType === "pi-goal" && (x.data as { type?: string }).type === "end"), 40 * 60_000);
		},
		check(c, entries, result) {
			const own2 = compactions(entries).filter(own).length;
			const end = entries.filter((x) => x.customType === "pi-goal" && (x.data as { type?: string }).type === "end").at(-1)?.data as { outcome?: string; reason?: string } | undefined;
			const evalInput = evaluatorInput(c.sessionDir);
			const notes = [
				`本扩展 compaction ${own2} 条；目标结束 ${c.extra.ended}，结果 ${end?.outcome}（${end?.reason ?? ""}）。`,
				`按最终会话重建的评估者输入：${evalInput.length} 字符（上限 60000），含验证记录小节：${evalInput.includes("### 验证记录")}，含 npm test：${evalInput.includes("npm test")}。`,
				`协调结果：退出码 ${result.exitCode}，超时 ${result.timedOut}。`,
			];
			return { pass: own2 >= 2 && end?.outcome === "met" && evalInput.length <= 60_000 && evalInput.includes("### 验证记录") && evalInput.includes("npm test"), notes };
		},
	},
	{
		id: "T-goal-constraint",
		title: "约束只存在于摘要中时，与约束冲突的目标不被评估者判定为达成",
		window: 160_000,
		packages: (root) => [ROOT, copyPiGoal(root)],
		worst: worstFor(45, 160_000),
		unobservableCalls: true,
		async rpc(io, c) {
			await rpcPrompt(io, "k", `本次会话的硬性约束：不得修改 ${join(c.project, "test")} 目录下的任何文件。只回复「收到」。`);
			c.extra.reads = await readUntilCompaction(io, c.docs, c.sessionDir, "r");
			await rpcPrompt(io, "g", `/goal ${join(c.project, "notes", "result.txt")} 的内容为 done，${join(c.project, "test", "a.txt")} 的内容为 changed，并且整个过程遵守了用户此前在对话中提出的全部约束。`);
			c.extra.decided = await waitSession(
				c.sessionDir,
				(e) => e.some((x) => (x.customType === "pi-goal" && (x.data as { type?: string }).type === "end") || (x.type === "custom_message" && x.customType === "pi-goal-continue")),
				20 * 60_000,
			);
			await rpcPrompt(io, "x", "/goal clear");
		},
		check(c, entries) {
			const constraintInSummaryOnly = compactions(entries).some((x) => own(x) && String(x.summary).includes("test"));
			const end = entries.filter((x) => x.customType === "pi-goal" && (x.data as { type?: string }).type === "end")[0]?.data as { outcome?: string; reason?: string } | undefined;
			const firstContinue = entries.find((x) => x.type === "custom_message" && x.customType === "pi-goal-continue");
			const firstVerdictMet = end?.outcome === "met" && (!firstContinue || entries.indexOf(firstContinue) > entries.findIndex((x) => x.data === end));
			const changed = existsSync(join(c.project, "test", "a.txt")) ? readFileSync(join(c.project, "test", "a.txt"), "utf8").trim() : "";
			const notes = [
				`压缩后摘要提及 test 约束：${constraintInSummaryOnly}；读了 ${c.extra.reads} 个文档。`,
				`首个评估结论为达成：${firstVerdictMet}；结束记录 ${end?.outcome ?? "无"}（${end?.reason ?? ""}）；首条续跑消息 ${firstContinue ? "有" : "无"}。`,
				`test/a.txt 当前内容：${changed}。`,
			];
			return { pass: constraintInSummaryOnly && c.extra.decided === true && !firstVerdictMet, notes };
		},
	},
];

/** 用 pi-goal 修改后的序列化函数，按最终会话的上下文条目重建评估者看到的文本（评估者的调用不写进会话文件）。 */
function evaluatorInput(sessionDir: string): string {
	const files: string[] = [];
	const walk = (d: string) => {
		for (const x of readdirSync(d, { withFileTypes: true })) {
			if (x.isDirectory()) walk(join(d, x.name));
			else if (x.name.endsWith(".jsonl")) files.push(join(d, x.name));
		}
	};
	if (existsSync(sessionDir)) walk(sessionDir);
	if (files.length === 0) return "";
	const sm = SessionManager.open(files[0]);
	return serializeForGoal(sm.buildContextEntries() as unknown[]);
}

let serializeForGoal: (entries: unknown[]) => string = () => "";

async function loadGoalSerializer(): Promise<void> {
	const mod = (await import(join(PI_GOAL_SRC, "extensions", "goal", "evaluator.ts"))) as { serializeTranscript: (e: unknown[], own: string) => string };
	serializeForGoal = (e) => mod.serializeTranscript(e, "pi-goal-continue");
}

async function main(ids: string[]): Promise<number> {
	const defs = ids.map((id) => {
		const d = CASES.find((x) => x.id === id);
		if (!d) throw new Error(`未知用例：${id}，可选：${CASES.map((x) => x.id).join("、")}`);
		return d;
	});
	await loadGoalSerializer();
	let failed = 0;
	await withCoordinator(`integration-${Date.now()}`, async (runStep) => {
		for (const def of defs) {
			assertAuthFresh(SOURCE_AGENT_DIR, MODEL.provider, def.worst.wallMs + 30 * 60_000);
			const root = join(process.env.TMPDIR ?? "/tmp", `sc-it-${def.id}-${Date.now()}`);
			// 根目录先按 0700 创建：packages 里的扩展副本要复制进来，不能让复制操作以默认权限先建出根目录。
			mkdirSync(root, { recursive: true, mode: 0o700 });
			const packages = def.packages ? [GUARD_PATH, ...def.packages(root)] : [];
			const iso = createIsolatedEnv({
				sourceAgentDir: SOURCE_AGENT_DIR,
				rootDir: root,
				provider: MODEL.provider,
				modelId: MODEL.id,
				compaction: { enabled: true, reserveTokens: RESERVE, keepRecentTokens: 20000 },
				contextWindowOverride: def.window,
				packages,
			});
			const out = join(ARCHIVE_DIR, def.id);
			rmSync(out, { recursive: true, force: true });
			mkdirSync(out, { recursive: true, mode: 0o700 });
			try {
				const sessionDir = join(root, "sessions");
				const c: Ctx = { root, project: iso.projectDir, docs: prepareProject(iso.projectDir), sessionDir, agentDir: iso.agentDir, extra: {} };
				process.stdout.write(`\n[${def.id}] ${def.title}\n`);
				const loadArgs = def.packages ? FLAGS : ["-ne", ...FLAGS, "-e", join(ROOT, "index.ts")];
				const mode = def.rpc ? ["--mode", "rpc"] : [];
				const result = await runStep({
					step: def.id,
					worst: def.worst,
					args: [...loadArgs, ...mode, "--session-dir", sessionDir, ...(def.args?.(c) ?? [])],
					env: { ...iso.env, PROBE_LOG: join(root, "probe.jsonl"), PROBE_MODE: "" },
					cwd: iso.projectDir,
					sessionDirs: [sessionDir, join(iso.agentDir, "subagent-sessions")],
					drive: def.rpc ? (io) => def.rpc!(io, c) : undefined,
					unobservableCalls: def.unobservableCalls,
					guardViaPackages: !!def.packages,
				});
				writeFileSync(join(out, "stdout.txt"), result.stdout);
				writeFileSync(join(out, "stderr.txt"), result.stderr);
				for (const [src, name] of [
					[sessionDir, "sessions"],
					[join(iso.agentDir, "subagent-sessions"), "subagent-sessions"],
				] as const) {
					if (existsSync(src)) cpSync(src, join(out, name), { recursive: true });
				}
				if (existsSync(join(root, "probe.jsonl"))) cpSync(join(root, "probe.jsonl"), join(out, "probe.jsonl"));
				const entries = collectEntries([sessionDir]) as Entry[];
				const verdict = def.check(c, entries, result);
				const summary = { id: def.id, title: def.title, exitCode: result.exitCode, timedOut: result.timedOut, actual: result.actual, driveError: result.driveError, ...verdict };
				writeFileSync(join(out, "result.json"), `${JSON.stringify(summary, null, 2)}\n`);
				process.stdout.write(`  退出码 ${result.exitCode}，超时 ${result.timedOut}，请求 ${result.actual?.requests ?? "未核实"}，费用 $${result.actual?.costUsd.toFixed(4) ?? "未核实"}${result.driveError ? `，驱动错误 ${result.driveError}` : ""}\n`);
				for (const n of verdict.notes) process.stdout.write(`  ${n}\n`);
				process.stdout.write(`  结论：${verdict.pass ? "通过" : "不通过"}\n`);
				if (!verdict.pass) failed++;
			} finally {
				iso.cleanup();
			}
		}
	});
	return failed === 0 ? 0 : 1;
}

if (process.argv[1] && process.argv[1].endsWith("eval/integration.ts")) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			process.stderr.write(`${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}\n`);
			process.exit(1);
		},
	);
}
