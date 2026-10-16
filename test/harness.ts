// faux 集成测试工具（方案 12.4、F50）：在同一进程内用 pi-ai 的 faux provider 驱动完整的 pi 会话，加载本扩展，不发生真实调用。

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, type ExtensionFactory, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { PACK_CLOSE, PACK_OPEN } from "../pack.ts";
import { realDeps, smartCompact } from "../index.ts";

export type Session = Awaited<ReturnType<typeof createAgentSession>>["session"];

export type Entry = Record<string, unknown> & { type?: string; id?: string; customType?: string; details?: Record<string, unknown>; message?: Record<string, unknown> };

export const GOOD_NARRATIVE = [
	"## Goal",
	"读取 notes.md 并整理其中的要点",
	"## Constraints & Preferences",
	"- 不要修改 test/ 目录",
	"## Progress",
	"### Done",
	"- [x] 已多次读取 notes.md",
	"## Key Decisions",
	"(none)",
	"## Next Steps",
	"1. 继续整理 notes.md 的要点",
	"## Critical Context",
	"(none)",
].join("\n");

export interface Request {
	n: number;
	summary: boolean;
	/** 最后一条消息的文本（摘要请求即整段提示词）。 */
	text: string;
	/** 全部消息的文本，用于检查模型实际看到了什么。 */
	all: string;
	lastRole: string;
}

export interface RunOptions {
	/** 只替换版本诊断字符串，缺省使用实际 SDK 版本，不伪装成旧的已验证版本。 */
	piVersion?: string;
	settings?: Record<string, unknown>;
	contextWindow?: number;
	config?: Record<string, unknown>;
	env?: Record<string, string>;
	factories?: ExtensionFactory[];
	/** 每一步是一条提示词，或一个直接操作会话的函数（例如手动压缩）。 */
	steps: (string | ((session: Session) => Promise<void>))[];
	/** 普通对话请求的脚本，n 为该类请求的序号（从 0 开始）。 */
	chat: (n: number, req: Request) => AssistantMessage;
	/** 摘要请求的脚本，缺省为回填合格的叙述与压缩包。 */
	summary?: (n: number, req: Request) => AssistantMessage;
	/** notes.md 的行数，决定每次读取带来的上下文增量。 */
	noteLines?: number;
	/** 额外的 faux 模型（第一个模型固定为 faux/m）。 */
	extraModels?: { id: string; contextWindow: number; maxTokens: number }[];
	/** 绑定扩展之后、执行步骤之前的准备，例如切换到虚拟模型。 */
	setup?: (session: Session, runtime: ModelRuntime) => Promise<void>;
}

export interface RunResult {
	entries: Entry[];
	requests: Request[];
	handoffs: string[];
	compactions: Entry[];
	dir: string;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((b: { type?: string; text?: string }) => (b.type === "text" ? (b.text ?? "") : "")).join("\n");
}

/** 合格的摘要输出：叙述加上（模型输出模式时）原样回填请求中的压缩包数据。 */
export function goodSummary(req: Request): AssistantMessage {
	const i = req.text.lastIndexOf(PACK_OPEN);
	const j = req.text.lastIndexOf(PACK_CLOSE);
	const pack = i >= 0 && j > i ? `\n\n${req.text.slice(i, j + PACK_CLOSE.length)}` : "";
	return fauxAssistantMessage(fauxText(`${GOOD_NARRATIVE}${pack}`));
}

export const readNotes = () => fauxAssistantMessage(fauxToolCall("read", { path: "notes.md" }), { stopReason: "toolUse" });
export const say = (t: string) => fauxAssistantMessage(fauxText(t));

function readJsonl(file: string): Entry[] {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((l) => l.trim())
		.map((l) => JSON.parse(l) as Entry);
}

function walk(d: string, pred: (name: string) => boolean): string[] {
	if (!existsSync(d)) return [];
	const out: string[] = [];
	for (const x of readdirSync(d, { withFileTypes: true })) {
		if (x.isDirectory()) out.push(...walk(join(d, x.name), pred));
		else if (pred(x.name)) out.push(join(d, x.name));
	}
	return out;
}

/** 运行一次会话并返回会话条目、请求记录与交接文档。临时目录在返回前删除，交接文档内容已读入。 */
export async function run(o: RunOptions): Promise<RunResult & { handoffTexts: string[]; logs: string[] }> {
	const dir = mkdtempSync(join(tmpdir(), "sc-test-"));
	const cwd = join(dir, "project");
	const agentDir = join(dir, "agent");
	const sessionsDir = join(agentDir, "sessions");
	mkdirSync(cwd, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(cwd, "notes.md"), "测试用的笔记内容，用来让上下文增长。\n".repeat(o.noteLines ?? 1200));
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify(o.settings ?? { retry: { enabled: false }, compaction: { enabled: true, reserveTokens: 8000, keepRecentTokens: 20000 } }));
	if (o.config) writeFileSync(join(agentDir, "smart-compact.json"), JSON.stringify(o.config));
	// faux provider 不校验凭据；这里写一个测试用的假值，不是真实密钥。
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ faux: { type: "api_key", key: "faux-test-key" } }), { mode: 0o600 });
	const requests: Request[] = [];
	const logs: string[] = [];
	try {
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
		const faux = fauxProvider({ provider: "faux", models: [{ id: "m", contextWindow: o.contextWindow ?? 60_000, maxTokens: 16_000 }, ...(o.extraModels ?? [])] });
		runtime.registerNativeProvider(faux.provider);
		await runtime.refresh({ providers: ["faux"] });
		for (let i = 0; i < 300 && !runtime.hasConfiguredAuth("faux"); i++) await new Promise((r) => setTimeout(r, 10));
		const model = runtime.getModel("faux", "m") ?? faux.getModel();
		let chats = 0;
		let summaries = 0;
		faux.setResponses(
			Array.from({ length: 400 }, () => (context: { systemPrompt?: string; messages: Array<{ role: string; content?: unknown }> }) => {
				const last = context.messages[context.messages.length - 1];
				const sys = context.messages.find((m) => m.role === "system");
				const summary = `${context.systemPrompt ?? ""}${textOf(sys?.content)}`.includes("context summarization assistant");
				const all = context.messages.map((m) => textOf(m.content) || JSON.stringify(m)).join("\n");
				const req: Request = { n: requests.length, summary, text: textOf(last?.content), all, lastRole: last?.role ?? "" };
				requests.push(req);
				if (summary) return (o.summary ?? ((_n: number, r: Request) => goodSummary(r)))(summaries++, req);
				return o.chat(chats++, req);
			}),
		);
		const env = { ...process.env, ...(o.env ?? {}) };
		const ext: ExtensionFactory = (pi) => smartCompact(pi, { ...realDeps(), agentDir, env, ...(o.piVersion === undefined ? {} : { piVersion: o.piVersion }), log: (l) => logs.push(l) });
		const loader = new DefaultResourceLoader({ cwd, agentDir, extensionFactories: [ext, ...(o.factories ?? [])] });
		await loader.reload();
		const { session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime, model, resourceLoader: loader, sessionManager: SessionManager.create(cwd, sessionsDir) });
		await session.bindExtensions({ mode: "print" });
		await o.setup?.(session, runtime);
		for (const step of o.steps) {
			if (typeof step === "string") await session.prompt(step);
			else await step(session);
			await session.agent.waitForIdle();
		}
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		const files = walk(sessionsDir, (n) => n.endsWith(".jsonl"));
		const entries = files.flatMap(readJsonl);
		const handoffs = walk(sessionsDir, (n) => n.endsWith(".md"));
		return { entries, requests, handoffs, handoffTexts: handoffs.map((h) => readFileSync(h, "utf8")), compactions: entries.filter((e) => e.type === "compaction"), dir, logs };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}
