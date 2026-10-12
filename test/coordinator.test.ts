import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CoordinatorPaths, GUARD_PATH, initLimits, withCoordinator } from "../eval/coordinator.ts";
import { type Amounts, BudgetExceededError, spent } from "../eval/ledger.ts";
import { acquireLock, LockError, readLedger, releaseLock } from "../eval/ledger-file.ts";

const FAKE_PI = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.mjs");
const root = mkdtempSync(join(tmpdir(), "sc-coord-"));
after(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function fresh(): { paths: CoordinatorPaths; sessions: string } {
	const dir = join(root, `case-${n++}`);
	const sessions = join(dir, "sessions");
	mkdirSync(sessions, { recursive: true });
	const paths = { ledgerFile: join(dir, "ledger", "budget-ledger.jsonl"), lockFile: join(dir, "ledger", "budget.lock") };
	initLimits({ requests: 10, inputTokens: 10_000, outputTokens: 1_000, billedTokens: 11_000, costUsd: 1, wallMs: 120_000 }, paths);
	return { paths, sessions };
}

const worst: Amounts = { requests: 3, inputTokens: 1_000, outputTokens: 100, billedTokens: 1_100, costUsd: 0.1, wallMs: 20_000 };

function spec(sessions: string, env: Record<string, string>, w: Amounts = worst) {
	return {
		step: "fake",
		worst: w,
		// 假脚本带 shebang，直接作为 pi 可执行文件启动；协调脚本会在参数最前面加上 -e <守卫>。
		args: ["--print", "hi"],
		env: { PATH: process.env.PATH ?? "", FAKE_SESSION_FILE: join(sessions, "s.jsonl"), ...env },
		cwd: root,
		sessionDirs: [sessions],
		piBin: FAKE_PI,
	};
}

test("预留落盘后启动子进程，结束后按会话文件结算，并传入守卫与上限", async () => {
	const { paths, sessions } = fresh();
	const r = await withCoordinator("run", (run) => run(spec(sessions, { FAKE_REQUESTS: "2" })), paths);
	assert.equal(r.exitCode, 0);
	assert.equal(r.timedOut, false);
	assert.equal(r.actual?.requests, 2);
	const seen = JSON.parse(readFileSync(join(sessions, "s.jsonl.env.json"), "utf8"));
	assert.equal(seen.maxRequests, "3");
	assert.equal(seen.maxTokens, "1100");
	assert.deepEqual(seen.args.slice(0, 2), ["-e", GUARD_PATH]);
	const records = readLedger(paths.ledgerFile);
	assert.deepEqual(records.map((x) => x.type), ["limits", "reserve", "settle"]);
	assert.equal(spent(records).requests, 2);
});

test("会话文件损坏时结算为 null，预留按最坏值计", async () => {
	const { paths, sessions } = fresh();
	const r = await withCoordinator("run", (run) => run(spec(sessions, { FAKE_CORRUPT: "1" })), paths);
	assert.equal(r.actual, null);
	assert.equal(spent(readLedger(paths.ledgerFile)).requests, worst.requests);
});

test("超过 wallMs 时终止子进程并标记超时", async () => {
	const { paths, sessions } = fresh();
	const r = await withCoordinator("run", (run) => run(spec(sessions, { FAKE_SLEEP_MS: "30000" }, { ...worst, wallMs: 500 })), paths);
	assert.equal(r.timedOut, true);
});

test("预留会超出上限时不启动子进程", async () => {
	const { paths, sessions } = fresh();
	await assert.rejects(
		withCoordinator("run", (run) => run(spec(sessions, {}, { ...worst, requests: 11 })), paths),
		BudgetExceededError,
	);
	assert.deepEqual(readLedger(paths.ledgerFile).map((x) => x.type), ["limits"]);
});

test("锁已被占用时拒绝运行；运行结束后锁被释放", async () => {
	const { paths, sessions } = fresh();
	const held = acquireLock(paths.lockFile, "other");
	await assert.rejects(withCoordinator("run", async () => 1, paths), LockError);
	releaseLock(paths.lockFile, held.owner);
	await withCoordinator("run", (run) => run(spec(sessions, {})), paths);
	const again = acquireLock(paths.lockFile, "after");
	releaseLock(paths.lockFile, again.owner);
});

test("账本已有记录时不能重新设置上限", () => {
	const { paths } = fresh();
	assert.throws(() => initLimits({ requests: 1, inputTokens: 1, outputTokens: 1, billedTokens: 1, costUsd: 1, wallMs: 1 }, paths), /不能重新设置上限/);
});

test("非法上限不写入账本", () => {
	const dir = join(root, "bad-limits");
	const paths = { ledgerFile: join(dir, "l", "ledger.jsonl"), lockFile: join(dir, "l", "lock") };
	assert.throws(() => initLimits({ requests: -1 } as never, paths));
	assert.deepEqual(readLedger(paths.ledgerFile), []);
});

const FAKE_RPC = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-rpc.mjs");

test("drive：通过 stdin 发命令、按 LF 切分 stdout 记录、结束后关闭 stdin 让子进程退出", async () => {
	const { paths, sessions } = fresh();
	const r = await withCoordinator(
		"run",
		(run) =>
			run({
				...spec(sessions, {}),
				args: [],
				piBin: FAKE_RPC,
				drive: async (io) => {
					for (const n of [1, 2]) {
						const start = io.records.length;
						io.send({ id: `p${n}`, type: "prompt", message: "hi" });
						const settled = await io.waitFor((x) => x.type === "agent_settled" && io.records.indexOf(x) >= start, 5_000);
						assert.equal(settled.n, n);
						assert.equal(settled.text, "含 分隔符");
					}
				},
			}),
		paths,
	);
	assert.equal(r.exitCode, 0);
	assert.equal(r.driveError, undefined);
	assert.equal(r.actual?.requests, 2);
	assert.equal(r.records.filter((x) => x.type === "response").length, 2);
});

test("drive 超时：记录 driveError，子进程仍被关闭 stdin 后退出", async () => {
	const { paths, sessions } = fresh();
	const r = await withCoordinator(
		"run",
		(run) => run({ ...spec(sessions, {}), args: [], piBin: FAKE_RPC, drive: async (io) => void (await io.waitFor((x) => x.type === "never", 200)) }),
		paths,
	);
	assert.match(r.driveError ?? "", /超时/);
	assert.equal(r.exitCode, 0);
});

test("含不可观测调用的步骤按无法核实结算，保留全额预留", async () => {
	const { paths, sessions } = fresh();
	const r = await withCoordinator("run", (run) => run({ ...spec(sessions, { FAKE_REQUESTS: "1" }), unobservableCalls: true }), paths);
	assert.equal(r.actual, null);
	assert.equal(spent(readLedger(paths.ledgerFile)).requests, worst.requests);
});
