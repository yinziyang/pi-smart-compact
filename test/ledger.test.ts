import assert from "node:assert/strict";
import { test } from "node:test";
import {
	type Amounts,
	BudgetExceededError,
	LEDGER_VERSION,
	LedgerCorruptError,
	type LedgerRecord,
	type Limits,
	makeReserve,
	makeSettle,
	parseLedger,
	spent,
	ZERO,
} from "../eval/ledger.ts";

const AT = "2026-10-10T00:00:00.000Z";
const limits: Limits = { requests: 10, inputTokens: 1000, outputTokens: 100, billedTokens: 1100, costUsd: 5, wallMs: 60_000 };
const one: Amounts = { requests: 2, inputTokens: 200, outputTokens: 20, billedTokens: 220, costUsd: 1, wallMs: 10_000 };
const base: LedgerRecord[] = [{ v: LEDGER_VERSION, type: "limits", limits, approvedAt: AT }];

test("未结算的预留按最坏值计入已花费", () => {
	const r = makeReserve(base, "a", "S5", one, AT);
	assert.deepEqual(spent([...base, r]), one);
});

test("结算后按实际用量计，重复结算只计第一次", () => {
	const r = makeReserve(base, "a", "S5", one, AT);
	const actual = { ...one, requests: 1, costUsd: 0.2 };
	const s1 = makeSettle([...base, r], "a", actual, AT);
	assert.ok(s1);
	assert.equal(makeSettle([...base, r, s1], "a", ZERO, AT), undefined);
	assert.deepEqual(spent([...base, r, s1]), actual);
});

test("用量缺失（null）时不释放预留，仍按最坏值计", () => {
	const r = makeReserve(base, "a", "S5", one, AT);
	const s = makeSettle([...base, r], "a", null, AT);
	assert.ok(s);
	assert.deepEqual(spent([...base, r, s]), one);
});

test("预算恰好用尽可以预留，再多一点就拒绝并指出字段", () => {
	const exact: Amounts = { ...limits, costUsd: 5 };
	const r = makeReserve(base, "a", "all", exact, AT);
	assert.throws(() => makeReserve([...base, r], "b", "more", { ...ZERO, requests: 1 }, AT), (e: unknown) => e instanceof BudgetExceededError && e.field === "requests");
});

test("价目未知（costUsd 为 null）时不检查金额，其余上限照常检查", () => {
	const noCost: LedgerRecord[] = [{ v: LEDGER_VERSION, type: "limits", limits: { ...limits, costUsd: null }, approvedAt: AT }];
	assert.doesNotThrow(() => makeReserve(noCost, "a", "x", { ...one, costUsd: 1e9 }, AT));
	assert.throws(() => makeReserve(noCost, "a", "x", { ...one, wallMs: 1e9 }, AT), BudgetExceededError);
});

test("没有 limits 时拒绝预留", () => {
	assert.throws(() => makeReserve([], "a", "x", one, AT), LedgerCorruptError);
});

test("重复的预留 id 被拒绝", () => {
	const r = makeReserve(base, "a", "x", one, AT);
	assert.throws(() => makeReserve([...base, r], "a", "x", one, AT), LedgerCorruptError);
});

test("结算不存在的预留被拒绝", () => {
	assert.throws(() => makeSettle(base, "nope", one, AT), LedgerCorruptError);
});

test("负数或非数字的用量被拒绝", () => {
	assert.throws(() => makeReserve(base, "a", "x", { ...one, requests: -1 }, AT), TypeError);
	assert.throws(() => makeSettle([...base, makeReserve(base, "a", "x", one, AT)], "a", { ...one, costUsd: Number.NaN }, AT), TypeError);
});

test("parseLedger：损坏的行、未知版本、首条不是 limits 都视为损坏", () => {
	const good = JSON.stringify(base[0]);
	assert.equal(parseLedger(`${good}\n\n`).length, 1);
	assert.throws(() => parseLedger(`${good}\n{坏的`), LedgerCorruptError);
	assert.throws(() => parseLedger(JSON.stringify({ ...base[0], v: 2 })), LedgerCorruptError);
	const reserve = JSON.stringify(makeReserve(base, "a", "x", one, AT));
	assert.throws(() => parseLedger(reserve), LedgerCorruptError);
	assert.throws(() => parseLedger(`${good}\n${good}`), LedgerCorruptError);
	assert.throws(() => parseLedger(`${good}\n${JSON.stringify({ v: 1, type: "settle", id: "ghost", actual: null, at: AT })}`), LedgerCorruptError);
	assert.throws(() => parseLedger(`${good}\n${reserve}\n${reserve}`), LedgerCorruptError);
});
