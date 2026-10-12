// 原始分支的自有简化类型，以及把 context_edit 应用到原始分支（方案 5.3）。
// pi 的条目是纯 JSON 数据，这里只声明本扩展用到的字段，index.ts 把 getBranch() 的结果按这个结构传入。

/** 消息内容块，只保留本扩展读取的字段。 */
export interface RawBlock {
	type: string;
	text?: string;
	thinking?: string;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

/** 消息，只保留本扩展读取的字段。 */
export interface RawMessage {
	role: string;
	content?: string | RawBlock[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	command?: string;
	output?: string;
	exitCode?: number;
	stopReason?: string;
	provider?: string;
	model?: string;
	usage?: unknown;
	customType?: string;
	summary?: string;
	timestamp?: number;
}

/** 分支条目，只保留本扩展读取的字段。 */
export interface RawEntry {
	type: string;
	id: string;
	parentId?: string | null;
	timestamp?: string;
	message?: RawMessage;
	targetId?: string;
	replacement?: { content: unknown } | null;
	customType?: string;
	data?: unknown;
	content?: string | RawBlock[];
	details?: unknown;
	summary?: string;
	firstKeptEntryId?: string;
	tokensBefore?: number;
	provider?: string;
	modelId?: string;
}

/**
 * 把分支上的 context_edit 应用到原始条目：同一目标以最后一次编辑为准，replacement 为 null 的目标整条剔除，有 replacement 的替换消息内容。
 * 返回值不含 context_edit 条目本身，也不修改输入。
 */
export function applyEdits(branch: readonly RawEntry[]): RawEntry[] {
	const last = new Map<string, RawEntry["replacement"]>();
	for (const e of branch) if (e.type === "context_edit" && e.targetId) last.set(e.targetId, e.replacement ?? null);
	const out: RawEntry[] = [];
	for (const e of branch) {
		if (e.type === "context_edit") continue;
		if (!last.has(e.id)) {
			out.push(e);
			continue;
		}
		const rep = last.get(e.id);
		if (rep === null || rep === undefined) continue;
		out.push(replaceContent(e, rep.content));
	}
	return out;
}

/** 返回内容被替换后的条目副本；message 条目替换 message.content，custom_message 条目替换 content。 */
export function replaceContent(e: RawEntry, content: unknown): RawEntry {
	if (e.message) return { ...e, message: { ...e.message, content: content as RawMessage["content"] } };
	return { ...e, content: content as RawEntry["content"] };
}

/** 消息的纯文本：字符串内容原样返回，数组内容拼接 text 块；thinking 与图片不计入。 */
export function messageText(m: RawMessage | undefined): string {
	if (!m) return "";
	if (m.role === "bashExecution") return `$ ${m.command ?? ""}\n${m.output ?? ""}`;
	if (m.role === "compactionSummary" || m.role === "branchSummary") return m.summary ?? "";
	return contentText(m.content);
}

/** 内容的纯文本。 */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b): b is RawBlock => !!b && typeof b === "object" && (b as RawBlock).type === "text" && typeof (b as RawBlock).text === "string")
		.map((b) => b.text)
		.join("\n");
}

/** assistant 消息里的工具调用。 */
export function toolCalls(m: RawMessage | undefined): { id: string; name: string; args: Record<string, unknown> }[] {
	if (!m || m.role !== "assistant" || !Array.isArray(m.content)) return [];
	return m.content
		.filter((b) => b && b.type === "toolCall" && typeof b.name === "string")
		.map((b) => ({ id: String(b.id ?? ""), name: b.name!, args: b.arguments && typeof b.arguments === "object" ? b.arguments : {} }));
}

/** 内容里是否含图片块。 */
export function hasImage(content: unknown): boolean {
	return Array.isArray(content) && content.some((b) => b && typeof b === "object" && (b as RawBlock).type === "image");
}

/**
 * 判断最新 compaction 是否已因历史被修改而失效（方案 5.2 第 4 步）。
 * 最新 compaction 之后出现目标位于其保留区之前的 context_edit 时失效，返回该 compaction 的 id 与最早的失效编辑 id；否则返回 null。
 * 只扫描最新 compaction 之后的条目。
 */
export function findInvalidation(branch: readonly RawEntry[]): { compactionId: string; editId: string } | null {
	let ci = -1;
	for (let i = branch.length - 1; i >= 0; i--) {
		if (branch[i].type === "compaction") {
			ci = i;
			break;
		}
	}
	if (ci < 0) return null;
	const comp = branch[ci];
	const keptIndex = branch.findIndex((e) => e.id === comp.firstKeptEntryId);
	// 保留区起点找不到时无法判断位置，按「所有 compaction 之前的条目」处理。
	const boundary = keptIndex >= 0 ? keptIndex : ci;
	const index = new Map<string, number>();
	for (let i = 0; i < ci; i++) index.set(branch[i].id, i);
	for (let i = ci + 1; i < branch.length; i++) {
		const e = branch[i];
		if (e.type !== "context_edit" || !e.targetId) continue;
		const t = index.get(e.targetId);
		if (t !== undefined && t < boundary) return { compactionId: comp.id, editId: e.id };
	}
	return null;
}
