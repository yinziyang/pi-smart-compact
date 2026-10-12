// P0 spike 运行器：每项验证在隔离环境中经预算协调脚本执行，结果归档到 ~/.pi/agent/.collab/smart-compact/spike/<id>/（方案 12.1）。
//
// 用法：node spike/run.ts <spike-id> [<spike-id> ...]
// 归档内容：探针日志 probe.jsonl、会话文件、stdout 与 stderr、spec.json（本次参数与预留）、result.json（协调结果与判定）。
// 判定逻辑写在各 spike 的 check 函数里，只读归档内容，不再调用模型。

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLLAB_DIR, withCoordinator, type StepResult } from "../eval/coordinator.ts";
import { assertAuthFresh, createIsolatedEnv, type IsolateOptions } from "../eval/isolate.ts";
import type { Amounts } from "../eval/ledger.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROBE = join(HERE, "probe.ts");
const SOURCE_AGENT_DIR = join(homedir(), ".pi", "agent");
const PI_DOCS = join(homedir(), ".nvm", "versions", "node", "v24.18.1", "lib", "node_modules", "@earendil-works", "pi-coding-agent", "docs");
const ARCHIVE_DIR = join(COLLAB_DIR, "spike");
const MODEL = { provider: "openai-codex", id: "gpt-6-luna" };

export interface ProbeRow {
	t: number;
	pid: number;
	session: string;
	ev: string;
	ctxTokens: number | null;
	[k: string]: unknown;
}

interface SpikeDef {
	id: string;
	title: string;
	isolate: Omit<IsolateOptions, "sourceAgentDir" | "rootDir" | "provider" | "modelId">;
	probeMode: string;
	/** pi 参数；{docs} 会被替换为隔离项目目录下的 docs 路径。 */
	args: string[];
	worst: Amounts;
	extraEnv?: Record<string, string>;
	check(rows: ProbeRow[], sessions: string[], result: StepResult): { pass: boolean; notes: string[] };
}

function amounts(requests: number, avgIn: number, avgOut = 2_000): Amounts {
	return {
		requests,
		inputTokens: requests * avgIn,
		outputTokens: requests * avgOut,
		billedTokens: requests * (avgIn + avgOut),
		costUsd: Math.ceil(requests * (avgIn * 0.1 + avgOut * 0.5)) / 1e6 + 0.01,
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

const SPIKES: SpikeDef[] = [
	{
		id: "S1",
		title: "原生窗口减余量触发（测试窗口 45k，余量 32768，触发点 12232）",
		isolate: { compaction: { enabled: true, reserveTokens: 32768, keepRecentTokens: 8000 }, contextWindowOverride: 45_000 },
		probeMode: "",
		args: ["-p", "按顺序用 read 工具读取 {docs}/extensions.md、{docs}/compaction.md、{docs}/settings.md、{docs}/sessions.md、{docs}/models.md、{docs}/cli.md 六个文件，每次只读一个。每读完一个文件只回复「已读」两个字，不要总结内容。全部读完后回复「完成」。"],
		worst: amounts(15, 50_000),
		check(rows) {
			const notes: string[] = [];
			const compactions = rows.filter((r) => r.ev === "session_compact");
			const before = rows.filter((r) => r.ev === "session_before_compact");
			notes.push(`压缩次数 ${compactions.length}，before 事件 ${before.length}，原因 ${before.map((b) => b.reason).join("、") || "无"}。`);
			const tb = compactions.map((c) => Number(c.tokensBefore));
			notes.push(`tokensBefore：${tb.join("、") || "无"}；触发点 12232。`);
			const windows = [...new Set(rows.map((r) => r.ctxWindow).filter((w) => w !== null))];
			notes.push(`getContextUsage 报告的窗口：${windows.join("、")}。`);
			const pass = compactions.length >= 1 && tb.every((v) => v >= 12232) && before.every((b) => b.reason === "threshold") && windows.every((w) => w === 45000);
			return { pass, notes };
		},
	},
];

function archive(def: SpikeDef, iso: { agentDir: string }, sessionDir: string, probeLog: string, result: StepResult): { rows: ProbeRow[]; sessions: string[] } {
	const dir = join(ARCHIVE_DIR, def.id);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	if (existsSync(probeLog)) cpSync(probeLog, join(dir, "probe.jsonl"));
	const sessions: string[] = [];
	for (const root of [sessionDir, join(iso.agentDir, "subagent-sessions")]) {
		if (!existsSync(root)) continue;
		cpSync(root, join(dir, root === sessionDir ? "sessions" : "subagent-sessions"), { recursive: true });
		const walk = (d: string) => {
			for (const n of readdirSync(d, { withFileTypes: true })) {
				if (n.isDirectory()) walk(join(d, n.name));
				else if (n.name.endsWith(".jsonl")) sessions.push(join(d, n.name));
			}
		};
		walk(root);
	}
	writeFileSync(join(dir, "stdout.txt"), result.stdout);
	writeFileSync(join(dir, "stderr.txt"), result.stderr);
	return { rows: readJsonl(probeLog) as ProbeRow[], sessions };
}

async function main(ids: string[]): Promise<number> {
	const defs = ids.map((id) => {
		const d = SPIKES.find((s) => s.id === id);
		if (!d) throw new Error(`未知 spike：${id}`);
		return d;
	});
	let failed = 0;
	await withCoordinator(`spike-${Date.now()}`, async (runStep) => {
		for (const def of defs) {
			assertAuthFresh(SOURCE_AGENT_DIR, MODEL.provider, def.worst.wallMs + 30 * 60_000);
			const root = join(process.env.TMPDIR ?? "/tmp", `sc-spike-${def.id}-${Date.now()}`);
			const iso = createIsolatedEnv({ ...def.isolate, sourceAgentDir: SOURCE_AGENT_DIR, rootDir: root, provider: MODEL.provider, modelId: MODEL.id });
			try {
				const docs = join(iso.projectDir, "docs");
				cpSync(PI_DOCS, docs, { recursive: true, filter: (src) => !src.includes("/images") });
				const sessionDir = join(root, "sessions");
				const probeLog = join(root, "probe.jsonl");
				const args = ["-ne", "-nc", "-ns", "-np", "--no-themes", "--no-mcp", "--session-dir", sessionDir, "-e", PROBE, ...def.args.map((a) => a.replaceAll("{docs}", docs))];
				const env = { ...iso.env, PROBE_LOG: probeLog, PROBE_MODE: def.probeMode, ...(def.extraEnv ?? {}) };
				process.stdout.write(`\n[${def.id}] ${def.title}\n`);
				const result = await runStep({ step: def.id, worst: def.worst, args, env, cwd: iso.projectDir, sessionDirs: [sessionDir, join(iso.agentDir, "subagent-sessions")] });
				const { rows, sessions } = archive(def, iso, sessionDir, probeLog, result);
				const verdict = def.check(rows, sessions, result);
				const out = { id: def.id, title: def.title, exitCode: result.exitCode, timedOut: result.timedOut, actual: result.actual, ...verdict };
				writeFileSync(join(ARCHIVE_DIR, def.id, "result.json"), `${JSON.stringify(out, null, 2)}\n`);
				process.stdout.write(`  退出码 ${result.exitCode}，超时 ${result.timedOut}，用量 ${JSON.stringify(result.actual)}\n`);
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
