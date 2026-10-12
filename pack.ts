// 压缩包：从「应用了 context_edit 的原始分支」抽取各节，按预算组装，以及模型输出模式下的逐节校验（方案 5.1、5.3、5.2 第 7 步）。
//
// 结构约定：
//   - 压缩包以 `<smart-compact-pack v="1">` 开始、`</smart-compact-pack>` 结束，内含六个固定标题的小节，顺序见 HEADINGS。
//   - 每个条目以带编号的行开头，例如 `- [v1] ...`；编号前缀 v、e、u、s、f、h 分别属于验证、失败、用户原话、skill、已修改文件、交接与召回。
//   - 自由文本（用户原话、错误尾部）每行加前缀 `│ `，解析时跳过这些行，所以其中伪造的标题、编号与压缩包标记都不会被当作结构。
//   - 单行字段（命令、路径、工具名）里形如 `[v1]` 的编号与压缩包标记会被替换成全角形式，同样不会被解析。

import { estC, utf8Bytes } from "./budget.ts";
import { contentText, messageText, toolCalls, type RawEntry } from "./edits.ts";
import { redact } from "./redact.ts";

export const PACK_OPEN = '<smart-compact-pack v="1">';
export const PACK_CLOSE = "</smart-compact-pack>";
export const ESCAPE = "│ ";

export const HEADINGS = [
	"## 验证记录（命令 → 结果）",
	"## 最近失败（原文尾部）",
	"## 用户原话（按时间倒序，原文）",
	"## 已加载的 skill（需要时重新 read）",
	"## 文件（已修改 / 已读取，按最近排序）",
	"## 交接文档与召回",
] as const;

const SKILL_NOTE = "这些 skill 的正文已随压缩移出上下文，下一步若与之相关，先 read 对应 SKILL.md 再继续。";
const RESUME_STEPS = ["1. 按 Next Steps 继续。", "2. 修改任何文件前先重新 read，不凭记忆。", "3. 相关 skill 先重新 read。", "4. 细节不确定时调用 recall_history，不要猜。"];

/** 验证记录匹配的命令模式（方案 5.3）。 */
const VERIFY_RE = /(^|[\s;&|(/])(test|tests|build|lint|tsc|vet|pytest|cargo|go\s+test|go\s+build|npm\s+(run|test|ci)|pnpm|yarn|make|jest|vitest|mypy|ruff|eslint|gradle|mvn)(\b|$)/;
const SKILL_BLOCK_RE = /<skill name="([^"]*)" location="([^"]*)">[\s\S]*?<\/skill>/g;

const FAIL_KEEP = 3;
const FAIL_TAIL_CHARS = 1200;
/** 截断后的失败条目至少保留的原文尾部，单位 estC。 */
const FAIL_MIN_TAIL_EST = 20;
const ANCHOR_CHARS = 120;
const USER_MAX_EST = 1500;
const USER_HEAD_EST = 1000;
const USER_TAIL_EST = 400;
const LOCAL_MAX_MODIFIED = 80;
const LOCAL_MAX_READ = 40;

/** pi 溢出恢复省略的执行记录，格式见方案第 8 节。 */
export interface RecoveryRecord {
	editId: string;
	targetId: string;
	role: string;
	toolName?: string;
	content: unknown;
}

export interface VerifyItem {
	cmd: string;
	status: string;
}
export interface FailureItem {
	tool: string;
	entryId: string;
	tail: string;
	anchor: string;
}
export interface UserItem {
	entryId: string;
	text: string;
}
export interface SkillItem {
	name: string;
	path: string;
}

/** 未裁剪的压缩包数据；文本已脱敏。 */
export interface PackData {
	verify: VerifyItem[];
	failures: FailureItem[];
	users: UserItem[];
	skills: SkillItem[];
	modified: string[];
	read: string[];
	handoffPath?: string;
}

export interface PackInput {
	/** 应用了 context_edit 的原始分支，按时间顺序。 */
	entries: readonly RawEntry[];
	/** 保留区内的条目 id，其中的用户消息不重复收录。 */
	keptIds: ReadonlySet<string>;
	/** 本次恢复省略的执行记录，作为最近的失败收录。 */
	omitted: readonly RecoveryRecord[];
	handoffPath?: string;
}

/** 单行化并中和编号与标记，用于命令、路径、工具名等单行字段。 */
export function neutralize(s: string): string {
	return s
		.replace(/\r?\n/g, " ⏎ ")
		.replace(/\[([veusfh]\d+)\]/g, "［$1］")
		.replace(/<(\/?)smart-compact-pack/g, "‹$1smart-compact-pack");
}

/** 多行自由文本：每行加转义前缀，编号与标记同样中和。 */
export function escapeBlock(s: string): string {
	return s
		.split(/\r?\n/)
		.map((l) => `${ESCAPE}${l.replace(/\[([veusfh]\d+)\]/g, "［$1］").replace(/<(\/?)smart-compact-pack/g, "‹$1smart-compact-pack")}`)
		.join("\n");
}

/** 按估算 token 取头部；fromEnd 为真时取尾部。只在 code point 边界截断。 */
export function sliceByEst(s: string, tokens: number, fromEnd = false): string {
	const chars = [...s];
	if (fromEnd) chars.reverse();
	let acc = 0;
	let i = 0;
	for (; i < chars.length; i++) {
		acc += chars[i].codePointAt(0)! < 0x80 ? 1 / 3.5 : 1.2;
		if (acc > tokens) break;
	}
	const kept = chars.slice(0, i);
	if (fromEnd) kept.reverse();
	return kept.join("");
}

function exitStatus(result: RawEntry | undefined): string {
	const m = result?.message;
	if (!m) return "未完成";
	const code = /Command exited with code (\d+)/.exec(contentText(m.content));
	if (code) return `退出码 ${code[1]}`;
	return m.isError ? "出错" : "退出码 0";
}

function stripSkills(text: string, skills: SkillItem[]): string {
	return text.replace(SKILL_BLOCK_RE, (_m, name: string, location: string) => {
		skills.push({ name, path: location });
		return "";
	});
}

function truncateUser(text: string, entryId: string): string {
	if (estC(text) <= USER_MAX_EST) return text;
	return `${sliceByEst(text, USER_HEAD_EST)}…[已截断，recall_history entryId=${entryId} 可取全文]…${sliceByEst(text, USER_TAIL_EST, true)}`;
}

function failureFrom(tool: string, entryId: string, text: string): FailureItem {
	const tail = redact(text).slice(-FAIL_TAIL_CHARS);
	const lines = tail.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
	const anchor = (lines.at(-1) ?? "").slice(-ANCHOR_CHARS);
	return { tool: neutralize(tool), entryId, tail, anchor };
}

/** 从应用了 context_edit 的原始分支抽取全部压缩包数据（未裁剪，已脱敏）。 */
export function extractPack(input: PackInput): PackData {
	const results = new Map<string, RawEntry>();
	for (const e of input.entries) if (e.message?.role === "toolResult" && e.message.toolCallId) results.set(e.message.toolCallId, e);

	const verify = new Map<string, string>();
	const failures: FailureItem[] = [];
	const users: UserItem[] = [];
	const skills: SkillItem[] = [];
	const modified: string[] = [];
	const read: string[] = [];

	for (const e of input.entries) {
		const m = e.message;
		if (!m) continue;
		if (m.role === "assistant") {
			for (const call of toolCalls(m)) {
				const path = typeof call.args.path === "string" ? call.args.path : undefined;
				if (call.name === "bash" && typeof call.args.command === "string" && VERIFY_RE.test(call.args.command)) {
					const cmd = neutralize(redact(call.args.command));
					verify.delete(cmd);
					verify.set(cmd, exitStatus(results.get(call.id)));
				} else if ((call.name === "edit" || call.name === "write") && path) modified.push(path);
				else if (call.name === "read" && path) {
					read.push(path);
					if (path.endsWith("/SKILL.md")) skills.push({ name: path.split("/").at(-2) ?? path, path });
				}
			}
		} else if (m.role === "bashExecution" && typeof m.command === "string" && VERIFY_RE.test(m.command)) {
			const cmd = neutralize(redact(m.command));
			verify.delete(cmd);
			verify.set(cmd, typeof m.exitCode === "number" ? `退出码 ${m.exitCode}` : "出错");
		} else if (m.role === "toolResult" && m.isError) {
			failures.push(failureFrom(m.toolName ?? "tool", e.id, contentText(m.content)));
		} else if (m.role === "user") {
			const rest = stripSkills(messageText(m), skills).trim();
			if (rest && !input.keptIds.has(e.id)) users.push({ entryId: e.id, text: truncateUser(redact(rest), e.id) });
		}
	}
	for (const r of input.omitted) {
		if (r.role === "toolResult") failures.push(failureFrom(r.toolName ?? "tool", r.targetId, contentText(r.content)));
	}

	const recentUnique = (xs: string[]) => [...new Set([...xs].reverse())];
	const mod = recentUnique(modified).map((p) => neutralize(redact(p)));
	const modSet = new Set(mod);
	const skillSeen = new Set<string>();
	const skillList: SkillItem[] = [];
	for (const s of [...skills].reverse()) {
		if (skillSeen.has(s.path)) continue;
		skillSeen.add(s.path);
		skillList.push({ name: neutralize(redact(s.name)), path: neutralize(redact(s.path)) });
	}
	return {
		verify: [...verify].reverse().map(([cmd, status]) => ({ cmd, status })),
		failures: failures.slice(-FAIL_KEEP).reverse(),
		users: users.reverse(),
		skills: skillList,
		modified: mod,
		read: recentUnique(read).map((p) => neutralize(redact(p))).filter((p) => !modSet.has(p)),
		handoffPath: input.handoffPath ? neutralize(input.handoffPath) : undefined,
	};
}

/** 一个可裁剪的条目：编号、所属小节下标与渲染后的文本。 */
interface Item {
	id: string | null;
	section: number;
	text: string;
}

function items(data: PackData, maxModified: number, maxRead: number): Item[] {
	const out: Item[] = [];
	data.verify.forEach((v, i) => out.push({ id: `v${i + 1}`, section: 0, text: `- [v${i + 1}] \`${v.cmd}\` → ${v.status}` }));
	data.failures.forEach((f, i) => out.push({ id: `e${i + 1}`, section: 1, text: `- [e${i + 1}] ${f.tool}（entryId=${f.entryId}）锚点：${neutralize(f.anchor)}\n${escapeBlock(f.tail)}` }));
	data.users.forEach((u, i) => out.push({ id: `u${i + 1}`, section: 2, text: `- [u${i + 1}] entryId=${u.entryId}\n${escapeBlock(u.text)}` }));
	data.skills.forEach((s, i) => out.push({ id: `s${i + 1}`, section: 3, text: `- [s${i + 1}] ${s.name} — ${s.path}` }));
	data.modified.slice(0, maxModified).forEach((p, i) => out.push({ id: `f${i + 1}`, section: 4, text: `- [f${i + 1}] 已修改：${p}` }));
	data.read.slice(0, maxRead).forEach((p) => out.push({ id: null, section: 4, text: `- 已读取：${p}` }));
	return out;
}

function handoffText(data: PackData): string {
	const where = data.handoffPath ? `交接文档：${data.handoffPath}。` : "";
	return [`- [h1] ${where}细节不确定时调用 recall_history（query 为空格分隔的关键词，或 entryId 取某条记录全文）取回压缩前的原文。`, ...RESUME_STEPS.map((s) => `  ${s}`)].join("\n");
}

function render(list: readonly Item[], data: PackData): string {
	const parts: string[] = [PACK_OPEN];
	HEADINGS.forEach((h, s) => {
		parts.push(h);
		for (const it of list) if (it.section === s) parts.push(it.text);
		if (s === 3 && list.some((it) => it.section === 3)) parts.push(SKILL_NOTE);
		if (s === 5) parts.push(handoffText(data));
	});
	parts.push(PACK_CLOSE);
	return parts.join("\n");
}

/** 截断条目文本：保留首行（编号、工具名、锚点），其余部分保留尾部，因为报错与结论通常在末尾。 */
function keepHeadLineAndTail(text: string, tokens: number): string {
	const nl = text.indexOf("\n");
	if (nl < 0) return sliceByEst(text, tokens);
	const head = text.slice(0, nl);
	const rest = sliceByEst(text.slice(nl + 1), Math.max(0, tokens - estC(head) - 1), true);
	return rest ? `${head}\n${rest.startsWith(ESCAPE) ? rest : `${ESCAPE}${rest}`}` : head;
}

/**
 * 按 estC 目标 Pt 选取条目：验证与失败合计不超过 25%，用户原话不超过 55%，其余各节共用剩下的部分，未用额度依次让给后面的节（方案 7.2）。
 * 交接与召回一节总是保留，它的额度先从 Pt 中扣除。单个条目放不下时截断它的文本。
 * 第一组里最近失败先选，最多占组内额度的 60% 并按条数平分，剩下的给验证记录：验证命令很多的会话里，按顺序先放验证记录会把失败全部挤掉（回放评测实测）。
 */
function selectByEst(all: readonly Item[], data: PackData, Pt: number): Item[] {
	const fixed = estC(render([], data));
	let left = Math.max(0, Pt - fixed);
	const groups: { sections: number[]; share: number }[] = [
		{ sections: [1, 0], share: 0.25 },
		{ sections: [2], share: 0.55 },
		{ sections: [3, 4], share: 1 },
	];
	const chosen: Item[] = [];
	let carry = 0;
	for (const g of groups) {
		let room = Math.min(left, Math.floor(g.share * Math.max(0, Pt - fixed)) + carry);
		const spentBefore = room;
		// 失败条目的额度：最多占组内 60%，按条数平分；每条至少要放下首行与一小段尾部，放不下时减少条数（保留最近的）。
		const failures = all.filter((it) => it.section === 1);
		const failRoom = Math.floor(0.6 * room);
		const minCost = (it: Item) => estC(it.text.split("\n", 1)[0]) + FAIL_MIN_TAIL_EST + 2;
		let failCount = failures.length;
		while (failCount > 0 && Math.floor(failRoom / failCount) < Math.max(...failures.slice(0, failCount).map(minCost))) failCount--;
		const failEach = failCount ? Math.floor(failRoom / failCount) : 0;
		const failKeep = new Set(failures.slice(0, failCount));
		for (const sec of g.sections) {
			for (const it of priorityOrder(all, sec)) {
				const cost = estC(it.text) + 1;
				if (sec === 1) {
					if (!failKeep.has(it)) continue;
					const text = cost <= failEach ? it.text : keepHeadLineAndTail(it.text, failEach - 2);
					chosen.push({ ...it, text });
					room -= estC(text) + 1;
				} else if (cost <= room) {
					chosen.push(it);
					room -= cost;
				} else if (room > 40 && it.section !== 4) {
					chosen.push({ ...it, text: sliceByEst(it.text, room - 2) });
					room = 0;
				}
			}
		}
		left -= spentBefore - room;
		carry = room;
	}
	// 恢复输入顺序：render 按小节输出，节内按这里的顺序。
	const pos = new Map(all.map((it, i) => [it, i]));
	return chosen.sort((a, b) => (pos.get(original(all, a)) ?? 0) - (pos.get(original(all, b)) ?? 0));
}

/**
 * 某一节条目的选取顺序。用户原话按时间倒序排列，但最早的一条（通常是任务的原始需求与约束）排在第一位优先保证收录：
 * 只按倒序选取时，额度不够会最先挤掉它（回放评测实测，关键约束因此遗漏）。
 */
function priorityOrder(all: readonly Item[], sec: number): Item[] {
	const items = all.filter((it) => it.section === sec);
	if (sec !== 2 || items.length < 2) return items;
	return [items[items.length - 1], ...items.slice(0, -1)];
}

/** 截断后的条目对应的原条目（按编号与小节匹配；无编号的条目按文本匹配）。 */
function original(all: readonly Item[], it: Item): Item {
	return all.find((x) => x.section === it.section && (it.id !== null ? x.id === it.id : x.text === it.text)) ?? it;
}

/** 只在 UTF-8 code point 边界截断到不超过 maxBytes 字节。 */
export function truncateBytes(s: string, maxBytes: number): string {
	if (utf8Bytes(s) <= maxBytes) return s;
	let out = "";
	let bytes = 0;
	for (const ch of s) {
		const b = utf8Bytes(ch);
		if (bytes + b > maxBytes) break;
		out += ch;
		bytes += b;
	}
	return out;
}

/**
 * 本地模式的最终压缩包：先按 Pt 用 estC 选取，再按 Pb 用 UTF-8 字节数从后面的小节往前裁。
 * 交接与召回一节不参与裁剪，它包含召回入口与压缩后的固定步骤。
 */
export function renderLocal(data: PackData, Pt: number, Pb: number): string {
	let list = selectByEst(items(data, LOCAL_MAX_MODIFIED, LOCAL_MAX_READ), data, Pt);
	let text = render(list, data);
	while (utf8Bytes(text) > Pb && list.length > 0) {
		const over = utf8Bytes(text) - Pb;
		const last = list[list.length - 1];
		const lastBytes = utf8Bytes(last.text);
		if (lastBytes > over + 40 && last.section !== 4) {
			list = [...list.slice(0, -1), { ...last, text: truncateBytes(last.text, lastBytes - over - 4) }];
		} else {
			list = list.slice(0, -1);
		}
		text = render(list, data);
	}
	// 只剩固定部分仍超限时，按字节截断整段；正常参数下固定部分远小于 Pb。
	return utf8Bytes(text) <= Pb ? text : truncateBytes(text, Pb);
}

/** 完整压缩包，不裁剪，用于交接文档与 details.pack。 */
export function renderFull(data: PackData): string {
	return render(items(data, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY), data);
}

/** 模型输出模式下随请求发给模型的压缩包数据与校验所需的期望。 */
export interface ModelPackData {
	text: string;
	expected: Expected[];
}

/** 一个预期编号及其必须逐字出现的内容。 */
export interface Expected {
	id: string;
	section: number;
	mustContain: string[];
	/** 用户原话：编号后必须带 entryId 且正文非空。 */
	needsBody?: boolean;
}

/** 按 Pt 选取后生成模型输出模式的压缩包数据。 */
export function renderModelData(data: PackData, Pt: number): ModelPackData {
	const selected = selectByEst(items(data, LOCAL_MAX_MODIFIED, LOCAL_MAX_READ), data, Pt);
	const expected: Expected[] = [];
	const list: Item[] = [];
	for (const it of selected) {
		const e = it.id ? expectationFor(data, it.id) : null;
		// 条目被裁剪后不再完整包含逐字凭据（命令、状态、锚点、路径、entryId）时整条舍弃，不能靠放宽校验接受它。
		if (e && !e.mustContain.every((s) => it.text.split("\n").some((l) => structural(l) && l.includes(s)))) continue;
		list.push(it);
		if (e) expected.push(e);
	}
	expected.push({ id: "h1", section: 5, mustContain: [data.handoffPath, "recall_history"].filter((x): x is string => !!x) });
	return { text: render(list, data), expected };
}

/** 一个编号条目在模型输出中必须逐字保留的内容。 */
function expectationFor(data: PackData, id: string): Expected | null {
	const n = Number(id.slice(1)) - 1;
	switch (id[0]) {
		case "v":
			return { id, section: 0, mustContain: [data.verify[n].cmd, data.verify[n].status] };
		case "e":
			return { id, section: 1, mustContain: [data.failures[n].tool, neutralize(data.failures[n].anchor)].filter(Boolean) };
		case "u":
			return { id, section: 2, mustContain: [`entryId=${data.users[n].entryId}`], needsBody: true };
		case "s":
			return { id, section: 3, mustContain: [data.skills[n].path] };
		case "f":
			return { id, section: 4, mustContain: [data.modified[n]] };
		default:
			return null;
	}
}

/** 模型输出中压缩包开始标记之前的部分，即叙述摘要。没有标记时返回全文。 */
export function narrativePart(output: string): string {
	const lines = output.split("\n");
	const i = lines.findIndex((l) => l.trim() === PACK_OPEN);
	return i < 0 ? output : lines.slice(0, i).join("\n");
}

/** 只识别没有转义前缀的行。 */
function structural(line: string): boolean {
	return !line.startsWith(ESCAPE) && !line.startsWith(ESCAPE.trim());
}

/**
 * 校验模型输出中的压缩包（方案 5.2 第 7 步）。返回问题列表，空数组表示合格。
 * 编号只在非转义行中识别；每个条目的范围是从它的编号行到下一个编号行或小节结束。
 */
export function validateModelPack(output: string, expected: readonly Expected[]): string[] {
	const problems: string[] = [];
	const lines = output.split("\n");
	const opens = lines.flatMap((l, i) => (structural(l) && l.trim() === PACK_OPEN ? [i] : []));
	const closes = lines.flatMap((l, i) => (structural(l) && l.trim() === PACK_CLOSE ? [i] : []));
	if (opens.length !== 1 || closes.length !== 1 || closes[0] < opens[0]) return ["压缩包边界缺失或重复"];
	const body = lines.slice(opens[0] + 1, closes[0]);
	const headIdx = body.flatMap((l, i) => (structural(l) && l.startsWith("## ") ? [i] : []));
	const heads = headIdx.map((i) => body[i].trim());
	if (heads.length !== HEADINGS.length || heads.some((h, i) => h !== HEADINGS[i])) return ["小节标题缺失、多余或顺序不对"];

	// 每个编号出现的位置：小节下标与条目文本。
	const seen = new Map<string, { section: number; text: string }[]>();
	headIdx.forEach((start, s) => {
		const end = s + 1 < headIdx.length ? headIdx[s + 1] : body.length;
		let current: { id: string; lines: string[] } | null = null;
		const flush = () => {
			if (!current) return;
			const list = seen.get(current.id) ?? [];
			list.push({ section: s, text: current.lines.join("\n") });
			seen.set(current.id, list);
			current = null;
		};
		for (let i = start + 1; i < end; i++) {
			const l = body[i];
			const ids = structural(l) ? [...l.matchAll(/\[([veusfh]\d+)\]/g)].map((m) => m[1]) : [];
			if (ids.length > 0) {
				flush();
				for (const id of ids.slice(1)) {
					const list = seen.get(id) ?? [];
					list.push({ section: s, text: l });
					seen.set(id, list);
				}
				current = { id: ids[0], lines: [l] };
			} else if (current) {
				(current as { lines: string[] }).lines.push(l);
			}
		}
		flush();
	});

	const wanted = new Set(expected.map((e) => e.id));
	for (const id of seen.keys()) if (!wanted.has(id)) problems.push(`出现输入中不存在的编号 [${id}]`);
	for (const e of expected) {
		const hits = seen.get(e.id) ?? [];
		if (hits.length !== 1) {
			problems.push(`[${e.id}] 出现 ${hits.length} 次`);
			continue;
		}
		const hit = hits[0];
		if (hit.section !== e.section) {
			problems.push(`[${e.id}] 位于错误的小节`);
			continue;
		}
		// 逐字内容必须出现在结构行里；转义的原文行允许被模型压缩，不能作为凭据。
		const structText = hit.text.split("\n").filter(structural).join("\n");
		for (const s of e.mustContain) if (!structText.includes(s)) problems.push(`[${e.id}] 缺少原文：${s.slice(0, 80)}`);
		if (e.needsBody) {
			const body = hit.text.replace(/^.*?\[u\d+\]/, "").replace(/entryId=\S+/, "").replace(/│/g, "").trim();
			if (!body) problems.push(`[${e.id}] 正文为空`);
		}
	}
	return problems;
}
