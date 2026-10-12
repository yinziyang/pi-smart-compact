import assert from "node:assert/strict";
import { test } from "node:test";
import { chooseCut, type CutEntry } from "../cut.ts";
import { applyEdits, findInvalidation, messageText, type RawEntry } from "../edits.ts";

const e = (id: string, role: string, est = 100): CutEntry => ({ id, roles: [role], est });

test("切点不落在 toolResult 上，取累计达到 K 处及之后最近的有效切点", () => {
	const es = [e("a", "user"), e("b", "assistant"), e("c", "toolResult", 500), e("d", "toolResult", 500), e("f", "assistant"), e("g", "user")];
	const r = chooseCut(es, 900, "b")!;
	assert.equal(r.firstKeptEntryId, "f");
	assert.equal(r.keptEst, 200);
	assert.equal(r.usedPreparation, false);
});

test("之后没有有效切点时取最后一个有效切点", () => {
	const es = [e("a", "user"), e("b", "assistant"), e("c", "toolResult", 5000), e("d", "toolResult", 5000)];
	assert.equal(chooseCut(es, 4000, "a")!.firstKeptEntryId, "b");
});

test("切点前没有消息时改用 preparation 的切点，它也无效时返回 null", () => {
	const es = [e("a", "user", 5000), e("b", "assistant"), e("c", "user")];
	const r = chooseCut(es, 4000, "c")!;
	assert.equal(r.firstKeptEntryId, "c");
	assert.equal(r.usedPreparation, true);
	assert.equal(chooseCut(es, 4000, "a"), null);
	assert.equal(chooseCut(es, 4000, "zz"), null);
});

test("连续自定切点：新切点在旧保留区之前或之后都按投影条目计算", () => {
	// 投影已去掉 compaction 条目，旧保留区就是序列开头的一段。
	const es = [e("k1", "user"), e("k2", "assistant"), e("n1", "user", 3000), e("n2", "assistant", 3000)];
	assert.equal(chooseCut(es, 3000, "n1")!.firstKeptEntryId, "n2");
	assert.equal(chooseCut(es, 6100, "n1")!.firstKeptEntryId, "k2");
});

const msg = (id: string, role: string, content: string, extra: Partial<RawEntry> = {}): RawEntry => ({ type: "message", id, message: { role, content }, ...extra });
const edit = (id: string, targetId: string, replacement: RawEntry["replacement"]): RawEntry => ({ type: "context_edit", id, targetId, replacement });

test("applyEdits：null 剔除、替换生效、同一目标以最后一次为准，不修改输入", () => {
	const branch = [msg("a", "user", "原文 A"), msg("b", "user", "原文 B"), msg("c", "user", "原文 C"), edit("x1", "a", null), edit("x2", "b", { content: "替换 B" }), edit("x3", "c", null), edit("x4", "c", { content: "最终 C" })];
	const out = applyEdits(branch);
	assert.deepEqual(out.map((x) => [x.id, messageText(x.message)]), [["b", "替换 B"], ["c", "最终 C"]]);
	assert.equal(messageText(branch[1].message), "原文 B");
});

test("findInvalidation：编辑目标位于最新 compaction 保留区之前时失效，编辑保留区内或之后的条目不失效", () => {
	const comp: RawEntry = { type: "compaction", id: "C", firstKeptEntryId: "k" };
	const base = [msg("old", "user", "x"), msg("k", "user", "y"), comp, msg("new", "user", "z")];
	assert.equal(findInvalidation(base), null);
	assert.equal(findInvalidation([...base, edit("e1", "k", null)]), null);
	assert.equal(findInvalidation([...base, edit("e2", "new", null)]), null);
	assert.deepEqual(findInvalidation([...base, edit("e3", "old", { content: "改" })]), { compactionId: "C", editId: "e3" });
	// 编辑在 compaction 之前出现的不算。
	assert.equal(findInvalidation([msg("old", "user", "x"), edit("e0", "old", null), msg("k", "user", "y"), comp]), null);
});
