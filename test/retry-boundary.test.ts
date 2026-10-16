import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { goodSummary, readNotes, run, say, type Session } from "./harness.ts";

test("同模型ID的窗口在摘要期间改变时不能提交旧预算结果", { timeout: 20_000 }, async () => {
	let session: Session | undefined;
	let changed = false;
	const output = await run({
		setup: async (current) => { session = current; },
		steps: ["读取笔记到达阈值"],
		chat: (n) => n < 14 ? readNotes() : say("完成"),
		summary: (n, request) => {
			if (n === 0) {
				assert.ok(session?.model);
				Object.assign(session.model, { contextWindow: 30_000 });
				changed = true;
			}
			return goodSummary(request);
		},
	});
	assert.ok(changed);
	assert.equal(output.compactions.length, 0, "旧模型预算的结果不能在新窗口下提交");
	assert.equal(output.requests.filter((request) => request.summary).length, 1, "不能用旧choice在新模型配置下继续重算");
});

test("仅元数据的分支切换也必须拒绝跨分支提交", { timeout: 20_000 }, async () => {
	let session: Session | undefined;
	let switched = false;
	const marker: ExtensionFactory = (pi) => {
		pi.on("turn_end", () => { pi.appendEntry("t02c-branch-marker", { progress: 1 }); });
	};
	const output = await run({
		factories: [marker],
		setup: async (current) => { session = current; },
		steps: ["读取笔记到达阈值"],
		chat: (n) => n < 14 ? readNotes() : say("完成"),
		summary: (n, request) => {
			if (n === 0) {
				assert.ok(session);
				const manager = session.sessionManager;
				const leaf = manager.getLeafEntry();
				assert.equal(leaf?.type, "custom", "必须制造只移除元数据的分支切换");
				assert.ok(leaf?.parentId);
				const messages = JSON.stringify(manager.buildSessionProjection().messages);
				manager.branch(leaf.parentId);
				assert.equal(JSON.stringify(manager.buildSessionProjection().messages), messages, "该反例的可见消息必须完全相同");
				switched = true;
			}
			return goodSummary(request);
		},
	});
	assert.ok(switched, "必须实际执行分支切换");
	assert.equal(output.compactions.length, 0, "可见消息相同不能代替分支身份校验");
});

test("编辑旧摘要之前的历史时，即使投影相同也必须丢弃旧叙述重建", { timeout: 20_000 }, async () => {
	let session: Session | undefined;
	let preparing = true;
	let edited = false;
	let target = "";
	const output = await run({
		settings: { retry: { enabled: false }, compaction: { enabled: false, reserveTokens: 8000, keepRecentTokens: 1000 } },
		setup: async (current) => { session = current; },
		steps: ["原始机密 OLD_FACT_771，读取笔记", async (current) => {
			const branch = current.sessionManager.getBranch();
			target = branch.find((entry) => entry.type === "message" && entry.message.role === "user")!.id;
			const initial = await current.compact();
			const currentBranch = current.sessionManager.getBranch();
			assert.ok(currentBranch.findIndex((entry) => entry.id === target) < currentBranch.findIndex((entry) => entry.id === initial.firstKeptEntryId));
			preparing = false;
			current.setAutoCompactionEnabled(true);
		}, "继续读取笔记"],
		chat: (n) => n < (preparing ? 6 : 20) ? readNotes() : say("完成"),
		summary: (_n, request) => {
			if (!preparing && !edited) {
				assert.ok(session);
				const manager = session.sessionManager;
				const before = JSON.stringify(manager.buildSessionProjection().messages);
				manager.appendContextEdit(target, null);
				assert.equal(JSON.stringify(manager.buildSessionProjection().messages), before, "编辑必须发生在已被旧摘要覆盖的历史中");
				edited = true;
			}
			return goodSummary(request);
		},
	});
	assert.ok(edited);
	const rebuilt = output.compactions.find((entry) => entry.details?.reason === "threshold" && entry.details.rebuild === true);
	assert.ok(rebuilt, output.logs.join(" | "));
	assert.ok(!String(rebuilt.summary).includes("OLD_FACT_771"));
	assert.ok(!output.requests.filter((request) => request.summary).at(-1)?.text.includes("OLD_FACT_771"));
});
