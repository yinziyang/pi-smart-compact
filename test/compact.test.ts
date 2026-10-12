import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fullText } from "../compact.ts";

const msg = (m: Record<string, unknown>) => ({ timestamp: 0, ...m }) as unknown as AgentMessage;

test("fullText 按模型可见内容估算：工具结果不截断，排除上下文的 bash 输出不计入，bash 附加文本计入", () => {
	const big = "x".repeat(10_000);
	const t = fullText([
		msg({ role: "toolResult", toolCallId: "c", toolName: "read", isError: false, content: [{ type: "text", text: big }] }),
		msg({ role: "bashExecution", command: "cat hidden", output: "h".repeat(40_000), exitCode: 0, cancelled: false, truncated: false, excludeFromContext: true }),
		msg({ role: "bashExecution", command: "ls", output: "visible-out", exitCode: 1, cancelled: false, truncated: false }),
		msg({ role: "assistant", content: [{ type: "thinking", thinking: "思考" }, { type: "toolCall", id: "c2", name: "edit", arguments: { path: "a.ts" } }], provider: "p", model: "m", api: "a", usage: {}, stopReason: "toolUse" }),
	]);
	assert.ok(t.includes(big), "工具结果全文");
	assert.ok(!t.includes("h".repeat(100)), "excludeFromContext 的输出不计入");
	assert.ok(t.includes("visible-out") && t.includes("ls"));
	assert.ok(t.includes("Command exited with code 1"), "非零退出码提示");
	const wrapped = fullText([msg({ role: "branchSummary", summary: "分支摘要正文", fromId: "x" })]);
	assert.ok(wrapped.includes("分支摘要正文") && wrapped.includes("</summary>"), "摘要包装文本");
	assert.ok(t.includes("思考") && t.includes('edit {"path":"a.ts"}'));
});
