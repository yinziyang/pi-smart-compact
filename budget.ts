// token 计量、预算公式、基线不变量与防循环规则（方案 7.1 ~ 7.4）。
// 全部是纯函数，状态由调用方持有并持久化。

/** 叙述摘要、压缩包、保留区三项的下限（方案 7.3）。 */
export const FLOOR = { N: 4096, Pt: 2000, K: 4000 } as const;

/** 压缩包包装文本的固定上限，单位 token（方案 7.2）。 */
export const PACK_WRAPPER_TOKENS = 200;

/** 不变量要求压缩后的基线不超过触发点的这个比例（方案 7.3）。 */
export const BASELINE_RATIO = 0.55;

/** 两次压缩之间的增长低于触发点的这个比例记一次过密（方案 7.4 R2）。 */
export const DENSE_RATIO = 0.3;

/** 压缩包的两种生成方式（方案 5.1）。 */
export type PackMode = "local" | "model";

/** 保守估算：ASCII 按 3.5 字符一个 token，其余每个字符按 1.2 个 token，再乘校准系数 c（方案 7.1）。 */
export function estC(s: string, c = 1): number {
	let ascii = 0;
	let other = 0;
	for (const ch of s) {
		if (ch.codePointAt(0)! < 0x80) ascii++;
		else other++;
	}
	return Math.ceil(Math.ceil(ascii / 3.5 + other * 1.2) * c);
}

/** UTF-8 字节数，本地模式下作为 byte-level BPE 的 token 上界（方案 F36）。 */
export function utf8Bytes(s: string): number {
	return Buffer.byteLength(s, "utf8");
}

function clamp(x: number, lo: number, hi: number): number {
	// 上限小于下限时（例如用户把 keepRecentTokens 设得很小）以上限为准，不扩大保留区。
	if (hi < lo) return hi;
	return Math.min(hi, Math.max(lo, x));
}

export interface BudgetInput {
	/** 触发点 T = W − reserveTokens。 */
	T: number;
	/** pi 合并 modelOverrides 后对该模型生效的 keepRecentTokens。 */
	keepRecentTokens: number;
	/** 0、1、2，见 R1。 */
	level: number;
	mode: PackMode;
	/** 固定开销的估算值。 */
	fEst: number;
	/** overflow 且 willRetry 时 Pt 与 K 再减半（方案第 8 节）。 */
	overflowRetry: boolean;
}

export interface Budget {
	/** 叙述摘要的真实 token 上限。 */
	N: number;
	/** 压缩包目标，estC。 */
	Pt: number;
	/** 本地模式压缩包的 UTF-8 字节硬上限。 */
	Pb: number;
	/** 保留原文，estC。 */
	K: number;
	/** 最终摘要的真实 token 上界。 */
	sMax: number;
	/** 是否因不变量不满足而降到了下限参数。 */
	floored: boolean;
	/** 下限参数也不满足不变量时为 false，调用方应进入 R5。 */
	ok: boolean;
}

/** 最终摘要的上界：本地模式 N + Pb + 200，模型输出模式 N + Pt（方案 7.3）。 */
export function summaryMax(mode: PackMode, N: number, Pt: number): number {
	return mode === "local" ? N + 3 * Pt + PACK_WRAPPER_TOKENS : N + Pt;
}

function invariantHolds(fEst: number, mode: PackMode, N: number, Pt: number, K: number, T: number): boolean {
	return fEst + summaryMax(mode, N, Pt) + K <= BASELINE_RATIO * T;
}

/** 按方案 7.2 的公式与 R1 的预算级别计算本次压缩的预算，并检查 7.3 的不变量。 */
export function computeBudget(input: BudgetInput): Budget {
	const { T, keepRecentTokens, level, mode, fEst, overflowRetry } = input;
	let N = clamp(Math.round(0.045 * T), FLOOR.N, 8192);
	let Pt = clamp(Math.round(0.05 * T), FLOOR.Pt, 9000);
	let K = clamp(Math.round(0.12 * T), FLOOR.K, keepRecentTokens);
	if (level >= 2) {
		N = FLOOR.N;
		Pt = FLOOR.Pt;
		K = Math.min(FLOOR.K, K);
	} else if (level === 1) {
		Pt = Math.max(FLOOR.Pt, Math.round(Pt / 2));
		K = Math.max(Math.min(FLOOR.K, K), Math.round(K / 2));
	}
	if (overflowRetry) {
		Pt = Math.max(FLOOR.Pt, Math.round(Pt / 2));
		K = Math.max(Math.min(FLOOR.K, K), Math.round(K / 2));
	}
	let floored = false;
	if (!invariantHolds(fEst, mode, N, Pt, K, T)) {
		floored = true;
		N = FLOOR.N;
		Pt = FLOOR.Pt;
		K = Math.min(FLOOR.K, K);
	}
	const ok = invariantHolds(fEst, mode, N, Pt, K, T);
	return { N, Pt, Pb: 3 * Pt, K, sMax: summaryMax(mode, N, Pt), floored, ok };
}

/** 按物理模型分开保存的状态（方案 7.4）。 */
export interface ModelState {
	c: number;
	fEst: number | null;
	dense: number;
	budgetLevel: number;
}

export function freshModelState(): ModelState {
	return { c: 1, fEst: null, dense: 0, budgetLevel: 0 };
}

/** 压缩后首条有效响应的基线样本（方案 7.1）。 */
export interface BaselineSample {
	baselineUsable: boolean;
	baselineAdjusted: number | null;
	calibrationEligible: boolean;
	usageInputActual: number | null;
	/** 本次压缩的预估基线 B_est。 */
	bEst: number;
	/** estC(叙述 + 压缩包 + 保留区)，用于更新 F_est。 */
	estWithoutF: number;
}

export interface RuleOutcome {
	state: ModelState;
	/** 非空时调用方应进入 R5，值为原因。 */
	r5?: "baseline";
}

/** R1 与校准：用压缩后的基线样本更新模型状态（方案 7.1、7.4）。 */
export function applyBaseline(prev: ModelState, sample: BaselineSample, T: number): RuleOutcome {
	const state = { ...prev };
	if (sample.calibrationEligible && sample.usageInputActual !== null && sample.bEst > 0) {
		state.c = Math.min(3, Math.max(1, (sample.usageInputActual / sample.bEst) * state.c));
		state.fEst = Math.max(0, Math.round(sample.usageInputActual - sample.estWithoutF));
	}
	if (!sample.baselineUsable || sample.baselineAdjusted === null) return { state };
	if (sample.baselineAdjusted > BASELINE_RATIO * T) {
		if (state.budgetLevel >= 2) return { state, r5: "baseline" };
		state.budgetLevel++;
	}
	return { state };
}

/**
 * R2：本次压缩开始时，按上次压缩后的基线判断是否过密。
 * prevBaseline 为上次压缩的 baselineAdjusted，上次样本不可用时传 null，此时不做判定。
 */
export function applyDensity(prev: ModelState, tokensBefore: number, prevBaseline: number | null, T: number): RuleOutcome {
	const state = { ...prev };
	if (prevBaseline === null) return { state };
	if (tokensBefore - prevBaseline >= DENSE_RATIO * T) {
		state.dense = 0;
		return { state };
	}
	if (state.budgetLevel >= 2) return { state, r5: "baseline" };
	state.dense++;
	if (state.dense >= 2) state.budgetLevel = 2;
	return { state };
}

/** R3 计数只需要的条目字段。 */
export interface CountableEntry {
	type: string;
	customType?: string;
	details?: unknown;
}

/** 本扩展写入 compaction details 的版本标记键。 */
export const DETAILS_MARK = "smartCompact";

/** compaction details 中是否带有本扩展的版本标记。 */
export function isOwnCompaction(e: CountableEntry): boolean {
	if (e.type !== "compaction" || !e.details || typeof e.details !== "object") return false;
	return (e.details as Record<string, unknown>)[DETAILS_MARK] === 1;
}

/**
 * R3：从活动分支重建自动压缩次数。
 * 统计最近一条 smart-compact-reset 之后、带本扩展标记且 reason 为 threshold 或 overflow 的 compaction 条目数。
 */
export function countAutoCompactions(branch: readonly CountableEntry[]): number {
	let n = 0;
	for (const e of branch) {
		if (e.type === "custom" && e.customType === "smart-compact-reset") n = 0;
		else if (isOwnCompaction(e)) {
			const reason = (e.details as { reason?: unknown }).reason;
			if (reason === "threshold" || reason === "overflow") n++;
		}
	}
	return n;
}
