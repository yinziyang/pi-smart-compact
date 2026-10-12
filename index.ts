// smart-compact 入口：把 pi 的事件绑定到压缩主流程、防循环规则、恢复省略记录与 recall_history 工具（方案第 3 节时序）。
//
// 每个会话一份运行时状态（按 sessionId 保存），父会话与 pi-subagents 子会话互不影响。
// 关键不变量：
//   - session_before_compact 在任何路径上都不返回空（signal 已取消、关闭开关或 pi 版本不符除外），因为空结果会让 pi 默认摘要接手，而默认摘要没有长度上限（方案 F45）。
//   - session_before_compact 内不追加会话条目；状态在 session_compact、session_compact_failed 与 agent_settled 中持久化（方案 7.4）。
//   - 处于 R5 时，普通输入被拦截，每个回合开始时中止，只有 /compact 与 /smart-compact 可用（方案 7.4 R5）。
//   - context handler 不抛异常：出错时把消息中的压缩摘要替换为固定短通知。

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { VERSION, type ExtensionAPI, type ExtensionContext, type SessionBoundaryDraft } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { applyBaseline, applyDensity, computeBudget, countAutoCompactions, freshModelState, isOwnCompaction, type ModelState } from "./budget.ts";
import { handoffDir, handoffDoc, nextHandoffPath, removeHandoffsBefore, writeHandoffFile } from "./handoff.ts";
import { chooseModel, initialFEst, isVirtual, modelKey, requestFromEvent, runCompaction, virtualWindow, type OwnDetails } from "./compact.ts";
import { applyEdits, contentText, findInvalidation, messageText, toolCalls, type RawEntry } from "./edits.ts";
import { extractPack, type RecoveryRecord } from "./pack.ts";
import { capRecall, recallById, recallByQuery, validRecoveryRecords, type RecallDoc } from "./recall.ts";
import * as rec from "./recovery.ts";
import { redact } from "./redact.ts";
import { compactionSettingsFor, MAX_RECORDS, parseConfig, restoreState, STATE_TYPE, freshState, type CompactionRecord, type Config, type PersistedState, type R5Reason } from "./state.ts";

/** 已验证的 pi 版本；不一致时不接管摘要（方案风险 2）。 */
export const VERIFIED_PI_VERSION = "1.1.0";
const RESET_TYPE = "smart-compact-reset";
const INVALIDATED_TYPE = "smart-compact-invalidated";
const STATUS_KEY = "smart-compact";
/** 旧摘要作废后替换进模型上下文的固定短通知（不超过 1000 字节）。 */
export const INVALID_NOTICE = "（较早的压缩摘要依据的历史已被修改，该摘要已作废，正在重建。需要压缩前的细节时调用 recall_history 取回。）";

const R5_TEXT: Record<R5Reason, string> = {
	baseline: "压缩后基线过高",
	failed: "压缩失败",
	history: "历史被修改，旧摘要作废",
	count: "自动压缩次数达上限",
	virtual: "虚拟模型窗口问题",
};

/** 需要隔离的外部依赖（方案 11.3）。 */
export interface Deps {
	now: () => number;
	randomId: () => string;
	agentDir: string;
	env: NodeJS.ProcessEnv;
	piVersion: string;
	/** 没有界面时的诊断输出。 */
	log: (line: string) => void;
}

export function realDeps(): Deps {
	return { now: Date.now, randomId: randomUUID, agentDir: process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), env: process.env, piVersion: VERSION, log: (line) => process.stderr.write(`${line}\n`) };
}

/** 压缩后等待采样的基线（方案 7.1）。 */
interface PendingSample {
	leafId: string | null;
	key: string;
	T: number;
	bEst: number;
	estRawWithoutF: number;
}

interface Runtime {
	state: PersistedState;
	dirty: boolean;
	scan: rec.ScanState;
	/** 当前打开的开窗标记 id；只有追加了开窗标记的窗口才追加关窗标记。 */
	windowId: string | null;
	abortNextTurn: boolean;
	inflight: boolean;
	/** 本扩展在 session_before_compact 返回了结果，等待 session_compact 核对。 */
	returned: { nonce: string; batchNonce: string | null; key: string; T: number; reason: string; tokensBefore: number } | null;
	/** session_before_compact 已分批、尚未消费的恢复批次 nonce。 */
	batchNonce: string | null;
	pendingSample: PendingSample | null;
	/** 等待在安全时机追加的 custom 条目。 */
	pendingCustom: { customType: string; data: unknown }[];
	/** 已尝试过重建的 compaction id，每次失效只尝试一次。 */
	rebuiltFor: string | null;
	/** 已记录失效的 compaction id。 */
	invalidatedId: string | null;
	/** 重建得到、等待以边界条目追加的 compaction。 */
	pendingDraft: { forId: string; draft: SessionBoundaryDraft } | null;
	/** 历史被修改时最早的失效编辑的时间，用于清理更早的交接文档。 */
	invalidatedAt: number | null;
	/** 当前模型的预算窗口来自声明值时，记下它供 message_end 校验。 */
	declaredWindow: number | null;
	notified: Set<string>;
}

function freshRuntime(): Runtime {
	return { state: freshState(), dirty: false, scan: rec.freshScanState(), windowId: null, abortNextTurn: false, inflight: false, returned: null, batchNonce: null, pendingSample: null, pendingCustom: [], rebuiltFor: null, invalidatedId: null, pendingDraft: null, invalidatedAt: null, declaredWindow: null, notified: new Set() };
}

function branchOf(ctx: ExtensionContext): RawEntry[] {
	return ctx.sessionManager.getBranch() as unknown as RawEntry[];
}

function firstWord(text: string): string {
	return text.trimStart().split(/\s+/, 1)[0] ?? "";
}

/** R5 时放行的输入：第一个词恰好是 /compact 或 /smart-compact（方案 7.4 R5）。 */
export function allowedInR5(text: string): boolean {
	const w = firstWord(text);
	return w === "/compact" || w === "/smart-compact";
}

export function smartCompact(pi: ExtensionAPI, deps: Deps): void {
	const runtimes = new Map<string, Runtime>();
	const configPath = join(deps.agentDir, "smart-compact.json");
	const loadConfig = (): { config: Config; problems: string[] } => {
		let text: string | undefined;
		try {
			text = readFileSync(configPath, "utf8");
		} catch {
			text = undefined;
		}
		return parseConfig(text);
	};
	let { config, problems: configProblems } = loadConfig();
	const takeover = () => deps.env.PI_SMART_COMPACT_SUMMARY !== "off" && deps.piVersion === VERIFIED_PI_VERSION;
	const fault = (): "main" | "all" | undefined => (deps.env.PI_SMART_COMPACT_FAULT === "main" || deps.env.PI_SMART_COMPACT_FAULT === "all" ? deps.env.PI_SMART_COMPACT_FAULT : undefined);

	const rt = (ctx: ExtensionContext): Runtime => {
		const id = ctx.sessionManager.getSessionId();
		let r = runtimes.get(id);
		if (!r) {
			r = freshRuntime();
			runtimes.set(id, r);
		}
		return r;
	};
	/** 有界面时用通知，没有界面（print、RPC 模式）时写诊断日志，保证失败原因总能被看到。 */
	const tell = (ctx: ExtensionContext, text: string, level: "info" | "warning" | "error" = "warning") => {
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else deps.log(`[smart-compact] ${level}: ${text}`);
	};
	const notifyOnce = (ctx: ExtensionContext, r: Runtime, key: string, text: string, level: "info" | "warning" | "error" = "warning") => {
		if (r.notified.has(key)) return;
		r.notified.add(key);
		tell(ctx, text, level);
	};
	const persist = (r: Runtime) => {
		if (!r.dirty) return;
		pi.appendEntry(STATE_TYPE, r.state);
		r.dirty = false;
	};
	const flushCustom = (r: Runtime) => {
		for (const c of r.pendingCustom.splice(0)) pi.appendEntry(c.customType, c.data);
	};
	const modelStateFor = (r: Runtime, key: string): ModelState => r.state.models[key] ?? freshModelState();
	const setModelState = (r: Runtime, key: string, s: ModelState) => {
		r.state.models[key] = s;
		r.dirty = true;
	};
	const updateStatus = (ctx: ExtensionContext, r: Runtime) => {
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, r.state.r5 ? `自动压缩已停止：${R5_TEXT[r.state.r5.reason]}` : undefined);
	};

	const dirOf = (ctx: ExtensionContext) => handoffDir(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionDir(), ctx.sessionManager.getSessionId());
	const nextPath = (ctx: ExtensionContext): string | undefined => {
		const dir = dirOf(ctx);
		return dir ? nextHandoffPath(dir, deps.now()) : undefined;
	};
	/** 写交接文档；失败只记警告（方案第 9 节）。返回是否写成功。 */
	const writeHandoff = (ctx: ExtensionContext, r: Runtime, path: string | undefined, text: string): boolean => {
		const dir = dirOf(ctx);
		if (!path || !dir) return false;
		try {
			writeHandoffFile(dir, path, text, config.handoffKeep);
			return true;
		} catch (err) {
			notifyOnce(ctx, r, `handoff:${path}`, `smart-compact：交接文档写入失败：${err instanceof Error ? err.message : String(err)}`);
			return false;
		}
	};
	/** 重建成功后删除本会话中生成时间早于失效编辑的交接文档；清理失败不影响压缩结果。 */
	const cleanupHandoffs = (ctx: ExtensionContext, r: Runtime, keep: string | undefined) => {
		const dir = dirOf(ctx);
		if (dir && r.invalidatedAt !== null) {
			try {
				removeHandoffsBefore(dir, keep, r.invalidatedAt);
			} catch {
				// 旧文档留在本会话目录中，不影响压缩结果。
			}
		}
		r.invalidatedAt = null;
	};

	/**
	 * 进入 R5。abort 为真（缺省）时立即中止当前运行，并在下一个 turn_start 再中止一次：进入 R5 的位置可能晚于本回合的 turn_start（例如虚拟模型在 prepareRequest 中触发的压缩、context 事件），只等下一个回合会让本回合的请求与工具照常执行。
	 * session_before_compact 返回压缩结果的路径传 false，避免中止影响 pi 追加这次结果，由下一个 turn_start 中止。
	 */
	const enterR5 = (ctx: ExtensionContext, r: Runtime, reason: R5Reason, abort = true) => {
		r.abortNextTurn = true;
		if (abort) ctx.abort();
		if (r.state.r5?.reason === reason) return;
		r.state.r5 = { reason, since: new Date(deps.now()).toISOString() };
		r.dirty = true;
		// 进入时写一份交接文档，包含被 pi 移出上下文的最近执行记录（方案 7.4 R5 行为）。
		const path = nextPath(ctx);
		const pending = [...r.scan.collected, ...r.scan.batches.flatMap((b) => b.records)];
		const data = extractPack({ entries: applyEdits(branchOf(ctx)), keptIds: new Set(), omitted: pending, handoffPath: path });
		const ok = writeHandoff(ctx, r, path, handoffDoc(`smart-compact 交接文档（自动压缩已停止：${R5_TEXT[reason]}）`, undefined, data, { reason }));
		const where = ok ? `请用交接文档 ${path} 开新会话` : "请开新会话";
		const exit = reason === "history" ? "或执行 /compact 手动重建" : "或执行 /smart-compact reset";
		tell(ctx, `自动压缩已停止：${R5_TEXT[reason]}。${where}，${exit}。`, "error");
		updateStatus(ctx, r);
	};
	const exitR5 = (ctx: ExtensionContext, r: Runtime) => {
		if (!r.state.r5) return;
		r.state.r5 = null;
		r.dirty = true;
		r.abortNextTurn = false;
		updateStatus(ctx, r);
	};

	/** 会话开始与切换分支时从分支恢复状态，并重建 R3 计数与恢复记录。 */
	const restore = (ctx: ExtensionContext) => {
		const r = freshRuntime();
		runtimes.set(ctx.sessionManager.getSessionId(), r);
		const branch = branchOf(ctx);
		for (let i = branch.length - 1; i >= 0; i--) {
			const e = branch[i];
			if (e.type === "custom" && e.customType === STATE_TYPE) {
				const s = restoreState(e.data);
				if (s) r.state = s;
				else notifyOnce(ctx, r, "state-version", "smart-compact：会话中的状态记录版本无法识别，已按新会话初始化。");
				break;
			}
		}
		if (countAutoCompactions(branch) >= config.maxAutoCompactions && !r.state.r5) r.state.r5 = { reason: "count", since: new Date(deps.now()).toISOString() };
		const rebuilt = rec.rebuildFromMarkers(branch);
		if (rebuilt.records.length) pi.appendEntry(rec.RECOVERY_TYPE, { version: rec.RECOVERY_VERSION, nonce: deps.randomId(), createdAt: new Date(deps.now()).toISOString(), records: rebuilt.records });
		if (rebuilt.unconfirmedWindows > 0) notifyOnce(ctx, r, "unconfirmed", "smart-compact：上次运行中断，最近一次失败回合的记录未能确认来源，未纳入召回。", "info");
		updateStatus(ctx, r);
		return r;
	};

	/** 按当前模型预检不变量（方案 7.3），下限参数也不满足时提示。 */
	const precheck = (ctx: ExtensionContext, r: Runtime) => {
		const model = ctx.model;
		if (!model) return;
		const reserve = compactionSettingsFor(pi.getSettings(), modelKey(model)).reserveTokens;
		let window = model.contextWindow;
		r.declaredWindow = null;
		if (isVirtual(model)) {
			// 虚拟模型的窗口在这里就确定并保存，message_end 从第一条响应起校验实际路由（方案 7.2）。
			const vw = virtualWindow(ctx, model, config);
			if (!vw) {
				if (r.state.r5?.reason !== "virtual") enterR5(ctx, r, "virtual");
				return;
			}
			if (vw.declared) r.declaredWindow = vw.window;
			window = vw.window;
			if (!config.virtualWindowTokens[modelKey(model)] && !(model.contextWindow > 0)) notifyOnce(ctx, r, `virtual-floor:${modelKey(model)}`, `smart-compact：虚拟模型 ${modelKey(model)} 的预算窗口取注册表最小值 ${window}，可在 smart-compact.json 的 virtualWindowTokens 中声明。`, "info");
		}
		const T = window - reserve;
		const fEst = modelStateFor(r, modelKey(model)).fEst ?? initialFEst(ctx.getSystemPrompt(), activeTools());
		const b = computeBudget({ T, keepRecentTokens: 20000, level: 2, mode: "local", fEst, overflowRetry: false });
		if (!b.ok) notifyOnce(ctx, r, `small:${modelKey(model)}`, `smart-compact：模型 ${modelKey(model)} 的窗口相对固定开销过小（F_est≈${fEst}，T=${T}），建议减少 MCP 工具或换用更大窗口的模型。`);
	};
	const activeTools = () => {
		const active = new Set(pi.getActiveTools());
		return pi.getAllTools().filter((t) => active.has(t.name));
	};

	pi.on("session_start", (_e, ctx) => {
		({ config, problems: configProblems } = loadConfig());
		const r = restore(ctx);
		for (const p of configProblems) notifyOnce(ctx, r, `config:${p}`, `smart-compact：${p}`);
		if (deps.piVersion !== VERIFIED_PI_VERSION) notifyOnce(ctx, r, "version", `smart-compact：pi 版本 ${deps.piVersion} 未经验证（已验证 ${VERIFIED_PI_VERSION}），本扩展不接管压缩摘要。`);
		precheck(ctx, r);
	});
	pi.on("session_tree", (_e, ctx) => {
		precheck(ctx, restore(ctx));
	});
	// 注册表刷新或鉴权变化后重新计算虚拟模型窗口（方案 7.2）。
	pi.on("before_agent_start", (_e, ctx) => {
		precheck(ctx, rt(ctx));
	});

	pi.on("model_select", (e, ctx) => {
		const r = rt(ctx);
		const changed = !e.previousModel || modelKey(e.model) !== modelKey(e.previousModel);
		// 切换模型后，新模型的响应不能作为旧模型压缩后的基线样本（方案 7.1 按物理模型分开保存）。
		if (changed) r.pendingSample = null;
		if (changed && r.state.r5 && (r.state.r5.reason === "baseline" || r.state.r5.reason === "failed" || r.state.r5.reason === "virtual")) exitR5(ctx, r);
		precheck(ctx, r);
	});

	pi.on("input", (e, ctx) => {
		const r = rt(ctx);
		if (!r.state.r5 || allowedInR5(e.text)) return { action: "continue" };
		tell(ctx, `自动压缩已停止：${R5_TEXT[r.state.r5.reason]}。输入未发送。可执行 /compact、/smart-compact reset，或用交接文档开新会话。`, "error");
		return { action: "handled" };
	});

	pi.on("turn_start", (_e, ctx) => {
		const r = rt(ctx);
		if (r.abortNextTurn || r.state.r5) {
			r.abortNextTurn = false;
			ctx.abort();
		}
	});

	/** 检测最新摘要是否因历史被修改而失效；首次发现某个 compaction 失效时记下失效条目（方案 5.2 第 4 步）。 */
	const detectInvalidation = (ctx: ExtensionContext, r: Runtime) => {
		const branch = branchOf(ctx);
		const inv = findInvalidation(branch);
		if (inv && r.invalidatedId !== inv.compactionId) {
			r.invalidatedId = inv.compactionId;
			const edit = branch.find((x) => x.id === inv.editId);
			r.invalidatedAt = Date.parse(edit?.timestamp ?? "") || deps.now();
			r.pendingCustom.push({ customType: INVALIDATED_TYPE, data: { version: 1, compactionId: inv.compactionId, editId: inv.editId } });
		}
		return inv;
	};

	/**
	 * 历史被修改后的重建：从应用了编辑的原始分支重新生成摘要，结果以边界条目（turn_end 或 agent_before_settle）追加为新的 compaction。
	 * 不走 ctx.compact()：pi 的手动压缩在最近一次压缩之后内容很少时会以「Nothing to compact」拒绝。
	 * 也不等到运行结束：被中止的运行不会触发 agent_before_settle（agent-session.js 的 _runAgentPrompt），所以在发现失效的那次 context 事件里同步重建，本次请求直接使用新摘要。
	 * 返回 "aborted" 表示被用户中止，不算失败，下一次请求会重试。
	 */
	const rebuild = async (ctx: ExtensionContext, r: Runtime, signal: AbortSignal): Promise<SessionBoundaryDraft | "failed" | "aborted"> => {
		const branch = branchOf(ctx);
		const choice = chooseModel(ctx, branch, config);
		if (!choice) {
			tell(ctx, "smart-compact：重建失败：找不到可用的摘要模型。", "error");
			return "failed";
		}
		const latest = [...branch].reverse().find((x) => x.type === "compaction");
		const ms = modelStateFor(r, choice.key);
		const handoffPath = nextPath(ctx);
		const out = await runCompaction({
			event: {
				reason: "manual",
				willRetry: false,
				settings: compactionSettingsFor(pi.getSettings(), modelKey(ctx.model ?? choice.summaryModel)),
				tokensBefore: ctx.getContextUsage()?.tokens ?? 0,
				branchEntries: branch,
				fallbackFirstKept: latest?.firstKeptEntryId ?? "",
				signal,
			},
			ctx,
			config,
			choice,
			modelState: ms,
			fEst: ms.fEst ?? initialFEst(ctx.getSystemPrompt(), activeTools()),
			omitted: null,
			rebuild: true,
			handoffPath,
			nonce: deps.randomId(),
			fault: fault(),
			now: deps.now,
		});
		if (signal.aborted) return "aborted";
		if (out.kind !== "ok") {
			if (out.kind === "failed") writeHandoff(ctx, r, handoffPath, out.handoff ?? "");
			tell(ctx, `smart-compact：重建失败：${out.kind === "failed" ? out.error : "预算不满足不变量"}。`, "error");
			return "failed";
		}
		if (!writeHandoff(ctx, r, handoffPath, out.handoff)) out.result.details.handoffPath = undefined;
		if (r.state.r5?.reason === "history") exitR5(ctx, r);
		cleanupHandoffs(ctx, r, out.result.details.handoffPath);
		// 边界条目追加的 compaction 不触发 session_compact（agent-session.js 的 _commitBoundaryDrafts），统计在这里记录。
		// 简化：重建之后不做基线采样，旧样本作废；它不计入自动压缩次数，也不参与 R1、R2，下一次正常压缩照常采样。
		r.pendingSample = null;
		const record: CompactionRecord = { time: new Date(deps.now()).toISOString(), reason: "rebuild", tokensBefore: ctx.getContextUsage()?.tokens ?? null, bEst: out.result.details.bEst, usageInputActual: null, addedEstimate: null, baselineAdjusted: null, baselineUsable: false, calibrationEligible: false };
		r.state.records[choice.key] = [...(r.state.records[choice.key] ?? []), record].slice(-MAX_RECORDS);
		r.dirty = true;
		const { summary, firstKeptEntryId, details, usage } = out.result;
		return { type: "compaction", summary, firstKeptEntryId, details, usage };
	};

	/**
	 * 处理失效：已有待落盘的重建结果时直接用它；本次失效还没尝试过重建时立即重建；重建失败进入 R5（历史被修改）。
	 * 返回应替换进模型上下文的摘要文本。
	 */
	const handleInvalidation = async (ctx: ExtensionContext, r: Runtime, signal: AbortSignal): Promise<string | null> => {
		const inv = detectInvalidation(ctx, r);
		if (!inv) return r.state.r5?.reason === "history" ? INVALID_NOTICE : null;
		if (r.pendingDraft?.forId === inv.compactionId) return r.pendingDraft.draft.type === "compaction" ? r.pendingDraft.draft.summary : INVALID_NOTICE;
		if (r.rebuiltFor === inv.compactionId || !takeover()) {
			if (!r.state.r5) enterR5(ctx, r, "history");
			return INVALID_NOTICE;
		}
		const out = await rebuild(ctx, r, signal);
		if (out === "aborted") return INVALID_NOTICE;
		r.rebuiltFor = inv.compactionId;
		if (out === "failed") {
			enterR5(ctx, r, "history");
			return INVALID_NOTICE;
		}
		r.pendingDraft = { forId: inv.compactionId, draft: out };
		return out.type === "compaction" ? out.summary : INVALID_NOTICE;
	};

	pi.on("context", async (e, ctx) => {
		const r = rt(ctx);
		const replace = (messages: AgentMessage[], summary: string) => messages.map((m) => (m.role === "compactionSummary" ? { ...m, summary } : m));
		try {
			const summary = await handleInvalidation(ctx, r, ctx.signal ?? new AbortController().signal);
			return summary === null ? undefined : { messages: replace(e.messages, summary) };
		} catch {
			return { messages: replace(e.messages, INVALID_NOTICE) };
		}
	});

	/** 取出待追加的边界条目：失效记录与重建得到的 compaction。 */
	const takeBoundary = (r: Runtime): SessionBoundaryDraft[] => {
		const entries: SessionBoundaryDraft[] = r.pendingCustom.splice(0).map((c) => ({ type: "custom" as const, customType: c.customType, data: c.data }));
		if (r.pendingDraft) {
			entries.push(r.pendingDraft.draft);
			r.pendingDraft = null;
		}
		return entries;
	};

	pi.on("turn_end", (_e, ctx) => {
		const entries = takeBoundary(rt(ctx));
		return entries.length ? { entries } : undefined;
	});

	pi.on("message_end", (e, ctx) => {
		const m = e.message as { role?: string; stopReason?: string; usage?: Record<string, unknown>; provider?: string; model?: string };
		if (m.role !== "assistant") return;
		const r = rt(ctx);
		// 虚拟模型的声明窗口校验（方案 7.2）。
		// 失败或中止的响应只要带着物理模型字段也要校验（方案 S8）；路由失败的响应仍记着虚拟模型，find 得到虚拟模型时跳过。
		if (r.declaredWindow !== null && ctx.model && isVirtual(ctx.model) && m.provider && m.model) {
			const phys = ctx.modelRegistry.find(m.provider, m.model);
			if (phys && !isVirtual(phys) && phys.contextWindow > 0 && phys.contextWindow < r.declaredWindow && !r.state.r5) {
				enterR5(ctx, r, "virtual");
				ctx.abort();
				return;
			}
		}
		const s = r.pendingSample;
		if (!s) return;
		// 只采样与压缩时同一个物理模型的响应；虚拟路由到其他模型时放弃本次样本。
		if (m.provider && m.model && `${m.provider}/${m.model}` !== s.key && m.stopReason !== "error" && m.stopReason !== "aborted") {
			r.pendingSample = null;
			return;
		}
		const u = m.usage ?? {};
		const nums = ["input", "output", "cacheRead", "cacheWrite"].map((k) => u[k]);
		if (m.stopReason === "error" || m.stopReason === "aborted" || !nums.every((x) => typeof x === "number" && Number.isFinite(x) && x >= 0)) return;
		const [input, output, cacheRead, cacheWrite] = nums as number[];
		if (input + output + cacheRead + cacheWrite <= 0) return;
		r.pendingSample = null;
		const actual = input + cacheRead + cacheWrite;
		// 压缩之后、这条响应之前新增的模型可见条目（方案 7.1）：有任何一条，样本就不可用。
		const branch = branchOf(ctx);
		const from = s.leafId ? branch.findIndex((x) => x.id === s.leafId) + 1 : 0;
		const added = branch.slice(from).filter((x) => x.type === "custom_message" || (x.type === "message" && x.message?.role !== "assistant"));
		const usable = added.length === 0;
		const addedEstimate = added.reduce((a, x) => a + Math.ceil((messageText(x.message) || contentText(x.content)).length / 3.5), 0);
		const records = r.state.records[s.key] ?? [];
		const last = records.at(-1);
		if (last) {
			last.usageInputActual = actual;
			last.addedEstimate = addedEstimate;
			last.baselineAdjusted = usable ? actual : null;
			last.baselineUsable = usable;
			last.calibrationEligible = usable;
		}
		const out = applyBaseline(modelStateFor(r, s.key), { baselineUsable: usable, baselineAdjusted: usable ? actual : null, calibrationEligible: usable, usageInputActual: actual, bEst: s.bEst, estRawWithoutF: s.estRawWithoutF }, s.T);
		setModelState(r, s.key, out.state);
		if (out.r5 && !r.state.r5) {
			enterR5(ctx, r, out.r5);
			ctx.abort();
		}
	});

	// 恢复省略记录的扫描状态机（方案第 8 节）。
	pi.on("agent_end", (e, ctx) => {
		const r = rt(ctx);
		const branch = branchOf(ctx);
		rec.onAgentEnd(r.scan, branch);
		const last = [...e.messages].reverse().find((m) => m.role === "assistant") as { stopReason?: string } | undefined;
		if (last && (last.stopReason === "error" || last.stopReason === "length")) {
			const candidates: string[] = [];
			for (let i = branch.length - 1; i >= 0; i--) {
				const x = branch[i];
				if (x.type !== "message") continue;
				candidates.unshift(x.id);
				if (x.message?.role === "assistant") break;
			}
			r.windowId = deps.randomId();
			pi.appendEntry(rec.WINDOW_TYPE, { version: rec.RECOVERY_VERSION, windowId: r.windowId, candidateTargetIds: candidates });
			r.scan.windowStart = branchOf(ctx).length;
		} else {
			r.windowId = null;
		}
	});
	const closeWindow = (ctx: ExtensionContext) => {
		const r = rt(ctx);
		const ids = rec.closeWindow(r.scan, branchOf(ctx));
		if (r.windowId) {
			pi.appendEntry(rec.WINDOW_CLOSE_TYPE, { version: rec.RECOVERY_VERSION, windowId: r.windowId, confirmedEditIds: ids });
			r.windowId = null;
		}
	};
	pi.on("agent_start", (_e, ctx) => closeWindow(ctx));
	pi.on("agent_before_settle", async (_e, ctx) => {
		closeWindow(ctx);
		const r = rt(ctx);
		// 运行的最后一个回合之后才出现的失效编辑，在这里重建；运行已结束，用独立的中止信号，资源上限仍由 MAX_REQUESTS 与 MAX_WALL_MS 约束。
		try {
			await handleInvalidation(ctx, r, new AbortController().signal);
		} catch (err) {
			tell(ctx, `smart-compact：重建出错：${err instanceof Error ? err.message : String(err)}`, "error");
		}
		const entries = takeBoundary(r);
		return entries.length ? { entries } : undefined;
	});

	const writeRecovery = (r: Runtime, nonce: string) => {
		const batch = rec.consumeBatch(r.scan, nonce);
		if (batch) pi.appendEntry(rec.RECOVERY_TYPE, { version: rec.RECOVERY_VERSION, nonce: batch.nonce, createdAt: new Date(deps.now()).toISOString(), records: batch.records });
	};

	pi.on("agent_settled", (_e, ctx) => {
		const r = rt(ctx);
		rec.scan(r.scan, branchOf(ctx));
		r.scan.windowStart = null;
		rec.takeBatch(r.scan, deps.randomId());
		for (const b of [...r.scan.batches]) writeRecovery(r, b.nonce);
		r.scan.seen.clear();
		flushCustom(r);
		persist(r);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!takeover() || event.signal.aborted) return undefined;
		const r = rt(ctx);
		const stop = (reason: R5Reason | null) => {
			// threshold 与 overflow 两级都失败或被禁止时让运行真正停下：handler 内中止一次，下一个 turn_start 再中止一次（方案 F49）。
			ctx.abort();
			r.abortNextTurn = true;
			if (reason) enterR5(ctx, r, reason);
			return { cancel: true };
		};
		if (r.inflight) {
			tell(ctx, "smart-compact：已有压缩在进行。", "warning");
			if (event.reason === "threshold") ctx.abort();
			return { cancel: true };
		}
		r.inflight = true;
		const leaf = ctx.sessionManager.getLeafId();
		let batchNonce: string | null = null;
		try {
			const branch = event.branchEntries as unknown as RawEntry[];
			rec.scanAndAdvance(r.scan, branch);
			batchNonce = deps.randomId();
			const batch = rec.takeBatch(r.scan, batchNonce);
			if (!batch) batchNonce = null;
			r.batchNonce = batchNonce;

			const auto = event.reason !== "manual";
			const r5 = r.state.r5;
			if (r5 && event.reason === "threshold") return stop(null);
			if (r5?.reason === "count" && auto) return stop(null);

			const invalid = findInvalidation(branch);
			const rebuild = !!invalid || r5?.reason === "history";
			const choice = chooseModel(ctx, branch, config);
			if (!choice) {
				if (!auto) {
					tell(ctx, "smart-compact：找不到可用的摘要模型。", "error");
					return { cancel: true };
				}
				return stop(isVirtual(ctx.model) ? "virtual" : "failed");
			}
			r.declaredWindow = choice.declaredWindow ? choice.window : null;
			const T = choice.window - event.preparation.settings.reserveTokens;
			let ms = modelStateFor(r, choice.key);
			const prevRec = (r.state.records[choice.key] ?? []).at(-1);
			const dens = applyDensity(ms, event.preparation.tokensBefore, prevRec?.baselineUsable ? prevRec.baselineAdjusted : null, T);
			ms = dens.state;
			setModelState(r, choice.key, ms);
			if (dens.r5 && !r.state.r5) {
				if (event.reason === "threshold") return stop("baseline");
				enterR5(ctx, r, "baseline", false);
			}
			const fEst = ms.fEst ?? initialFEst(ctx.getSystemPrompt(), activeTools());
			const handoffPath = nextPath(ctx);
			// overflow 且会重试时，在调用模型之前先把被省略的执行记录写进交接文档（方案第 8 节）。
			if (event.reason === "overflow" && event.willRetry && batch) {
				const data = extractPack({ entries: applyEdits(branch), keptIds: new Set(), omitted: batch.records, handoffPath });
				writeHandoff(ctx, r, handoffPath, handoffDoc("smart-compact 交接文档（溢出恢复，压缩前）", undefined, data, { reason: event.reason }));
			}
			const nonce = deps.randomId();
			const out = await runCompaction({ event: requestFromEvent(event), ctx, config, choice, modelState: ms, fEst, omitted: batch, rebuild, handoffPath, nonce, fault: fault(), now: deps.now });
			if (event.signal.aborted) return undefined;
			if (out.kind === "invariant") return stop("baseline");
			if (out.kind === "failed") {
				writeHandoff(ctx, r, handoffPath, out.handoff ?? "");
				tell(ctx, `smart-compact：压缩失败：${out.error}。${auto ? "" : "可以重试 /compact。"}`, "error");
				if (!auto) return { cancel: true };
				return stop("failed");
			}
			if (ctx.sessionManager.getLeafId() !== leaf) {
				tell(ctx, "smart-compact：压缩期间会话发生了变化，结果已丢弃，请重新发送。", "warning");
				if (event.reason === "threshold") ctx.abort();
				return { cancel: true };
			}
			// overflow 与 manual 在下限参数仍不满足不变量时照常压缩，但随后进入 R5（方案 7.3、7.4）。
			if (!out.result.details.budget.ok && auto) enterR5(ctx, r, "baseline", false);
			const wrote = writeHandoff(ctx, r, handoffPath, out.handoff);
			if (!wrote) out.result.details.handoffPath = undefined;
			r.returned = { nonce, batchNonce, key: choice.key, T, reason: event.reason, tokensBefore: event.preparation.tokensBefore };
			return { compaction: out.result };
		} catch (err) {
			// 任何异常都不能让 pi 默认摘要接手（方案第 9 节）。
			tell(ctx, `smart-compact：压缩出错：${err instanceof Error ? err.message : String(err)}`, "error");
			if (event.reason === "manual") return { cancel: true };
			return stop("failed");
		} finally {
			r.inflight = false;
		}
	});

	pi.on("session_compact", (event, ctx) => {
		const r = rt(ctx);
		const entry = event.compactionEntry as unknown as RawEntry;
		const details = entry.details as Partial<OwnDetails> | undefined;
		const mine = r.returned;
		r.returned = null;
		if (mine && details?.nonce === mine.nonce) {
			// 恢复批次单独核对自己的 nonce：其他 handler 可能保留顶层 nonce 却改掉 omittedAttempt。
			if (mine.batchNonce) {
				if (details.omittedAttempt?.nonce === mine.batchNonce) rec.consumeBatch(r.scan, mine.batchNonce);
				else writeRecovery(r, mine.batchNonce);
			}
			const record: CompactionRecord = { time: new Date(deps.now()).toISOString(), reason: mine.reason, tokensBefore: mine.tokensBefore, bEst: details.bEst ?? null, usageInputActual: null, addedEstimate: null, baselineAdjusted: null, baselineUsable: false, calibrationEligible: false };
			r.state.records[mine.key] = [...(r.state.records[mine.key] ?? []), record].slice(-MAX_RECORDS);
			r.dirty = true;
			if (details.rebuild && r.state.r5?.reason === "history") {
				exitR5(ctx, r);
				cleanupHandoffs(ctx, r, details.handoffPath);
			}
			if (countAutoCompactions(branchOf(ctx)) >= config.maxAutoCompactions && !r.state.r5) enterR5(ctx, r, "count");
			persist(r);
			r.pendingSample = { leafId: ctx.sessionManager.getLeafId(), key: mine.key, T: mine.T, bEst: details.bEst ?? 0, estRawWithoutF: details.estRawWithoutF ?? 0 };
			return;
		}
		if (mine) {
			// 本扩展返回了结果，但最新 compaction 不是它：存在其他会返回 compaction 的扩展（方案 F22）。
			tell(ctx, "smart-compact：本次压缩结果被其他扩展覆盖，请不要同时安装其他压缩扩展。", "warning");
			if (mine.batchNonce) writeRecovery(r, mine.batchNonce);
		} else if (r.batchNonce) writeRecovery(r, r.batchNonce);
		persist(r);
		if (!isOwnCompaction(entry) && takeover()) notifyOnce(ctx, r, "foreign", "smart-compact：检测到不是本扩展生成的压缩。");
	});

	pi.on("session_compact_failed", (_e, ctx) => {
		const r = rt(ctx);
		r.returned = null;
		if (r.batchNonce) writeRecovery(r, r.batchNonce);
		r.batchNonce = null;
		flushCustom(r);
		persist(r);
	});

	/** recall_history 的检索范围：应用了编辑的原始分支中的消息，加上通过验证的恢复省略记录（方案第 6 节）。 */
	const recallDocs = (ctx: ExtensionContext): RecallDoc[] => {
		const branch = branchOf(ctx);
		const docs: RecallDoc[] = [];
		for (const e of applyEdits(branch)) {
			const m = e.message;
			if (e.type !== "message" || !m) continue;
			const calls = toolCalls(m).map((c) => `[调用 ${c.name}] ${JSON.stringify(c.args)}`);
			const text = [messageText(m), ...calls].filter(Boolean).join("\n");
			if (text) docs.push({ entryId: e.id, role: m.role === "toolResult" ? `toolResult(${m.toolName ?? ""})` : m.role, time: e.timestamp ?? "", text: redact(text) });
		}
		const records: RecoveryRecord[] = [];
		for (const e of branch) records.push(...rec.persistedRecords(e));
		for (const x of validRecoveryRecords(branch, records)) {
			docs.push({ entryId: x.targetId, role: `${x.role}（溢出恢复省略）`, time: "", text: redact(contentText(x.content)) });
		}
		return docs;
	};

	pi.registerTool({
		name: "recall_history",
		label: "Recall history",
		description: "Fetch original text from before compaction. query: space-separated keywords (all must match); entryId: fetch one record in full.",
		parameters: Type.Object({ query: Type.String(), entryId: Type.Optional(Type.String()) }),
		annotations: { readOnlyHint: true },
		async execute(_id, params, _signal, _onUpdate, ctx) {
			const docs = recallDocs(ctx);
			const text = capRecall(params.entryId ? (recallById(docs, params.entryId) ?? `找不到 entryId=${params.entryId}，或该记录已被删除。`) : recallByQuery(docs, params.query));
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerCommand("smart-compact", {
		description: "smart-compact：status 查看状态，reset 解除停止状态并清零自动压缩次数",
		handler: async (args, ctx) => {
			const r = rt(ctx);
			const sub = args.trim().split(/\s+/)[0] || "status";
			if (sub === "reset") {
				if (r.state.r5?.reason === "history") {
					tell(ctx, "历史被修改导致的停止只能由重建成功或开新会话解除，可以执行 /compact 手动重建。", "warning");
					return;
				}
				pi.appendEntry(RESET_TYPE, { version: 1, at: new Date(deps.now()).toISOString() });
				for (const k of Object.keys(r.state.models)) r.state.models[k] = { ...r.state.models[k], budgetLevel: 0, dense: 0 };
				exitR5(ctx, r);
				r.dirty = true;
				persist(r);
				tell(ctx, "smart-compact 已重置：自动压缩次数清零，预算级别恢复。", "info");
				return;
			}
			const branch = branchOf(ctx);
			const lines = [
				`接管摘要：${takeover() ? "是" : "否"}`,
				`停止状态：${r.state.r5 ? `${R5_TEXT[r.state.r5.reason]}（${r.state.r5.since}）` : "无"}`,
				`本会话自动压缩次数：${countAutoCompactions(branch)} / ${config.maxAutoCompactions}`,
				...Object.entries(r.state.models).map(([k, s]) => `${k}：预算级别 ${s.budgetLevel}，连续过密 ${s.dense}，c=${s.c.toFixed(2)}，F_est=${s.fEst ?? "未知"}`),
			];
			tell(ctx, lines.join("\n"), "info");
		},
	});
}

export default function (pi: ExtensionAPI): void {
	smartCompact(pi, realDeps());
}
