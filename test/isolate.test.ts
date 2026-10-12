import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { assertAuthFresh, createIsolatedEnv, withWindowOverride } from "../eval/isolate.ts";

const root = mkdtempSync(join(tmpdir(), "sc-isolate-"));
after(() => rmSync(root, { recursive: true, force: true }));

const src = join(root, "src");
mkdirSync(src);
writeFileSync(join(src, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", expires: 2_000_000 }, other: { key: "secret" } }));
writeFileSync(join(src, "models.json"), JSON.stringify({ providers: { "openai-codex": { modelOverrides: { "gpt-x": { name: "X" } } }, p2: { baseUrl: "u" } } }));
writeFileSync(join(src, "models-store.json"), "{}");

test("withWindowOverride 保留已有字段，只写 contextWindow", () => {
	const out = withWindowOverride({ providers: { a: { modelOverrides: { m: { name: "n" } }, baseUrl: "b" } } }, "a", "m", 160000);
	assert.deepEqual(out, { providers: { a: { modelOverrides: { m: { name: "n", contextWindow: 160000 } }, baseUrl: "b" } } });
	assert.deepEqual(withWindowOverride({}, "a", "m", 1), { providers: { a: { modelOverrides: { m: { contextWindow: 1 } } } } });
});

test("createIsolatedEnv：只带被测 provider 凭据、设置从零生成、窗口覆盖、权限与白名单环境", () => {
	const iso = createIsolatedEnv({
		sourceAgentDir: src,
		rootDir: join(root, "iso"),
		provider: "openai-codex",
		modelId: "gpt-x",
		compaction: { enabled: true, reserveTokens: 32768, keepRecentTokens: 20000 },
		contextWindowOverride: 160000,
		packages: ["/tmp/ext"],
	});
	const auth = JSON.parse(readFileSync(join(iso.agentDir, "auth.json"), "utf8"));
	assert.deepEqual(Object.keys(auth), ["openai-codex"]);
	assert.equal(statSync(join(iso.agentDir, "auth.json")).mode & 0o777, 0o600);
	const settings = JSON.parse(readFileSync(join(iso.agentDir, "settings.json"), "utf8"));
	assert.deepEqual(settings, {
		defaultProvider: "openai-codex",
		defaultModel: "gpt-x",
		compaction: { enabled: true, reserveTokens: 32768, keepRecentTokens: 20000 },
		packages: ["/tmp/ext"],
	});
	const models = JSON.parse(readFileSync(join(iso.agentDir, "models.json"), "utf8"));
	assert.deepEqual(models.providers["openai-codex"].modelOverrides["gpt-x"], { name: "X", contextWindow: 160000 });
	assert.deepEqual(models.providers.p2, { baseUrl: "u" });
	assert.deepEqual(Object.keys(iso.env).sort(), ["HOME", "PATH", "PI_CODING_AGENT_DIR"]);
	assert.equal(iso.env.HOME, iso.homeDir);
	assert.equal(statSync(join(root, "iso")).mode & 0o777, 0o700);
	iso.cleanup();
	assert.throws(() => statSync(join(root, "iso")));
});

test("assertAuthFresh：有效期不足时报错，足够时返回剩余毫秒，非 OAuth 返回 Infinity", () => {
	assert.equal(assertAuthFresh(src, "openai-codex", 500_000, () => 1_000_000), 1_000_000);
	assert.throws(() => assertAuthFresh(src, "openai-codex", 2_000_000, () => 1_000_000), /不足本次运行所需/);
	assert.equal(assertAuthFresh(src, "other", 1), Number.POSITIVE_INFINITY);
	assert.throws(() => assertAuthFresh(src, "missing", 1), /没有 provider/);
});
