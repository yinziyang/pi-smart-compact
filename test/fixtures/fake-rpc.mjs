// 测试用的假 RPC 子进程：逐行读取 stdin 的 JSON 命令，回一条 response；prompt 命令再发一条 agent_settled 事件。
// stdin 关闭后写一个会话文件（FAKE_SESSION_FILE）并退出，模拟 pi 的有序退出。
import { writeFileSync } from "node:fs";

let buf = "";
let prompts = 0;
process.stdin.on("data", (d) => {
	buf += String(d);
	let nl = buf.indexOf("\n");
	while (nl >= 0) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		const cmd = JSON.parse(line);
		process.stdout.write(`${JSON.stringify({ id: cmd.id, type: "response", command: cmd.type, success: true })}\n`);
		if (cmd.type === "prompt") {
			prompts++;
			process.stdout.write(`${JSON.stringify({ type: "agent_settled", n: prompts, text: "含 分隔符" })}\n`);
		}
		nl = buf.indexOf("\n");
	}
});
process.stdin.on("end", () => {
	if (process.env.FAKE_SESSION_FILE) {
		const usage = { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } };
		const lines = Array.from({ length: prompts }, () => JSON.stringify({ type: "message", message: { role: "assistant", usage } }));
		writeFileSync(process.env.FAKE_SESSION_FILE, `${lines.join("\n")}\n`);
	}
	process.exit(0);
});
