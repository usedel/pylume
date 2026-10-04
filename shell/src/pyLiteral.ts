// JSON 值 → Python 字面量的序列化（单一实现，两消费方）：
//   · pasteJson.ts（PR-M 粘贴 JSON → dict）经 jsonToPythonLiteral 间接使用；
//   · devtools/curl2python/gen.ts（fmtDict 缺陷收口：原 JSON.stringify 冒充 dict
//     字面量，true/false/null 三值产出非法 Python——登记见 dx_features_backlog §6.6 PR-M）。
// 零依赖纯函数（不经 Monaco/state），vitest 直测。

/** 4 空格缩进的 Python 字面量序列化（尾逗号收尾，利于 diff 与后续编辑） */
function toPy(v: unknown, indent: number): string {
  const pad = "    ".repeat(indent);
  const padIn = "    ".repeat(indent + 1);
  if (v === null) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  // 数字与字符串的 JSON 字面量语法是 Python 合法子集（NaN/Infinity 不是合法 JSON，不会出现）
  if (typeof v === "number") return JSON.stringify(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    return "[\n" + v.map((x) => `${padIn}${toPy(x, indent + 1)}`).join(",\n") + ",\n" + pad + "]";
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    return (
      "{\n" +
      entries.map(([k, val]) => `${padIn}${JSON.stringify(k)}: ${toPy(val, indent + 1)}`).join(",\n") +
      ",\n" + pad + "}"
    );
  }
  return JSON.stringify(v);
}

/** JSON 解析结果（任意值，含顶层标量）→ Python 字面量。纯函数（单测）。 */
export function pythonLiteralOf(value: unknown): string {
  return toPy(value, 0);
}
