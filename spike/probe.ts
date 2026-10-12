// P0 spike 用的探针扩展：记录 pi 的事件时序，并按 PROBE_MODE 执行各项验证需要的动作（方案 12.1）。
//
// 环境变量：
//   - PROBE_LOG：必填，事件日志文件路径，每行一条 JSON，带进程号与会话 id，父子会话写同一个文件。
//   - PROBE_MODE：逗号分隔的动作列表，可为空：
//     - abort-in-compact：在 session_before_compact 中先 ctx.abort() 再返回 cancel，并在随后的 turn_start 再中止一次（方案 7.4 R5 的做法，S10）。
//     - abort-turn-start:N：在第 N 次 turn_start 调用 ctx.abort()（S10 路径二）。
//     - custom-compact：自定切点，并用 generateSummaryWithUsage + ctx.modelRegistry.streamSimple 生成摘要（S5、S6）。
//     - append-in-settle：在 agent_before_settle handler 内用 pi.appendEntry 追加条目，同时返回一条 boundary 草稿（S12）。
//     - summary-cap：在 session_before_compact 中用 maxTokens=64 请求一段要求很长的摘要，记录实际输出 token 与结束原因，然后交回 pi 默认处理（S14）。
//     - virtual：注册虚拟模型 probe/auto，按请求次数在 PROBE_VIRTUAL_TARGETS 列出的两个物理模型之间交替路由（S8）。
// 这个扩展只用于 spike，不进入正式实现。

import { appendFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";

type Json = Record<string, unknown>;

function usageSummary(u: unknown): Json | undefined {
	if (!u || typeof u !== "object") return undefined;
	const o = u as Record<string, number>;
	return { input: o.input, output: o.output, cacheRead: o.cacheRead, cacheWrite: o.cacheWrite };
}

export default function probe(pi: ExtensionAPI): void {
	const logFile = process.env.PROBE_LOG;
	const modes = new Set((process.env.PROBE_MODE ?? "").split(",").map((m) => m.trim()).filter(Boolean));
	const abortAt = [...modes].find((m) => m.startsWith("abort-turn-start:"));
	const abortTurn = abortAt ? Number(abortAt.split(":")[1]) : undefined;
	let turnStarts = 0;
	// 发送新提示词前的压缩检查发生在运行开始之前，此时 ctx.abort() 无事可中止，所以要在随后的 turn_start 补一次。
	let abortNextTurn = false;
	let sessionId = "";

	const log = (ev: string, data: Json = {}, ctx?: ExtensionContext) => {
		// 进程内 faux spike 用这个共享序列把探针事件与 provider 调用排成一条时间线，精确统计中止后的调用次数。
		(globalThis as { __probeSeq?: string[] }).__probeSeq?.push(ev);
		if (!logFile) return;
		const usage = ctx?.getContextUsage();
		const row = { t: Date.now(), pid: process.pid, session: sessionId, ev, ctxTokens: usage?.tokens ?? null, ctxWindow: usage?.contextWindow ?? null, ...data };
		try {
			appendFileSync(logFile, `${JSON.stringify(row)}\n`);
		} catch {
			// 日志写失败不影响被测行为。
		}
	};

	pi.registerCommand("probe-cmd", {
		description: "spike 用的探针命令，只记录一次调用",
		handler: async (_args, ctx) => log("probe_cmd", {}, ctx),
	});

	pi.on("session_start", (_e, ctx) => {
		sessionId = ctx.sessionManager.getSessionId();
		log("session_start", { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null, modelWindow: ctx.model?.contextWindow ?? null }, ctx);
	});
	pi.on("input", (e, ctx) => {
		log("input", { text: String((e as { text?: unknown }).text ?? "").slice(0, 60) }, ctx);
		return { action: "continue" };
	});
	pi.on("before_agent_start", (_e, ctx) => log("before_agent_start", {}, ctx));
	pi.on("agent_start", (_e, ctx) => log("agent_start", { leaf: ctx.sessionManager.getLeafId() }, ctx));
	pi.on("agent_end", (_e, ctx) => log("agent_end", { leaf: ctx.sessionManager.getLeafId() }, ctx));
	pi.on("turn_start", (_e, ctx) => {
		turnStarts++;
		log("turn_start", { n: turnStarts }, ctx);
		if ((abortTurn !== undefined && turnStarts === abortTurn) || abortNextTurn) {
			log("probe_abort", { at: "turn_start", n: turnStarts }, ctx);
			abortNextTurn = false;
			ctx.abort();
		}
	});
	pi.on("turn_end", (_e, ctx) => log("turn_end", {}, ctx));
	pi.on("message_end", (e, ctx) => {
		const m = e.message as { role?: string; stopReason?: string; provider?: string; model?: string; usage?: unknown };
		if (m.role === "assistant") log("assistant_end", { stopReason: m.stopReason, provider: m.provider, model: m.model, usage: usageSummary(m.usage) }, ctx);
	});
	pi.on("model_select", (_e, ctx) => log("model_select", { model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null }, ctx));

	pi.on("session_before_compact", async (event, ctx) => {
		const prep = event.preparation;
		log(
			"session_before_compact",
			{
				reason: event.reason,
				willRetry: event.willRetry,
				tokensBefore: prep.tokensBefore,
				firstKept: prep.firstKeptEntryId,
				settings: prep.settings,
				leaf: ctx.sessionManager.getLeafId(),
				branchTail: ctx.sessionManager
					.getBranch()
					.slice(-6)
					.map((b) => ({ type: b.type, id: b.id, target: (b as { targetId?: string }).targetId, replacement: (b as { replacement?: unknown }).replacement === null ? null : undefined })),
			},
			ctx,
		);
		if (modes.has("abort-in-compact")) {
			log("probe_abort", { at: "session_before_compact" }, ctx);
			ctx.abort();
			abortNextTurn = true;
			return { cancel: true };
		}
		if (modes.has("summary-cap") && ctx.model) {
			const msgs = ctx.sessionManager.buildSessionProjection().messages.filter((m) => m.role !== "system").slice(0, 6);
			try {
				const r = await generateSummaryWithUsage(msgs, ctx.model, 80, undefined, undefined, event.signal, "无论上面的格式要求如何，都必须写不少于两千字，逐条详细展开。", undefined, "off", (m, c, o) => ctx.modelRegistry.streamSimple(m, c, o));
				log("probe_cap_result", { requestedMaxTokens: 64, outputTokens: (r.usage as { output?: number } | undefined)?.output ?? null, chars: r.text.length }, ctx);
			} catch (err) {
				log("probe_cap_error", { requestedMaxTokens: 64, error: err instanceof Error ? err.message : String(err) }, ctx);
			}
			return undefined;
		}
		if (!modes.has("custom-compact")) return undefined;

		// S5、S6：在投影上自选切点。从尾部往前按 chars/4 累计到约 4000 token，取该位置及之后最近的有效切点：
		// 有效切点是第一条消息为 user 或 assistant 的条目，不切在工具结果上（方案 F13）。
		const entries = ctx.sessionManager.buildSessionProjection().entries.filter((pe) => pe.sourceEntry.type !== "compaction");
		const isCut = (i: number) => {
			const role = entries[i]?.messages[0]?.role;
			return role === "user" || role === "assistant";
		};
		let acc = 0;
		let cut = -1;
		for (let i = entries.length - 1; i > 0; i--) {
			acc += Math.ceil(JSON.stringify(entries[i].messages).length / 4);
			if (acc >= 4000) {
				for (let j = i; j < entries.length; j++) {
					if (isCut(j)) {
						cut = j;
						break;
					}
				}
				// 之后没有有效切点时，取之前最近的一个（方案 5.2 第 2 步），保留的原文会多一些。
				for (let j = i - 1; cut < 0 && j > 0; j--) if (isCut(j)) cut = j;
				break;
			}
		}
		const shape = entries.map((pe, i) => `${i}:${pe.sourceEntry.type}/${pe.messages.map((m) => m.role).join("+") || "-"}/${Math.ceil(JSON.stringify(pe.messages).length / 4)}`);
		log("probe_custom_shape", { cut, acc, shape }, ctx);
		if (cut <= 0 || !ctx.model) {
			log("probe_custom_skip", { cut, entries: entries.length }, ctx);
			return undefined;
		}
		const toSummarize = entries.slice(0, cut).flatMap((pe) => pe.messages.filter((m) => m.role !== "system"));
		try {
			const result = await generateSummaryWithUsage(
				toSummarize,
				ctx.model,
				Math.ceil(4096 / 0.8),
				undefined,
				undefined,
				event.signal,
				undefined,
				undefined,
				"off",
				(m, c, o) => ctx.modelRegistry.streamSimple(m, c, o),
				undefined,
				undefined,
				undefined,
				ctx.sessionManager.getSessionId(),
			);
			const firstKeptEntryId = entries[cut].sourceEntry.id;
			log("probe_custom_done", { firstKeptEntryId, summaryChars: result.text.length, usage: usageSummary(result.usage) }, ctx);
			return { compaction: { summary: result.text, firstKeptEntryId, tokensBefore: prep.tokensBefore, usage: result.usage, details: { probe: 1 } } };
		} catch (err) {
			log("probe_custom_error", { error: err instanceof Error ? err.message : String(err) }, ctx);
			return undefined;
		}
	});
	pi.on("session_compact", (e, ctx) => {
		const c = e.compactionEntry as { id: string; firstKeptEntryId: string; tokensBefore: number; details?: unknown };
		log("session_compact", { reason: e.reason, willRetry: e.willRetry, fromExtension: e.fromExtension, id: c.id, firstKept: c.firstKeptEntryId, tokensBefore: c.tokensBefore, details: c.details }, ctx);
	});
	pi.on("session_compact_failed", (e, ctx) => log("session_compact_failed", { ...(e as unknown as Json) }, ctx));

	pi.on("agent_before_settle", (_e, ctx) => {
		log("agent_before_settle", { leaf: ctx.sessionManager.getLeafId() }, ctx);
		if (!modes.has("append-in-settle")) return undefined;
		pi.appendEntry("probe-close-marker", { at: Date.now() });
		log("probe_appended_marker", { leaf: ctx.sessionManager.getLeafId() }, ctx);
		return { entries: [{ type: "custom", customType: "probe-boundary-draft", data: { at: Date.now() } }] };
	});
	pi.on("agent_settled", (_e, ctx) => log("agent_settled", { leaf: ctx.sessionManager.getLeafId() }, ctx));

	if (modes.has("virtual")) {
		const targets = (process.env.PROBE_VIRTUAL_TARGETS ?? "").split(",").filter(Boolean);
		let calls = 0;
		pi.registerVirtualModel({
			provider: "probe",
			id: "auto",
			name: "Probe Auto",
			route(request, ctx) {
				const pick = targets[calls++ % targets.length] ?? "";
				const [provider, ...rest] = pick.split("/");
				const model = ctx.modelRegistry.find(provider, rest.join("/"));
				log("probe_route", { reason: request.reason, pick, window: model?.contextWindow ?? null });
				if (!model) throw new Error(`找不到路由目标：${pick}`);
				return { model, thinkingLevel: "off" };
			},
		});
	}
}
