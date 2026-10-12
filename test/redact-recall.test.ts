import assert from "node:assert/strict";
import { test } from "node:test";
import type { RawEntry } from "../edits.ts";
import { recallById, recallByQuery, validRecoveryRecords, MAX_TOTAL, type RecallDoc } from "../recall.ts";
import { containsSecret, redact, redactDeep } from "../redact.ts";

// 测试用的伪造密钥在运行时拼接，源码里不出现完整的密钥字面量。
const fake = (prefix: string, body: string) => `${prefix}${body}`;

test("每类密钥各一条正例与一条反例", () => {
	const cases: [string, string][] = [
		[`key ${fake("sk-", "abcdefghijklmnop1234")}`, "sk-short"],
		[`t ${fake("ghp_", "abcdefghijklmnopqrstuvwxyz")}`, "ghp_abc"],
		[`t ${fake("github_pat_", "11ABCDEFGHIJKLMNOPQRSTUV")}`, "github_pat_x"],
		[`aws ${fake("AKIA", "ABCDEFGHIJKLMNOP")}`, "AKIA123"],
		[`Authorization: Bearer ${fake("abc", "def123456789")}`, "Bearer 是一种认证方式"],
		[`${fake("-----BEGIN RSA ", "PRIVATE KEY-----")}\nMIIE\n-----END RSA PRIVATE KEY-----`, "BEGIN PUBLIC KEY"],
		[`password=${fake("hunter", "2abc")}`, "密码在文档里"],
		["password=alphabeticpass", "passwords are hashed"],
		["secret=123456789", "secretary"],
		[`token=${fake("abcdefgh", "ijklmnopqrst")}`, "token: 8192"],
		[`api_key: "${fake("abc", "123def")}"`, "tokens: 8192"],
	];
	for (const [pos, neg] of cases) {
		assert.equal(containsSecret(pos), true, pos);
		assert.equal(containsSecret(redact(pos)), false, redact(pos));
		assert.equal(containsSecret(neg), false, neg);
		assert.equal(redact(neg), neg);
	}
	assert.equal(redact(`password=${fake("hunter", "2abc")}`), "password=[已脱敏]");
	assert.deepEqual(redactDeep({ a: [`x ${fake("sk-", "abcdefghijklmnop1234")}`], n: 1 }), { a: ["x [已脱敏]"], n: 1 });
});

const docs: RecallDoc[] = [
	{ entryId: "e1", role: "user", time: "t1", text: "迁移 数据库 schema 到 v2" },
	{ entryId: "e2", role: "toolResult", time: "t2", text: `${"x".repeat(2000)} Database migration failed ${"y".repeat(2000)}` },
];

test("多关键词全部命中、不区分大小写，命中点前后各 600 字符", () => {
	assert.match(recallByQuery(docs, "数据库 v2"), /\[e1\]/);
	assert.equal(recallByQuery(docs, "数据库 v3"), "没有匹配的记录。");
	const r = recallByQuery(docs, "DATABASE failed");
	assert.match(r, /\[e2\]/);
	assert.ok(r.length < 1400);
});

test("entryId 取全文，总长度不超过上限并注明已截断", () => {
	assert.match(recallById(docs, "e1")!, /迁移/);
	assert.equal(recallById(docs, "nope"), null);
	const big = [{ entryId: "b", role: "user", time: "", text: "z".repeat(50000) }];
	const r = recallById(big, "b")!;
	assert.ok(r.length <= MAX_TOTAL);
	assert.match(r, /已截断/);
	const many = Array.from({ length: 20 }, (_, i) => ({ entryId: `m${i}`, role: "user", time: "", text: `kw ${"q".repeat(3000)}` }));
	assert.ok(recallByQuery(many, "kw").length <= MAX_TOTAL);
});

test("恢复记录逐条验证：编辑不在分支上、不是 null 编辑、之后又被编辑的都不可召回", () => {
	const branch: RawEntry[] = [
		{ type: "message", id: "a" },
		{ type: "message", id: "b" },
		{ type: "context_edit", id: "x1", targetId: "a", replacement: null },
		{ type: "context_edit", id: "x2", targetId: "b", replacement: null },
		{ type: "context_edit", id: "x3", targetId: "b", replacement: { content: "改" } },
	];
	const rec = (editId: string, targetId: string) => ({ editId, targetId, role: "toolResult", content: "c" });
	const ok = validRecoveryRecords(branch, [rec("x1", "a"), rec("x2", "b"), rec("gone", "a"), rec("x1", "b")]);
	assert.deepEqual(ok.map((r) => r.editId), ["x1"]);
});
