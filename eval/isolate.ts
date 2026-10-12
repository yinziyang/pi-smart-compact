// 生成隔离的 pi 运行环境，供 P0 spike、集成测试与回放评测使用（方案 12.3 第 2 步）。
//
// 隔离内容：
//   - 配置目录：新建的 PI_CODING_AGENT_DIR，settings.json 从零生成，只含被测需要的几项。
//   - 凭据：auth.json 只保留被测 provider 的条目，权限 0600。
//   - 模型：复制 models.json 与 models-store.json；需要小窗口测试模型时，用 models.json 的 modelOverrides 覆盖 contextWindow（方案 F48），不在运行时改写模型对象。
//   - 项目目录：一个空目录，子进程以它为工作目录启动，避免加载真实项目的 .pi 配置与上下文文件。
//   - HOME：指向临时目录，环境变量只保留白名单。
// 整个根目录权限 0700，用完由调用方调用 cleanup 删除。

import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensureSafeDir } from "./ledger-file.ts";

export interface IsolateOptions {
	/** 真实配置目录，例如 ~/.pi/agent，只从中读取模型与凭据。 */
	sourceAgentDir: string;
	/** 隔离环境的根目录，不存在时创建。 */
	rootDir: string;
	provider: string;
	modelId: string;
	compaction: { enabled: boolean; reserveTokens: number; keepRecentTokens: number };
	/** 设置时，用 modelOverrides 把被测模型的 contextWindow 改成该值。 */
	contextWindowOverride?: number;
	/** 其他模型的窗口覆盖，例如虚拟模型的第二个路由目标。 */
	extraWindowOverrides?: Array<{ provider: string; modelId: string; contextWindow: number }>;
	/** 隔离配置 packages 中安装的本地扩展路径，例如 smart-compact、pi-goal、pi-subagents。 */
	packages?: string[];
	/** 额外透传给子进程的环境变量，例如本扩展的测试开关。 */
	extraEnv?: Record<string, string>;
}

export interface IsolatedEnv {
	agentDir: string;
	projectDir: string;
	homeDir: string;
	/** 子进程使用的完整环境变量，只含白名单。 */
	env: Record<string, string>;
	cleanup(): void;
}

function readJsonObject(file: string): Record<string, unknown> {
	if (!existsSync(file)) return {};
	const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`不是 JSON 对象：${file}`);
	return parsed as Record<string, unknown>;
}

function writePrivateJson(file: string, value: unknown): void {
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

/** 在 models.json 的结构中为某个 provider 的某个模型写入 contextWindow 覆盖。 */
export function withWindowOverride(models: Record<string, unknown>, provider: string, modelId: string, contextWindow: number): Record<string, unknown> {
	const providers = { ...((models.providers as Record<string, unknown> | undefined) ?? {}) };
	const entry = { ...((providers[provider] as Record<string, unknown> | undefined) ?? {}) };
	const overrides = { ...((entry.modelOverrides as Record<string, unknown> | undefined) ?? {}) };
	overrides[modelId] = { ...((overrides[modelId] as Record<string, unknown> | undefined) ?? {}), contextWindow };
	entry.modelOverrides = overrides;
	providers[provider] = entry;
	return { ...models, providers };
}

/**
 * OAuth 凭据在隔离环境中被刷新时，provider 可能轮换 refresh token，使真实配置里的旧 token 失效、真实 pi 掉登录。
 * 所以每次运行前要求 access token 的剩余有效期覆盖整次运行，运行中不会触发刷新。
 * 返回剩余毫秒数；不是 OAuth 凭据（没有 expires）时返回 Infinity；有效期不足时抛错。
 */
export function assertAuthFresh(sourceAgentDir: string, provider: string, minValidMs: number, now: () => number = Date.now): number {
	const auth = readJsonObject(join(sourceAgentDir, "auth.json"));
	const entry = auth[provider] as { expires?: unknown } | undefined;
	if (!entry) throw new Error(`auth.json 中没有 provider「${provider}」的凭据`);
	if (typeof entry.expires !== "number") return Number.POSITIVE_INFINITY;
	const remaining = entry.expires - now();
	if (remaining < minValidMs) {
		throw new Error(`「${provider}」的 access token 剩余 ${Math.round(remaining / 60000)} 分钟，不足本次运行所需的 ${Math.round(minValidMs / 60000)} 分钟。请先在真实环境中运行一次 pi 刷新登录，再重试。`);
	}
	return remaining;
}

export function createIsolatedEnv(opts: IsolateOptions): IsolatedEnv {
	ensureSafeDir(opts.rootDir);
	const agentDir = join(opts.rootDir, "agent");
	const projectDir = join(opts.rootDir, "project");
	const homeDir = join(opts.rootDir, "home");
	for (const dir of [agentDir, projectDir, homeDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });

	writePrivateJson(join(agentDir, "settings.json"), {
		defaultProvider: opts.provider,
		defaultModel: opts.modelId,
		compaction: opts.compaction,
		packages: opts.packages ?? [],
	});

	let models = readJsonObject(join(opts.sourceAgentDir, "models.json"));
	if (opts.contextWindowOverride !== undefined) models = withWindowOverride(models, opts.provider, opts.modelId, opts.contextWindowOverride);
	for (const o of opts.extraWindowOverrides ?? []) models = withWindowOverride(models, o.provider, o.modelId, o.contextWindow);
	writePrivateJson(join(agentDir, "models.json"), models);

	const store = join(opts.sourceAgentDir, "models-store.json");
	if (existsSync(store)) copyFileSync(store, join(agentDir, "models-store.json"));

	const auth = readJsonObject(join(opts.sourceAgentDir, "auth.json"));
	writePrivateJson(join(agentDir, "auth.json"), opts.provider in auth ? { [opts.provider]: auth[opts.provider] } : {});

	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: homeDir,
		PI_CODING_AGENT_DIR: agentDir,
		...(opts.extraEnv ?? {}),
	};
	return {
		agentDir,
		projectDir,
		homeDir,
		env,
		cleanup: () => rmSync(opts.rootDir, { recursive: true, force: true }),
	};
}
