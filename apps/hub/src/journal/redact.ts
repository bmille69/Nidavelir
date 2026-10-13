const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/=-]{10,}/gi,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /(?<=(?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{6,}/gi,
];
const SECRET_KEYS = /^(api[_-]?key|token|secret|password|authorization|access_token|refresh_token)$/i;

/** Masque les secrets connus avant écriture dans le journal (docs/SECURITY.md §8). */
export function redactSecrets<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown, key?: string): unknown {
  if (key && SECRET_KEYS.test(key) && value != null) return "<redacted>";
  if (typeof value === "string") {
    return SECRET_PATTERNS.reduce((s, re) => s.replace(re, "<redacted>"), value);
  }
  if (Array.isArray(value)) return value.map((v) => walk(v));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v, k)]));
  }
  return value;
}
