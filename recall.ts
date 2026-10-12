// recall_history 的检索与截取（方案第 6 节）。纯函数，输入由 index.ts 从活动分支整理。

import type { RecoveryRecord } from "./pack.ts";
import type { RawEntry } from "./edits.ts";

/** 可检索的一条记录。text 已脱敏。 */
export interface RecallDoc {
	entryId: string;
	role: string;
	/** ISO 时间，可能为空。 */
	time: string;
	text: string;
}

export const HIT_CONTEXT = 600;
export const MAX_HITS = 5;
export const MAX_TOTAL = 10000;

/**
 * 逐条验证恢复省略记录（方案第 6 节）：记录的 editId 仍在当前活动分支上、是针对 targetId 且 replacement 为 null 的编辑、之后没有针对同一目标的其他编辑，三项都满足才保留。
 */
export function validRecoveryRecords(branch: readonly RawEntry[], records: readonly RecoveryRecord[]): RecoveryRecord[] {
	const pos = new Map<string, number>();
	branch.forEach((e, i) => pos.set(e.id, i));
	return records.filter((r) => {
		const i = pos.get(r.editId);
		if (i === undefined) return false;
		const edit = branch[i];
		if (edit.type !== "context_edit" || edit.targetId !== r.targetId || edit.replacement !== null) return false;
		for (let j = i + 1; j < branch.length; j++) if (branch[j].type === "context_edit" && branch[j].targetId === r.targetId) return false;
		return true;
	});
}

function cap(s: string, max: number): string {
	return s.length <= max ? s : `${s.slice(0, max)}\n…[已截断]`;
}

/** 按 entryId 取全文，最多 MAX_TOTAL 字符。找不到时返回 null。 */
export function recallById(docs: readonly RecallDoc[], entryId: string): string | null {
	const d = docs.find((x) => x.entryId === entryId);
	if (!d) return null;
	return cap(`[${d.entryId}] ${d.role} ${d.time}\n${d.text}`, MAX_TOTAL);
}

/**
 * 关键词检索：空格分隔的关键词全部命中（不区分大小写）的记录才算匹配，从新到旧最多取 MAX_HITS 处。
 * 每处返回第一个关键词命中点前后各 HIT_CONTEXT 字符，总返回不超过 MAX_TOTAL 字符。
 */
export function recallByQuery(docs: readonly RecallDoc[], query: string): string {
	const words = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (words.length === 0) return "query 为空。";
	const parts: string[] = [];
	for (let i = docs.length - 1; i >= 0 && parts.length < MAX_HITS; i--) {
		const d = docs[i];
		const lower = d.text.toLowerCase();
		if (!words.every((w) => lower.includes(w))) continue;
		const at = lower.indexOf(words[0]);
		const start = Math.max(0, at - HIT_CONTEXT);
		const end = Math.min(d.text.length, at + words[0].length + HIT_CONTEXT);
		parts.push(`[${d.entryId}] ${d.role} ${d.time}\n${start > 0 ? "…" : ""}${d.text.slice(start, end)}${end < d.text.length ? "…" : ""}`);
	}
	if (parts.length === 0) return "没有匹配的记录。";
	return cap(parts.join("\n\n---\n\n"), MAX_TOTAL);
}
