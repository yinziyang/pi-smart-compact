import assert from "node:assert/strict";
import { test } from "node:test";
import { applyBaseline, applyDensity, computeBudget, countAutoCompactions, estC, freshModelState, utf8Bytes, type BaselineSample } from "../budget.ts";

const base = { keepRecentTokens: 20000, level: 0, mode: "local" as const, fEst: 25000, overflowRetry: false };

test("estC：纯英文、纯中文、emoji 与校准系数", () => {
	assert.equal(estC("abcdefg"), 2);
	assert.equal(estC("中文测试"), 5);
	assert.equal(estC("😀"), 2);
	assert.equal(estC("abcdefg", 2), 4);
	assert.equal(utf8Bytes("中😀"), 7);
});

test("272k、1M、128k 三种触发点下的公式与方案 7.2 一致", () => {
	const b272 = computeBudget({ ...base, T: 239232 });
	assert.deepEqual([b272.N, b272.Pt, b272.Pb, b272.K, b272.sMax, b272.ok, b272.floored], [8192, 9000, 27000, 20000, 35392, true, false]);
	const b1m = computeBudget({ ...base, T: 967232 });
	assert.deepEqual([b1m.N, b1m.Pt, b1m.K], [8192, 9000, 20000]);
	// 128k：正常参数不满足不变量，降到下限后满足。
	const b128 = computeBudget({ ...base, T: 95232 });
	assert.deepEqual([b128.N, b128.Pt, b128.K, b128.floored, b128.ok], [4096, 2000, 4000, true, true]);
	assert.equal(computeBudget({ ...base, T: 95232, fEst: 0 }).floored, false);
});

test("下限参数仍不满足不变量时 ok 为假；模型输出模式的上界是 N + Pt", () => {
	assert.equal(computeBudget({ ...base, T: 40000 }).ok, false);
	const m = computeBudget({ ...base, T: 239232, mode: "model" });
	assert.equal(m.sMax, 8192 + 9000);
});

test("budgetLevel 逐级收紧，overflow 重试时再减半", () => {
	const l1 = computeBudget({ ...base, T: 239232, level: 1 });
	assert.deepEqual([l1.N, l1.Pt, l1.K], [8192, 4500, 10000]);
	const l2 = computeBudget({ ...base, T: 239232, level: 2 });
	assert.deepEqual([l2.N, l2.Pt, l2.K], [4096, 2000, 4000]);
	const ov = computeBudget({ ...base, T: 239232, overflowRetry: true });
	assert.deepEqual([ov.Pt, ov.K], [4500, 10000]);
});

const sample = (o: Partial<BaselineSample>): BaselineSample => ({ baselineUsable: true, baselineAdjusted: 50000, calibrationEligible: true, usageInputActual: 50000, bEst: 40000, estWithoutF: 20000, ...o });

test("校准系数限制在 1 到 3，F_est 按真实基线更新", () => {
	assert.equal(applyBaseline(freshModelState(), sample({ usageInputActual: 400000 }), 1e9).state.c, 3);
	assert.equal(applyBaseline(freshModelState(), sample({ usageInputActual: 1000 }), 1e9).state.c, 1);
	const s = applyBaseline(freshModelState(), sample({}), 1e9).state;
	assert.equal(s.c, 1.25);
	assert.equal(s.fEst, 30000);
	// 不可校准时 c 与 F_est 都不变。
	assert.deepEqual(applyBaseline(freshModelState(), sample({ calibrationEligible: false }), 1e9).state, freshModelState());
});

test("R1：基线超标逐级收紧，2 级再超标进入 R5；样本不可用时跳过", () => {
	const T = 100000;
	let st = freshModelState();
	st = applyBaseline(st, sample({ baselineAdjusted: 60000 }), T).state;
	assert.equal(st.budgetLevel, 1);
	st = applyBaseline(st, sample({ baselineAdjusted: 60000 }), T).state;
	assert.equal(st.budgetLevel, 2);
	assert.equal(applyBaseline(st, sample({ baselineAdjusted: 60000 }), T).r5, "baseline");
	assert.equal(applyBaseline(st, sample({ baselineUsable: false, baselineAdjusted: null }), T).r5, undefined);
});

test("R2：连续两次过密进入最小模式，最小模式下再过密进入 R5，不过密的样本清零", () => {
	const T = 100000;
	let st = freshModelState();
	st = applyDensity(st, 70000, 50000, T).state;
	assert.equal(st.dense, 1);
	assert.equal(applyDensity(st, 90000, 50000, T).state.dense, 0);
	st = applyDensity(st, 70000, 50000, T).state;
	assert.equal(st.budgetLevel, 2);
	assert.equal(applyDensity(st, 70000, 50000, T).r5, "baseline");
	assert.equal(applyDensity(st, 70000, null, T).r5, undefined);
});

test("R3：按最近 reset 之后本扩展的自动压缩计数，手动与其他来源不计", () => {
	const own = (reason: string) => ({ type: "compaction", details: { smartCompact: 1, reason } });
	const branch = [own("threshold"), own("overflow"), { type: "custom", customType: "smart-compact-reset" }, own("threshold"), own("manual"), { type: "compaction", details: { reason: "threshold" } }, own("overflow")];
	assert.equal(countAutoCompactions(branch), 2);
	assert.equal(countAutoCompactions(branch.slice(0, 2)), 2);
});
