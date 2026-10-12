// 脱敏（方案 11.4）：在送给摘要模型之前、写交接文档与召回结果之前替换密钥。
// 模型输出不做事后替换，只用 containsSecret 判定不合格，因为替换会改变 token 数。

const MASK = "[已脱敏]";

/** 任何赋值都视为秘密的键。 */
const SECRET_KEYS = "password|passwd|pwd|secret|client[_-]?secret|api[_-]?key|access[_-]?key|private[_-]?key";
/** token 一词常用于计量（「token: 8192」），这些键只认像凭据的值。 */
const TOKEN_KEYS = "token|auth[_-]?token|access[_-]?token|refresh[_-]?token";
const SECRET_KEY_RE = new RegExp(`^(?:${SECRET_KEYS})$`, "i");
const TOKEN_KEY_RE = new RegExp(`^(?:${TOKEN_KEYS})$`, "i");

/** 像凭据的值：至少 16 个字符，或至少 6 个字符且同时含字母与数字。 */
function credentialLike(v: string): boolean {
	return v.length >= 16 || (v.length >= 6 && /\d/.test(v) && /[A-Za-z]/.test(v));
}

/** 带格式的整段密钥，整段替换。 */
const PATTERNS: RegExp[] = [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, /\bsk-[A-Za-z0-9_-]{16,}/g, /\bgithub_pat_[A-Za-z0-9_]{20,}/g, /\bghp_[A-Za-z0-9]{20,}/g, /\bAKIA[0-9A-Z]{16}\b/g];

const BEARER = /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

// 键值赋值的值，按顺序尝试：
//   - 闭合的双引号或单引号串，允许转义（含反斜杠续行）与跨行。
//   - 未闭合的引号串（例如被截断的输出），遮蔽到行尾，宁可多遮。
//   - 到空白、逗号、分号为止的裸值。
const VALUE = `("(?:[^"\\\\]|\\\\[\\s\\S])*"|'(?:[^'\\\\]|\\\\[\\s\\S])*'|"[^\\n]*|'[^\\n]*|[^\\s"',;]+)`;
const SECRET_ASSIGN = new RegExp(`(\\b(?:${SECRET_KEYS})["']?\\s*[:=]\\s*)${VALUE}`, "gi");
const TOKEN_ASSIGN = new RegExp(`(\\b(?:${TOKEN_KEYS})["']?\\s*[:=]\\s*)${VALUE}`, "gi");

function unquote(v: string): { quote: string; inner: string } {
	const q = v[0];
	if (q !== '"' && q !== "'") return { quote: "", inner: v };
	const closed = v.length >= 2 && v.endsWith(q);
	return { quote: q, inner: closed ? v.slice(1, -1) : v.slice(1) };
}

/** 一个赋值值是否需要遮蔽；已经是占位文本的不算。 */
function assignSecret(value: string, tokenKey: boolean): boolean {
	const { inner } = unquote(value);
	if (inner === MASK || inner === "") return false;
	return tokenKey ? credentialLike(inner) : true;
}

function maskValue(value: string): string {
	const { quote } = unquote(value);
	const closed = quote !== "" && value.length >= 2 && value.endsWith(quote);
	return `${quote}${MASK}${closed ? quote : ""}`;
}

/** 替换文本中的全部密钥。 */
export function redact(s: string): string {
	let out = s;
	for (const re of PATTERNS) out = out.replace(re, MASK);
	out = out.replace(BEARER, (_m, prefix: string) => `${prefix}${MASK}`);
	out = out.replace(SECRET_ASSIGN, (m, prefix: string, value: string) => (assignSecret(value, false) ? `${prefix}${maskValue(value)}` : m));
	out = out.replace(TOKEN_ASSIGN, (m, prefix: string, value: string) => (assignSecret(value, true) ? `${prefix}${maskValue(value)}` : m));
	return out;
}

/** 文本中是否仍有匹配脱敏规则的内容。 */
export function containsSecret(s: string): boolean {
	if (PATTERNS.some((re) => new RegExp(re.source, re.flags).test(s))) return true;
	if (new RegExp(BEARER.source, BEARER.flags).test(s)) return true;
	for (const m of s.matchAll(new RegExp(SECRET_ASSIGN.source, SECRET_ASSIGN.flags))) if (assignSecret(m[2], false)) return true;
	for (const m of s.matchAll(new RegExp(TOKEN_ASSIGN.source, TOKEN_ASSIGN.flags))) if (assignSecret(m[2], true)) return true;
	return false;
}

/**
 * 深拷贝任意 JSON 值并脱敏：每个字符串按文本规则处理；对象中键名是敏感键的字符串值整体遮蔽（工具参数会被 pi 序列化成 `name(password="…")` 送进摘要请求）。
 * token 类键只遮蔽像凭据的值。
 */
export function redactDeep<T>(v: T, key?: string): T {
	// 敏感键先于值类型判断：数字、数组、对象形式的秘密同样整体遮蔽，pi 会用 JSON.stringify 把它们写进摘要请求。
	if (key && SECRET_KEY_RE.test(key) && v !== null && v !== undefined && v !== "" && v !== MASK) return MASK as T;
	if (key && TOKEN_KEY_RE.test(key) && typeof v === "string" && credentialLike(v)) return MASK as T;
	if (typeof v === "string") return redact(v) as T;
	if (Array.isArray(v)) return v.map((x) => redactDeep(x)) as T;
	if (v && typeof v === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, x] of Object.entries(v)) out[k] = redactDeep(x, k);
		return out as T;
	}
	return v;
}
