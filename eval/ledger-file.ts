// 账本与锁文件的磁盘读写（方案第 13 节第 0 步）。
//
// 安全约束：
//   - 目录权限 0700，锁文件与账本文件 0600。
//   - 路径中出现符号链接时拒绝，避免被重定向到别处写入。
//   - 每次追加记录后 fsync 文件；账本首次创建时还 fsync 父目录，保证新文件本身落盘。
//   - 锁用 O_CREAT | O_EXCL 独占创建，只有持有相同 owner token 的进程能删除；残留锁不自动清除。

import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { type LedgerRecord, parseLedger } from "./ledger.ts";

/** 路径不安全（含符号链接、权限不对）时抛出。 */
export class UnsafePathError extends Error {
	override name = "UnsafePathError";
}

/** 锁已被占用或无法释放时抛出。 */
export class LockError extends Error {
	override name = "LockError";
}

/**
 * 确保目录存在、权限为 0700，且目录本身不是符号链接。
 * 上级路径中的系统级符号链接（macOS 的 /tmp、/var）不算违规：先规范化为真实路径再检查权限。
 */
export function ensureSafeDir(dir: string): void {
	const abs = resolve(dir);
	mkdirSync(abs, { recursive: true, mode: 0o700 });
	if (lstatSync(abs).isSymbolicLink()) throw new UnsafePathError(`目录是符号链接：${abs}`);
	const mode = lstatSync(realpathSync(abs)).mode & 0o777;
	if (mode !== 0o700) throw new UnsafePathError(`目录权限应为 0700，实际为 ${mode.toString(8)}：${abs}`);
}

function assertNotSymlink(file: string): void {
	if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new UnsafePathError(`文件是符号链接：${file}`);
}

function fsyncDir(dir: string): void {
	const fd = openSync(dir, constants.O_RDONLY);
	try {
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
}

/** 读取账本；文件不存在时返回空数组，内容损坏时抛 LedgerCorruptError。 */
export function readLedger(file: string): LedgerRecord[] {
	assertNotSymlink(file);
	if (!existsSync(file)) return [];
	return parseLedger(readFileSync(file, "utf8"));
}

/** 追加一条记录并 fsync；文件首次创建时同时 fsync 父目录。 */
export function appendRecord(file: string, record: LedgerRecord): void {
	ensureSafeDir(dirname(file));
	assertNotSymlink(file);
	const created = !existsSync(file);
	const fd = openSync(file, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT, 0o600);
	try {
		writeSync(fd, `${JSON.stringify(record)}\n`);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	if (created) fsyncDir(dirname(file));
}

export interface LockInfo {
	owner: string;
	pid: number;
	runId: string;
	startedAt: string;
}

/** 独占创建锁文件，失败即抛 LockError。返回的 owner 用于释放。 */
export function acquireLock(file: string, runId: string, now: () => Date = () => new Date()): LockInfo {
	ensureSafeDir(dirname(file));
	assertNotSymlink(file);
	const info: LockInfo = { owner: randomUUID(), pid: process.pid, runId, startedAt: now().toISOString() };
	let fd: number;
	try {
		fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") {
			throw new LockError(`锁文件已存在，可能有另一个协调脚本在运行，或上次运行异常退出：${file}。确认原进程及其子进程都已退出后再手动删除。`);
		}
		throw err;
	}
	try {
		writeSync(fd, JSON.stringify(info));
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	fsyncDir(dirname(file));
	return info;
}

/** 只有 owner 相同时才删除锁文件；重复释放（文件已不存在）视为成功。 */
export function releaseLock(file: string, owner: string): void {
	assertNotSymlink(file);
	if (!existsSync(file)) return;
	let current: Partial<LockInfo>;
	try {
		current = JSON.parse(readFileSync(file, "utf8")) as Partial<LockInfo>;
	} catch {
		throw new LockError(`锁文件内容无法解析，不删除：${file}`);
	}
	if (current.owner !== owner) throw new LockError(`锁不属于当前进程，不删除：${file}`);
	unlinkSync(file);
}
