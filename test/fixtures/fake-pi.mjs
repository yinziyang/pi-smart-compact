#!/usr/bin/env node
// 测试用的假 pi：不调用任何模型，按环境变量的指示写一个会话文件、休眠或直接退出。
//   FAKE_SESSION_FILE：要写的会话文件路径。
//   FAKE_REQUESTS：写入几条带 usage 的 assistant 消息，默认 1。
//   FAKE_SLEEP_MS：退出前休眠的毫秒数，用于测试超时终止。
//   FAKE_CORRUPT=1：写一行坏 JSON，用于测试用量缺失。
// 同时把收到的预算环境变量与参数写到 FAKE_SESSION_FILE + ".env.json"，供测试核对。
import { writeFileSync } from "node:fs";

const file = process.env.FAKE_SESSION_FILE;
const n = Number(process.env.FAKE_REQUESTS ?? "1");
if (file) {
	const lines = [JSON.stringify({ type: "session", id: "fake" })];
	for (let i = 0; i < n; i++) {
		lines.push(JSON.stringify({ type: "message", message: { role: "assistant", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } }));
	}
	if (process.env.FAKE_CORRUPT === "1") lines.push("{坏");
	writeFileSync(file, `${lines.join("\n")}\n`);
	writeFileSync(`${file}.env.json`, JSON.stringify({
		maxRequests: process.env.PI_BUDGET_MAX_REQUESTS,
		maxTokens: process.env.PI_BUDGET_MAX_BILLED_TOKENS,
		args: process.argv.slice(2),
	}));
}
const sleep = Number(process.env.FAKE_SLEEP_MS ?? "0");
if (sleep > 0) setTimeout(() => process.exit(0), sleep);
