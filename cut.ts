// 在有效投影上选择切点（方案 5.2 第 2 步）。

/** 投影条目的简化形式，由 index.ts 从 buildSessionProjection().entries 转换而来，已去掉 compaction 条目与 system 消息。 */
export interface CutEntry {
	id: string;
	/** 该条目投影出的消息角色，按顺序。 */
	roles: string[];
	/** 该条目消息的保守估算 token。 */
	est: number;
}

/** 可以作为切点的消息角色；toolResult 不能作为切点（方案 F13）。 */
const CUT_ROLES = new Set(["user", "assistant", "bashExecution", "custom", "branchSummary", "compactionSummary"]);

function isCut(e: CutEntry): boolean {
	return e.roles.some((r) => CUT_ROLES.has(r));
}

export interface CutResult {
	/** 在输入序列中的下标，之前的条目全部进入摘要。 */
	index: number;
	firstKeptEntryId: string;
	/** 保留区（下标及之后）的估算 token。 */
	keptEst: number;
	/** 是否改用了 pi preparation 的切点。 */
	usedPreparation: boolean;
}

/**
 * 从末尾往前累加估算 token，达到 K 时取该位置及之后最近的有效切点；之后没有有效切点时取最后一个有效切点，保留最少的原文。
 * 切点之前没有任何条目时，改用 pi preparation 的 firstKeptEntryId；它也不在序列中或位于开头时返回 null，调用方按失败处理。
 */
export function chooseCut(entries: readonly CutEntry[], K: number, preparationFirstKept: string): CutResult | null {
	let index = -1;
	let acc = 0;
	for (let i = entries.length - 1; i >= 0; i--) {
		acc += entries[i].est;
		if (acc < K) continue;
		for (let j = i; j < entries.length; j++) {
			if (isCut(entries[j])) {
				index = j;
				break;
			}
		}
		if (index < 0) {
			for (let j = entries.length - 1; j >= 0; j--) {
				if (isCut(entries[j])) {
					index = j;
					break;
				}
			}
		}
		break;
	}
	let usedPreparation = false;
	if (index <= 0) {
		index = entries.findIndex((e) => e.id === preparationFirstKept);
		usedPreparation = true;
		if (index <= 0) return null;
	}
	let keptEst = 0;
	for (let i = index; i < entries.length; i++) keptEst += entries[i].est;
	return { index, firstKeptEntryId: entries[index].id, keptEst, usedPreparation };
}
