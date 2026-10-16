// 宿主边界只验证本扩展实际消费的结构和当前数据，不把方法存在等同于未来时序或持久化语义兼容。
// 已知宿主的取消、边界提交及恢复窗口语义仍须由真实 SDK 回归验证。

import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { RawEntry } from "./edits.ts";
import { redact } from "./redact.ts";

type ObjectValue = Record<string, unknown>;

function object(value: unknown): ObjectValue {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("对象缺失或类型错误");
	return value as ObjectValue;
}

function requireMethods(value: unknown, name: string, methods: string[]): void {
	const target = object(value);
	for (const method of methods) if (typeof target[method] !== "function") throw new Error(`${name}.${method} 缺失`);
}

function nonnegative(value: unknown): boolean {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function signalAborted(value: unknown): boolean {
	const signal = object(value);
	requireMethods(signal, "signal", ["addEventListener", "removeEventListener", "throwIfAborted"]);
	if (typeof signal.aborted !== "boolean") throw new Error("signal.aborted 不符合契约");
	return signal.aborted;
}

function content(value: unknown): boolean {
	if (typeof value === "string") return true;
	return Array.isArray(value) && value.every((block) => {
		const b = object(block);
		if (b.type === "text") return typeof b.text === "string";
		if (b.type === "thinking") return typeof b.thinking === "string";
		if (b.type === "image") return typeof b.data === "string" && typeof b.mimeType === "string";
		if (b.type === "toolCall") return typeof b.id === "string" && typeof b.name === "string" && !!b.arguments && typeof b.arguments === "object";
		return false;
	});
}

function message(value: unknown): void {
	const m = object(value);
	if (["system", "user", "assistant", "toolResult", "custom"].includes(String(m.role))) {
		if (!content(m.content)) throw new Error("消息 content 不符合契约");
	} else if (m.role === "bashExecution") {
		if (typeof m.command !== "string" || typeof m.output !== "string") throw new Error("bash 消息不符合契约");
	} else if (m.role === "compactionSummary" || m.role === "branchSummary") {
		if (typeof m.summary !== "string") throw new Error("摘要消息不符合契约");
	} else throw new Error("消息 role 不符合契约");
}

/** 校验原始分支，包括恢复与召回依赖的编辑结构，不接受重复来源 ID。 */
export function requireBranch(value: unknown): asserts value is RawEntry[] {
	if (!Array.isArray(value)) throw new Error("branchEntries 不是数组");
	const ids = new Set<string>();
	for (const entry of value) {
		const e = object(entry);
		if (typeof e.id !== "string" || !e.id || ids.has(e.id) || typeof e.type !== "string") throw new Error("分支条目 ID 或 type 不符合契约");
		ids.add(e.id);
		if (e.type === "message") message(e.message);
		if (e.type === "custom_message" && !content(e.content)) throw new Error("custom_message content 不符合契约");
		if (e.type === "compaction" && (typeof e.summary !== "string" || typeof e.firstKeptEntryId !== "string")) throw new Error("compaction 条目不符合契约");
		if (e.type === "context_edit") {
			if (typeof e.targetId !== "string" || !e.targetId || !(e.replacement === null || content(object(e.replacement).content))) throw new Error("context_edit 不符合契约");
		}
	}
}

/** 在使用或恢复会话状态前检查全部必需的会话能力，避免仅保护压缩入口。 */
export function requireSession(ctx: ExtensionContext): void {
	const sm = ctx.sessionManager;
	requireMethods(sm, "sessionManager", ["getSessionId", "getBranch", "getLeafId", "getSessionFile", "getSessionDir", "buildSessionProjection"]);
	const id = sm.getSessionId();
	if (typeof id !== "string" || !id) throw new Error("getSessionId 返回值不符合契约");
	const leaf = sm.getLeafId();
	if (leaf !== null && typeof leaf !== "string") throw new Error("getLeafId 返回值不符合契约");
	const file = sm.getSessionFile();
	if (file !== undefined && typeof file !== "string") throw new Error("getSessionFile 返回值不符合契约");
	if (typeof sm.getSessionDir() !== "string") throw new Error("getSessionDir 返回值不符合契约");
	requireBranch(sm.getBranch());
}

/** 校验摘要所需能力，真实流结果与路由行为由摘要调用和 SDK 回归共同验证。 */
export function requireSummaryHost(ctx: ExtensionContext): void {
	requireMethods(ctx.modelRegistry, "modelRegistry", ["streamSimple", "getAll", "find", "hasConfiguredAuth"]);
	requireMethods(ctx, "context", ["getSystemPrompt", "getContextUsage", "abort"]);
}

/** 校验预算的有限数值和当前支持的压缩原因，供事件入口及直接压缩调用复用。 */
export function requireRequest(value: unknown): void {
	const e = object(value);
	const settings = object(e.settings);
	if (!nonnegative(settings.reserveTokens) || !nonnegative(settings.keepRecentTokens) || !nonnegative(e.tokensBefore)) throw new Error("压缩预算必须为有效有限数值");
	if (!["manual", "threshold", "overflow"].includes(String(e.reason)) || typeof e.willRetry !== "boolean") throw new Error("reason 或 willRetry 不符合契约");
	signalAborted(e.signal);
	if (e.customInstructions !== undefined && typeof e.customInstructions !== "string") throw new Error("customInstructions 不符合契约");
	requireBranch(e.branchEntries);
	if (typeof e.fallbackFirstKept !== "string" || (e.fallbackFirstKept !== "" && !e.branchEntries.some((entry) => entry.id === e.fallbackFirstKept))) throw new Error("firstKeptEntryId 不属于分支");
}

/** 在读取 preparation 前验证事件，缺字段不能使 runner 接管异常后继续原生摘要。 */
export function requireCompactEvent(event: SessionBeforeCompactEvent): void {
	const e = object(event);
	const preparation = object(e.preparation);
	requireRequest({ ...e, settings: preparation.settings, tokensBefore: preparation.tokensBefore, fallbackFirstKept: preparation.firstKeptEntryId });
	if (!preparation.firstKeptEntryId) throw new Error("preparation.firstKeptEntryId 缺失");
}

/** 验证当前投影的来源和编辑结果，防止已删除或替换的内容通过宿主投影重新进入摘要。 */
export function checkedProjection(ctx: ExtensionContext, branch: readonly RawEntry[]): { id: string; messages: AgentMessage[] }[] {
	const projection = object(ctx.sessionManager.buildSessionProjection());
	if (!Array.isArray(projection.entries)) throw new Error("投影 entries 缺失");
	const sources = new Map(branch.map((entry) => [entry.id, entry]));
	const edits = new Map(branch.filter((e) => e.type === "context_edit").map((e) => [e.targetId, e.replacement]));
	const seen = new Set<string>();
	return projection.entries.map((value) => {
		const pe = object(value);
		const source = object(pe.sourceEntry);
		const raw = typeof source.id === "string" ? sources.get(source.id) : undefined;
		if (!raw || source.type !== raw.type || seen.has(raw.id)) throw new Error("投影来源 ID 不属于当前分支或重复");
		seen.add(raw.id);
		if (!Array.isArray(pe.messages)) throw new Error("投影 messages 不是数组");
		for (const m of pe.messages) message(m);
		const edit = edits.get(raw.id);
		if (edits.has(raw.id) && edit === null && pe.messages.length) throw new Error("投影泄露已删除消息");
		if (!["message", "custom_message", "compaction", "branch_summary"].includes(raw.type) && pe.messages.length) throw new Error("非消息来源产生了投影消息");
		if (raw.type === "branch_summary" && pe.messages.some((m) => m.role !== "branchSummary" || m.summary !== raw.summary)) throw new Error("分支摘要投影不匹配来源");
		if (raw.type === "message" || raw.type === "custom_message") {
			const expected = raw.type === "message" ? raw.message! : { role: "custom", content: raw.content };
			const editable = ["user", "assistant", "toolResult", "custom"].includes(expected.role);
			let expectedContent = editable && edit ? edit.content : expected.content;
			if (edit && (expected.role === "assistant" || expected.role === "toolResult") && typeof expectedContent === "string") expectedContent = [{ type: "text", text: expectedContent }];
			for (const value of pe.messages) {
				const m = object(value);
				if (m.role !== expected.role || !isDeepStrictEqual(m.content, expectedContent)) throw new Error("投影消息不匹配来源或替换内容");
				if (raw.type === "message" && !isDeepStrictEqual(value, { ...expected, ...(editable ? { content: expectedContent } : {}) })) throw new Error("投影消息字段不匹配来源");
				if (raw.type === "custom_message" && m.customType !== raw.customType) throw new Error("投影 customType 不匹配来源");
			}
		}
		return { id: raw.id, messages: (raw.type === "compaction" ? [] : pe.messages.filter((m) => m.role !== "system")) as AgentMessage[] };
	}).filter((pe) => pe.messages.length > 0);
}

/** 集中拦住宿主契约失败，不向 runner 泄漏异常，不在压缩前事件追加会话状态。 */
export function hostBoundary(pi: ExtensionAPI, enabled: () => boolean, diagnose: (ctx: ExtensionContext, text: string, automatic: boolean) => void) {
	const reject = (ctx: ExtensionContext, error: unknown, automatic: boolean) => {
		const reason = error instanceof Error ? error.message : String(error);
		try { ctx.abort(); } catch { /* 宿主中止能力也可能缺失，不能再向 runner 抛出异常。 */ }
		try {
			diagnose(ctx, `smart-compact：宿主契约不兼容：${redact(reason)}。已停止当前操作，请检查宿主能力与数据。`, automatic);
		} catch {
			// 诊断通道也失效时仍返回取消结果，不能让 runner 因日志异常而继续默认摘要。
		}
	};
	const run = async <T, F>(ctx: ExtensionContext, task: () => T | Promise<T>, fallback: F, automatic = false): Promise<T | F> => {
		try {
			requireSession(ctx);
			return await task();
		} catch (error) {
			reject(ctx, error, automatic);
			return fallback;
		}
	};
	// SDK 的重载只在此处桥接，业务 handler 仍由原始 on 签名检查事件和返回值。
	const on = ((name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => {
		const subscribe = pi.on as (name: string, handler: (event: any, ctx: ExtensionContext) => unknown) => () => void;
		return subscribe.call(pi, name, async (event, ctx) => {
			const automatic = name === "session_before_compact" && (event?.reason === "threshold" || event?.reason === "overflow");
			if (name === "session_before_compact") {
				if (!enabled()) return undefined;
				try {
					if (signalAborted(object(event).signal)) return undefined;
				} catch (error) {
					reject(ctx, error, automatic);
					return { cancel: true };
				}
			}
			const fallback = name === "session_before_compact" ? { cancel: true } : name === "context" ? { messages: [] } : name === "input" ? { action: "handled" } : undefined;
			return run(ctx, () => {
				if (name === "session_before_compact") {
					requireCompactEvent(event);
					requireSummaryHost(ctx);
				}
				return handler(event, ctx);
			}, fallback, automatic);
		});
	}) as ExtensionAPI["on"];
	return { on, run };
}
