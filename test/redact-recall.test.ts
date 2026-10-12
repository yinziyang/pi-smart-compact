import assert from "node:assert/strict";
import { test } from "node:test";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { RawEntry } from "../edits.ts";
import { capRecall, recallById, recallByQuery, validRecoveryRecords, MAX_TOTAL, type RecallDoc } from "../recall.ts";
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
	const notFound = capRecall(`找不到 entryId=${"x".repeat(10001)}，或该记录已被删除。`);
	assert.ok(notFound.length <= MAX_TOTAL);
	assert.match(notFound, /已截断/);
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

test("带引号的值整体遮蔽，含空白与逗号也不留尾巴", () => {
	assert.equal(redact('password="alpha beta" x'), 'password="[已脱敏]" x');
	assert.equal(redact("api_key='alpha,beta'"), "api_key='[已脱敏]'");
	assert.equal(redact('secret="a\\"b c"'), 'secret="[已脱敏]"');
	assert.equal(containsSecret('password="[已脱敏]"'), false);
	assert.equal(containsSecret('password="alpha beta"'), true);
});

test("结构化工具参数按键名遮蔽，经 pi 序列化后摘要请求里不出现秘密", () => {
	const msg = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "login", arguments: { user: "u", password: "alphabeticpass", token: "8192", access_token: "abcdefghijklmnopqrstu" } }], provider: "p", model: "m", api: "a", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 0 };
	const text = serializeConversation(convertToLlm([redactDeep(msg)] as never));
	assert.ok(!text.includes("alphabeticpass"), text);
	assert.ok(!text.includes("abcdefghijklmnopqrstu"), text);
	assert.match(text, /8192/);
});

test("跨行与未闭合的引号值同样遮蔽，检测与替换一致", () => {
	assert.equal(redact('password="alpha\nbeta" ok'), 'password="[已脱敏]" ok');
	assert.equal(redact('password="alpha beta\n下一行'), 'password="[已脱敏]\n下一行');
	for (const s of ['password="alpha\nbeta"', 'password="alpha beta', "secret='unclosed value"]) {
		assert.equal(containsSecret(s), true, s);
		assert.equal(containsSecret(redact(s)), false, redact(s));
	}
});

test("敏感键的非字符串值整体遮蔽，token 计量数字保留", () => {
	const out = redactDeep({ password: 12345678, secret: ["alpha beta"], api_key: { value: "alpha beta" }, token: 8192, n: 1 });
	assert.deepEqual(out, { password: "[已脱敏]", secret: "[已脱敏]", api_key: "[已脱敏]", token: 8192, n: 1 });
	const msg = { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "login", arguments: { password: 12345678, secret: { v: "alpha beta" } } }], provider: "p", model: "m", api: "a", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, stopReason: "toolUse", timestamp: 0 };
	const text = serializeConversation(convertToLlm([redactDeep(msg)] as never));
	assert.ok(!text.includes("12345678") && !text.includes("alpha beta"), text);
});

test("反斜杠续行（LF 与 CRLF）的引号值整体遮蔽", () => {
	for (const nl of ["\n", "\r\n"]) {
		const s = `password="alpha\\${nl}beta" ok`;
		assert.equal(redact(s), 'password="[已脱敏]" ok', JSON.stringify(s));
	}
});
