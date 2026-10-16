import assert from "node:assert/strict";
import { test } from "node:test";
import { goodSummary, readNotes, run, say, type Session } from "./harness.ts";
import { RECOVERY_TYPE } from "../recovery.ts";

for (const addOmission of [false, true]) {
	test(`overflow 重算${addOmission ? "合并新增省略记录且" : "后"}只消费成功批次一次`, { timeout: 20_000 }, async () => {
		let session: Session | undefined;
		let added = false;
		let newEditId: string | undefined;
		const output = await run({
			setup: async (current) => { session = current; },
			steps: ["读 notes.md 多次", "输出长文"],
			chat: (n) => {
				if (n < 6) return readNotes();
				if (n === 6) return say("已读");
				if (n === 7) return { ...say("被截断的执行记录 OMEGA77"), stopReason: "length" };
				return say("已完成压缩后的工作");
			},
			summary: (n, request) => {
				if (n === 0) {
					assert.ok(session);
					const manager = session.sessionManager;
					// 在真实恢复窗口内制造额外省略记录，检验重算时批次合并而不是提前消费。
					if (addOmission) {
						const target = manager.appendMessage({ ...say("新增的省略记录 OMEGA88"), stopReason: "length" });
						newEditId = manager.appendContextEdit(target, null);
					}
					manager.appendCustomMessageEntry("t02c-result", "重算时必须保留的后台结果", true);
					added = true;
				}
				return goodSummary(request);
			},
		});
		assert.ok(added);
		const summaries = output.requests.filter((request) => request.summary);
		assert.ok(summaries.length >= 2, "必须真的重算，不能靠未发生竞态通过");
		const compaction = output.compactions.find((entry) => entry.details?.reason === "overflow");
		assert.ok(compaction, output.logs.join(" | "));
		const details = compaction.details as { omittedAttempt: { nonce: string; records: { editId: string; content: unknown }[] }; stats: { requests: number } };
		assert.ok(details.omittedAttempt?.records.some((record) => JSON.stringify(record.content).includes("OMEGA77")), "原省略记录不能在失败尝试后丢失");
		if (addOmission) assert.ok(details.omittedAttempt.records.some((record) => record.editId === newEditId && JSON.stringify(record.content).includes("OMEGA88")), "重算必须合并恢复窗口内新增的省略记录");
		assert.ok(details.stats.requests >= 2, "丢弃尝试必须计入最终资源统计");
		const holders = output.entries.flatMap((entry) => {
			if (entry.type === "compaction") return [(entry.details as { omittedAttempt?: { records: { editId: string }[] } })?.omittedAttempt];
			if (entry.type === "custom" && entry.customType === RECOVERY_TYPE) return [entry.data as { records: { editId: string }[] }];
			return [];
		}).filter((holder) => holder !== undefined);
		const ids = holders.flatMap((holder) => holder.records.map((record) => record.editId));
		assert.equal(new Set(ids).size, ids.length, "成功提交后不得再次把同一批次写成恢复条目");
	});
}
