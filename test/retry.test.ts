import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_REQUESTS } from "../compact.ts";
import { STATE_TYPE } from "../state.ts";
import { goodSummary, readNotes, run, say, type Session } from "./harness.ts";

function spyAbort(session: Session, counter: { value: number }): void {
	const abort = session.abort.bind(session);
	session.abort = async () => {
		counter.value++;
		await abort();
	};
}

for (const reason of ["threshold", "overflow"] as const) {
	test(`${reason}期间普通custom元数据追加不取消压缩`, { timeout: 20_000 }, async () => {
		let session: Session | undefined;
		const aborts = { value: 0 };
		let appended = false;
		const result = await run({
			setup: async (current) => {
				session = current;
				spyAbort(current, aborts);
			},
			steps: reason === "overflow" ? ["积累笔记", "输出长文"] : ["多次读取并整理笔记"],
			chat: (n) => {
				if (n < (reason === "threshold" ? 14 : 6)) return readNotes();
				if (reason === "overflow" && n === 7) return { ...say("被长度限制中断的长文"), stopReason: "length" };
				return say("笔记整理完成");
			},
			summary: (_n, req) => {
				if (!appended) {
					assert.ok(session);
					session.sessionManager.appendCustomEntry("t02c-progress", { progress: "正在整理" });
					appended = true;
				}
				return goodSummary(req);
			},
		});
		assert.ok(appended);
		assert.equal(aborts.value, 0, "普通custom元数据不应调用会话abort");
		assert.ok(result.compactions.some((entry) => (entry.details as { reason?: string })?.reason === reason), `${reason}应提交压缩结果`);
	});
}

test("threshold期间实质消息变化后提交时主模型上下文不丢新内容", { timeout: 20_000 }, async () => {
	let session: Session | undefined;
	const aborts = { value: 0 };
	let appended = false;
	const result = await run({
		setup: async (current) => {
			session = current;
			spyAbort(current, aborts);
		},
		steps: ["多次读取并整理笔记"],
		chat: (n) => n < 14 ? readNotes() : say("笔记整理完成"),
		summary: (n, req) => {
			if (n === 0) {
				assert.ok(session);
				session.sessionManager.appendCustomMessageEntry("t02c-content", "重算必须包含这段最新内容", true);
				appended = true;
			}
			return goodSummary(req);
		},
	});
	assert.ok(appended);
	assert.ok(result.requests.filter((request) => !request.summary).some((request) => request.all.includes("重算必须包含这段最新内容")), "提交压缩后主模型上下文仍应包含新追加的消息");
	assert.ok(result.compactions.some((entry) => (entry.details as { reason?: string })?.reason === "threshold"), "应自动提交threshold压缩");
	assert.equal(aborts.value, 0, "消息变化后成功提交不应中止会话");
});

test("threshold期间已摘要消息被context_edit修改后重算最新历史", { timeout: 20_000 }, async () => {
	let session: Session | undefined;
	const aborts = { value: 0 };
	let entered = false;
	let edited = false;
	let captureError: unknown;
	const result = await run({
		setup: async (current) => {
			session = current;
			spyAbort(current, aborts);
		},
		steps: ["多次读取并整理笔记"],
		chat: (n) => n < 14 ? readNotes() : say("笔记整理完成"),
		summary: (n, req) => {
			if (n === 0) {
				entered = true;
				try {
					assert.ok(session);
					const target = session.sessionManager.getBranch().find((entry) =>
						entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message.role),
					);
					assert.ok(target, "应找到可编辑的user、assistant或toolResult条目");
					session.sessionManager.appendContextEdit(target.id, { content: [{ type: "text", text: "编辑后的历史内容必须进入重算" }] });
					edited = true;
				} catch (error) {
					captureError = error;
					throw error;
				}
			}
			return goodSummary(req);
		},
	});
	assert.ok(entered, `应进入首次摘要回调；摘要请求数=${result.requests.filter((request) => request.summary).length}；日志=${JSON.stringify(result.logs)}；捕获异常=${String(captureError)}`);
	assert.ok(edited, `应成功追加历史编辑；日志=${JSON.stringify(result.logs)}；捕获异常=${String(captureError)}`);
	const summaries = result.requests.filter((request) => request.summary);
	assert.ok(summaries.length >= 2, "历史编辑后应再次请求摘要");
	assert.ok(summaries.at(-1)?.all.includes("编辑后的历史内容必须进入重算"), "最终摘要请求应看到编辑后的内容");
	assert.ok(result.compactions.some((entry) => (entry.details as { reason?: string })?.reason === "threshold"), "应自动提交threshold压缩");
	assert.equal(aborts.value, 0, "历史编辑重算成功不应中止会话");
});

test("持续变化时重算次数受单次压缩请求上限约束", { timeout: 20_000 }, async () => {
	let session: Session | undefined;
	const aborts = { value: 0 };
	let changes = 0;
	let postCompactionPromptCount = 0;
	const result = await run({
		setup: async (current) => {
			session = current;
			spyAbort(current, aborts);
		},
		steps: ["多次读取并整理笔记"],
		chat: (n) => {
			if (n < 14) return readNotes();
			if (changes > 0) {
				postCompactionPromptCount++;
				return say("保护后的新请求");
			}
			return say("笔记整理完成");
		},
		summary: (n, req) => {
			if (session && n < MAX_REQUESTS + 2) {
				session.sessionManager.appendCustomMessageEntry("t02c-churn", `持续变化${n}`, false);
				changes++;
			}
			return goodSummary(req);
		},
	});
	assert.ok(changes > 0);
	assert.ok(result.requests.filter((request) => request.summary).length <= MAX_REQUESTS, "连续变化不得超过单次压缩请求上限");
	assert.equal(result.compactions.filter((entry) => (entry.details as { reason?: string })?.reason === "threshold").length, 0, "预算耗尽时不得提交过期摘要");
	const persisted = result.entries.filter((entry) => entry.type === "custom" && entry.customType === STATE_TYPE).at(-1);
	assert.equal((persisted?.data as { r5?: { reason?: string } } | undefined)?.r5?.reason, "failed", "预算耗尽应持久化R5失败状态");
	assert.equal(postCompactionPromptCount, 0, "失败保护生效后主请求不得越过停止边界");
	assert.ok(aborts.value > 0, "不可恢复的重算耗尽应中止运行");
});

test("用户取消摘要后不启动重算", { timeout: 20_000 }, async () => {
	let session: Session | undefined;
	const result = await run({
		setup: async (current) => { session = current; },
		steps: ["多次读取并整理笔记"],
		chat: (n) => n < 14 ? readNotes() : say("笔记整理完成"),
		summary: (n, req) => {
			if (n === 0) {
				assert.ok(session);
				void session.abort();
			}
			return goodSummary(req);
		},
	});
	assert.ok(!result.compactions.some((entry) => (entry.details as { reason?: string })?.reason === "threshold"), "Esc终止的本次自动压缩不得提交");
});
