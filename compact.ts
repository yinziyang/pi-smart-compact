// session_before_compact 的主流程（方案第 3 节时序、5.2、第 8 ~ 9 节）：选摘要模型、算预算、选切点、生成摘要与压缩包、组装结果。
// 这里是本扩展与 pi 类型之间的适配层：把 pi 的条目与消息转换成纯函数模块的输入，再把结果转换回 pi 的 CompactionResult。
// 本模块不追加任何会话条目（方案 7.4：session_before_compact 内不调用 appendEntry），状态变更以返回值交给 index.ts。

import { convertToLlm, generateSummaryWithUsage, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import { computeBudget, estC, utf8Bytes, type Budget, type ModelState, type PackMode } from "./budget.ts";
import { chooseCut, type CutEntry } from "./cut.ts";
import { applyEdits, type RawBlock, type RawEntry } from "./edits.ts";
import { summarize, type Generate, type SummaryStats } from "./narrative.ts";
import { handoffDoc } from "./handoff.ts";
import { extractPack, renderFull, renderLocal, renderModelData, truncateBytes, type RecoveryRecord } from "./pack.ts";
import { redact, redactDeep } from "./redact.ts";
import type { Config } from "./state.ts";

/** 摘要调用的瞬时错误重试策略（方案 F44）。 */
const RETRY = { enabled: true, maxRetries: 2, baseDelayMs: 2000 };
/** 单次压缩的资源上限（方案 5.2 第 5 步）。 */
export const MAX_REQUESTS = 12;
export const MAX_WALL_MS = 15 * 60_000;

type AnyModel = NonNullable<ExtensionContext["model"]>;

/** 本扩展写入 compaction details 的内容。 */
export interface OwnDetails {
	smartCompact: 1;
	version: 1;
	reason: SessionBeforeCompactEvent["reason"];
	nonce: string;
	mode: PackMode;
	fallback: boolean;
	rebuild: boolean;
	narrative: string;
	pack: string;
	files: { modified: string[]; read: string[] };
	budget: Budget & { T: number; level: number };
	stats: SummaryStats & { wallMs: number; costLabel: string };
	omittedAttempt?: { version: 1; nonce: string; createdAt: string; records: RecoveryRecord[] };
	handoffPath?: string;
	bEst: number;
	/** 叙述、压缩包与保留区按 c = 1 的估算之和。 */
	estRawWithoutF: number;
	modelKey: string;
}

export function modelKey(m: { provider: string; id: string }): string {
	return `${m.provider}/${m.id}`;
}

export function isVirtual(m: { api: string } | undefined): boolean {
	return m?.api === "pi-virtual";
}

export interface ModelChoice {
	/** 摘要模型 M_s。 */
	summaryModel: AnyModel;
	/** 摘要模型的窗口 W_s。 */
	summaryWindow: number;
	/** 预算用的窗口 W。 */
	window: number;
	/** 状态键：物理模型的 provider/id，找不到物理模型时为虚拟模型的键。 */
	key: string;
	mode: PackMode;
	/** W 来自用户声明或虚拟模型定义时为真，此时实际路由窗口更小要进入 R5（方案 7.2）。 */
	declaredWindow: boolean;
}

/** 虚拟模型的预算窗口 W（方案 7.2）。候选集合为空时返回 undefined。 */
export function virtualWindow(ctx: ExtensionContext, model: AnyModel, config: Config): { window: number; declared: boolean } | undefined {
	const declared = config.virtualWindowTokens[modelKey(model)];
	if (declared) return { window: declared, declared: true };
	if (model.contextWindow > 0) return { window: model.contextWindow, declared: true };
	const windows = ctx.modelRegistry
		.getAll()
		.filter((m) => !isVirtual(m) && m.contextWindow > 0 && ctx.modelRegistry.hasConfiguredAuth(m))
		.map((m) => m.contextWindow);
	return windows.length ? { window: Math.min(...windows), declared: false } : undefined;
}

/** 按方案 5.2 第 0 步确定摘要模型，并按 5.1 选择压缩包模式。找不到可用模型时返回 undefined。 */
export function chooseModel(ctx: ExtensionContext, branch: readonly RawEntry[], config: Config): ModelChoice | undefined {
	const current = ctx.model;
	if (!current) return undefined;
	const local = (m: AnyModel) => !isVirtual(m) && (config.byteBpeProviders.includes(m.provider) || config.byteBpeModels.includes(modelKey(m)));
	if (!isVirtual(current)) {
		return { summaryModel: current, summaryWindow: current.contextWindow, window: current.contextWindow, key: modelKey(current), mode: local(current) ? "local" : "model", declaredWindow: false };
	}
	const vw = virtualWindow(ctx, current, config);
	if (!vw) return undefined;
	let start = 0;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "model_change") {
			start = i + 1;
			break;
		}
	}
	for (let i = branch.length - 1; i >= start; i--) {
		const m = branch[i].message;
		if (m?.role !== "assistant" || m.stopReason === "error" || m.stopReason === "aborted" || !m.provider || !m.model) continue;
		const phys = ctx.modelRegistry.find(m.provider, m.model);
		if (phys && !isVirtual(phys) && ctx.modelRegistry.hasConfiguredAuth(phys)) {
			return { summaryModel: phys, summaryWindow: phys.contextWindow, window: vw.window, key: modelKey(phys), mode: local(phys) ? "local" : "model", declaredWindow: vw.declared };
		}
		break;
	}
	// 没有可用的物理响应时直接用虚拟模型做摘要，由 pi 路由；窗口取虚拟模型的下界，分词器未知。
	return { summaryModel: current, summaryWindow: vw.window, window: vw.window, key: modelKey(current), mode: "model", declaredWindow: vw.declared };
}

/** 一条待摘要消息及其来源条目 id。 */
interface Item {
	msg: AgentMessage;
	entryId: string;
}

function serialize(msgs: AgentMessage[]): string {
	return serializeConversation(convertToLlm(msgs));
}

/**
 * 保留区内容的完整文本，用于估算原样发给模型的部分。
 * 先经 convertToLlm 对齐模型实际可见的内容（例如过滤 excludeFromContext 的 bash 输出、加上 bash 状态与摘要包装文本），再取全部文本块、thinking、工具调用参数与工具结果全文。
 * 不用 serializeConversation：它会把工具结果截到 2000 字符（方案 F9），会严重低估读文件等大块结果。
 */
export function fullText(msgs: readonly AgentMessage[]): string {
	const parts: string[] = [];
	for (const m of convertToLlm([...msgs])) {
		const content = (m as { content?: unknown }).content;
		if (typeof content === "string") {
			parts.push(content);
			continue;
		}
		if (!Array.isArray(content)) continue;
		for (const b of content as RawBlock[]) {
			if (b.type === "text") parts.push(b.text ?? "");
			else if (b.type === "thinking") parts.push(b.thinking ?? "");
			else if (b.type === "toolCall") parts.push(`${b.name ?? ""} ${JSON.stringify(b.arguments ?? {})}`);
		}
	}
	return parts.join("\n");
}

/** 初始固定开销：system prompt 加活动工具 schema 的估算（方案 7.3）。 */
export function initialFEst(systemPrompt: string, tools: readonly { name: string; description?: string; promptGuidelines?: string[]; parameters?: unknown }[]): number {
	return estC(systemPrompt) + tools.reduce((a, t) => a + estC(JSON.stringify({ n: t.name, d: t.description, g: t.promptGuidelines, p: t.parameters })), 0);
}

/** 一次压缩请求：来自 session_before_compact，或来自历史被修改后的重建（方案 5.2 第 4 步）。 */
export interface CompactRequest {
	reason: SessionBeforeCompactEvent["reason"];
	willRetry: boolean;
	/** pi 合并 modelOverrides 后对该模型生效的值。 */
	settings: { reserveTokens: number; keepRecentTokens: number };
	tokensBefore: number;
	branchEntries: readonly RawEntry[];
	/** 自定切点前没有消息时改用的切点。 */
	fallbackFirstKept: string;
	customInstructions?: string;
	signal: AbortSignal;
}

export function requestFromEvent(e: SessionBeforeCompactEvent): CompactRequest {
	return {
		reason: e.reason,
		willRetry: e.willRetry,
		settings: e.preparation.settings,
		tokensBefore: e.preparation.tokensBefore,
		branchEntries: e.branchEntries as unknown as RawEntry[],
		fallbackFirstKept: e.preparation.firstKeptEntryId,
		customInstructions: e.customInstructions,
		signal: e.signal,
	};
}

export interface CompactInput {
	event: CompactRequest;
	ctx: ExtensionContext;
	config: Config;
	choice: ModelChoice;
	modelState: ModelState;
	fEst: number;
	/** 本次恢复省略记录，已分批，nonce 写进 details。 */
	omitted: { nonce: string; records: RecoveryRecord[] } | null;
	/** 历史被修改后的重建：从应用了编辑的原始分支读取全部历史，不用旧摘要（方案 5.2 第 4 步）。 */
	rebuild: boolean;
	handoffPath: string | undefined;
	nonce: string;
	fault: "main" | "all" | undefined;
	now: () => number;
}

export type CompactOutcome =
	| { kind: "ok"; result: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage: Usage; details: OwnDetails }; handoff: string }
	| { kind: "failed"; error: string; handoff: string | undefined; stats?: SummaryStats }
	| { kind: "invariant"; budget: Budget; T: number };

/** 上一次压缩的叙述：出自本扩展时取 details.narrative，否则取 summary 原文。 */
function previousSummary(branch: readonly RawEntry[]): string | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type !== "compaction") continue;
		const d = e.details as Partial<OwnDetails> | undefined;
		if (d?.smartCompact === 1 && typeof d.narrative === "string") return d.narrative;
		return e.summary;
	}
	return undefined;
}

function sumUsage(stats: SummaryStats): Usage {
	const total = stats.input + stats.output + stats.cacheRead + stats.cacheWrite;
	return { input: stats.input, output: stats.output, cacheRead: stats.cacheRead, cacheWrite: stats.cacheWrite, totalTokens: total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: stats.cost ?? 0 } };
}

/** 执行一次压缩的主流程。不抛异常：内部错误转成 failed。 */
export async function runCompaction(input: CompactInput): Promise<CompactOutcome> {
	const { event, ctx, config, choice, modelState, fEst, omitted, rebuild, handoffPath, nonce, fault, now } = input;
	const started = now();
	const settings = event.settings;
	const T = choice.window - settings.reserveTokens;
	const overflowRetry = event.reason === "overflow" && event.willRetry;
	const budget = computeBudget({ T, keepRecentTokens: settings.keepRecentTokens, level: modelState.budgetLevel, mode: choice.mode, fEst, overflowRetry });
	if (!budget.ok && event.reason === "threshold") return { kind: "invariant", budget, T };

	const branch = event.branchEntries;
	const applied = applyEdits(branch);
	const c = modelState.c;

	// 投影条目：已应用 compaction 与 context_edit，去掉 compaction 条目与 system 消息。
	const projected = ctx.sessionManager
		.buildSessionProjection()
		.entries.filter((pe) => pe.sourceEntry.type !== "compaction")
		.map((pe) => ({ id: pe.sourceEntry.id, messages: pe.messages.filter((m) => m.role !== "system") }))
		.filter((pe) => pe.messages.length > 0);
	// 保留区会原样发给模型，必须按完整内容估算；serializeConversation 会把工具结果截到 2000 字符（方案 F9），用它估算会严重低估读文件等大块结果。
	const cutEntries: CutEntry[] = projected.map((pe) => ({ id: pe.id, roles: pe.messages.map((m) => m.role), est: estC(fullText(pe.messages), c) }));
	const cut = chooseCut(cutEntries, budget.K, event.fallbackFirstKept);
	const keptIds = new Set(cut ? projected.slice(cut.index).map((pe) => pe.id) : []);

	const data = extractPack({ entries: applied, keptIds, omitted: omitted?.records ?? [], handoffPath });
	const statsExtra = { reason: event.reason, tokensBefore: event.tokensBefore, T, budget };
	const earlyHandoff = handoffDoc("smart-compact 交接文档（压缩进行中）", undefined, data, statsExtra);
	if (!cut) return { kind: "failed", error: "找不到可用的切点", handoff: earlyHandoff };

	let items: Item[];
	if (rebuild) {
		// 重建：从应用了编辑的原始分支取切点之前的 message 与 custom_message，排除 compaction、branch_summary 与本扩展的条目。
		const stop = applied.findIndex((e) => e.id === cut.firstKeptEntryId);
		items = applied
			.slice(0, stop < 0 ? applied.length : stop)
			.filter((e) => (e.type === "message" && e.message && e.message.role !== "compactionSummary" && e.message.role !== "branchSummary") || e.type === "custom_message")
			.map((e) => ({
				entryId: e.id,
				msg: (e.type === "message" ? e.message : { role: "custom", customType: e.customType ?? "", content: e.content ?? "", display: true, timestamp: Date.parse(e.timestamp ?? "") || 0 }) as unknown as AgentMessage,
			}));
	} else {
		items = projected.slice(0, cut.index).flatMap((pe) => pe.messages.map((msg) => ({ msg, entryId: pe.id })));
	}
	items = items.map((it) => ({ entryId: it.entryId, msg: redactDeep(it.msg) }));
	const prev = rebuild ? undefined : previousSummary(branch);
	const prevRedacted = prev === undefined ? undefined : redact(prev);

	const measure = choice.mode === "local" ? utf8Bytes : (s: string) => Math.ceil(estC(s) * 1.5);
	const modelData = choice.mode === "model" ? renderModelData(data, budget.Pt) : undefined;
	const model = choice.summaryModel;
	const sessionId = ctx.sessionManager.getSessionId();
	const generate: Generate<Item> = async (a) => {
		let requests = 1;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), Math.max(0, a.deadline - now()));
		try {
			const r = await generateSummaryWithUsage(
				a.items.map((i) => i.msg),
				model,
				a.reserveTokens,
				undefined,
				undefined,
				AbortSignal.any([event.signal, ctrl.signal]),
				a.focus,
				a.previousSummary,
				a.thinkingLevel,
				(m, cx, o) => ctx.modelRegistry.streamSimple(m, cx, o),
				undefined,
				RETRY,
				{
					onRetryAttemptStart: () => {
						requests++;
						// 内部重试会超出本次压缩的请求上限时中止。
						if (requests > a.maxRequests) ctrl.abort();
					},
				},
				sessionId,
			);
			return { ok: true, text: r.text, usage: r.usage, requests };
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err), requests };
		} finally {
			clearTimeout(timer);
		}
	};
	const userFocus = event.reason === "manual" ? event.customInstructions : undefined;
	const res = await summarize<Item>({
		items,
		itemText: (i) => serialize([i.msg]),
		truncate: (i, max) => ({ entryId: i.entryId, msg: { role: "user", content: [{ type: "text", text: `${truncateBytes(serialize([i.msg]), max - 120)}\n…[已截断，recall_history entryId=${i.entryId} 可取全文]` }], timestamp: 0 } as AgentMessage }),
		note: (text) => ({ entryId: "", msg: { role: "user", content: [{ type: "text", text }], timestamp: 0 } as AgentMessage }),
		measure,
		windowTokens: choice.summaryWindow,
		N: budget.N,
		Pt: budget.Pt,
		mode: choice.mode,
		packData: modelData?.text,
		expected: modelData?.expected,
		handoffPath,
		userFocus: userFocus ? redact(userFocus) : undefined,
		previousSummary: prevRedacted,
		fault,
		maxRequests: MAX_REQUESTS,
		deadline: started + MAX_WALL_MS,
		now,
		generate,
	});
	if (!res.ok) return { kind: "failed", error: res.error, handoff: earlyHandoff, stats: res.stats };

	// 组装最终摘要并用最终文本重新核对上限（方案 11.4 最后一条）。
	let summary: string;
	let packText = "";
	if (choice.mode === "local") {
		packText = renderLocal(data, budget.Pt, budget.Pb);
		if (utf8Bytes(packText) > budget.Pb) return { kind: "failed", error: "压缩包超过字节上限", handoff: earlyHandoff, stats: res.stats };
		summary = `${res.narrative.trimEnd()}\n\n${packText}`;
	} else {
		summary = res.text;
	}
	const narrativeEst = estC(res.narrative, c);
	const packEst = estC(packText || summary.slice(res.narrative.length), c);
	const estWithoutF = narrativeEst + packEst + cut.keptEst;
	const wallMs = now() - started;
	const details: OwnDetails = {
		smartCompact: 1,
		version: 1,
		reason: event.reason,
		nonce,
		mode: choice.mode,
		fallback: res.fallback,
		rebuild,
		narrative: res.narrative,
		pack: renderFull(data),
		files: { modified: data.modified, read: data.read },
		budget: { ...budget, T, level: modelState.budgetLevel },
		stats: { ...res.stats, wallMs, costLabel: res.stats.cost === null ? "未知" : `$${res.stats.cost.toFixed(4)}` },
		omittedAttempt: omitted ? { version: 1, nonce: omitted.nonce, createdAt: new Date(now()).toISOString(), records: omitted.records } : undefined,
		handoffPath,
		bEst: fEst + estWithoutF,
		estRawWithoutF: estWithoutF / c,
		modelKey: choice.key,
	};
	const handoff = handoffDoc("smart-compact 交接文档", res.narrative, data, { ...statsExtra, stats: details.stats, fallback: res.fallback, mainError: res.ok ? res.mainError : undefined, bEst: details.bEst });
	return { kind: "ok", result: { summary, firstKeptEntryId: cut.firstKeptEntryId, tokensBefore: event.tokensBefore, usage: sumUsage(res.stats), details }, handoff };
}
