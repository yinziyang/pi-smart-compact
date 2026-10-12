// 费用预演：只计算、不调用任何模型，列出全流程真实调用的最坏用量与费用（方案第 13 节第 0 步）。
//
// 估算口径：
//   - 每个环节按「请求次数 × 每次平均输入 / 输出 token」估算，数值是偏高的上界，不是期望值。
//   - 最坏费用假设没有任何提示缓存命中，全部输入按原价计；另给一个按 70% 输入命中缓存的「典型」费用作参考。
//   - 单次输入超过价目分档阈值（inputTokensAbove）时按高价档计。
//   - 价目未知的模型费用记为 null，需要用户单独授权。
//   - openai-codex 走 OAuth 订阅，实际消耗的是订阅额度，这里的美元数只是按公开价目折算的参考。
// 回放样本从本地会话中挑选：峰值上下文不低于 120k，排除评审会话本身，截断点不超过默认模型的触发点。
//
// 命令行：node eval/preview.ts [--json <输出文件>]

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Amounts, Limits } from "./ledger.ts";

const AGENT_DIR = join(homedir(), ".pi", "agent");

/** 默认被测模型：价目已知、窗口 272k。 */
const TEST_MODEL = { provider: "openai-codex", id: "gpt-6.1-sol", window: 272_000 };
/** 建议的触发余量（方案 4.2）。 */
const RESERVE = 32_768;
const TEST_TRIGGER = TEST_MODEL.window - RESERVE;
/** 压缩后基线上界，按不变量 0.55 × T 估。 */
const POST_BASELINE = Math.round(0.55 * TEST_TRIGGER);
/** 每次请求的墙钟时间上界，单位毫秒。 */
const WALL_PER_REQUEST = 90_000;

interface Price {
	input: number;
	output: number;
	cacheRead: number;
	tierAbove?: number;
	tierInput?: number;
	tierOutput?: number;
	tierCacheRead?: number;
}

/** 一个环节：requests 次请求，每次平均 avgIn 输入与 avgOut 输出。 */
interface Item {
	phase: string;
	name: string;
	model: string;
	requests: number;
	avgIn: number;
	avgOut: number;
	optional?: boolean;
}

interface Row extends Item {
	amounts: Amounts;
	worstCost: number | null;
	typicalCost: number | null;
}

function loadPrices(): Map<string, Price> {
	const prices = new Map<string, Price>();
	const store = JSON.parse(readFileSync(join(AGENT_DIR, "models-store.json"), "utf8")) as Record<string, { models?: Array<{ id: string; cost?: Record<string, unknown> }> }>;
	for (const [provider, entry] of Object.entries(store)) {
		for (const m of entry.models ?? []) {
			const c = m.cost as { input?: number; output?: number; cacheRead?: number; tiers?: Array<{ inputTokensAbove: number; input: number; output: number; cacheRead: number }> } | undefined;
			if (!c || typeof c.input !== "number" || typeof c.output !== "number") continue;
			const tier = c.tiers?.[0];
			prices.set(`${provider}/${m.id}`, {
				input: c.input,
				output: c.output,
				cacheRead: c.cacheRead ?? c.input,
				tierAbove: tier?.inputTokensAbove,
				tierInput: tier?.input,
				tierOutput: tier?.output,
				tierCacheRead: tier?.cacheRead,
			});
		}
	}
	return prices;
}

/** 单次请求的费用，单位美元；cacheShare 为输入中按缓存价计的比例。 */
function requestCost(p: Price, input: number, output: number, cacheShare: number): number {
	const high = p.tierAbove !== undefined && input > p.tierAbove;
	const inPrice = high ? (p.tierInput ?? p.input) : p.input;
	const outPrice = high ? (p.tierOutput ?? p.output) : p.output;
	const cachePrice = high ? (p.tierCacheRead ?? p.cacheRead) : p.cacheRead;
	return (input * (1 - cacheShare) * inPrice + input * cacheShare * cachePrice + output * outPrice) / 1e6;
}

function toRow(item: Item, prices: Map<string, Price>): Row {
	const input = item.requests * item.avgIn;
	const output = item.requests * item.avgOut;
	const p = prices.get(item.model);
	return {
		...item,
		amounts: { requests: item.requests, inputTokens: input, outputTokens: output, billedTokens: input + output, costUsd: 0, wallMs: item.requests * WALL_PER_REQUEST },
		worstCost: p ? item.requests * requestCost(p, item.avgIn, item.avgOut, 0) : null,
		typicalCost: p ? item.requests * requestCost(p, item.avgIn, item.avgOut, 0.7) : null,
	};
}

interface Candidate {
	file: string;
	peak: number;
	model: string;
	size: number;
}

/** 从本地会话挑选回放样本；只读取 usage 字段，不读取对话内容。 */
export function findReplayCandidates(sessionsDir: string, trigger: number, limit = 8): Candidate[] {
	const files: string[] = [];
	const walk = (d: string) => {
		for (const n of readdirSync(d)) {
			const p = join(d, n);
			if (statSync(p).isDirectory()) walk(p);
			else if (n.endsWith(".jsonl")) files.push(p);
		}
	};
	if (existsSync(sessionsDir)) walk(sessionsDir);
	const out: Candidate[] = [];
	for (const f of files) {
		if (f.includes("pictl-sc-review")) continue;
		let peak = 0;
		let model = "";
		let ok = true;
		for (const line of readFileSync(f, "utf8").split("\n")) {
			if (!line.trim()) continue;
			let e: { type?: string; provider?: string; modelId?: string; message?: { role?: string; usage?: Record<string, number> } };
			try {
				e = JSON.parse(line);
			} catch {
				ok = false;
				break;
			}
			if (e.type === "model_change") model = `${e.provider}/${e.modelId}`;
			const u = e.type === "message" && e.message?.role === "assistant" ? e.message.usage : undefined;
			if (u) peak = Math.max(peak, (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0));
		}
		if (ok && peak >= 120_000) out.push({ file: f, peak, model, size: Math.min(peak, trigger - 10_000) });
	}
	return out.sort((a, b) => b.peak - a.peak).slice(0, limit);
}

export function buildItems(candidates: Candidate[]): Item[] {
	const M = `${TEST_MODEL.provider}/${TEST_MODEL.id}`;
	const items: Item[] = [
		{ phase: "P0", name: "S1 原生窗口触发（测试窗口 160k）", model: M, requests: 40, avgIn: 100_000, avgOut: 3_000 },
		{ phase: "P0", name: "S5 摘要调用链", model: M, requests: 3, avgIn: 60_000, avgOut: 8_000 },
		{ phase: "P0", name: "S6 自定切点被接受", model: M, requests: 30, avgIn: 100_000, avgOut: 3_000 },
		{ phase: "P0", name: "S7 RPC compact", model: M, requests: 4, avgIn: 60_000, avgOut: 8_000 },
		{ phase: "P0", name: "S8 虚拟模型路由", model: M, requests: 40, avgIn: 100_000, avgOut: 3_000 },
		{ phase: "P0", name: "S9~S11 事件时序与中止", model: M, requests: 40, avgIn: 50_000, avgOut: 2_000 },
		{ phase: "P0", name: "S12 恢复省略与重启（测试窗口 40k）", model: M, requests: 40, avgIn: 40_000, avgOut: 2_000 },
		{ phase: "P0", name: "S13 子会话加载 -e 扩展", model: M, requests: 15, avgIn: 30_000, avgOut: 2_000 },
		{ phase: "集成", name: "T-trigger", model: M, requests: 40, avgIn: 100_000, avgOut: 3_000 },
		{ phase: "集成", name: "T-manual", model: M, requests: 15, avgIn: 60_000, avgOut: 8_000 },
		{ phase: "集成", name: "T-small（测试窗口 64k）", model: M, requests: 30, avgIn: 50_000, avgOut: 2_000 },
		{ phase: "集成", name: "T-goal（含评估者）", model: M, requests: 100, avgIn: 100_000, avgOut: 3_000 },
		{ phase: "集成", name: "T-goal-constraint", model: M, requests: 50, avgIn: 100_000, avgOut: 3_000 },
		{ phase: "集成", name: "T-sub", model: M, requests: 80, avgIn: 100_000, avgOut: 3_000 },
		{ phase: "集成", name: "T-fallback", model: M, requests: 30, avgIn: 100_000, avgOut: 3_000 },
		{ phase: "集成", name: "T-recall", model: M, requests: 30, avgIn: 100_000, avgOut: 3_000 },
		{ phase: "集成", name: "T-edit", model: M, requests: 20, avgIn: 60_000, avgOut: 3_000 },
		{ phase: "集成", name: "T-edit2", model: M, requests: 50, avgIn: 100_000, avgOut: 3_000 },
		{ phase: "集成", name: "T-failclosed", model: M, requests: 20, avgIn: 60_000, avgOut: 3_000 },
		{ phase: "集成", name: "T-native", model: M, requests: 2, avgIn: 5_000, avgOut: 500 },
	];
	const replay = (phase: string, tag: string) => {
		for (const [i, c] of candidates.entries()) {
			const name = `${tag} 样本 ${i + 1}（${Math.round(c.size / 1000)}k）`;
			items.push(
				{ phase, name: `${name} 压缩 A/B/C`, model: M, requests: 2 + 3 + 2, avgIn: c.size, avgOut: 16_000 },
				{ phase, name: `${name} 答题 O`, model: M, requests: 6, avgIn: c.size, avgOut: 2_000 },
				{ phase, name: `${name} 答题 A/B/C`, model: M, requests: 18, avgIn: POST_BASELINE, avgOut: 2_000 },
				{ phase, name: `${name} 评判`, model: M, requests: 6, avgIn: 20_000, avgOut: 2_000 },
			);
		}
	};
	replay("回放", "回放");
	items.push(
		{ phase: "回放", name: "128k 样本（gpt-5.3-codex-spark 自动触发）", model: "openai-codex/gpt-5.3-codex-spark", requests: 50, avgIn: 70_000, avgOut: 3_000 },
		{ phase: "1M（可跳过）", name: "1M 合成样本 压缩 B", model: M, requests: 3, avgIn: 950_000, avgOut: 16_000, optional: true },
		{ phase: "1M（可跳过）", name: "1M 合成样本 答题 O", model: M, requests: 6, avgIn: 950_000, avgOut: 2_000, optional: true },
		{ phase: "1M（可跳过）", name: "1M 合成样本 答题 B 与评判", model: M, requests: 12, avgIn: 80_000, avgOut: 2_000, optional: true },
	);
	replay("调参重跑（预留，需再次确认）", "重跑");
	return items;
}

function fmtUsd(v: number | null): string {
	return v === null ? "未知" : `$${v.toFixed(2)}`;
}

function sum(rows: Row[]): { amounts: Amounts; worst: number | null; typical: number | null } {
	const amounts: Amounts = { requests: 0, inputTokens: 0, outputTokens: 0, billedTokens: 0, costUsd: 0, wallMs: 0 };
	let worst: number | null = 0;
	let typical: number | null = 0;
	for (const r of rows) {
		for (const k of Object.keys(amounts) as (keyof Amounts)[]) amounts[k] += r.amounts[k];
		worst = worst === null || r.worstCost === null ? null : worst + r.worstCost;
		typical = typical === null || r.typicalCost === null ? null : typical + r.typicalCost;
	}
	return { amounts, worst, typical };
}

function main(argv: string[]): number {
	const prices = loadPrices();
	const candidates = findReplayCandidates(join(AGENT_DIR, "sessions"), TEST_TRIGGER);
	const rows = buildItems(candidates).map((i) => toRow(i, prices));
	const phases = [...new Set(rows.map((r) => r.phase))];
	const lines: string[] = [];
	lines.push(`被测模型：${TEST_MODEL.provider}/${TEST_MODEL.id}，触发点 ${TEST_TRIGGER}，压缩后基线上界 ${POST_BASELINE}。`);
	lines.push(`回放样本 ${candidates.length} 个：${candidates.map((c) => `${Math.round(c.peak / 1000)}k→截断 ${Math.round(c.size / 1000)}k（原模型 ${c.model}）`).join("；")}`);
	lines.push("");
	lines.push("| 阶段 | 请求 | 输入 token | 输出 token | 墙钟上界 | 最坏费用 | 典型费用 |");
	lines.push("|---|---|---|---|---|---|---|");
	for (const ph of phases) {
		const s = sum(rows.filter((r) => r.phase === ph));
		lines.push(`| ${ph} | ${s.amounts.requests} | ${(s.amounts.inputTokens / 1e6).toFixed(1)}M | ${(s.amounts.outputTokens / 1e6).toFixed(2)}M | ${(s.amounts.wallMs / 3.6e6).toFixed(1)}h | ${fmtUsd(s.worst)} | ${fmtUsd(s.typical)} |`);
	}
	const required = rows.filter((r) => !r.optional && !r.phase.startsWith("调参"));
	const total = sum(required);
	const withOptional = sum(rows.filter((r) => !r.phase.startsWith("调参")));
	lines.push("");
	lines.push(`必做合计（不含 1M 与重跑）：请求 ${total.amounts.requests}，输入 ${(total.amounts.inputTokens / 1e6).toFixed(1)}M，最坏 ${fmtUsd(total.worst)}，典型 ${fmtUsd(total.typical)}。`);
	lines.push(`含 1M 样本：最坏 ${fmtUsd(withOptional.worst)}，典型 ${fmtUsd(withOptional.typical)}。`);
	process.stdout.write(`${lines.join("\n")}\n`);

	const jsonIdx = argv.indexOf("--json");
	if (jsonIdx >= 0 && argv[jsonIdx + 1]) {
		const proposed: Limits = { ...total.amounts, costUsd: total.worst === null ? null : Math.ceil(total.worst) };
		writeFileSync(resolve(argv[jsonIdx + 1]), `${JSON.stringify({ items: rows, proposedLimits: proposed }, null, 2)}\n`);
	}
	return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	process.exit(main(process.argv.slice(2)));
}
