import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawEntry } from "../edits.ts";
import * as rec from "../recovery.ts";
import { defaultConfig, parseConfig, restoreState, STATE_VERSION } from "../state.ts";

test("配置：文件缺失用缺省值，格式错误整体用缺省值，单项越界只替换该项并说明", () => {
	assert.deepEqual(parseConfig(undefined), { config: defaultConfig(), problems: [] });
	assert.equal(parseConfig("{坏").problems.length, 1);
	const r = parseConfig(JSON.stringify({ maxAutoCompactions: 0, handoffKeep: 5, byteBpeModels: ["a/b"], virtualWindowTokens: { "v/x": -1 } }));
	assert.equal(r.config.maxAutoCompactions, 6);
	assert.equal(r.config.handoffKeep, 5);
	assert.deepEqual(r.config.byteBpeModels, ["a/b"]);
	assert.deepEqual(r.config.virtualWindowTokens, {});
	assert.equal(r.problems.length, 2);
});

test("状态：版本不符返回 null；缺字段按不可用处理；越界值回到缺省", () => {
	assert.equal(restoreState({ version: STATE_VERSION + 1 }), null);
	assert.equal(restoreState("x"), null);
	const s = restoreState({ version: STATE_VERSION, models: { "a/b": { c: 9, budgetLevel: 5, dense: 1 } }, records: { "a/b": [{ baselineAdjusted: 10 }] }, r5: { reason: "nope" } })!;
	assert.deepEqual(s.models["a/b"], { c: 1, fEst: null, dense: 1, budgetLevel: 0 });
	assert.equal(s.records["a/b"][0].baselineUsable, false);
	assert.equal(s.r5, null);
	assert.deepEqual(restoreState({ version: STATE_VERSION, r5: { reason: "count", since: "t" } })!.r5, { reason: "count", since: "t" });
});

const msg = (id: string, role: string, content: string): RawEntry => ({ type: "message", id, message: { role, content, toolName: role === "toolResult" ? "bash" : undefined } });
const edit = (id: string, targetId: string, replacement: RawEntry["replacement"]): RawEntry => ({ type: "context_edit", id, targetId, replacement });

test("记录内容：取省略编辑之前同一目标的最后一次编辑，已被删除的不保存", () => {
	const b = [msg("a", "toolResult", "原文"), edit("x1", "a", { content: "替换后" }), edit("x2", "a", null), msg("c", "toolResult", "c 原文"), edit("y1", "c", null), edit("y2", "c", null)];
	assert.equal(rec.recordFor(b, 2)?.content, "替换后");
	assert.equal(rec.recordFor(b, 4)?.content, "c 原文");
	assert.equal(rec.recordFor(b, 5), null);
});

test("扫描状态机：只采集窗口内的 null 编辑，同一 editId 只采集一次，多次 agent_end 各自采集", () => {
	const s = rec.freshScanState();
	const b: RawEntry[] = [msg("a", "assistant", "x"), edit("before", "a", null)];
	rec.onAgentEnd(s, b); // 窗口从末尾打开，之前的编辑不算
	b.push(msg("t", "toolResult", "失败 1"), edit("e1", "t", null));
	rec.scanAndAdvance(s, b);
	rec.scanAndAdvance(s, b);
	assert.deepEqual(s.collected.map((r) => r.editId), ["e1"]);
	b.push(msg("t2", "toolResult", "失败 2"));
	rec.onAgentEnd(s, b);
	b.push(edit("e2", "t2", null));
	assert.deepEqual(rec.closeWindow(s, b), ["e2"]);
	assert.deepEqual(s.collected.map((r) => r.editId), ["e1", "e2"]);
	// 窗口关闭后出现的编辑（例如其他扩展的删除）不采集。
	b.push(msg("t3", "toolResult", "x"), edit("e3", "t3", null));
	rec.scan(s, b);
	assert.equal(s.collected.length, 2);
	const batch = rec.takeBatch(s, "n1")!;
	assert.equal(batch.records.length, 2);
	assert.equal(rec.consumeBatch(s, "nope"), null);
	assert.equal(rec.consumeBatch(s, "n1")?.nonce, "n1");
	assert.equal(rec.consumeBatch(s, "n1"), null);
});

test("重启重建：有关窗标记只接受确认的编辑，没有关窗标记的窗口不建立召回例外，已持久化的不重复", () => {
	const custom = (customType: string, data: unknown): RawEntry => ({ type: "custom", id: `${customType}-${JSON.stringify(data).length}`, customType, data });
	const b: RawEntry[] = [
		msg("a", "assistant", "失败回合"),
		custom(rec.WINDOW_TYPE, { windowId: "w1" }),
		edit("e1", "a", null),
		msg("t", "toolResult", "其他扩展删的"),
		edit("e9", "t", null),
		custom(rec.WINDOW_CLOSE_TYPE, { windowId: "w1", confirmedEditIds: ["e1"] }),
		msg("b", "assistant", "第二次失败"),
		custom(rec.WINDOW_TYPE, { windowId: "w2" }),
		edit("e2", "b", null),
	];
	const r = rec.rebuildFromMarkers(b);
	assert.deepEqual(r.records.map((x) => x.editId), ["e1"]);
	assert.equal(r.unconfirmedWindows, 1);
	b.push(custom(rec.RECOVERY_TYPE, { records: r.records }));
	assert.deepEqual(rec.rebuildFromMarkers(b).records, []);
});
