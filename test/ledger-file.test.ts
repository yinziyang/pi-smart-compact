import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { LEDGER_VERSION, LedgerCorruptError, type LedgerRecord } from "../eval/ledger.ts";
import { acquireLock, appendRecord, LockError, readLedger, releaseLock, UnsafePathError } from "../eval/ledger-file.ts";

const root = mkdtempSync(join(tmpdir(), "sc-ledger-"));
after(() => rmSync(root, { recursive: true, force: true }));

const limitsRecord: LedgerRecord = {
	v: LEDGER_VERSION,
	type: "limits",
	limits: { requests: 1, inputTokens: 1, outputTokens: 1, billedTokens: 1, costUsd: null, wallMs: 1 },
	approvedAt: "2026-10-10T00:00:00.000Z",
};

test("追加记录后可读回，文件 0600、目录 0700", () => {
	const dir = join(root, "a");
	const file = join(dir, "ledger.jsonl");
	appendRecord(file, limitsRecord);
	assert.equal(readLedger(file).length, 1);
	assert.equal(statSync(file).mode & 0o777, 0o600);
	assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test("账本文件不存在时读出空数组，内容损坏时抛错", () => {
	const dir = join(root, "b");
	assert.deepEqual(readLedger(join(dir, "none.jsonl")), []);
	mkdirSync(dir, { mode: 0o700 });
	writeFileSync(join(dir, "bad.jsonl"), "not json\n");
	assert.throws(() => readLedger(join(dir, "bad.jsonl")), LedgerCorruptError);
});

test("目录权限不是 0700 时拒绝写入", () => {
	const dir = join(root, "c");
	mkdirSync(dir, { mode: 0o755 });
	chmodSync(dir, 0o755);
	assert.throws(() => appendRecord(join(dir, "l.jsonl"), limitsRecord), UnsafePathError);
});

test("账本文件或目录是符号链接时拒绝", () => {
	const real = join(root, "real");
	mkdirSync(real, { mode: 0o700 });
	const link = join(root, "link");
	symlinkSync(real, link);
	assert.throws(() => appendRecord(join(link, "l.jsonl"), limitsRecord), UnsafePathError);
	const dir = join(root, "d");
	mkdirSync(dir, { mode: 0o700 });
	writeFileSync(join(real, "target.jsonl"), "");
	symlinkSync(join(real, "target.jsonl"), join(dir, "l.jsonl"));
	assert.throws(() => appendRecord(join(dir, "l.jsonl"), limitsRecord), UnsafePathError);
});

test("锁：第二次获取失败，只有 owner 能释放，重复释放无害", () => {
	const lockFile = join(root, "e", "budget.lock");
	const lock = acquireLock(lockFile, "run-1");
	assert.equal(statSync(lockFile).mode & 0o777, 0o600);
	assert.equal(JSON.parse(readFileSync(lockFile, "utf8")).runId, "run-1");
	assert.throws(() => acquireLock(lockFile, "run-2"), LockError);
	assert.throws(() => releaseLock(lockFile, "someone-else"), LockError);
	releaseLock(lockFile, lock.owner);
	assert.doesNotThrow(() => releaseLock(lockFile, lock.owner));
	const again = acquireLock(lockFile, "run-3");
	releaseLock(lockFile, again.owner);
});
