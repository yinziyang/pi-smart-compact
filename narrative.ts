// 叙述摘要的生成编排：侧重点文本、分块滚动摘要、长度与结构校验、一次重试与受控回退（方案 5.2 第 5 ~ 7 步、第 9 节）。
//
// 模型调用以参数注入（generate），本模块不接触 pi 的类型。
// 不变量：
//   - 任何被采纳的模型输出都满足 usage.output 是有限非负整数且不超过当次的 N_out，并且不含匹配脱敏规则的内容。
//   - 单次压缩（含分块、重试与受控回退）累计的 provider 请求不超过 maxRequests，墙钟时间不超过 deadline。
//   - 主路径失败后只做一次受控回退；受控回退也失败时返回失败，由调用方决定取消与 R5。

import type { PackMode } from "./budget.ts";
import { narrativePart, validateModelPack, type Expected } from "./pack.ts";
import { containsSecret } from "./redact.ts";

/** pi 的输出安全余量（方案 F39）。 */
const OUTPUT_SAFETY = 4096;
/** 摘要系统提示词与模板的估算开销，按模板原文的 1.5 倍以上取整。 */
const TEMPLATE_TOKENS = 1500;
/** 输入上限的额外余量。 */
const SLACK = 1000;
/** 每条消息序列化时的包装开销。 */
const ITEM_OVERHEAD = 8;
/** 分块数上限与最小输入上限（方案 5.2 第 5 步）。 */
const MAX_CHUNKS = 8;
const MIN_INPUT = 2000;

const REQUIRED_BODY = ["## Goal", "## Progress", "## Next Steps"];
const REQUIRED_HEAD = ["## Constraints & Preferences", "## Key Decisions", "## Critical Context"];

/** 摘要调用的 usage，只用到这几个字段。 */
export interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	cost?: { total?: unknown };
}

export interface GenerateArgs<T> {
	items: T[];
	/** 传给 generateSummaryWithUsage 的 reserveTokens，pi 据此得到 maxTokens = floor(0.8 × reserveTokens)。 */
	reserveTokens: number;
	focus: string | undefined;
	previousSummary: string | undefined;
	thinkingLevel: "off";
	/** 本次调用最多还能发出的 provider 请求数，含 provider 内部的瞬时错误重试。 */
	maxRequests: number;
	/** 本次调用必须结束的时间点（毫秒时间戳）。 */
	deadline: number;
}

export type GenerateResult = { ok: true; text: string; usage: UsageLike | undefined; requests: number } | { ok: false; error: string; requests: number };

export type Generate<T> = (args: GenerateArgs<T>) => Promise<GenerateResult>;

export interface SummarizeOptions<T> {
	items: T[];
	itemText: (t: T) => string;
	/** 把单条消息截断到 measure 不超过 max。 */
	truncate: (t: T, max: number) => T;
	/** 生成一条说明消息，用于受控回退时注明「更早的历史未纳入」。 */
	note: (text: string) => T;
	/** 输入大小的量度：本地模式为 UTF-8 字节数，模型输出模式为 1.5 × estC。 */
	measure: (s: string) => number;
	/** 摘要模型的原生窗口 W_s。 */
	windowTokens: number;
	N: number;
	Pt: number;
	mode: PackMode;
	/** 模型输出模式下的压缩包数据与期望编号。 */
	packData?: string;
	expected?: Expected[];
	/** 交接文档路径，受控回退在模型输出模式下要求写进 [h1] 行。 */
	handoffPath?: string;
	/** 用户 /compact 的参数。 */
	userFocus?: string;
	previousSummary?: string;
	/** 测试用的故障注入：main 让主路径失败，all 让两级都失败。 */
	fault?: "main" | "all";
	maxRequests: number;
	deadline: number;
	now: () => number;
	generate: Generate<T>;
}

export interface SummaryStats {
	requests: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 没有任何调用返回费用时为 null。 */
	cost: number | null;
	calls: number;
	chunks: number;
}

export type SummarizeResult =
	| { ok: true; text: string; narrative: string; fallback: boolean; stats: SummaryStats; mainError?: string }
	| { ok: false; error: string; stats: SummaryStats };

/** 校验 usage.output：必须是有限非负整数、不超过上限，为 0 时正文必须为空（方案 5.2 第 7 步）。 */
export function checkUsage(usage: UsageLike | undefined, text: string, nOut: number): string | null {
	const out = usage?.output;
	if (typeof out !== "number" || !Number.isFinite(out) || out < 0 || !Number.isInteger(out)) return "usage.output 无法核实";
	if (out === 0 && text.trim()) return "usage.output 为 0 但正文非空";
	if (out > nOut) return `输出 ${out} token，超过上限 ${nOut}`;
	return null;
}

/** 叙述摘要结构校验，返回缺失或过短的章节。 */
export function checkStructure(narrative: string): string[] {
	const lines = narrative.split("\n");
	const sections = new Map<string, string>();
	let current: string | null = null;
	for (const l of lines) {
		const t = l.trim();
		if (/^## (?!#)/.test(t)) {
			current = t;
			sections.set(current, "");
		} else if (current) sections.set(current, `${sections.get(current)}${l}\n`);
	}
	const missing: string[] = [];
	for (const h of REQUIRED_BODY) if ((sections.get(h) ?? "").replace(/\s/g, "").length < 10) missing.push(h);
	for (const h of REQUIRED_HEAD) if (!sections.has(h)) missing.push(h);
	return missing;
}

const BASE_FOCUS = [
	"保留失败过的方案与失败原因。",
	"写清验证状态：用什么命令验证、结果如何、哪些尚未验证。",
	"原样保留路径、函数名、错误原文。",
	"已经存在于文件、计划、commit、diff 里的内容只写路径，不复制正文。",
].join("\n");

function packInstruction(packData: string): string {
	return [
		"在叙述摘要之后，原样输出下面的压缩包结构：保留开始与结束标记、六个小节标题及其顺序、每个条目的编号（如 [v1]、[u1]），每个编号只出现一次且留在原小节。",
		"命令、退出码、工具名、错误锚点、路径、entryId 必须逐字保留；以「│ 」开头的原文行可以压缩，但用户原话条目不得为空。",
		"不要新增编号，不要输出第二个压缩包。",
		packData,
	].join("\n");
}

function userFocusLine(userFocus: string | undefined): string | undefined {
	return userFocus?.trim() ? `最高优先级（用户 /compact 指定）：${userFocus.trim()}` : undefined;
}

function joinFocus(parts: (string | undefined)[]): string | undefined {
	const s = parts.filter((p): p is string => !!p && !!p.trim()).join("\n\n");
	return s || undefined;
}

function emptyStats(): SummaryStats {
	return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: null, calls: 0, chunks: 0 };
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}

function addUsage(stats: SummaryStats, u: UsageLike | undefined): void {
	stats.input += num(u?.input);
	stats.output += num(u?.output);
	stats.cacheRead += num(u?.cacheRead);
	stats.cacheWrite += num(u?.cacheWrite);
	const c = u?.cost?.total;
	// provider 未返回费用（为 0 或缺失）时不累加，全部调用都没有费用时保持 null，即「未知」。
	if (typeof c === "number" && Number.isFinite(c) && c > 0) stats.cost = (stats.cost ?? 0) + c;
}

/** 让 maxTokens = floor(0.8 × reserveTokens) 不超过 nOut 的 reserveTokens。 */
export function reserveFor(nOut: number): number {
	return Math.ceil(nOut / 0.8);
}

interface CallSpec<T> {
	items: T[];
	nOut: number;
	focus: string | undefined;
	previousSummary: string | undefined;
	validate: (text: string) => string[];
	/** 带上本次侧重点（含重试说明）后，完整请求是否仍在输入上限之内（方案 5.2 第 5 步）。 */
	fits: (focus: string | undefined) => boolean;
}

/** 执行一次调用并校验；不合格时带着问题说明重试一次。成功返回文本，失败返回原因。 */
async function callValidated<T>(o: SummarizeOptions<T>, stats: SummaryStats, spec: CallSpec<T>): Promise<{ text: string } | { error: string }> {
	let extra: string | undefined;
	for (let attempt = 0; attempt < 2; attempt++) {
		const left = o.maxRequests - stats.requests;
		if (left <= 0) return { error: `单次压缩的 provider 请求达到上限 ${o.maxRequests}` };
		if (o.now() >= o.deadline) return { error: "单次压缩超过墙钟时间上限" };
		const focus = joinFocus([spec.focus, extra]);
		if (!spec.fits(focus)) return { error: "加上重试说明后输入超过上限" };
		const r = await o.generate({
			items: spec.items,
			reserveTokens: reserveFor(spec.nOut),
			focus,
			previousSummary: spec.previousSummary,
			thinkingLevel: "off",
			maxRequests: left,
			deadline: o.deadline,
		});
		stats.requests += r.requests;
		stats.calls++;
		if (!r.ok) return { error: r.error };
		addUsage(stats, r.usage);
		const problems: string[] = [];
		const usageProblem = checkUsage(r.usage, r.text, spec.nOut);
		if (usageProblem) problems.push(usageProblem);
		if (containsSecret(r.text)) problems.push("输出中含有匹配脱敏规则的内容");
		problems.push(...spec.validate(r.text));
		if (problems.length === 0) return { text: r.text };
		const notes: string[] = [];
		if (usageProblem) notes.push(`上次输出超长，本次正文必须控制在约 ${Math.floor(0.6 * spec.nOut)} token 以内。`);
		const rest = problems.filter((p) => p !== usageProblem);
		if (rest.length) notes.push(`上次输出不合格：${rest.join("；")}。必须使用完整格式。`);
		extra = notes.join("\n");
		if (attempt === 1) return { error: `两次输出都不合格：${problems.join("；")}` };
	}
	return { error: "不可达" };
}

function inputLimit<T>(o: SummarizeOptions<T>, nOut: number, focus: string | undefined, prev: string | undefined): number {
	return o.windowTokens - nOut - OUTPUT_SAFETY - TEMPLATE_TOKENS - o.measure(focus ?? "") - o.measure(prev ?? "") - SLACK;
}

function sizeOf<T>(o: SummarizeOptions<T>, t: T): number {
	return o.measure(o.itemText(t)) + ITEM_OVERHEAD;
}

/** 主路径：按输入上限分块滚动摘要，最后一次调用产出最终叙述（模型输出模式下连同压缩包）。 */
async function mainPath<T>(o: SummarizeOptions<T>, stats: SummaryStats): Promise<{ text: string; narrative: string } | { error: string }> {
	if (o.fault) return { error: "故障注入：主路径失败" };
	const finalNOut = o.mode === "model" ? o.N + o.Pt : o.N;
	const finalFocus = joinFocus([BASE_FOCUS, o.mode === "model" && o.packData ? packInstruction(o.packData) : undefined, userFocusLine(o.userFocus)]);
	const midFocus = joinFocus([BASE_FOCUS, userFocusLine(o.userFocus)]);
	let prev = o.previousSummary;
	let rest = [...o.items];
	for (let chunk = 1; ; chunk++) {
		if (chunk > MAX_CHUNKS) return { error: `分块数超过 ${MAX_CHUNKS}` };
		stats.chunks = chunk;
		const lastLimit = inputLimit(o, finalNOut, finalFocus, prev);
		const total = rest.reduce((a, t) => a + sizeOf(o, t), 0);
		if (total <= lastLimit) {
			if (lastLimit <= MIN_INPUT && rest.length > 0) return { error: `输入上限 ${lastLimit} 过小` };
			const validate = (text: string) => {
				const narrative = o.mode === "model" ? narrativePart(text) : text;
				const missing = checkStructure(narrative).map((h) => `缺少章节或内容过短：${h}`);
				return o.mode === "model" ? [...missing, ...validateModelPack(text, o.expected ?? [])] : missing;
			};
			const fits = (f: string | undefined) => total <= inputLimit(o, finalNOut, f, prev);
			const r = await callValidated(o, stats, { items: rest, nOut: finalNOut, focus: finalFocus, previousSummary: prev, validate, fits });
			if ("error" in r) return r;
			return { text: r.text, narrative: o.mode === "model" ? narrativePart(r.text).trimEnd() : r.text };
		}
		const limit = inputLimit(o, o.N, midFocus, prev);
		if (limit <= MIN_INPUT) return { error: `输入上限 ${limit} 过小` };
		const batch: T[] = [];
		let used = 0;
		while (rest.length > 0) {
			const s = sizeOf(o, rest[0]);
			if (used + s <= limit) {
				batch.push(rest.shift()!);
				used += s;
			} else if (batch.length === 0) {
				// 单条消息超过上限时截断后送入，原文可经 recall_history 取回。
				batch.push(o.truncate(rest.shift()!, limit - ITEM_OVERHEAD));
				break;
			} else break;
		}
		const batchSize = batch.reduce((a, t) => a + sizeOf(o, t), 0);
		const fits = (f: string | undefined) => batchSize <= inputLimit(o, o.N, f, prev);
		const r = await callValidated(o, stats, { items: batch, nOut: o.N, focus: midFocus, previousSummary: prev, validate: (t) => checkStructure(t).map((h) => `缺少章节或内容过短：${h}`), fits });
		if ("error" in r) return r;
		prev = r.text;
	}
}

/** 受控回退：单次调用，默认提示词，只带 /compact 参数作为侧重点；输入放不下时只取最近部分（方案第 9 节）。 */
async function fallbackPath<T>(o: SummarizeOptions<T>, stats: SummaryStats): Promise<{ text: string } | { error: string }> {
	if (o.fault === "all") return { error: "故障注入：受控回退失败" };
	const h1 =
		o.mode === "model"
			? `在输出末尾单独写一行，以「- [h1] 」开头，内容包含${o.handoffPath ? `交接文档路径 ${o.handoffPath} 与` : ""} recall_history 的用法：细节不确定时调用 recall_history 按关键词取回压缩前原文。`
			: undefined;
	const focus = joinFocus([userFocusLine(o.userFocus), h1]);
	const limit = inputLimit(o, o.N, focus, o.previousSummary);
	if (limit <= MIN_INPUT) return { error: `受控回退的输入上限 ${limit} 过小` };
	let items = [...o.items];
	const total = items.reduce((a, t) => a + sizeOf(o, t), 0);
	if (total > limit) {
		const note = o.note("（更早的历史未纳入本次摘要，可用 recall_history 取回。）");
		let used = sizeOf(o, note);
		const kept: T[] = [];
		for (let i = items.length - 1; i >= 0; i--) {
			const s = sizeOf(o, items[i]);
			if (used + s > limit) {
				if (kept.length === 0) kept.unshift(o.truncate(items[i], limit - used - ITEM_OVERHEAD));
				break;
			}
			kept.unshift(items[i]);
			used += s;
		}
		items = [note, ...kept];
	}
	const validate = (text: string) => {
		if (o.mode !== "model") return [];
		const line = text.split("\n").find((l) => l.trimStart().startsWith("- [h1]"));
		if (!line) return ["缺少 [h1] 行"];
		const need = ["recall_history", ...(o.handoffPath ? [o.handoffPath] : [])];
		return need.filter((s) => !line.includes(s)).map((s) => `[h1] 缺少：${s}`);
	};
	const size = items.reduce((a, t) => a + sizeOf(o, t), 0);
	const fits = (f: string | undefined) => size <= inputLimit(o, o.N, f, o.previousSummary);
	return callValidated(o, stats, { items, nOut: o.N, focus, previousSummary: o.previousSummary, validate, fits });
}

/** 生成最终摘要：先走主路径，失败后走一次受控回退。 */
export async function summarize<T>(o: SummarizeOptions<T>): Promise<SummarizeResult> {
	const stats = emptyStats();
	const main = await mainPath(o, stats);
	if ("text" in main) return { ok: true, text: main.text, narrative: main.narrative, fallback: false, stats };
	const fb = await fallbackPath(o, stats);
	if ("text" in fb) return { ok: true, text: fb.text, narrative: fb.text, fallback: true, stats, mainError: main.error };
	return { ok: false, error: `主路径：${main.error}；受控回退：${fb.error}`, stats };
}
