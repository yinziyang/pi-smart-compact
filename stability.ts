import { isDeepStrictEqual } from "node:util";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ModelChoice } from "./compact.ts";
import type { RawEntry } from "./edits.ts";
import { checkedProjection } from "./host-contract.ts";
import { RECOVERY_TYPE, WINDOW_CLOSE_TYPE, WINDOW_TYPE } from "./recovery.ts";
import { STATE_TYPE } from "./state.ts";

/** 压缩输入快照用于识别摘要生成期间的实质变化，不把宿主提交能力误当成原子比较交换。 */
export interface InputSnapshot {
	sessionId: string;
	sessionFile: string | undefined;
	manager: object;
	leafId: string | null;
	entries: RawEntry[];
	projection: { id: string; messages: AgentMessage[] }[];
	model: unknown;
	systemPrompt: string;
	tools: unknown;
	budget: unknown;
}

/** 保存独立的实际消费输入，异步生成期间宿主原地修改对象也不能污染旧快照。 */
export function captureSnapshot(ctx: ExtensionContext, branch: RawEntry[], choice: ModelChoice, budget: unknown, tools: readonly { name: string; description?: string; promptGuidelines?: string[]; parameters?: unknown }[]): InputSnapshot {
	return {
		sessionId: ctx.sessionManager.getSessionId(),
		sessionFile: ctx.sessionManager.getSessionFile(),
		manager: ctx.sessionManager,
		leafId: ctx.sessionManager.getLeafId(),
		entries: structuredClone(relevantEntries(branch)),
		projection: structuredClone(checkedProjection(ctx, branch)),
		model: structuredClone({ current: ctx.model, choice }),
		systemPrompt: ctx.getSystemPrompt(),
		tools: structuredClone(tools.map((tool) => ({ name: tool.name, description: tool.description, promptGuidelines: tool.promptGuidelines, parameters: tool.parameters }))),
		budget: structuredClone(budget),
	};
}

/** 只剔除执行器不读取的普通元数据，保留已摘要原文和恢复协议条目。 */
export function relevantEntries(branch: readonly RawEntry[]): RawEntry[] {
	const consumed = new Set([STATE_TYPE, RECOVERY_TYPE, WINDOW_TYPE, WINDOW_CLOSE_TYPE, "smart-compact-reset", "smart-compact-invalidated"]);
	return branch.filter((entry) => entry.message !== undefined || entry.type !== "custom" || consumed.has(entry.customType ?? ""));
}

/** 规划身份变化不能沿用旧预算，包括会话、模型配置和活动工具的变化。 */
export function samePlanningIdentity(a: InputSnapshot, b: InputSnapshot): boolean {
	return a.sessionId === b.sessionId && a.sessionFile === b.sessionFile && a.manager === b.manager && isDeepStrictEqual(a.model, b.model) && a.systemPrompt === b.systemPrompt && isDeepStrictEqual(a.tools, b.tools) && isDeepStrictEqual(a.budget, b.budget);
}

/** 投影相同也必须比较原始历史，避免已摘要前缀被编辑后错误沿用旧叙述。 */
export function sameInput(a: InputSnapshot, b: InputSnapshot): boolean {
	return samePlanningIdentity(a, b) && isDeepStrictEqual(a.entries, b.entries) && isDeepStrictEqual(a.projection, b.projection);
}

/** 验证旧叶子仍位于当前分支上，允许并发追加无关元数据但拒绝切换分支。 */
export function leafIsAncestor(branch: readonly RawEntry[], leafId: string | null): boolean {
	return leafId === null || branch.some((entry) => entry.id === leafId);
}
