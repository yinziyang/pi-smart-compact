// 预算账本：测试与评测期间全部真实 provider 调用的唯一记账处（方案第 13 节第 0 步）。
//
// 账本是只追加的 jsonl 文件，三种记录：
//   - limits：用户确认的硬上限，必须是第一条记录，之后不再改。
//   - reserve：启动一次调用前，按最坏情况预留的额度，带唯一 id。
//   - settle：调用结束后的实际用量，同一 id 只结算一次；actual 为 null 表示用量缺失。
// 不变量：
//   - 未结算、或结算用量缺失的预留，一律按预留的最坏值计入已花费，不释放。
//   - 任何一行无法解析或版本不认识，整本账视为损坏，调用方必须拒绝继续。
//   - 预留后的合计超过任一上限就拒绝预留。
// 本文件只含纯函数；读写文件由 ledger-file.ts 负责。

/** 账本记录的格式版本。 */
export const LEDGER_VERSION = 1;

/** 一次或一组调用的用量。token 与请求数为非负整数，费用单位为美元，时间单位为毫秒。 */
export interface Amounts {
	requests: number;
	inputTokens: number;
	outputTokens: number;
	/** provider 计费的全部 token：输入、输出、缓存读写之和。 */
	billedTokens: number;
	costUsd: number;
	wallMs: number;
}

/** 用户确认的硬上限。costUsd 为 null 表示价目未知、没有金额上限，只靠其余各项约束。 */
export interface Limits extends Omit<Amounts, "costUsd"> {
	costUsd: number | null;
}

export type LedgerRecord =
	| { v: typeof LEDGER_VERSION; type: "limits"; limits: Limits; approvedAt: string }
	| { v: typeof LEDGER_VERSION; type: "reserve"; id: string; step: string; worst: Amounts; at: string }
	| { v: typeof LEDGER_VERSION; type: "settle"; id: string; actual: Amounts | null; at: string };

/** 账本内容无法信任时抛出，调用方必须停止全部真实调用。 */
export class LedgerCorruptError extends Error {
	override name = "LedgerCorruptError";
}

/** 预留会超出上限时抛出。 */
export class BudgetExceededError extends Error {
	override name = "BudgetExceededError";
	readonly field: keyof Amounts;
	constructor(message: string, field: keyof Amounts) {
		super(message);
		this.field = field;
	}
}

const AMOUNT_FIELDS = ["requests", "inputTokens", "outputTokens", "billedTokens", "costUsd", "wallMs"] as const satisfies readonly (keyof Amounts)[];

export const ZERO: Amounts = { requests: 0, inputTokens: 0, outputTokens: 0, billedTokens: 0, costUsd: 0, wallMs: 0 };

function isNonNegativeNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

function isAmounts(v: unknown): v is Amounts {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return AMOUNT_FIELDS.every((f) => isNonNegativeNumber(o[f]));
}

function isLimits(v: unknown): v is Limits {
	if (!v || typeof v !== "object") return false;
	const o = v as Record<string, unknown>;
	return AMOUNT_FIELDS.every((f) => (f === "costUsd" ? o[f] === null || isNonNegativeNumber(o[f]) : isNonNegativeNumber(o[f])));
}

/** 解析单行记录，格式不对时抛 LedgerCorruptError。 */
export function parseRecord(line: string, lineNo: number): LedgerRecord {
	let raw: unknown;
	try {
		raw = JSON.parse(line);
	} catch {
		throw new LedgerCorruptError(`第 ${lineNo} 行不是合法 JSON`);
	}
	const o = raw as Record<string, unknown> | null;
	if (!o || typeof o !== "object" || o.v !== LEDGER_VERSION) throw new LedgerCorruptError(`第 ${lineNo} 行版本无法识别`);
	switch (o.type) {
		case "limits":
			if (isLimits(o.limits) && typeof o.approvedAt === "string") return o as LedgerRecord;
			break;
		case "reserve":
			if (typeof o.id === "string" && o.id && typeof o.step === "string" && isAmounts(o.worst) && typeof o.at === "string") return o as LedgerRecord;
			break;
		case "settle":
			if (typeof o.id === "string" && o.id && (o.actual === null || isAmounts(o.actual)) && typeof o.at === "string") return o as LedgerRecord;
			break;
	}
	throw new LedgerCorruptError(`第 ${lineNo} 行字段不完整或类型错误`);
}

/** 解析整本账，并校验记录之间的关系。 */
export function parseLedger(text: string): LedgerRecord[] {
	const records = text
		.split("\n")
		.map((line, i) => ({ line, i }))
		.filter(({ line }) => line.trim() !== "")
		.map(({ line, i }) => parseRecord(line, i + 1));
	if (records.length > 0 && records[0].type !== "limits") throw new LedgerCorruptError("第一条记录必须是 limits");
	if (records.filter((r) => r.type === "limits").length > 1) throw new LedgerCorruptError("limits 记录只能有一条");
	const reserved = new Set<string>();
	for (const r of records) {
		if (r.type === "reserve") {
			if (reserved.has(r.id)) throw new LedgerCorruptError(`预留 id 重复：${r.id}`);
			reserved.add(r.id);
		} else if (r.type === "settle" && !reserved.has(r.id)) {
			throw new LedgerCorruptError(`结算了不存在的预留：${r.id}`);
		}
	}
	return records;
}

export function limitsOf(records: LedgerRecord[]): Limits | undefined {
	const first = records[0];
	return first?.type === "limits" ? first.limits : undefined;
}

function add(a: Amounts, b: Amounts): Amounts {
	const out = { ...a };
	for (const f of AMOUNT_FIELDS) out[f] = a[f] + b[f];
	return out;
}

/**
 * 已花费的合计。
 * 每个预留取第一次结算的实际用量；没有结算、或结算用量为 null 的，按预留的最坏值计。
 */
export function spent(records: LedgerRecord[]): Amounts {
	const settled = new Map<string, Amounts | null>();
	for (const r of records) if (r.type === "settle" && !settled.has(r.id)) settled.set(r.id, r.actual);
	let total = ZERO;
	for (const r of records) {
		if (r.type !== "reserve") continue;
		total = add(total, settled.get(r.id) ?? r.worst);
	}
	return total;
}

/** 预留 worst 之后会超出的第一个字段；不会超出时返回 undefined。 */
export function firstExceeded(limits: Limits, current: Amounts, worst: Amounts): keyof Amounts | undefined {
	const after = add(current, worst);
	for (const f of AMOUNT_FIELDS) {
		const cap = limits[f];
		if (cap === null) continue;
		if (after[f] > cap) return f;
	}
	return undefined;
}

/** 生成预留记录；超出上限或账本没有 limits 时抛错。 */
export function makeReserve(records: LedgerRecord[], id: string, step: string, worst: Amounts, at: string): LedgerRecord {
	const limits = limitsOf(records);
	if (!limits) throw new LedgerCorruptError("账本缺少 limits 记录，用户尚未确认预算");
	if (!isAmounts(worst)) throw new TypeError("worst 必须是非负的用量");
	if (records.some((r) => r.type === "reserve" && r.id === id)) throw new LedgerCorruptError(`预留 id 重复：${id}`);
	const over = firstExceeded(limits, spent(records), worst);
	if (over) throw new BudgetExceededError(`预留「${step}」会超出上限：${over}`, over);
	return { v: LEDGER_VERSION, type: "reserve", id, step, worst, at };
}

/** 生成结算记录；已结算过的 id 返回 undefined，表示忽略重复结算。 */
export function makeSettle(records: LedgerRecord[], id: string, actual: Amounts | null, at: string): LedgerRecord | undefined {
	if (!records.some((r) => r.type === "reserve" && r.id === id)) throw new LedgerCorruptError(`结算了不存在的预留：${id}`);
	if (records.some((r) => r.type === "settle" && r.id === id)) return undefined;
	if (actual !== null && !isAmounts(actual)) throw new TypeError("actual 必须是非负的用量或 null");
	return { v: LEDGER_VERSION, type: "settle", id, actual, at };
}
