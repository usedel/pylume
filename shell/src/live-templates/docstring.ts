// `"""` + Enter 自动生成 docstring（tech-debt #16，对标 PyCharm 的 docstring 生成）。
// 触发：python 文件中，光标位于 def/class 块体首行、行内已敲出 `"""`（3~6 个引号，
// 覆盖 Monaco autoClosingQuotes 的自动配对）后按 Enter → 按签名生成 Args/Returns（函数）
// 或 Attributes（类）骨架并替换当前行。
// 纯判定与生成函数均可单测（enclosingSignature / buildDocstring）。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";

type Monaco = typeof MonacoApi;

export interface DocstringSignature {
  /** 块体缩进（块头缩进 + 4 空格） */
  indent: string;
  /** def 的形参名（self/cls 过滤、去注解与默认值）；class 为空数组 */
  args: string[];
  kind: "def" | "class";
}

/** 按顶层逗号分割（忽略括号内的逗号，如默认值 `a=(1, 2)`） */
function splitTopLevel(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of s) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (cur.trim() || parts.length > 0) parts.push(cur);
  return parts.map((p) => p.trim()).filter(Boolean);
}

// 从单个参数片段提取形参名：去 `*`/`**` 变参前缀、截断注解（`:`）与默认值（`=`）
function argName(part: string): string | null {
  let t = part.trim();
  const star = /^\*+/.exec(t)?.[0] ?? "";
  t = t.slice(star.length);
  const name = t.split(/[:=]/, 1)[0].trim();
  return name || null;
}

/** 向上找最近的 def/class 块头（单行签名），返回块体缩进 + 形参名；非块体首行返回 null */
export function enclosingSignature(
  model: MonacoApi.editor.ITextModel,
  lineNumber: number,
): DocstringSignature | null {
  for (let l = lineNumber - 1; l >= 1; l--) {
    const line = model.getLineContent(l);
    const trimmed = line.trim();
    if (!trimmed) continue;
    const indent = line.slice(0, line.length - line.trimStart().length);

    const defM = /^(?:async\s+)?def\s+\w+\s*\(([\s\S]*)\)\s*(?:->.*)?:\s*$/.exec(trimmed);
    if (defM) {
      const args = splitTopLevel(defM[1] ?? "")
        .map(argName)
        .filter((n): n is string => !!n && n !== "self" && n !== "cls");
      return { indent: indent + "    ", args, kind: "def" };
    }

    const classM = /^class\s+\w+/.exec(trimmed);
    if (classM) {
      return { indent: indent + "    ", args: [], kind: "class" };
    }

    // 遇到其他非空行（非块头）——说明光标不在块体首行，放弃触发
    break;
  }
  return null;
}

/** 按签名生成 docstring 骨架（Google 风格 Args/Returns 或 Attributes） */
export function buildDocstring(sig: DocstringSignature): string {
  const { indent, args, kind } = sig;
  const lines: string[] = [];
  lines.push(`${indent}"""`);
  if (kind === "class") {
    lines.push(`${indent}`);
    lines.push(`${indent}Attributes:`);
    lines.push(`${indent}    `);
  } else if (args.length > 0) {
    lines.push(`${indent}`);
    lines.push(`${indent}Args:`);
    for (const a of args) lines.push(`${indent}    ${a}: `);
    lines.push(`${indent}`);
    lines.push(`${indent}Returns:`);
    lines.push(`${indent}    `);
  } else {
    lines.push(`${indent}`);
    lines.push(`${indent}Returns:`);
    lines.push(`${indent}    `);
  }
  lines.push(`${indent}"""`);
  return lines.join("\n");
}

/** 光标行到光标之前是否仅为「缩进 + 3~6 个引号」（docstring 触发形态） */
function isDocstringTriggerLine(before: string): boolean {
  return /^\s*"{3,6}\s*$/.test(before);
}

/** 注册 `"""` + Enter 的 docstring 自动生成；返回 disposable（随 live-templates 一并 dispose） */
export function registerDocstringTrigger(
  monaco: Monaco,
  editor: MonacoApi.editor.IStandaloneCodeEditor,
): { dispose(): void } {
  const disposable = editor.onKeyDown((e) => {
    if (e.keyCode !== monaco.KeyCode.Enter) return;
    const model = editor.getModel();
    const pos = editor.getPosition();
    if (!model || !pos) return;
    if (model.getLanguageId() !== "python") return;

    const line = model.getLineContent(pos.lineNumber);
    const before = line.slice(0, pos.column - 1);
    if (!isDocstringTriggerLine(before)) return;

    const sig = enclosingSignature(model, pos.lineNumber);
    if (!sig) return;

    e.preventDefault();
    e.stopPropagation();

    const doc = buildDocstring(sig);
    const range = new monaco.Range(
      pos.lineNumber,
      1,
      pos.lineNumber,
      model.getLineMaxColumn(pos.lineNumber),
    );
    editor.executeEdits("pylume-docstring", [{ range, text: doc, forceMoveMarkers: true }]);
    // 光标落在开引号 `"""` 之后（描述位），用户即可续写 summary
    editor.setPosition({ lineNumber: pos.lineNumber, column: sig.indent.length + 4 });
    editor.focus();
  });

  return { dispose: () => disposable.dispose() };
}