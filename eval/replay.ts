// 回放评测（方案 12.3）：判定「压缩后对话质量不变差」的依据。
//
// 流程（每个样本）：
//   1. 从本地真实会话复制一份，截断在一条 stopReason 为 stop、输入侧 usage 不超过截断上限的 assistant 消息之后，并把 session 头部的 cwd 改成空的临时项目目录。
//   2. 用一次模型调用从截断后的用户消息中提取 1 到 3 条关键用户约束（方案要求事先标注，这里由模型代为标注，结果归档供人工复核）。
//   3. 生成四组基础副本：O 不压缩；A 用 pi 默认压缩；B 用 smart-compact 压缩；C 用 smart-compact 的受控回退（PI_SMART_COMPACT_FAULT=main）。压缩一律经 RPC 的 compact 命令。
//   4. 每个「组别 × 问题」各复制一份独立副本，用 -p 回答一个问题，禁用全部工具，问题之间互不可见。
//   5. 每个问题一次评判调用：以 O 组回答为参照，给匿名化的 A、B、C 回答打 0~2 分；「用户约束」一题另外判断 B 是否覆盖全部关键约束。
// 所有调用都经预算协调脚本串行执行，在隔离配置中运行，关闭自动压缩，答题与评判加 -nt。
//
// 用法：node eval/replay.ts [--limit N] [--samples 1,2]；结果归档到 ~/.pi/agent/.collab/smart-compact/replay/。

import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COLLAB_DIR, type StepResult, withCoordinator } from "./coordinator.ts";
import { assertAuthFresh, createIsolatedEnv } from "./isolate.ts";
import type { Amounts } from "./ledger.ts";
import { findReplayCandidates } from "./preview.ts";
import { rpcCommand } from "../spike/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const SOURCE_AGENT_DIR = join(homedir(), ".pi", "agent");
const ARCHIVE_DIR = join(COLLAB_DIR, "replay");
const MODEL = { provider: "openai-codex", id: "gpt-6-luna", window: 272_000, maxTokens: 128_000 };
const RESERVE = 32_768;
const TRIGGER = MODEL.window - RESERVE;
const BASE = ["-nc", "-ns", "-np", "--no-themes", "--no-mcp", "--provider", MODEL.provider, "--model", MODEL.id];
/** 只使用 openai-codex 产生的会话；deepseek 产生的会话需要用户另行同意，不纳入。 */
const ALLOWED_ORIGIN = /^openai-codex\//;
/** 排除本项目自己的评审会话。 */
const EXCLUDE = /pictl-sc-/;

const QUESTIONS = [
	{ key: "goal", q: "当前的总体目标是什么？" },
	{ key: "next", q: "下一步具体要做什么？" },
	{ key: "constraints", q: "用户在对话中提出过哪些约束或偏好？逐条列出。" },
	{ key: "failure", q: "最近一次失败是什么？原因是什么？" },
	{ key: "verified", q: "哪些事情已经验证过？分别是怎么验证的（命令与结果）？" },
	{ key: "skills", q: "接下来应该遵守哪些 skill 或规则？" },
] as const;
const GROUPS = ["O", "A", "B", "C"] as const;
type Group = (typeof GROUPS)[number];

/** 单次请求的预留：守卫按「窗口 + maxTokens」预占计费 token；费用按 luna 价目（输入 0.1、输出 0.5 美元每百万 token）。 */
function worst(requests: number, avgIn: number, avgOut = 8_000): Amounts {
	return {
		requests,
		inputTokens: requests * avgIn,
		outputTokens: requests * avgOut,
		billedTokens: requests * (MODEL.window + MODEL.maxTokens),
		costUsd: (requests * (avgIn * 0.1 + avgOut * 0.5)) / 1e6 + 0.01,
		wallMs: Math.max(requests, 1) * 180_000,
	};
}

interface Line {
	raw: string;
	obj: Record<string, unknown>;
}

/** 截断会话：保留到最后一条输入侧 usage 不超过 limit 且 stopReason 为 stop 的 assistant 消息。返回新文本与截断点的输入 token。 */
export function truncateSession(text: string, limit: number, cwd: string): { text: string; tokens: number; userTexts: string[] } | null {
	const lines: Line[] = text
		.split("\n")
		.filter((l) => l.trim())
		.map((raw) => ({ raw, obj: JSON.parse(raw) as Record<string, unknown> }));
	let cut = -1;
	let tokens = 0;
	lines.forEach((l, i) => {
		const m = l.obj.message as { role?: string; stopReason?: string; usage?: Record<string, number> } | undefined;
		if (l.obj.type !== "message" || m?.role !== "assistant" || m.stopReason !== "stop" || !m.usage) return;
		const t = (m.usage.input ?? 0) + (m.usage.cacheRead ?? 0) + (m.usage.cacheWrite ?? 0);
		if (t <= limit) {
			cut = i;
			tokens = t;
		}
	});
	if (cut < 0) return null;
	const kept = lines.slice(0, cut + 1).map((l, i) => (i === 0 && l.obj.type === "session" ? JSON.stringify({ ...l.obj, cwd }) : l.raw));
	const userTexts = lines
		.slice(0, cut + 1)
		.map((l) => l.obj.message as { role?: string; content?: unknown } | undefined)
		.filter((m) => m?.role === "user")
		.map((m) => (typeof m!.content === "string" ? m!.content : Array.isArray(m!.content) ? (m!.content as { type?: string; text?: string }[]).filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n") : ""));
	return { text: `${kept.join("\n")}\n`, tokens, userTexts };
}

function parseJson<T>(text: string): T | null {
	for (let s = text.indexOf("{"); s >= 0; s = text.indexOf("{", s + 1)) {
		for (let e = text.lastIndexOf("}"); e > s; e = text.lastIndexOf("}", e - 1)) {
			try {
				return JSON.parse(text.slice(s, e + 1)) as T;
			} catch {
				// 继续尝试更短的片段。
			}
		}
	}
	return null;
}

/** 固定的匿名化排列：按问题序号轮换，避免评判者按标签偏好打分。 */
function permutation(qi: number): Group[] {
	const base: Group[] = ["A", "B", "C"];
	return base.map((_, i) => base[(i + qi) % 3]);
}

interface SampleResult {
	sample: string;
	tokens: number;
	constraints: string[];
	scores: Record<Group, Record<string, number>>;
	bCoversConstraints: boolean | null;
	cFallback: boolean | null;
	bBaseline: number | null;
	compactions: Record<string, unknown>;
	errors: string[];
}

async function main(argv: string[]): Promise<number> {
	const limitIdx = argv.indexOf("--limit");
	const limit = limitIdx >= 0 ? Number(argv[limitIdx + 1]) : 5;
	const candidates = findReplayCandidates(join(SOURCE_AGENT_DIR, "sessions"), TRIGGER, 30)
		.filter((c) => ALLOWED_ORIGIN.test(c.model) && !EXCLUDE.test(c.file))
		.slice(0, limit);
	mkdirSync(ARCHIVE_DIR, { recursive: true, mode: 0o700 });
	const results: SampleResult[] = [];
	await withCoordinator(`replay-${Date.now()}`, async (runStep) => {
		for (const [si, cand] of candidates.entries()) {
			assertAuthFresh(SOURCE_AGENT_DIR, MODEL.provider, 90 * 60_000);
			const sample = `s${si + 1}`;
			const root = join(process.env.TMPDIR ?? "/tmp", `sc-replay-${sample}-${Date.now()}`);
			const iso = createIsolatedEnv({ sourceAgentDir: SOURCE_AGENT_DIR, rootDir: root, provider: MODEL.provider, modelId: MODEL.id, compaction: { enabled: false, reserveTokens: RESERVE, keepRecentTokens: 20000 } });
			const out = join(ARCHIVE_DIR, sample);
			rmSync(out, { recursive: true, force: true });
			mkdirSync(out, { recursive: true, mode: 0o700 });
			const res: SampleResult = { sample, tokens: 0, constraints: [], scores: { O: {}, A: {}, B: {}, C: {} }, bCoversConstraints: null, cFallback: null, bBaseline: null, compactions: {}, errors: [] };
			const step = async (name: string, args: string[], w: Amounts, extraEnv: Record<string, string> = {}, sessionDir?: string, drive?: Parameters<typeof runStep>[0]["drive"]): Promise<StepResult> => {
				const r = await runStep({ step: `replay:${sample}:${name}`, worst: w, args, env: { ...iso.env, ...extraEnv }, cwd: iso.projectDir, sessionDirs: sessionDir ? [sessionDir] : [], drive });
				if (r.exitCode !== 0 || r.timedOut || r.driveError) res.errors.push(`${name}：退出码 ${r.exitCode}，超时 ${r.timedOut}${r.driveError ? `，${r.driveError}` : ""}，${r.stderr.slice(-300)}`);
				return r;
			};
			try {
				process.stdout.write(`\n[${sample}] 原会话峰值 ${Math.round(cand.peak / 1000)}k（${cand.model}），截断上限 ${Math.round(cand.size / 1000)}k\n`);
				const t = truncateSession(readFileSync(cand.file, "utf8"), cand.size, iso.projectDir);
				if (!t) throw new Error("找不到合适的截断点");
				res.tokens = t.tokens;
				const baseDir = join(root, "base");
				mkdirSync(baseDir, { recursive: true });
				const baseFile = join(baseDir, "O.jsonl");
				writeFileSync(baseFile, t.text, { mode: 0o600 });
				writeFileSync(join(out, "meta.json"), JSON.stringify({ source: cand.file, peak: cand.peak, cutTokens: t.tokens }, null, 2));

				// 关键约束标注：只给模型看用户消息原文。
				const userDump = t.userTexts.join("\n---\n").slice(-30_000);
				const ann = await step("constraints", ["-ne", ...BASE, "-nt", "--no-session", "-p", `下面是一段编码会话里用户发出的全部消息（按时间顺序，用 --- 分隔）。从中找出 1 到 3 条最关键的、对后续工作有约束力的用户要求（例如禁止做什么、必须怎么做、偏好的方式）。只输出 JSON：{"constraints":["…"]}。\n\n<user_messages>\n${userDump}\n</user_messages>`], worst(1, 12_000, 2_000));
				res.constraints = parseJson<{ constraints?: string[] }>(ann.stdout)?.constraints?.slice(0, 3) ?? [];

				// 压缩阶段：A 默认压缩，B smart-compact，C 受控回退。
				const files: Record<Group, string> = { O: baseFile, A: join(baseDir, "A.jsonl"), B: join(baseDir, "B.jsonl"), C: join(baseDir, "C.jsonl") };
				for (const g of ["A", "B", "C"] as const) {
					copyFileSync(baseFile, files[g]);
					const ext = g === "A" ? ["-ne"] : ["-ne", "-e", join(ROOT, "index.ts")];
					const env: Record<string, string> = g === "C" ? { PI_SMART_COMPACT_FAULT: "main" } : {};
					const r = await step(`compact-${g}`, [...ext, ...BASE, "-nt", "--mode", "rpc", "--session", files[g]], worst(g === "A" ? 4 : 12, t.tokens, 16_000), env, baseDir, async (io) => {
						const resp = await rpcCommand(io, "c", { type: "compact" }, 20 * 60_000);
						if (resp.success !== true) throw new Error(`compact 失败：${JSON.stringify(resp).slice(0, 300)}`);
					});
					const entries = readFileSync(files[g], "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
					const comps = entries.filter((e) => e.type === "compaction");
					const last = comps.at(-1) as { details?: { smartCompact?: number; fallback?: boolean; stats?: unknown; budget?: unknown }; summary?: string; tokensBefore?: number } | undefined;
					res.compactions[g] = { count: comps.length, own: last?.details?.smartCompact === 1, fallback: last?.details?.fallback, summaryChars: last?.summary?.length, stats: last?.details?.stats, budget: last?.details?.budget, exit: r.exitCode };
					if (g === "C") res.cFallback = last?.details?.fallback === true;
					if (comps.length !== 1) res.errors.push(`${g} 组压缩阶段新增 ${comps.length} 条 compaction，样本作废`);
				}

				// 答题：每个组别与问题各一份副本。
				const answers: Record<Group, string[]> = { O: [], A: [], B: [], C: [] };
				for (const g of GROUPS) {
					for (const [qi, q] of QUESTIONS.entries()) {
						const dir = join(root, "answers", `${g}-${qi}`);
						mkdirSync(dir, { recursive: true });
						const file = join(dir, "s.jsonl");
						copyFileSync(files[g], file);
						const before = readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"type":"compaction"')).length;
						const ext = g === "B" || g === "C" ? ["-ne", "-e", join(ROOT, "index.ts")] : ["-ne"];
						const r = await step(`answer-${g}-${q.key}`, [...ext, ...BASE, "-nt", "--session", file, "-p", `只依据当前对话上下文回答下面的问题，不要调用任何工具，简洁作答：${q.q}`], worst(1, g === "O" ? t.tokens : 60_000, 4_000), { PI_SMART_COMPACT_SUMMARY: g === "O" ? "off" : "" }, dir);
						const after = readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"type":"compaction"')).length;
						if (after !== before) res.errors.push(`${g}-${q.key} 答题期间新增 compaction`);
						answers[g].push(r.stdout.trim());
					}
				}
				writeFileSync(join(out, "answers.json"), JSON.stringify(answers, null, 2));

				// 评判：以 O 为参照，匿名化 A、B、C。
				for (const [qi, q] of QUESTIONS.entries()) {
					const perm = permutation(qi);
					const labels = ["X", "Y", "Z"];
					const blocks = perm.map((g, i) => `<answer id="${labels[i]}">\n${answers[g][qi]}\n</answer>`).join("\n");
					const extra =
						q.key === "constraints" && res.constraints.length
							? `\n另外，判断每个回答是否覆盖了下面全部关键约束（意思一致即可）：${JSON.stringify(res.constraints)}。在 JSON 中加入 "covers": {"X": true|false, "Y": …, "Z": …}。`
							: "";
					const prompt = `你是评分者。下面有一个问题、一个参考回答（来自拥有完整上下文的 agent），以及三个待评回答。按与参考回答在关键信息上的一致程度给每个待评回答打分：2 分为关键信息完整且没有错误，1 分为部分正确或有遗漏，0 分为错误、编造或没有回答。只输出 JSON：{"scores":{"X":0|1|2,"Y":…,"Z":…}}。${extra}\n\n<question>${q.q}</question>\n<reference>\n${answers.O[qi]}\n</reference>\n${blocks}`;
					const j = await step(`judge-${q.key}`, ["-ne", ...BASE, "-nt", "--no-session", "-p", prompt], worst(1, 12_000, 2_000));
					const parsed = parseJson<{ scores?: Record<string, number>; covers?: Record<string, boolean> }>(j.stdout);
					if (!parsed?.scores) {
						res.errors.push(`评判 ${q.key} 无法解析`);
						continue;
					}
					res.scores.O[q.key] = 2;
					perm.forEach((g, i) => (res.scores[g][q.key] = Number(parsed.scores![labels[i]] ?? 0)));
					if (q.key === "constraints" && parsed.covers) res.bCoversConstraints = parsed.covers[labels[perm.indexOf("B")]] === true;
				}
				// B 组压缩后的基线：用 B 组第一题答题请求的输入侧 usage。
				const bFile = join(root, "answers", "B-0", "s.jsonl");
				if (existsSync(bFile)) {
					const last = readFileSync(bFile, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as { type?: string; message?: { role?: string; usage?: Record<string, number> } }).filter((e) => e.type === "message" && e.message?.role === "assistant").at(-1);
					const u = last?.message?.usage;
					if (u) res.bBaseline = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0);
				}
				for (const g of ["A", "B", "C"] as const) cpSync(files[g], join(out, `${g}.jsonl`));
			} catch (err) {
				res.errors.push(err instanceof Error ? err.message : String(err));
			} finally {
				writeFileSync(join(out, "result.json"), `${JSON.stringify(res, null, 2)}\n`);
				results.push(res);
				iso.cleanup();
				const total = (g: Group) => Object.values(res.scores[g]).reduce((a, b) => a + b, 0);
				process.stdout.write(`  得分 A ${total("A")}、B ${total("B")}、C ${total("C")}（满分 12）；B 覆盖关键约束 ${res.bCoversConstraints}；C 走回退 ${res.cFallback}；B 基线 ${res.bBaseline}；错误 ${res.errors.length}\n`);
				for (const e of res.errors) process.stdout.write(`    ${e}\n`);
			}
		}
		await auto128(runStep, candidates[0]);
	});
	const verdict = evaluate(results);
	writeFileSync(join(ARCHIVE_DIR, "summary.json"), `${JSON.stringify({ results, verdict }, null, 2)}\n`);
	process.stdout.write(`\n${verdict.notes.join("\n")}\n结论：${verdict.pass ? "达标" : "不达标"}\n`);
	return verdict.pass ? 0 : 1;
}

/**
 * 方案 12.3 第 10 步：把被测模型的窗口覆盖为 128k（触发点 95232），用一个截断到约 11 万 token 的会话发一条新提问，让 pi 在发送前自动触发阈值压缩。
 * 只记录压缩的统计、提示缓存命中、费用与延迟，以及回答本身，不参与验收。
 */
async function auto128(runStep: Parameters<Parameters<typeof withCoordinator>[1]>[0], cand: { file: string } | undefined): Promise<void> {
	if (!cand) return;
	const root = join(process.env.TMPDIR ?? "/tmp", `sc-replay-128k-${Date.now()}`);
	const iso = createIsolatedEnv({ sourceAgentDir: SOURCE_AGENT_DIR, rootDir: root, provider: MODEL.provider, modelId: MODEL.id, compaction: { enabled: true, reserveTokens: RESERVE, keepRecentTokens: 20000 }, contextWindowOverride: 128_000 });
	const out = join(ARCHIVE_DIR, "auto-128k");
	rmSync(out, { recursive: true, force: true });
	mkdirSync(out, { recursive: true, mode: 0o700 });
	try {
		const t = truncateSession(readFileSync(cand.file, "utf8"), 115_000, iso.projectDir);
		if (!t || t.tokens <= 128_000 - RESERVE) throw new Error(`截断点 ${t?.tokens} 没有超过 128k 的触发点`);
		const dir = join(root, "s");
		mkdirSync(dir, { recursive: true });
		const file = join(dir, "s.jsonl");
		writeFileSync(file, t.text, { mode: 0o600 });
		const started = Date.now();
		const r = await runStep({
			step: "replay:auto-128k",
			worst: { ...worst(14, 110_000, 16_000), billedTokens: 14 * (128_000 + MODEL.maxTokens) },
			args: ["-ne", "-e", join(ROOT, "index.ts"), ...BASE, "-nt", "--session", file, "-p", `只依据当前对话上下文回答，不要调用任何工具：${QUESTIONS[1].q}`],
			env: iso.env,
			cwd: iso.projectDir,
			sessionDirs: [dir],
		});
		const entries = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
		const comp = entries.filter((e) => e.type === "compaction").at(-1) as { tokensBefore?: number; details?: Record<string, unknown> } | undefined;
		const after = entries.filter((e) => e.type === "message" && (e.message as { role?: string }).role === "assistant").at(-1) as { message?: { usage?: Record<string, number> } } | undefined;
		const report = { cutTokens: t.tokens, exitCode: r.exitCode, wallMs: Date.now() - started, actual: r.actual, compaction: comp ? { tokensBefore: comp.tokensBefore, reason: comp.details?.reason, mode: comp.details?.mode, stats: comp.details?.stats, budget: comp.details?.budget } : null, firstUsageAfter: after?.message?.usage ?? null, answer: r.stdout.trim().slice(0, 2000) };
		writeFileSync(join(out, "result.json"), `${JSON.stringify(report, null, 2)}\n`);
		process.stdout.write(`\n[auto-128k] 截断 ${t.tokens}，压缩 ${comp ? `原因 ${String(comp.details?.reason)}，tokensBefore ${comp.tokensBefore}` : "未发生"}，耗时 ${Math.round(report.wallMs / 1000)}s，费用 $${r.actual?.costUsd.toFixed(4) ?? "未核实"}\n`);
	} finally {
		iso.cleanup();
	}
}

/** 方案 12.3 第 7、8 步的验收标准；有错误的样本作废，不参与计分。 */
export function evaluate(results: SampleResult[]): { pass: boolean; notes: string[] } {
	const valid = results.filter((r) => r.errors.length === 0);
	const sum = (g: Group, key?: string) => valid.reduce((a, r) => a + (key ? (r.scores[g][key] ?? 0) : Object.values(r.scores[g]).reduce((x, y) => x + y, 0)), 0);
	const full = valid.length * QUESTIONS.length * 2;
	const A = sum("A");
	const B = sum("B");
	const C = sum("C");
	const perSample = valid.map((r) => Object.values(r.scores.B).reduce((x, y) => x + y, 0) / (QUESTIONS.length * 2));
	const checks: [string, boolean][] = [
		[`有效样本 ${valid.length}/${results.length}（至少 3 个）`, valid.length >= 3],
		[`B 总分 ${B} 不低于 A ${A}`, B >= A],
		[`C 总分 ${C} 不低于 A 的 90%（${(0.9 * A).toFixed(1)}）`, C >= 0.9 * A],
		[`B 平均得分率 ${full ? ((100 * B) / full).toFixed(1) : 0}% 不低于 85%`, full > 0 && B >= 0.85 * full],
		[`B 在「用户约束」${sum("B", "constraints")} 与「最近失败」${sum("B", "failure")} 上都不低于 A（${sum("A", "constraints")}、${sum("A", "failure")}）`, sum("B", "constraints") >= sum("A", "constraints") && sum("B", "failure") >= sum("A", "failure")],
		[`B 逐样本得分率 ${perSample.map((x) => `${(100 * x).toFixed(0)}%`).join("、")} 都不低于 70%`, perSample.every((x) => x >= 0.7)],
		[`B 覆盖全部关键约束：${valid.map((r) => r.bCoversConstraints).join("、")}`, valid.every((r) => r.bCoversConstraints === true)],
		[`B 压缩后基线 ${valid.map((r) => r.bBaseline).join("、")} 都不超过 0.55 × T（${Math.round(0.55 * TRIGGER)}）`, valid.every((r) => r.bBaseline !== null && r.bBaseline <= 0.55 * TRIGGER)],
		[`C 组都走了受控回退：${valid.map((r) => r.cFallback).join("、")}`, valid.every((r) => r.cFallback === true)],
	];
	return { pass: checks.every(([, ok]) => ok), notes: checks.map(([t, ok]) => `${ok ? "✓" : "✗"} ${t}`) };
}

if (process.argv[1] && process.argv[1].endsWith("eval/replay.ts")) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			process.stderr.write(`${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}\n`);
			process.exit(1);
		},
	);
}
