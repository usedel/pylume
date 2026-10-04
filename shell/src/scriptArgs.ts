// 脚本参数表单纯函数层（库特别支持 PR-4，docs/python_library_support_dev_plan.md §6）。
// 职责：ast_argparse 解析结果 → 表单模型 → 命令行拼装；反向：命令行 → 尽力回填，
// 冲突时返回 inconsistent 标志（**绝不静默覆盖用户输入**，§11.5 双向同步纪律）。
// 纯 TS、无 DOM、无子进程（解析走 py_eval ast_argparse 受控脚本）。

// ---------- 模型 ----------

export interface ScriptParam {
  name: string;
  /** 位置参数（argparse 无 flag）为 null */
  flag: string | null;
  /** "str" | "int" | "float" | "bool" | 未知类型名（按 str 处理） */
  type: string;
  /** 静态可确定的默认值（占位符用，**不是值**，§11.5） */
  default: unknown;
  required: boolean | null;
  help: string | null;
  /** 已归一化为字符串（choices 数字/混合统一 String()） */
  choices: string[] | null;
  /** argparse `nargs`（"*" / "+" / "?" / "N"）；null = 单值（§11.5：多值 → 多行文本） */
  nargs: string | null;
  source: "argparse" | "click" | "typer";
}

/** 多值参数（nargs='*' / '+' / N≥2）→ 表单用多行文本（§11.5 类型→控件映射） */
export function isMultiNargs(p: ScriptParam): boolean {
  return p.nargs === "*" || p.nargs === "+" || (/^\d+$/.test(p.nargs ?? "") && Number(p.nargs) >= 2);
}

/** 数值型 nargs 的取值个数上限；"*" / "+" 返回 null（不限） */
export function nargsCap(p: ScriptParam): number | null {
  return /^\d+$/.test(p.nargs ?? "") ? Number(p.nargs) : null;
}

/** 多值控件文本 → 值列表（空格 / 逗号分隔） */
export function splitMultiValue(v: string): string[] {
  return v.split(/[\s,]+/).filter(Boolean);
}

/** py_eval ast_argparse 的 data 形状 */
export interface AstArgsData {
  params: ScriptParam[];
}

/** nargs 归一化：只保留 "*" / "+" / "?" / 数字字符串，其余一律 null */
function normalizeNargs(v: unknown): string | null {
  if (v === "*" || v === "+" || v === "?") return v;
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return String(v);
  if (typeof v === "string" && /^\d+$/.test(v) && Number(v) > 0) return v;
  return null;
}

/** 归一化解析结果（脚本字段缺失容错；非法条目丢弃） */
export function toFormModel(data: AstArgsData | null | undefined): ScriptParam[] {
  if (!data || !Array.isArray(data.params)) return [];
  const out: ScriptParam[] = [];
  for (const p of data.params) {
    if (!p || typeof p.name !== "string" || !p.name) continue;
    out.push({
      name: p.name,
      flag: typeof p.flag === "string" && p.flag.startsWith("-") ? p.flag : null,
      type: typeof p.type === "string" && p.type ? p.type : "str",
      default: p.default ?? null,
      required: p.required === true,
      help: typeof p.help === "string" ? p.help : null,
      choices: Array.isArray(p.choices) && p.choices.length ? p.choices.map(String) : null,
      nargs: normalizeNargs(p.nargs),
      source: p.source === "click" || p.source === "typer" ? p.source : "argparse",
    });
  }
  return out;
}

// ---------- 命令行拼装（表单 → 命令行） ----------

export type FormValue = string | boolean;

/** 表单值 → 命令行参数串（bool=true 出 flag，空串跳过；含空格加引号） */
export function buildCommandLine(params: ScriptParam[], values: Record<string, FormValue>): string {
  const parts: string[] = [];
  for (const p of params) {
    const v = values[p.name];
    if (p.type === "bool") {
      if (v === true) parts.push(p.flag ?? `--${p.name}`);
      continue;
    }
    if (v === undefined || v === "" || v === false) continue;
    const s = String(v);
    // 位置参数（flag=null）只出值，不带 flag
    if (p.flag) parts.push(p.flag);
    // 多值参数（nargs='*'/'+'/N）：控件文本按空格 / 逗号切成多个 token
    if (isMultiNargs(p)) {
      for (const item of splitMultiValue(s)) parts.push(needsQuoting(item) ? quote(item) : item);
      continue;
    }
    parts.push(needsQuoting(s) ? quote(s) : s);
  }
  return parts.join(" ");
}

function needsQuoting(s: string): boolean {
  return /[\s"]/.test(s);
}

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

// ---------- 命令行回填（命令行 → 表单，尽力而为） ----------

export interface BackfillResult {
  /** 能完整回填时给出值（调用方覆盖表单）；null = 有无法归属的 token，**保持表单原样** */
  values: Record<string, FormValue> | null;
  /** 命令行含表单无法表达的内容 → 「表单与命令行不一致，以命令行为准」标注 */
  inconsistent: boolean;
}

/** 命令行分词（单双引号 + 反斜杠转义；Windows 风格容忍） */
export function tokenizeCommandLine(cmdline: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < cmdline.length) {
    while (i < cmdline.length && /\s/.test(cmdline[i]!)) i++;
    if (i >= cmdline.length) break;
    let cur = "";
    let quoted = false;
    while (i < cmdline.length && !(/\s/.test(cmdline[i]!) && !quoted)) {
      const c = cmdline[i]!;
      if (c === "\\" && i + 1 < cmdline.length && cmdline[i + 1] === '"') {
        cur += '"';
        i += 2;
        continue;
      }
      if (c === '"' || c === "'") {
        quoted = !quoted;
        i++;
        continue;
      }
      cur += c;
      i++;
    }
    out.push(cur);
  }
  return out;
}

/**
 * 命令行 → 表单值（尽力回填）：
 * - flag 匹配（长/短名 + `--name=value` 形态）；位置参数按声明顺序取值；
 * - 未识别 token / 无法归属的值 → inconsistent=true 且 values=null（**不覆盖表单**）；
 * - bool 类 flag 出现即 true；`--flag` 无值且非 bool → inconsistent。
 */
export function backfillFromCommandLine(params: ScriptParam[], cmdline: string): BackfillResult {
  const tokens = tokenizeCommandLine(cmdline.trim());
  const byFlag = new Map<string, ScriptParam>();
  const positionals: ScriptParam[] = [];
  for (const p of params) {
    if (p.flag) {
      byFlag.set(p.flag, p);
      // 短名：-i / --input 互认（取 flag 与 --name 两种形态）
      byFlag.set(`--${p.name}`, p);
    } else {
      positionals.push(p);
    }
  }
  const values: Record<string, FormValue> = {};
  let posIdx = 0;
  let inconsistent = false;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t.startsWith("-") && t.length > 1) {
      let flag = t;
      let inlineValue: string | null = null;
      const eq = t.indexOf("=");
      if (t.startsWith("--") && eq > 0) {
        flag = t.slice(0, eq);
        inlineValue = t.slice(eq + 1);
      }
      const p = byFlag.get(flag);
      if (!p) {
        inconsistent = true;
        i++;
        continue;
      }
      if (p.type === "bool") {
        values[p.name] = inlineValue === null ? true : inlineValue !== "false";
        i++;
        continue;
      }
      // 多值参数（nargs）：其后连续的非 flag token 全部归入（数值型 nargs 到上限为止）
      if (isMultiNargs(p)) {
        const collected: string[] = [];
        if (inlineValue !== null) collected.push(inlineValue);
        let j = i + 1;
        const cap = nargsCap(p);
        while (j < tokens.length && !tokens[j]!.startsWith("-")) {
          collected.push(tokens[j]!);
          j++;
          if (cap !== null && collected.length >= cap) break;
        }
        if (collected.length > 0) values[p.name] = collected.join(" ");
        i = j;
        continue;
      }
      if (inlineValue !== null) {
        values[p.name] = inlineValue;
        i++;
        continue;
      }
      const next = tokens[i + 1];
      if (next === undefined || next.startsWith("-")) {
        inconsistent = true; // --flag 无值
        i++;
        continue;
      }
      values[p.name] = next;
      i += 2;
      continue;
    }
    // 位置参数
    const p = positionals[posIdx];
    if (!p) {
      inconsistent = true;
      i++;
      continue;
    }
    values[p.name] = t;
    posIdx++;
    i++;
  }
  // 剩余未消化的位置参数槽位 = 命令行没写全，不算冲突（表单留空）。
  // inconsistent 时 values 置 null：调用方保持表单原样并标注「以命令行为准」，绝不静默覆盖（§11.5）。
  return { values: inconsistent ? null : values, inconsistent };
}

/** 命令行 → 尽力回填的对外封装：inconsistent 时返回 null values（调用方保持表单原样 + 显示标注） */
export function tryBackfill(params: ScriptParam[], cmdline: string): Record<string, FormValue> | null {
  const r = backfillFromCommandLine(params, cmdline);
  return r.inconsistent ? null : r.values;
}

/** required 校验：返回缺失参数名列表（§11.5：提交时校验，缺参指出缺哪个） */
export function missingRequired(params: ScriptParam[], values: Record<string, FormValue>): string[] {
  return params
    .filter((p) => p.required && p.type !== "bool")
    .filter((p) => {
      const v = values[p.name];
      return v === undefined || v === "";
    })
    .map((p) => p.name);
}
