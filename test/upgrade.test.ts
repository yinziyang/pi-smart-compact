// 固定同一真实 SDK 契约，仅改变诊断版本字符串，防止升级被版本白名单误停用。

import assert from "node:assert/strict";
import { test } from "node:test";
import { readNotes, run, say } from "./harness.ts";

for (const piVersion of ["1.2.0", "1.3.0", "9.9.9-future"]) {
	for (const reason of ["manual", "threshold", "overflow"] as const) {
		test(`契约不变时 pi ${piVersion} 的 ${reason} 压缩仍由 smart 接管`, { timeout: 20_000 }, async () => {
			const r = await run({
				piVersion,
				steps: reason === "manual" ? ["积累笔记", async (session) => { await session.compact(); }] : reason === "overflow" ? ["积累笔记", "输出长文"] : ["多次读取并整理笔记"],
				chat: (n) => {
					if (n < (reason === "threshold" ? 14 : 6)) return readNotes();
					if (reason === "overflow" && n === 7) return { ...say("被长度限制中断的长文"), stopReason: "length" };
					return say("笔记整理完成");
				},
			});
			const compaction = r.compactions.find((c) => (c.details as { reason?: string })?.reason === reason);
			assert.ok(compaction, `版本变化不能让 ${reason} 静默交回宿主默认摘要`);
			assert.equal((compaction.details as { smartCompact?: number }).smartCompact, 1);
			assert.ok(r.compactions.every((c) => (c.details as { smartCompact?: number })?.smartCompact === 1), "不能混入宿主默认摘要");
			assert.ok(!r.logs.some((line) => line.includes("未经验证")), "不能只因版本字符串不同就报警停用");
		});
	}
}
