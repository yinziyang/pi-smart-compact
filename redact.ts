// 脱敏（方案 11.4）：在送给摘要模型之前、写交接文档与召回结果之前替换密钥。
// 模型输出不做事后替换，只用 containsSecret 判定不合格，因为替换会改变 token 数。

const MASK = "[已脱敏]";

/** 每条规则匹配一类密钥；键值类规则保留键名，只替换值。 */
const RULES: { re: RegExp; keepGroup?: number }[] = [
	{ re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
	{ re: /\bsk-[A-Za-z0-9_-]{16,}/g },
	{ re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
	{ re: /\bghp_[A-Za-z0-9]{20,}/g },
	{ re: /\bAKIA[0-9A-Z]{16}\b/g },
	{ re: /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, keepGroup: 1 },
	// 键值类只认同时含字母与数字、至少 6 个字符的值，避免把「token: 8192」这类普通文字当成密钥，导致摘要被反复判为不合格。
	{ re: /(\b(?:password|passwd|secret|token|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)(?=[^\s"',;]*\d)(?=[^\s"',;]*[A-Za-z])[^\s"',;]{6,}/gi, keepGroup: 1 },
];

/** 替换文本中的全部密钥。 */
export function redact(s: string): string {
	let out = s;
	for (const { re, keepGroup } of RULES) {
		out = out.replace(re, (...m: string[]) => (keepGroup ? `${m[keepGroup]}${MASK}` : MASK));
	}
	return out;
}

/** 文本中是否仍有匹配脱敏规则的内容。 */
export function containsSecret(s: string): boolean {
	return RULES.some(({ re }) => {
		re.lastIndex = 0;
		const hit = re.test(s);
		re.lastIndex = 0;
		return hit;
	});
}

/** 深拷贝任意 JSON 值，并对其中每个字符串脱敏。 */
export function redactDeep<T>(v: T): T {
	if (typeof v === "string") return redact(v) as T;
	if (Array.isArray(v)) return v.map((x) => redactDeep(x)) as T;
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) out[k] = redactDeep(x);
		return out as T;
	}
	return v;
}
