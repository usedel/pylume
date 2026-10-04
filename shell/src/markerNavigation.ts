// 诊断导航（F8 / Shift+F8 · PyCharm 同款）：error/warning marker 逐个跳转 + 循环回绕。
//
// 背景（2026-09-29 排查实案）：15386 行大文件保存报「168 处语法错误」，但错误散布全文件
// 且真语法错误集中在末尾——用户视口在文件中上部时完全看不到波浪线，toast 数量与所见脱节。
// 有了逐个导航，用户保存后按 F8 即可顺藤摸瓜；保存 toast 也提供「定位」动作直达第一个错误。
//
// 口径与 saveTab 的 marker 统计一致：getModelMarkers 不带 owner 过滤 = 全桶覆盖
// （pylume-lsp / pylume-intel / pylume-ruff / pylume-pydantic / pylume-libs）。
// 序列排序：行号升序 + 同行按列；导航范围含 error 与 warning（Info/Hint 噪声大，不进序列）。
// 循环回绕：最后一个再按下一个 → 回到第一个（PyCharm 同款），toast 标注「已回绕」。

import { app } from "./state";
import { toast } from "./toast";
import { t } from "./i18n"; // 第十三批 i18n：动态文案走语言包

/** 导航序列项（纯数据，单测锁定语义） */
export interface NavMarker {
  line: number;
  column: number;
  severity: number;
  message: string;
}

/** 从 markers 提取导航序列：过滤严重级 + 行列升序（纯函数） */
export function buildNavSequence(
  markers: Array<{ startLineNumber: number; startColumn: number; severity: number; message: string }>,
  severities: ReadonlySet<number>,
): NavMarker[] {
  return markers
    .filter((m) => severities.has(m.severity))
    .map((m) => ({ line: m.startLineNumber, column: m.startColumn, severity: m.severity, message: m.message }))
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

/** 纯光标位置锚定（VS Code F8 同款语义，无模块级索引状态）：
 *  下一个（dir=1）= 光标位置**严格之后**的第一个诊断（比较含列：同行内列更靠右才算后）；
 *  光标已在末尾之后 → 回绕到第一个。上一个（dir=-1）= 光标位置**严格之前**的最后一个；
 *  光标在最前之前 → 回绕到最后一个。光标正停在某诊断上 → 下一个/上一个都不含它自身。 */
export function navTargetIndex(seq: NavMarker[], cur: { line: number; column: number }, dir: 1 | -1): number {
  if (seq.length === 0) return -1;
  if (dir === 1) {
    // 严格之后：行更大，或同行列更大
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].line > cur.line || (seq[i].line === cur.line && seq[i].column > cur.column)) return i;
    }
    return 0; // 回绕
  }
  for (let i = seq.length - 1; i >= 0; i--) {
    if (seq[i].line < cur.line || (seq[i].line === cur.line && seq[i].column < cur.column)) return i;
  }
  return seq.length - 1; // 回绕
}

/** 读取当前编辑器的导航序列（无活动 tab / diff tab / 无诊断 → 空序列） */
function currentSequence(): NavMarker[] {
  const tab = app.activeTab;
  if (!tab || tab.kind === "diff" || !tab.model) return [];
  const markers = app.monaco.editor.getModelMarkers({ resource: tab.model.uri }) as Array<{
    startLineNumber: number;
    startColumn: number;
    severity: number;
    message: string;
  }>;
  const S = app.monaco.MarkerSeverity;
  return buildNavSequence(markers, new Set([S.Error, S.Warning]));
}

/** 跳到下一个 / 上一个诊断（F8 / Shift+F8 的 handler）。
 *  每次按键都以当前光标位置实时定位——无会话内索引状态，天然免疫「诊断更新/切文件/
 *  外部跳转」导致的状态漂移；连按 F8 自然形成「从光标处向下巡游 + 回绕」。 */
export function gotoMarker(dir: 1 | -1): void {
  const seq = currentSequence();
  if (seq.length === 0) {
    toast(t("ide.mv.none"), "info");
    return;
  }

  const pos = app.editor.getPosition() ?? { lineNumber: 1, column: 1 };
  const idx = navTargetIndex(seq, { line: pos.lineNumber, column: pos.column }, dir);
  const target = seq[idx];
  const wrapped = dir === 1
    ? target.line < pos.lineNumber || (target.line === pos.lineNumber && target.column <= pos.column)
    : target.line > pos.lineNumber || (target.line === pos.lineNumber && target.column >= pos.column);

  app.editor.revealLineNearTop(target.line);
  app.editor.setPosition({ lineNumber: target.line, column: target.column });
  app.editor.focus();
  const kind = target.severity === app.monaco.MarkerSeverity.Error ? t("ide.mv.error") : t("ide.mv.warning");
  const brief = target.message.split("\n")[0].slice(0, 120);
  toast(t("ide.mv.progress", { idx: idx + 1, total: seq.length, wrapped: wrapped ? t("ide.mv.wrapped") : "", kind: kind, brief: brief }), "info");
}

// ---------- 保存 toast 的错误分类（2026-09-29 排查交付：pyrefly/basedpyright 实测口径） ----------
//
// 背景：旧文案把所有 error 级 marker 统称「语法错误」，但 pyrefly typeCheckingMode=default 下
// 大部分 error 是类型不匹配（如 15386 行文件 168 error 中仅 23 个是真语法错误）——用户按文案
// 找语法错误找不到，误以为错报。分类依据（两引擎裸 LSP 探测，2026-09-29）：
//   · pyrefly 语法错误 code='parse-error'，语义/类型错误带其它 code（unknown-name 等）
//   · basedpyright 语法错误**无 code**，语义/类型错误带 reportXxx code

/** 保存 toast 的分类结果 */
export interface SaveErrorBreakdown {
  syntax: number;
  other: number;
}

/** 自研诊断桶的 source（语义类：构造参数/注入问题/运行时智能，非 Python 语法错误） */
const NON_SYNTAX_SOURCES = new Set(["pylume-pydantic", "pylume-libs", "pylume-intel"]);

/** 判定单条 marker 是否语法错误（纯函数）：
 *  · pyrefly 语法错误 `code === "parse-error"`；语义/类型错误带其它 code（unknown-name 等）
 *  · basedpyright 语法错误**无 code**（语义错误恒带 reportXxx code），source 为引擎名
 *  · ruff 桶规则码落在 **source** 上（ruffLint.ts 构造 marker 不设 code）：
 *    `invalid-syntax` = 语法错误；`F401`/`E501` 等规则码形态 = 语义类
 *  · 自研桶（pydantic/libs/intel）无 code 也非语法错误
 *  兜底：无 code 且 source 未知 → 按语法错误处理（basedpyright 形态；宁可文案偏保守，
 *  语法错误漏标成类型错误会让用户更困惑——文件跑不起来却被告知只是类型问题）。
 *  修（2026-09-30）：`code` 放宽为 Monaco IMarker 的实际联合形态
 *  `string | { value: string; target: Uri }`——对象形态（链接型 code，Monaco
 *  quickfix/hover 注入）经下方 `code !== undefined` 分支归语义类，行为不变；
 *  此前签名只收 string，调用方传 IMarker[] 报 TS2345（生产构建 tsc 门禁红）。 */
export function isSyntaxErrorMarker(m: { source?: string; code?: string | { value: string; target: unknown } }): boolean {
  const code = m.code;
  if (code === "parse-error" || code === "invalid-syntax") return true;
  if (code !== undefined && code !== null && code !== "") return false; // 对象形态同样归语义类
  const source = m.source ?? "";
  if (source === "invalid-syntax") return true; // ruff 语法错误（规则码落 source）
  if (/^[A-Z]+\d/.test(source)) return false; // ruff 语义规则码（F401/E501/I001…）
  if (NON_SYNTAX_SOURCES.has(source)) return false; // 自研桶
  if (source === "ruff") return true; // ruff 无规则码兜底（多为解析失败类）
  return true; // basedpyright 语法错误（无 code）与未知引擎兜底
}

/** error 级 markers → 语法/其他分类计数（纯函数） */
export function breakDownSaveErrors(
  markers: Array<{ severity: number; source?: string; code?: string | { value: string; target: unknown } }>,
  errorSeverity: number,
): SaveErrorBreakdown {
  let syntax = 0;
  let other = 0;
  for (const m of markers) {
    if (m.severity !== errorSeverity) continue;
    if (isSyntaxErrorMarker(m)) syntax += 1;
    else other += 1;
  }
  return { syntax, other };
}

/** 分类结果 → toast 文案（纯函数；「（已保存）」后缀由调用方拼接口径统一） */
export function saveErrorToastMessage(fileName: string, b: SaveErrorBreakdown): string {
  const parts: string[] = [];
  if (b.syntax > 0) parts.push(t("ide.mv.syntaxErrors", { count: b.syntax }));
  if (b.other > 0) parts.push(t("ide.mv.otherErrors", { count: b.other }));
  return t("ide.mv.savedStatus", { file: fileName, parts: parts.join("，") });
}

/** 跳到当前文件第一个 error marker（保存 toast「定位」动作；无 error 时静默） */
export function revealFirstError(): void {
  const tab = app.activeTab;
  if (!tab || tab.kind === "diff" || !tab.model) return;
  const markers = app.monaco.editor.getModelMarkers({ resource: tab.model.uri }) as Array<{
    startLineNumber: number;
    startColumn: number;
    severity: number;
  }>;
  const errs = markers
    .filter((m) => m.severity === app.monaco.MarkerSeverity.Error)
    .sort((a, b) => a.startLineNumber - b.startLineNumber || a.startColumn - b.startColumn);
  const first = errs[0];
  if (!first) return;
  app.editor.revealLineNearTop(first.startLineNumber);
  app.editor.setPosition({ lineNumber: first.startLineNumber, column: first.startColumn });
  app.editor.focus();
}

