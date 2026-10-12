// 恢复省略记录（方案第 8 节「恢复省略记录」）：识别 pi 溢出恢复与自动重试追加的 replacement=null 编辑，保存被省略的执行记录，并在重启后按开窗、关窗标记重建。
//
// 状态机（每个会话一份）：
//   - agent_end：窗口已打开时先扫描到末尾；然后把 windowStart 设为当前末尾，打开窗口。
//   - session_before_compact：窗口打开时扫描到末尾，windowStart 推进到末尾，窗口保持打开。
//   - agent_start、agent_before_settle：窗口打开时先扫描，再关闭窗口。
//   - agent_settled：窗口打开时做最后一次扫描，然后把剩余记录写成恢复条目。
// 依据（方案 F47）：「agent_end 之后、下一次 agent_start 或 agent_before_settle 之前」的区间内出现的 replacement=null 编辑只来自 pi 的自动恢复，扩展无法在这个区间追加 context_edit。
// 本模块只做纯计算，追加条目由 index.ts 完成。

import type { RawEntry } from "./edits.ts";
import type { RecoveryRecord } from "./pack.ts";

export const RECOVERY_VERSION = 1;
export const WINDOW_TYPE = "smart-compact-window";
export const WINDOW_CLOSE_TYPE = "smart-compact-window-close";
export const RECOVERY_TYPE = "smart-compact-recovery";

/** 一批待写入的恢复记录。 */
export interface RecoveryBatch {
	nonce: string;
	records: RecoveryRecord[];
}

export interface ScanState {
	/** 窗口起点：分支条目序号；为 null 表示窗口关闭。 */
	windowStart: number | null;
	/** 已采集的 editId，用于去重。 */
	seen: Set<string>;
	/** 当前窗口内采集到的 editId，关窗时写进关窗标记。 */
	windowEdits: string[];
	/** 已采集、尚未分批的记录。 */
	collected: RecoveryRecord[];
	/** 已分批、等待消费的记录。 */
	batches: RecoveryBatch[];
}

export function freshScanState(): ScanState {
	return { windowStart: null, seen: new Set(), windowEdits: [], collected: [], batches: [] };
}

/**
 * 为一条省略编辑构造记录：取该编辑之前针对同一目标的最后一条 context_edit。
 * 没有时保存原始内容；最后一条是替换时只保存替换后的内容；最后一条是 null 时说明目标早已被删除，返回 null。
 */
export function recordFor(branch: readonly RawEntry[], editIndex: number): RecoveryRecord | null {
	const edit = branch[editIndex];
	if (edit.type !== "context_edit" || edit.replacement !== null || !edit.targetId) return null;
	const target = branch.find((e) => e.id === edit.targetId);
	if (!target) return null;
	let content: unknown = target.message ? target.message.content : target.content;
	for (let i = editIndex - 1; i >= 0; i--) {
		const e = branch[i];
		if (e.type !== "context_edit" || e.targetId !== edit.targetId) continue;
		if (e.replacement === null || e.replacement === undefined) return null;
		content = e.replacement.content;
		break;
	}
	return { editId: edit.id, targetId: edit.targetId, role: target.message?.role ?? target.type, toolName: target.message?.toolName, content };
}

/** 扫描 windowStart 之后的条目，采集新的 replacement=null 编辑；窗口关闭时什么都不做。 */
export function scan(state: ScanState, branch: readonly RawEntry[]): void {
	if (state.windowStart === null) return;
	for (let i = state.windowStart; i < branch.length; i++) {
		const e = branch[i];
		if (e.type !== "context_edit" || e.replacement !== null || state.seen.has(e.id)) continue;
		state.seen.add(e.id);
		state.windowEdits.push(e.id);
		const r = recordFor(branch, i);
		if (r) state.collected.push(r);
	}
}

/** agent_end：窗口已打开时先扫描，然后从当前末尾重新打开窗口。 */
export function onAgentEnd(state: ScanState, branch: readonly RawEntry[]): void {
	scan(state, branch);
	state.windowStart = branch.length;
	state.windowEdits = [];
}

/** agent_start 与 agent_before_settle：窗口打开时先扫描，再关闭。返回本窗口确认的 editId。 */
export function closeWindow(state: ScanState, branch: readonly RawEntry[]): string[] {
	if (state.windowStart === null) return [];
	scan(state, branch);
	state.windowStart = null;
	const ids = state.windowEdits;
	state.windowEdits = [];
	return ids;
}

/** session_before_compact：窗口打开时扫描并推进起点，窗口保持打开。 */
export function scanAndAdvance(state: ScanState, branch: readonly RawEntry[]): void {
	if (state.windowStart === null) return;
	scan(state, branch);
	state.windowStart = branch.length;
}

/** 把已采集的记录收成一批；没有记录时返回 null。 */
export function takeBatch(state: ScanState, nonce: string): RecoveryBatch | null {
	if (state.collected.length === 0) return null;
	const batch = { nonce, records: state.collected };
	state.collected = [];
	state.batches.push(batch);
	return batch;
}

/** 移除并返回指定 nonce 的批次；不存在时返回 null（写入之前核对 nonce，防止重复写）。 */
export function consumeBatch(state: ScanState, nonce: string): RecoveryBatch | null {
	const i = state.batches.findIndex((b) => b.nonce === nonce);
	if (i < 0) return null;
	return state.batches.splice(i, 1)[0];
}

/** 已经持久化到 compaction details 或恢复条目中的 editId。 */
export function persistedEditIds(branch: readonly RawEntry[]): Set<string> {
	const ids = new Set<string>();
	for (const e of branch) {
		const records = persistedRecords(e);
		for (const r of records) ids.add(r.editId);
	}
	return ids;
}

/** 条目中持久化的恢复记录：compaction 的 details.omittedAttempt 或 smart-compact-recovery 条目。 */
export function persistedRecords(e: RawEntry): RecoveryRecord[] {
	let holder: unknown;
	if (e.type === "compaction" && e.details && typeof e.details === "object") holder = (e.details as { omittedAttempt?: unknown }).omittedAttempt;
	else if (e.type === "custom" && e.customType === RECOVERY_TYPE) holder = e.data;
	const records = (holder as { records?: unknown } | undefined)?.records;
	if (!Array.isArray(records)) return [];
	return records.filter((r): r is RecoveryRecord => !!r && typeof r === "object" && typeof (r as RecoveryRecord).editId === "string" && typeof (r as RecoveryRecord).targetId === "string");
}

export interface RebuildResult {
	/** 需要写成恢复条目的记录。 */
	records: RecoveryRecord[];
	/** 没有关窗标记、因而不建立召回例外的窗口数。 */
	unconfirmedWindows: number;
}

/**
 * 重启后按开窗、关窗标记重建（方案第 8 节「进程中途退出的处理」）：
 *   - 有关窗标记的窗口只接受其 confirmedEditIds 中的编辑。
 *   - 没有关窗标记的窗口不建立召回例外。
 *   - 去掉已经持久化的 editId。
 */
export function rebuildFromMarkers(branch: readonly RawEntry[]): RebuildResult {
	const closes = new Map<string, string[]>();
	const opens: string[] = [];
	for (const e of branch) {
		if (e.type !== "custom") continue;
		const d = e.data as { windowId?: unknown; confirmedEditIds?: unknown } | undefined;
		if (typeof d?.windowId !== "string") continue;
		if (e.customType === WINDOW_TYPE) opens.push(d.windowId);
		else if (e.customType === WINDOW_CLOSE_TYPE) closes.set(d.windowId, Array.isArray(d.confirmedEditIds) ? d.confirmedEditIds.filter((x): x is string => typeof x === "string") : []);
	}
	const done = persistedEditIds(branch);
	const index = new Map<string, number>();
	branch.forEach((e, i) => index.set(e.id, i));
	const records: RecoveryRecord[] = [];
	let unconfirmedWindows = 0;
	for (const w of opens) {
		const confirmed = closes.get(w);
		if (!confirmed) {
			unconfirmedWindows++;
			continue;
		}
		for (const id of confirmed) {
			if (done.has(id)) continue;
			const i = index.get(id);
			if (i === undefined) continue;
			const r = recordFor(branch, i);
			if (r) {
				records.push(r);
				done.add(id);
			}
		}
	}
	return { records, unconfirmedWindows };
}
