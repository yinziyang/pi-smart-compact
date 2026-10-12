// P0 spike 运行器：每项验证在隔离环境中经预算协调脚本执行，结果归档到 ~/.pi/agent/.collab/smart-compact/spike/<id>/（方案 12.1）。
//
// 用法：node spike/run.ts <spike-id> [<spike-id> ...]
// 一项 spike 可以有多个步骤，步骤之间共用同一个隔离环境与会话目录，可以在步骤之间改 compaction.enabled。
// 每个步骤的探针日志单独写一个文件，判定时按步骤区分。
// 归档内容：每步的 probe-<n>.jsonl、stdout、stderr，全部会话文件，以及 result.json（协调结果与判定）。
// 判定逻辑写在各 spike 的 check 函数里，只读归档内容，不再调用模型。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLLAB_DIR, type RpcIo, type StepResult, withCoordinator } from "../eval/coordinator.ts";
import { assertAuthFresh, createIsolatedEnv, type IsolateOptions } from "../eval/isolate.ts";
import type { Amounts } from "../eval/ledger.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "probe.ts");
const SOURCE_AGENT_DIR = join(homedir(), ".pi", "agent");
const PI_DOCS = join(homedir(), ".nvm", "versions", "node", "v24.18.1", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "docs");
const PI_SUBAGENTS = join(homedir(), ".pi", "agent", "git", "github.com", "yinziyang", "pi-subagents");
const ARCHIVE_DIR = join(COLLAB_DIR, "spike");
const MODEL = { provider: "openai-codex", id: "gpt-6-luna" };
const BASE_FLAGS = ["-ne", "-nc", "-ns", "-np", "--no-themes", "--no-mcp"];
const DOC_FILES = ["extensions.md", "compaction.md", "settings.md", "sessions.md", "models.md", "cli.md"];

export interface ProbeRow {
	t: number;
	pid: number;
	session: string;
	ev: string;
	ctxTokens: number | null;
	[k: string]: unknown;
}

type Entry = Record<string, unknown> & { type?: string; id?: string };

interface StepDef {
	/** -p 模式的参数，或 rpc 驱动二选一。参数中的 {docs} 会被替换为隔离项目里的 docs 目录。 */
	args?: string[];
	rpc?: (io: RpcIo, docs: string) => Promise<void>;
	probeMode?: string;
	/** 运行本步骤前把 settings.json 的 compaction.enabled 改成该值。 */
	compactionEnabled?: boolean;
	extraArgs?: string[];
	extraEnv?: Record<string, string>;
	worst: Amounts;
}

interface StepOutcome {
	result: StepResult;
	rows: ProbeRow[];
	settingsAfter: Record<string, unknown>;
}

interface SpikeDef {
	id: string;
	title: string;
	isolate: Omit<IsolateOptions, "sourceAgentDir" | "rootDir" | "provider" | "modelId">;
	steps: StepDef[];
	check(steps: StepOutcome[], entries: Entry[]): { pass: boolean; notes: string[] };
}

function amounts(requests: number, avgIn: number, avgOut = 2_000): Amounts {
	return {
		requests,
		inputTokens: requests * avgIn,
		outputTokens: requests * avgOut,
		billedTokens: requests * (avgIn + avgOut),
		costUsd: (requests * (avgIn * 0.1 + avgOut * 0.5)) / 1e6 + 0.01,
		wallMs: requests * 90_000,
	};
}

function readJsonl(file: string): Record<string, unknown>[] {
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const read = (n: number, tail = "全部读完之后只回复「完成」两个字。") =>
	`这是一个连续任务，必须一次做完：依次调用 read 工具读取下面全部 ${n} 个文件，每次调用只读一个文件：${DOC_FILES.slice(0, n)
		.map((f) => `{docs}/${f}`)
		.join("、")}。读的过程中不要输出任何文字，也不要总结内容，读完一个立即读下一个，直到 ${n} 个文件全部读完。${tail}`;

/** 一条 assistant 记录是否真的发生了 provider 请求：被本地中止的回合会补记一条 usage 全为 0 的 error 消息，不算请求。 */
function isRealRequest(r: ProbeRow): boolean {
	const u = (r.usage ?? {}) as Record<string, number | undefined>;
	return r.ev === "assistant_end" && (u.input ?? 0) + (u.output ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0) > 0;
}

/** 某事件首次出现之后，还发生了几次真实的 provider 请求（用来判断中止是否真正阻止了请求）。 */
function assistantAfter(rows: ProbeRow[], ev: string): { found: boolean; after: number } {
	const i = rows.findIndex((r) => r.ev === ev);
	if (i < 0) return { found: false, after: 0 };
	return { found: true, after: rows.slice(i + 1).filter(isRealRequest).length };
}

function orderOf(rows: ProbeRow[], evs: string[]): number[] {
	return evs.map((e) => rows.findIndex((r) => r.ev === e));
}

async function rpcPrompt(io: RpcIo, id: string, message: string, timeoutMs = 600_000): Promise<Record<string, unknown>> {
	const start = io.records.length;
	io.send({ id, type: "prompt", message });
	const resp = await io.waitFor((r) => r.type === "response" && r.id === id, 60_000);
	const disposition = (resp.data as { disposition?: string } | undefined)?.disposition;
	if (disposition !== "handled") await io.waitFor((r) => r.type === "agent_settled" && io.records.indexOf(r) >= start, timeoutMs);
	return resp;
}

async function rpcCommand(io: RpcIo, id: string, record: Record<string, unknown>, timeoutMs = 300_000): Promise<Record<string, unknown>> {
	io.send({ id, ...record });
	return io.waitFor((r) => r.type === "response" && r.id === id, timeoutMs);
}

/** 分多次提问、每次读一个文件，让对话有更多请求与切点。中途被中止时停止发送后续提问。 */
async function sequentialReads(io: RpcIo, docs: string): Promise<void> {
	for (const [i, f] of DOC_FILES.entries()) {
		const start = io.records.length;
		await rpcPrompt(io, `r${i}`, `用 read 工具读取 ${docs}/${f}，读完只回复「已读」两个字。`);
		const aborted = io.records.slice(start).some((r) => r.type === "message_end" && (r.message as { stopReason?: string } | undefined)?.stopReason === "aborted");
		if (aborted) return;
	}
}

const SMALL = { compaction: { enabled: true, reserveTokens: 32768, keepRecentTokens: 8000 }, contextWindowOverride: 45_000 };

const SPIKES: SpikeDef[] = [
	{
		id: "S1",
		title: "原生窗口减余量触发（测试窗口 45k，余量 32768，触发点 12232）",
		isolate: SMALL,
		steps: [{ args: ["-p", read(6)], worst: amounts(15, 50_000) }],
		check([s]) {
			const rows = s.rows;
			const compactions = rows.filter((r) => r.ev === "session_compact");
			const before = rows.filter((r) => r.ev === "session_before_compact");
			const tb = compactions.map((c) => Number(c.tokensBefore));
			const windows = [...new Set(rows.map((r) => r.ctxWindow).filter((w) => w !== null))];
			const notes = [
				`压缩次数 ${compactions.length}，原因 ${before.map((b) => b.reason).join("、") || "无"}。`,
				`tokensBefore：${tb.join("、") || "无"}；触发点 12232。`,
				`getContextUsage 报告的窗口：${windows.join("、")}。`,
			];
			return { pass: compactions.length >= 1 && tb.every((v) => v >= 12232) && before.every((b) => b.reason === "threshold") && windows.every((w) => w === 45000), notes };
		},
	},
	{
		id: "S5-S6",
		title: "自定切点 + generateSummaryWithUsage 经 streamSimple（OAuth）生成摘要，pi 接受并能连续压缩",
		isolate: SMALL,
		steps: [
			{
				// 分 6 次提问、每次读一个文件，对话中才有足够的 user 与 assistant 切点。
				rpc: (io, docs) => sequentialReads(io, docs),
				probeMode: "custom-compact",
				worst: amounts(20, 50_000),
			},
		],
		check([s]) {
			const rows = s.rows;
			const done = rows.filter((r) => r.ev === "probe_custom_done");
			const errors = rows.filter((r) => r.ev === "probe_custom_error");
			const compacts = rows.filter((r) => r.ev === "session_compact");
			const matched = compacts.every((c, i) => c.fromExtension === true && (c.details as { probe?: number } | undefined)?.probe === 1 && c.firstKept === done[i]?.firstKeptEntryId);
			const drops = compacts.map((c) => {
				const i = rows.indexOf(c);
				const next = rows.slice(i + 1).find((r) => r.ev === "turn_end" && r.ctxTokens !== null);
				return { before: Number(c.tokensBefore), after: next?.ctxTokens ?? null };
			});
			const last = [...rows].reverse().find((r) => r.ev === "assistant_end");
			const notes = [
				`自定摘要成功 ${done.length} 次，失败 ${errors.length} 次${errors.length ? `：${errors.map((e) => e.error).join("；")}` : ""}。`,
				`pi 追加的 compaction 与自选切点一致：${matched}；fromExtension 都为真。`,
				`压缩前后上下文：${drops.map((d) => `${d.before}→${d.after}`).join("，")}。`,
				`最后一次响应 stopReason：${last?.stopReason}。`,
			];
			return { pass: done.length >= 1 && errors.length === 0 && matched && compacts.length === done.length && drops.every((d) => d.after !== null && d.after < d.before) && last?.stopReason === "stop", notes };
		},
	},
	{
		id: "S7-S11",
		title: "RPC 的 set_auto_compaction 与 compact；/compact 与扩展命令是否经过 input 事件",
		isolate: SMALL,
		steps: [
			{
				rpc: async (io, docs) => {
					await rpcPrompt(io, "p1", read(2).replaceAll("{docs}", docs));
					await rpcPrompt(io, "p2", "/probe-cmd");
					await rpcCommand(io, "a1", { type: "set_auto_compaction", enabled: false });
					await rpcCommand(io, "c1", { type: "compact" });
					await rpcPrompt(io, "p3", "/compact");
				},
				worst: amounts(10, 20_000, 4_000),
			},
		],
		check([s]) {
			const recs = s.result.records;
			const resp = (id: string) => recs.find((r) => r.type === "response" && r.id === id);
			const inputs = s.rows.filter((r) => r.ev === "input").map((r) => String(r.text));
			const compacts = s.rows.filter((r) => r.ev === "session_compact").map((r) => r.reason);
			const enabled = (s.settingsAfter.compaction as { enabled?: unknown } | undefined)?.enabled;
			const notes = [
				`set_auto_compaction 响应成功：${resp("a1")?.success}；compact 响应成功：${resp("c1")?.success}，firstKeptEntryId ${(resp("c1")?.data as { firstKeptEntryId?: string } | undefined)?.firstKeptEntryId ?? "无"}。`,
				`set_auto_compaction 之后 settings.json 的 compaction.enabled：${String(enabled)}（F20：会持久化）。`,
				`经过 input 事件的文本：${inputs.map((t) => `「${t.slice(0, 20)}」`).join("、")}。`,
				`/probe-cmd 被执行：${s.rows.some((r) => r.ev === "probe_cmd")}；压缩原因：${compacts.join("、") || "无"}。`,
				s.result.driveError ? `驱动错误：${s.result.driveError}` : "驱动正常结束。",
			];
			return { pass: resp("a1")?.success === true && resp("c1")?.success === true && enabled === false && !s.result.driveError && compacts.includes("manual"), notes };
		},
	},
	{
		id: "S9-S10a",
		title: "发送新提示词前的压缩检查晚于 input、早于 before_agent_start；在 session_before_compact 中中止可阻止该次请求",
		isolate: SMALL,
		steps: [
			{ compactionEnabled: false, args: ["-p", read(4)], worst: amounts(8, 20_000) },
			{ compactionEnabled: true, args: ["-c", "-p", "只回复「好」"], worst: amounts(4, 20_000) },
			{ compactionEnabled: false, args: ["-c", "-p", read(4)], worst: amounts(8, 20_000) },
			{ compactionEnabled: true, probeMode: "abort-in-compact", args: ["-c", "-p", "只回复「好」"], worst: amounts(4, 20_000) },
		],
		check(steps) {
			const s2 = steps[1].rows;
			const [inp, bc, bas] = orderOf(s2, ["input", "session_before_compact", "before_agent_start"]);
			const ordered = inp >= 0 && bc > inp && bas > bc;
			const s4 = steps[3].rows;
			const ab = assistantAfter(s4, "probe_abort");
			const notes = [
				`步骤 2 事件位置：input ${inp}，session_before_compact ${bc}（原因 ${s2[bc]?.reason ?? "无"}），before_agent_start ${bas}。顺序成立：${ordered}。`,
				`步骤 4：探针中止 ${ab.found ? "已触发" : "未触发"}，中止之后的真实请求 ${ab.after} 次。`,
			];
			return { pass: ordered && ab.found && ab.after === 0, notes };
		},
	},
	{
		id: "S10b",
		title: "工具续轮中途压缩时，在 session_before_compact 中中止可阻止后续请求",
		isolate: SMALL,
		steps: [{ args: ["-p", read(6)], probeMode: "abort-in-compact", worst: amounts(10, 30_000) }],
		check([s]) {
			const ab = assistantAfter(s.rows, "probe_abort");
			const reason = s.rows.find((r) => r.ev === "session_before_compact")?.reason;
			return { pass: ab.found && ab.after === 0 && reason === "threshold", notes: [`中止：${ab.found}，原因 ${reason}，中止后的真实请求 ${ab.after} 次。`] };
		},
	},
	{
		id: "S10c-S8",
		title: "虚拟模型：阈值按路由到的物理模型窗口判断；在 prepareRequest 中触发的压缩里中止可阻止请求",
		isolate: { ...SMALL, extraWindowOverrides: [{ provider: "openai-codex", modelId: "gpt-5.6-luna", contextWindow: 60_000 }] },
		steps: [
			{ extraArgs: ["--model", "probe/auto"], rpc: (io, docs) => sequentialReads(io, docs), probeMode: "virtual", extraEnv: { PROBE_VIRTUAL_TARGETS: "openai-codex/gpt-6-luna,openai-codex/gpt-5.6-luna" }, worst: amounts(20, 50_000) },
			{ extraArgs: ["--model", "probe/auto"], rpc: (io, docs) => sequentialReads(io, docs), probeMode: "virtual,abort-in-compact", extraEnv: { PROBE_VIRTUAL_TARGETS: "openai-codex/gpt-6-luna,openai-codex/gpt-5.6-luna" }, worst: amounts(20, 50_000) },
		],
		check([s8, s10]) {
			const notes: string[] = [];
			const routes = s8.rows.filter((r) => r.ev === "probe_route");
			notes.push(`路由 ${routes.length} 次，窗口序列：${routes.map((r) => r.window).join("、")}。`);
			const checks = s8.rows
				.filter((r) => r.ev === "session_before_compact")
				.map((bc) => {
					const i = s8.rows.indexOf(bc);
					const route = [...s8.rows.slice(0, i)].reverse().find((r) => r.ev === "probe_route");
					const w = Number(route?.window ?? 0);
					return { tokensBefore: Number(bc.tokensBefore), window: w, ok: Number(bc.tokensBefore) >= w - 32768 };
				});
			notes.push(`各次压缩：${checks.map((c) => `${c.tokensBefore}（路由窗口 ${c.window}，触发点 ${c.window - 32768}）`).join("；") || "无"}。`);
			const ab = assistantAfter(s10.rows, "probe_abort");
			notes.push(`虚拟模型下中止：${ab.found}，中止后的真实请求 ${ab.after} 次。`);
			return { pass: routes.length > 0 && checks.length > 0 && checks.every((c) => c.ok) && ab.found && ab.after === 0, notes };
		},
	},
	{
		id: "S10d",
		title: "在第 2 个 turn_start 调用 ctx.abort() 可阻止该回合的请求",
		isolate: SMALL,
		steps: [{ args: ["-p", read(6)], probeMode: "abort-turn-start:2", worst: amounts(6, 20_000) }],
		check([s]) {
			const ab = assistantAfter(s.rows, "probe_abort");
			return { pass: ab.found && ab.after === 0, notes: [`第 2 回合中止：${ab.found}，中止后的真实请求 ${ab.after} 次。`] };
		},
	},
	{
		id: "S12",
		title: "长度恢复：恢复省略编辑出现在 agent_end 之后、agent_before_settle 之前；agent_before_settle 内 appendEntry 早于 boundary 条目",
		isolate: { compaction: { enabled: true, reserveTokens: 6000, keepRecentTokens: 4000 }, contextWindowOverride: 30_000 },
		steps: [
			{
				args: ["-p", read(4, "全部读完后，写一篇不少于两万字的中文长文，逐段复述这些文档的内容，必须写满两万字，不要提前结束。")],
				probeMode: "append-in-settle",
				worst: amounts(12, 30_000, 20_000),
			},
		],
		check([s], entries) {
			const notes: string[] = [];
			const lengthIdx = entries.findIndex((e) => e.type === "message" && (e.message as { stopReason?: string } | undefined)?.stopReason === "length");
			notes.push(`出现 stopReason=length 的响应：${lengthIdx >= 0}。`);
			const edits = entries.map((e, i) => ({ e, i })).filter(({ e }) => e.type === "context_edit" && (e as { replacement?: unknown }).replacement === null);
			notes.push(`replacement=null 的编辑 ${edits.length} 条，位置 ${edits.map((x) => x.i).join("、")}。`);
			const agentEnds = s.rows.filter((r) => r.ev === "agent_end").map((r) => String(r.leaf));
			const settleRow = s.rows.find((r) => r.ev === "agent_before_settle");
			const idxOf = (id: string) => entries.findIndex((e) => e.id === id);
			const firstEnd = agentEnds.length ? idxOf(agentEnds[0]) : -1;
			const settleLeaf = settleRow ? idxOf(String(settleRow.leaf)) : -1;
			const editsInWindow = edits.length > 0 && edits.every(({ i }) => i > firstEnd && (settleLeaf < 0 || i <= settleLeaf));
			notes.push(`首个 agent_end 时叶子位置 ${firstEnd}，agent_before_settle 时叶子位置 ${settleLeaf}；省略编辑都落在两者之间：${editsInWindow}。`);
			const bc = s.rows.filter((r) => r.ev === "session_before_compact").map((r) => `${r.reason}/${r.willRetry}`);
			notes.push(`压缩事件：${bc.join("、") || "无"}；agent_start 次数 ${s.rows.filter((r) => r.ev === "agent_start").length}。`);
			const marker = entries.findIndex((e) => e.type === "custom" && e.customType === "probe-close-marker");
			const draft = entries.findIndex((e) => e.type === "custom" && e.customType === "probe-boundary-draft");
			notes.push(`appendEntry 条目位置 ${marker}，boundary 草稿位置 ${draft}；前者更早：${marker >= 0 && draft > marker}。`);
			return { pass: lengthIdx >= 0 && editsInWindow && marker >= 0 && draft > marker, notes };
		},
	},
	{
		id: "S13",
		title: "pi-subagents 子会话是否加载 -e 显式指定的扩展",
		isolate: SMALL,
		steps: [
			{
				args: ["-e", PI_SUBAGENTS, "-p", "使用 agent 工具派一个 subagent_type 为 general-purpose 的 subagent，run_in_background 为 false，让它用 read 工具读取 {docs}/models.md，读完只回复「子已读」。你收到结果后只回复「完成」。"],
				worst: amounts(10, 30_000),
			},
		],
		check([s]) {
			const sessions = [...new Set(s.rows.map((r) => r.session).filter(Boolean))];
			const childStarts = s.rows.filter((r) => r.ev === "session_start").length;
			return { pass: sessions.length >= 2, notes: [`探针看到的会话 ${sessions.length} 个，session_start ${childStarts} 次。子会话加载了 -e 扩展：${sessions.length >= 2}。`] };
		},
	},
];

function collectEntries(dirs: string[]): Entry[] {
	const out: Entry[] = [];
	const walk = (d: string) => {
		if (!existsSync(d)) return;
		for (const n of readdirSync(d, { withFileTypes: true })) {
			if (n.isDirectory()) walk(join(d, n.name));
			else if (n.name.endsWith(".jsonl")) out.push(...(readJsonl(join(d, n.name)) as Entry[]));
		}
	};
	for (const d of dirs) walk(d);
	return out;
}

async function main(ids: string[]): Promise<number> {
	const defs = ids.map((id) => {
		const d = SPIKES.find((s) => s.id === id);
		if (!d) throw new Error(`未知 spike：${id}，可选：${SPIKES.map((s) => s.id).join("、")}`);
		return d;
	});
	let failed = 0;
	await withCoordinator(`spike-${Date.now()}`, async (runStep) => {
		for (const def of defs) {
			const totalWall = def.steps.reduce((a, s) => a + s.worst.wallMs, 0);
			assertAuthFresh(SOURCE_AGENT_DIR, MODEL.provider, totalWall + 30 * 60_000);
			const root = join(process.env.TMPDIR ?? "/tmp", `sc-spike-${def.id}-${Date.now()}`);
			const iso = createIsolatedEnv({ ...def.isolate, sourceAgentDir: SOURCE_AGENT_DIR, rootDir: root, provider: MODEL.provider, modelId: MODEL.id });
			const out = join(ARCHIVE_DIR, def.id);
			// 每次运行前清空本项的归档，避免和上一次运行的会话文件混在一起。
			rmSync(out, { recursive: true, force: true });
			mkdirSync(out, { recursive: true, mode: 0o700 });
			try {
				const docs = join(iso.projectDir, "docs");
				cpSync(PI_DOCS, docs, { recursive: true, filter: (src) => !src.includes("/images") });
				const sessionDir = join(root, "sessions");
				const settingsFile = join(iso.agentDir, "settings.json");
				process.stdout.write(`\n[${def.id}] ${def.title}\n`);
				const outcomes: StepOutcome[] = [];
				for (const [i, step] of def.steps.entries()) {
					if (step.compactionEnabled !== undefined) {
						const st = JSON.parse(readFileSync(settingsFile, "utf8")) as { compaction: Record<string, unknown> };
						st.compaction.enabled = step.compactionEnabled;
						writeFileSync(settingsFile, `${JSON.stringify(st, null, 2)}\n`, { mode: 0o600 });
					}
					const probeLog = join(root, `probe-${i + 1}.jsonl`);
					const mode = step.rpc ? ["--mode", "rpc"] : [];
					const args = [...BASE_FLAGS, ...mode, "--session-dir", sessionDir, "-e", PROBE, ...(step.extraArgs ?? []), ...(step.args ?? []).map((a) => a.replaceAll("{docs}", docs))];
					const env = { ...iso.env, PROBE_LOG: probeLog, PROBE_MODE: step.probeMode ?? "", ...(step.extraEnv ?? {}) };
					const result = await runStep({
						step: `${def.id}#${i + 1}`,
						worst: step.worst,
						args,
						env,
						cwd: iso.projectDir,
						sessionDirs: [sessionDir, join(iso.agentDir, "subagent-sessions")],
						drive: step.rpc ? (io) => step.rpc!(io, docs) : undefined,
					});
					if (existsSync(probeLog)) cpSync(probeLog, join(out, `probe-${i + 1}.jsonl`));
					writeFileSync(join(out, `stdout-${i + 1}.txt`), result.stdout);
					writeFileSync(join(out, `stderr-${i + 1}.txt`), result.stderr);
					outcomes.push({ result, rows: readJsonl(probeLog) as ProbeRow[], settingsAfter: JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown> });
					process.stdout.write(`  步骤 ${i + 1}：退出码 ${result.exitCode}，超时 ${result.timedOut}，请求 ${result.actual?.requests ?? "未知"}，费用 $${result.actual?.costUsd.toFixed(4) ?? "未知"}${result.driveError ? `，驱动错误 ${result.driveError}` : ""}\n`);
				}
				for (const [src, name] of [
					[sessionDir, "sessions"],
					[join(iso.agentDir, "subagent-sessions"), "subagent-sessions"],
				] as const) {
					if (existsSync(src)) cpSync(src, join(out, name), { recursive: true });
				}
				const entries = collectEntries([sessionDir]);
				const verdict = def.check(outcomes, entries);
				writeFileSync(join(out, "result.json"), `${JSON.stringify({ id: def.id, title: def.title, steps: outcomes.map((o) => ({ exitCode: o.result.exitCode, timedOut: o.result.timedOut, actual: o.result.actual, driveError: o.result.driveError })), ...verdict }, null, 2)}\n`);
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

if (process.argv[1] && process.argv[1].endsWith("spike/run.ts")) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			process.stderr.write(`${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}\n`);
			process.exit(1);
		},
	);
}
