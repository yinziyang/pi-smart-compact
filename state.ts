// 配置文件与持久化状态的读取、校验与序列化（方案 7.4、第 14 节）。
// 两者都是外部输入：缺字段、类型不符或越界时按方案的缺省规则处理，不抛异常。

import { freshModelState, type ModelState } from "./budget.ts";

export const STATE_TYPE = "smart-compact";
export const STATE_VERSION = 1;

/** R5 的原因（方案 7.4 R5 一览）。 */
export type R5Reason = "baseline" | "failed" | "history" | "count" | "virtual";
const R5_REASONS: readonly R5Reason[] = ["baseline", "failed", "history", "count", "virtual"];

export interface R5State {
	reason: R5Reason;
	since: string;
}

/** 每次压缩一条记录（方案 7.4）。 */
export interface CompactionRecord {
	time: string;
	reason: string;
	tokensBefore: number | null;
	bEst: number | null;
	usageInputActual: number | null;
	addedEstimate: number | null;
	baselineAdjusted: number | null;
	baselineUsable: boolean;
	calibrationEligible: boolean;
}

export interface PersistedState {
	version: number;
	/** 键为物理模型的 provider/id。 */
	models: Record<string, ModelState>;
	/** 每个模型最近的压缩记录，只保留最近 MAX_RECORDS 条。 */
	records: Record<string, CompactionRecord[]>;
	r5: R5State | null;
}

export const MAX_RECORDS = 20;

export function freshState(): PersistedState {
	return { version: STATE_VERSION, models: {}, records: {}, r5: null };
}

function nonNegInt(v: unknown): number | null {
	return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

function readModel(v: unknown): ModelState {
	const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
	const s = freshModelState();
	if (typeof o.c === "number" && o.c >= 1 && o.c <= 3) s.c = o.c;
	s.fEst = nonNegInt(o.fEst);
	s.dense = nonNegInt(o.dense) ?? 0;
	const level = nonNegInt(o.budgetLevel);
	s.budgetLevel = level !== null && level <= 2 ? level : 0;
	return s;
}

function readRecord(v: unknown): CompactionRecord | null {
	if (!v || typeof v !== "object") return null;
	const o = v as Record<string, unknown>;
	return {
		time: typeof o.time === "string" ? o.time : "",
		reason: typeof o.reason === "string" ? o.reason : "",
		tokensBefore: nonNegInt(o.tokensBefore),
		bEst: nonNegInt(o.bEst),
		usageInputActual: nonNegInt(o.usageInputActual),
		addedEstimate: nonNegInt(o.addedEstimate),
		baselineAdjusted: nonNegInt(o.baselineAdjusted),
		// 缺少 baselineUsable 视为 false，缺少的数值字段按「不可用」处理（方案 7.4）。
		baselineUsable: o.baselineUsable === true && nonNegInt(o.baselineAdjusted) !== null,
		calibrationEligible: o.calibrationEligible === true,
	};
}

/**
 * 从一条 custom 条目的 data 恢复状态。
 * 版本更高或无法识别时返回 null，调用方按新会话初始化并提示一次。
 */
export function restoreState(data: unknown): PersistedState | null {
	if (!data || typeof data !== "object") return null;
	const o = data as Record<string, unknown>;
	if (o.version !== STATE_VERSION) return null;
	const out = freshState();
	if (o.models && typeof o.models === "object") for (const [k, v] of Object.entries(o.models)) out.models[k] = readModel(v);
	if (o.records && typeof o.records === "object") {
		for (const [k, v] of Object.entries(o.records)) {
			if (Array.isArray(v)) out.records[k] = v.map(readRecord).filter((r): r is CompactionRecord => r !== null).slice(-MAX_RECORDS);
		}
	}
	const r5 = o.r5 as { reason?: unknown; since?: unknown } | null | undefined;
	if (r5 && R5_REASONS.includes(r5.reason as R5Reason)) out.r5 = { reason: r5.reason as R5Reason, since: typeof r5.since === "string" ? r5.since : "" };
	return out;
}

/** 配置项（方案第 14 节）。 */
export interface Config {
	maxAutoCompactions: number;
	handoffKeep: number;
	virtualWindowTokens: Record<string, number>;
	byteBpeProviders: string[];
	byteBpeModels: string[];
}

export function defaultConfig(): Config {
	return { maxAutoCompactions: 6, handoffKeep: 20, virtualWindowTokens: {}, byteBpeProviders: ["openai", "openai-codex"], byteBpeModels: [] };
}

/**
 * 解析配置文件文本。文本为 undefined（文件缺失）时用缺省值。
 * 整体格式错误时全部用缺省值；单项越界或类型不符时该项用缺省值。两种情况都在 problems 中说明，由调用方提示一次。
 */
export function parseConfig(text: string | undefined): { config: Config; problems: string[] } {
	const config = defaultConfig();
	if (text === undefined) return { config, problems: [] };
	let o: Record<string, unknown>;
	try {
		const v = JSON.parse(text) as unknown;
		if (!v || typeof v !== "object" || Array.isArray(v)) return { config, problems: ["配置文件不是 JSON 对象，已使用缺省值"] };
		o = v as Record<string, unknown>;
	} catch {
		return { config, problems: ["配置文件无法解析，已使用缺省值"] };
	}
	const problems: string[] = [];
	const intIn = (k: "maxAutoCompactions" | "handoffKeep", lo: number, hi: number) => {
		if (o[k] === undefined) return;
		const v = o[k];
		if (typeof v === "number" && Number.isInteger(v) && v >= lo && v <= hi) config[k] = v;
		else problems.push(`${k} 应为 ${lo} 到 ${hi} 的整数，已使用缺省值`);
	};
	intIn("maxAutoCompactions", 1, 50);
	intIn("handoffKeep", 1, 200);
	if (o.virtualWindowTokens !== undefined) {
		const v = o.virtualWindowTokens;
		if (v && typeof v === "object" && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "number" && Number.isInteger(x) && x > 0)) config.virtualWindowTokens = v as Record<string, number>;
		else problems.push("virtualWindowTokens 应为「provider/id → 正整数」的对象，已使用缺省值");
	}
	for (const k of ["byteBpeProviders", "byteBpeModels"] as const) {
		if (o[k] === undefined) continue;
		const v = o[k];
		if (Array.isArray(v) && v.every((x) => typeof x === "string")) config[k] = v as string[];
		else problems.push(`${k} 应为字符串数组，已使用缺省值`);
	}
	return { config, problems };
}
