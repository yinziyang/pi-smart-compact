// 交接文档的生成与文件管理（方案 11.5）：路径、写盘、按保留份数清理，以及历史被修改后删除派生副本。
// 文件操作的失败由调用方处理：写失败只记警告，不影响压缩。

import { mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderFull, type PackData } from "./pack.ts";
import { redact } from "./redact.ts";

/** 交接文档正文：叙述摘要、未裁剪的压缩包、完整文件清单与本次统计，写盘前统一脱敏。 */
export function handoffDoc(title: string, narrative: string | undefined, data: PackData, extra: Record<string, unknown>): string {
	const parts = [`# ${title}`, "", "## 叙述摘要", "", narrative ?? "（无）", "", "## 压缩包（未裁剪）", "", renderFull(data), "", "## 完整文件清单", "", "### 已修改", ...data.modified.map((p) => `- ${p}`), "", "### 已读取", ...data.read.map((p) => `- ${p}`), "", "## 本次统计", "", "```json", JSON.stringify(extra, null, 2), "```", ""];
	return redact(parts.join("\n"));
}

/** 本会话的交接文档目录；没有 session 文件（无 session 模式）时返回 undefined。 */
export function handoffDir(sessionFile: string | undefined, sessionDir: string, sessionId: string): string | undefined {
	return sessionFile ? join(sessionDir, "smart-compact", sessionId) : undefined;
}

/** 下一份交接文档的路径：序号加 ISO 时间。目录不存在时序号从 1 开始。 */
export function nextHandoffPath(dir: string, nowMs: number): string {
	let n = 0;
	try {
		n = readdirSync(dir).filter((f) => f.endsWith(".md")).length;
	} catch {
		n = 0;
	}
	return join(dir, `${String(n + 1).padStart(4, "0")}-${new Date(nowMs).toISOString().replace(/[:.]/g, "-")}.md`);
}

/** 写交接文档（目录 0700、文件 0600），并只保留最近 keep 份。写失败时抛出，由调用方提示。 */
export function writeHandoffFile(dir: string, path: string, text: string, keep: number): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeFileSync(path, text, { mode: 0o600 });
	const files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
	for (const f of files.slice(0, Math.max(0, files.length - keep))) unlinkSync(join(dir, f));
}

/** 删除修改时间早于 beforeMs 的交接文档（保留 keepPath），它们是被删除历史的派生副本（方案 5.2 第 4 步）。 */
export function removeHandoffsBefore(dir: string, keepPath: string | undefined, beforeMs: number): void {
	for (const f of readdirSync(dir)) {
		const p = join(dir, f);
		if (p !== keepPath && f.endsWith(".md") && statSync(p).mtimeMs < beforeMs) unlinkSync(p);
	}
}
