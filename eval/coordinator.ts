// 预算协调脚本：所有会产生真实 provider 调用的步骤都经它串行执行（方案第 13 节第 0 步）。
//
// 一次协调运行的生命周期：
//   1. 独占创建锁文件，失败即退出，保证同一时刻只有一个协调进程写账本。
//   2. 每个步骤：按最坏情况写预留记录并 fsync，之后才启动 pi 子进程；子进程加载 budget-guard.ts，在进程内执行同一份上限。
//   3. 子进程结束或超时被终止后，从它的会话文件汇总实际用量并结算；用量缺失时结算为 null，账本按最坏值计。
//   4. 收到 SIGINT 或 SIGTERM 时不再启动新步骤，终止当前子进程（最多等 10 秒，之后强制结束），释放锁后退出。
// 账本文件与锁文件都在 ~/.pi/agent/.collab/smart-compact/budget/ 下（目录权限 0700），路径由 os.homedir() 拼接。
//
// 命令行：
//   node eval/coordinator.ts init-limits <limits.json>   写入用户确认的上限（账本为空时才允许）
//   node eval/coordinator.ts status                      显示已花费与上限

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Amounts, LEDGER_VERSION, type LedgerRecord, type Limits, limitsOf, makeReserve, makeSettle, parseRecord, spent } from "./ledger.ts";
import { acquireLock, appendRecord, readLedger, releaseLock } from "./ledger-file.ts";
import { usageFromSessionFile } from "./session-usage.ts";

/** 账本与锁文件所在目录。 */
export const COLLAB_DIR = join(homedir(), ".pi", "agent", ".collab", "smart-compact");
/** 账本与锁文件的路径，测试时传入临时目录下的路径。 */
export interface CoordinatorPaths {
	ledgerFile: string;
	lockFile: string;
}

/**
 * 账本目录名，可用环境变量 SC_BUDGET_DIR 指定，缺省为 budget。
 * 每个预算周期一本账：用户确认新的总预算后换一个目录名，旧账本原样保留，不改写已有上限。
 * 只允许字母、数字、点、下划线与连字符，防止路径穿越。
 */
const BUDGET_DIR = /^[A-Za-z0-9._-]+$/.test(process.env.SC_BUDGET_DIR ?? "") ? process.env.SC_BUDGET_DIR! : "budget";

export const DEFAULT_PATHS: CoordinatorPaths = {
	ledgerFile: join(COLLAB_DIR, BUDGET_DIR, "budget-ledger.jsonl"),
	lockFile: join(COLLAB_DIR, BUDGET_DIR, "budget.lock"),
};

/** 预算守卫扩展的绝对路径，子进程用 -e 加载。 */
export const GUARD_PATH = join(dirname(fileURLToPath(import.meta.url)), "budget-guard.ts");

/** 子进程超时后等待其退出的宽限时间，单位毫秒。超过后发 SIGKILL。 */
const KILL_GRACE_MS = 10_000;

export interface StepSpec {
	/** 步骤名，写进账本，例如 "S5" 或 "T-trigger"。 */
	step: string;
	/** 本步骤的最坏用量，即预留额度。wallMs 同时是子进程的超时时间。 */
	worst: Amounts;
	/** pi 的命令行参数（不含 -e 守卫，由协调脚本追加）。 */
	args: string[];
	/** 子进程环境变量，通常来自 isolate.ts 的白名单环境。 */
	env: Record<string, string>;
	/** 子进程工作目录。 */
	cwd: string;
	/** 结算时汇总这些目录下、本步骤开始后修改过的全部 .jsonl 会话文件。 */
	sessionDirs: string[];
	/** pi 可执行文件，默认 "pi"（按 env.PATH 查找）。 */
	piBin?: string;
	/**
	 * 为真表示本步骤含有会话文件里看不到的模型调用（例如 pi-goal 评估者的调用），实际用量无法从会话文件完整得到。
	 * 这类步骤一律按「无法核实」结算，保留全额预留，不按会话文件的部分用量释放。
	 */
	unobservableCalls?: boolean;
	/**
	 * 为真表示守卫已经作为隔离配置 packages 的第一项安装（涉及 pi-subagents 子会话的步骤，方案 F49），不再追加 -e 守卫。
	 * 守卫的计数挂在进程级共享状态上，同一进程加载两份会让同一个会话的预占冲突，所以两种方式只能选一种。
	 */
	guardViaPackages?: boolean;
	/**
	 * 可选的交互驱动，用于 RPC 模式：通过 io 向子进程 stdin 发 JSONL 命令、等待 stdout 上的记录。
	 * drive 结束后协调脚本关闭 stdin，请求子进程有序退出。不提供时 stdin 直接关闭。
	 */
	drive?: (io: RpcIo) => Promise<void>;
}

/** RPC 交互接口。stdout 按 LF 切分为记录，不使用 readline（它会把 U+2028 当作换行）。 */
export interface RpcIo {
	send(record: Record<string, unknown>): void;
	/** 等待第一条满足 pred 的记录（含之前已收到但未被消费的记录），超时抛错。 */
	waitFor(pred: (r: Record<string, unknown>) => boolean, timeoutMs: number): Promise<Record<string, unknown>>;
	/** 迄今收到的全部记录。 */
	records: Record<string, unknown>[];
	/** 子进程是否已退出；驱动里的轮询据此提前结束，不在子进程退出后空等。 */
	exited(): boolean;
}

export interface StepResult {
	step: string;
	reservationId: string;
	exitCode: number | null;
	timedOut: boolean;
	actual: Amounts | null;
	stdout: string;
	stderr: string;
	/** stdout 中解析出的 JSONL 记录（RPC 或 --mode json 时有内容）。 */
	records: Record<string, unknown>[];
	/** drive 回调抛出的错误，没有时为 undefined。 */
	driveError?: string;
}

function collectSessionFiles(dirs: string[], sinceMs: number): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		if (!existsSync(dir)) return;
		for (const name of readdirSync(dir)) {
			const p = join(dir, name);
			const st = statSync(p);
			if (st.isDirectory()) walk(p);
			else if (name.endsWith(".jsonl") && st.mtimeMs >= sinceMs) out.push(p);
		}
	};
	for (const d of dirs) walk(d);
	return out;
}

/** 汇总多个会话文件的用量；任何一个不可读或损坏时返回 null。 */
function sumUsage(files: string[], wallMs: number): Amounts | null {
	const total: Amounts = { requests: 0, inputTokens: 0, outputTokens: 0, billedTokens: 0, costUsd: 0, wallMs };
	for (const f of files) {
		const u = usageFromSessionFile(f);
		if (!u) return null;
		total.requests += u.requests;
		total.inputTokens += u.inputTokens;
		total.outputTokens += u.outputTokens;
		total.billedTokens += u.billedTokens;
		total.costUsd += u.costUsd;
	}
	return total;
}

/**
 * 持有锁的协调运行。所有步骤必须在 fn 内经 runStep 执行；fn 结束或进程收到终止信号时释放锁。
 */
export async function withCoordinator<T>(
	runId: string,
	fn: (runStep: (spec: StepSpec) => Promise<StepResult>) => Promise<T>,
	paths: CoordinatorPaths = DEFAULT_PATHS,
): Promise<T> {
	const lock = acquireLock(paths.lockFile, runId);
	let stopping = false;
	let current: ReturnType<typeof spawn> | undefined;

	const onSignal = (sig: NodeJS.Signals) => {
		if (stopping) return;
		stopping = true;
		process.stderr.write(`[coordinator] 收到 ${sig}，停止启动新步骤，终止当前子进程。\n`);
		if (current && current.exitCode === null) {
			current.kill("SIGTERM");
			setTimeout(() => current?.exitCode === null && current.kill("SIGKILL"), KILL_GRACE_MS).unref();
		}
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const runStep = async (spec: StepSpec): Promise<StepResult> => {
		if (stopping) throw new Error("协调运行正在停止，不再启动新步骤");
		const id = `${runId}:${spec.step}:${randomUUID()}`;
		// 先落盘预留，再启动子进程：进程在两者之间崩溃时，预留按最坏值计，不会漏记。
		appendRecord(paths.ledgerFile, makeReserve(readLedger(paths.ledgerFile), id, spec.step, spec.worst, new Date().toISOString()));

		const started = Date.now();
		// 守卫放在第一个 -e：它的 session_before_compact 必须先于其他扩展（产生摘要调用的 handler）执行。
		const child = spawn(spec.piBin ?? "pi", spec.guardViaPackages ? spec.args : ["-e", GUARD_PATH, ...spec.args], {
			cwd: spec.cwd,
			env: {
				...spec.env,
				PI_BUDGET_MAX_REQUESTS: String(spec.worst.requests),
				PI_BUDGET_MAX_BILLED_TOKENS: String(spec.worst.billedTokens),
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		current = child;
		let stdout = "";
		let stderr = "";
		let pending = "";
		const records: Record<string, unknown>[] = [];
		const waiters: Array<{ pred: (r: Record<string, unknown>) => boolean; resolve: (r: Record<string, unknown>) => void; from: number }> = [];
		const offer = () => {
			for (let i = waiters.length - 1; i >= 0; i--) {
				const w = waiters[i];
				const hit = records.slice(w.from).find(w.pred);
				if (hit) {
					waiters.splice(i, 1);
					w.resolve(hit);
				}
			}
		};
		child.stdout?.on("data", (d) => {
			const text = String(d);
			stdout += text;
			pending += text;
			let nl = pending.indexOf("\n");
			while (nl >= 0) {
				const line = pending.slice(0, nl).replace(/\r$/, "");
				pending = pending.slice(nl + 1);
				if (line.trim()) {
					try {
						records.push(JSON.parse(line) as Record<string, unknown>);
					} catch {
						// 非 JSON 的 stdout 行（例如 -p 模式的回答文本）只保留在 stdout 里。
					}
				}
				nl = pending.indexOf("\n");
			}
			offer();
		});
		child.stderr?.on("data", (d) => (stderr += String(d)));
		let childExited = false;
		child.on("close", () => (childExited = true));
		const io: RpcIo = {
			records,
			exited: () => childExited,
			send: (record) => child.stdin?.write(`${JSON.stringify(record)}\n`),
			waitFor: (pred, timeoutMs) =>
				new Promise((resolveWait, rejectWait) => {
					const hit = records.find(pred);
					if (hit) return resolveWait(hit);
					const timer = setTimeout(() => rejectWait(new Error(`等待 RPC 记录超时（${timeoutMs}ms）`)), timeoutMs);
					waiters.push({ pred, from: 0, resolve: (r) => (clearTimeout(timer), resolveWait(r)) });
				}),
		};
		let driveError: unknown;
		const driving = (spec.drive ? spec.drive(io) : Promise.resolve()).catch((err: unknown) => {
			driveError = err;
		}).finally(() => child.stdin?.end());

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), KILL_GRACE_MS).unref();
		}, spec.worst.wallMs);

		const exitCode = await new Promise<number | null>((res) => {
			child.on("error", () => res(null));
			child.on("close", (code) => res(code));
		});
		clearTimeout(timer);
		current = undefined;
		await driving;

		const actual = spec.unobservableCalls ? null : sumUsage(collectSessionFiles(spec.sessionDirs, started), Date.now() - started);
		const settle = makeSettle(readLedger(paths.ledgerFile), id, actual, new Date().toISOString());
		if (settle) appendRecord(paths.ledgerFile, settle);
		return { step: spec.step, reservationId: id, exitCode, timedOut, actual, stdout, stderr, records, driveError: driveError === undefined ? undefined : String(driveError) };
	};

	try {
		return await fn(runStep);
	} finally {
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
		releaseLock(paths.lockFile, lock.owner);
	}
}

/** 写入用户确认的上限。账本已有记录时拒绝，避免事后改上限。 */
export function initLimits(limits: Limits, paths: CoordinatorPaths = DEFAULT_PATHS, now: () => Date = () => new Date()): void {
	if (readLedger(paths.ledgerFile).length > 0) throw new Error(`账本已存在记录，不能重新设置上限：${paths.ledgerFile}`);
	const record: LedgerRecord = { v: LEDGER_VERSION, type: "limits", limits, approvedAt: now().toISOString() };
	// 用与读取时相同的校验检查一遍，避免把非法上限写进账本、之后整本账都无法读取。
	parseRecord(JSON.stringify(record), 1);
	appendRecord(paths.ledgerFile, record);
}

function formatStatus(paths: CoordinatorPaths): string {
	const records = readLedger(paths.ledgerFile);
	const limits = limitsOf(records);
	if (!limits) return "账本尚未设置上限。";
	const s = spent(records);
	const rows = (Object.keys(s) as (keyof Amounts)[]).map((k) => `${k}: ${s[k]} / ${limits[k] ?? "无金额上限"}`);
	return rows.join("\n");
}

async function main(argv: string[]): Promise<number> {
	const [cmd, arg] = argv;
	if (cmd === "init-limits" && arg) {
		const limits = JSON.parse(readFileSync(resolve(arg), "utf8")) as Limits;
		initLimits(limits);
		process.stdout.write(`已写入上限：${DEFAULT_PATHS.ledgerFile}\n`);
		return 0;
	}
	if (cmd === "status") {
		process.stdout.write(`${formatStatus(DEFAULT_PATHS)}\n`);
		return 0;
	}
	process.stderr.write("用法：node eval/coordinator.ts init-limits <limits.json> | status\n");
	return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(err: unknown) => {
			process.stderr.write(`${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}\n`);
			process.exit(1);
		},
	);
}
