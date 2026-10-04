// ruff 实时 lint（P2 · PyCharm PEP8 实时检查对标）：诊断的**第三桶**。
//
// 诊断分桶架构（lsp/client.ts::handleDiagnostics）本就按 owner 分别缓存与下发，
// 故新增 ruff 桶不需要动桥：这里直接以 `pylume-ruff` 为 owner 调 setModelMarkers，
// 与静态引擎（`pylume-lsp`）、运行时 intel（`pylume-intel`）三桶并存互补。
//
// 为什么是「离线 ruff check」而不是「ruff server LSP」：
//   · 与 Optimize Imports / 格式化同一个 stdin 管线（架构铁律：ruff 走独立子进程）；
//   · 不引入第二个语言服务器进程（省内存、省一条生命周期与崩溃面）；
//   · 代价是「保存/停手才刷」而非逐字符——对一个自用 IDE 足够，且更省电。
// ruff 缺席时静默降级（后端返回空列表），与探针缺席不拖垮运行的策略一致。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { app } from "./state";
import { toast } from "./toast"; // D-4：noqa 动作反馈（G-3）
import { withRuffHint } from "./ruffHints"; // PR-L：规则码中文速释（追加进 marker 消息，hover 原生渲染）
import { capMarkersBySeverity } from "./lsp/client"; // Monaco 渲染上限分层截断（Error 优先）
import { t } from "./i18n"; // 第十三批 i18n：动态文案走语言包

/** 后端 fs_cmds::RuffDiagnostic 的镜像 */
export interface RuffDiagnostic {
  line: number;
  column: number;
  end_line: number;
  end_column: number;
  message: string;
  code: string | null;
}

/** 诊断 owner（三桶之一，与 lsp/client.ts 的两桶并列；marker 按 owner 独立管理） */
export const RUFF_OWNER = "pylume-ruff";

/** 停手多久后跑一次（ms）：比 didChange 同步的 200ms 更长，避免边打字边刷波浪线 */
const LINT_DEBOUNCE_MS = 800;

export interface RuffLintHandlers {
  setMarkers: (path: string, markers: MonacoApi.editor.IMarkerData[], owner: string) => void;
}

let handlers: RuffLintHandlers | null = null;
let timer: number | undefined;
let token = 0;
/** ruff 缺席已提示过（一次会话只提示一次，避免每次编辑刷控制台） */
let missingNotified = false;

export function setRuffLintHandlers(h: RuffLintHandlers): void {
  handlers = h;
}

// ---------- D-4（PyCharm 调研）：严重度映射 + # noqa 抑制 ----------

/** 严重度存储值归一（非法/缺省回落 warning——G-3：不静默失效，宁可多显示一条波浪线） */
export function normalizeSeverity(v: string | undefined | null): "hint" | "info" | "warning" | "error" {
  const s = (v ?? "").trim().toLowerCase();
  return s === "hint" || s === "info" || s === "error" ? s : "warning";
}

/** 规则码 → 显示严重度：按规则码首字母分类查设置映射（E/W/F）；其余类别回落 Warning */
function severityFor(code: string | null): MonacoApi.MarkerSeverity {
  const S = app.monaco.MarkerSeverity;
  if (!code) return S.Warning;
  const cat = code[0]?.toUpperCase();
  const raw =
    cat === "E" ? app.settings.ruff_severity_e
    : cat === "W" ? app.settings.ruff_severity_w
    : cat === "F" ? app.settings.ruff_severity_f
    : null;
  if (raw === null) return S.Warning;
  const n = normalizeSeverity(raw);
  return n === "hint" ? S.Hint : n === "info" ? S.Info : n === "error" ? S.Error : S.Warning;
}

/** 纯函数（单测）：在行尾追加 / 扩展 `# noqa` 注释。
 *  返回新行全文；null = 该行已忽略此规则（无需修改）；裸 `# noqa` 已忽略全部，原样返回。 */
export function buildNoqaLine(line: string, code: string): string | null {
  const m = /\s+#\s*noqa(?::\s*([A-Za-z0-9_,\s]+))?\s*$/.exec(line);
  if (!m) return `${line.replace(/\s+$/, "")}  # noqa: ${code}`;
  if (m[1] === undefined) return line; // 裸 noqa = 忽略全部
  const codes = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  if (codes.includes(code)) return null;
  return `${line.slice(0, m.index)}  # noqa: ${[...codes, code].join(",")}`;
}

/** 编辑器右键「忽略此规则」：定位光标处的 ruff 诊断 → 行尾追加 `# noqa: <code>` → 立即重查 */
export async function addNoqaAtCursor(): Promise<void> {
  const ed = app.editor;
  const model = ed.getModel();
  const pos = ed.getPosition();
  if (!model || !pos) return;
  const markers = app.monaco.editor.getModelMarkers({ owner: RUFF_OWNER, resource: model.uri });
  const hit = markers.find(
    (m) => pos.lineNumber >= m.startLineNumber && pos.lineNumber <= m.endLineNumber,
  );
  // G-3：无诊断/非 ruff 诊断都显式说明，不做静默 no-op
  if (!hit) {
    toast(t("ide.ruff.noDiagnostic"), "info");
    return;
  }
  const code = hit.source && hit.source !== "ruff" ? hit.source : null;
  if (!code) {
    toast(t("ide.ruff.noCode"), "info");
    return;
  }
  const lineNo = hit.startLineNumber;
  const next = buildNoqaLine(model.getLineContent(lineNo), code);
  if (next === null) {
    toast(t("ide.ruff.alreadyIgnored", { code: code }), "info");
    return;
  }
  ed.executeEdits("pylume-noqa", [
    {
      range: new app.monaco.Range(lineNo, 1, lineNo, model.getLineMaxColumn(lineNo)),
      text: next,
    },
  ]);
  toast(t("ide.ruff.added", { code: code }), "success");
  await lintActiveFile(); // 立即重查，波浪线即时消失
}

/** 编辑器右键菜单入口（main.ts 的 disposable store 收口） */
export function initNoqaAction(editor: MonacoApi.editor.IStandaloneCodeEditor): MonacoApi.IDisposable {
  return editor.addAction({
    id: "pylume.noqaRule",
    label: t("ide.ruff.actionLabel"),
    contextMenuGroupId: "1_modification",
    contextMenuOrder: 3,
    run: () => void addNoqaAtCursor(),
  });
}

/** 请求 lint（防抖；关闭开关时直接清空） */
export function scheduleRuffLint(): void {
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void lintActiveFile(), LINT_DEBOUNCE_MS);
}

/** 立即 lint 当前文件（切换 tab / 保存后调用） */
export async function lintActiveFile(): Promise<void> {
  const tab = app.activeTab;
  if (!tab) return;
  const isPy = tab.path.endsWith(".py") || tab.path.endsWith(".pyw");
  if (!isPy) {
    clearRuffMarkers(tab.path);
    return;
  }
  const my = ++token;
  let diags: RuffDiagnostic[];
  try {
    diags = await invoke<RuffDiagnostic[]>("ruff_lint", {
      path: tab.path,
      content: tab.model.getValue(),
    });
  } catch {
    // ruff 缺席或执行失败：清空旧标记，不留下过期的波浪线
    if (!missingNotified) {
      missingNotified = true;
      console.info("[ruffLint] ruff 不可用，实时 lint 已跳过（不影响运行与调试）");
    }
    clearRuffMarkers(tab.path);
    return;
  }
  if (my !== token) return; // 已有更新的请求
  // 严重度走枚举而非裸数字（CR-29 同款纪律）。D-4：按规则码首字母类别（E/W/F）
  // 映射到设置里的显示级别（默认全 Warning，维持「卫生建议」定位）；其余类别回落 Warning。
  const markers: MonacoApi.editor.IMarkerData[] = diags.map((d) => ({
    startLineNumber: d.line,
    startColumn: d.column,
    endLineNumber: Math.max(d.end_line, d.line),
    endColumn: Math.max(d.end_column, d.column + 1),
    message: withRuffHint(d.code, d.message), // PR-L：code 前缀 + 命中速释表时追加中文解释
    severity: severityFor(d.code),
    source: d.code ?? "ruff",
  }));
  // Monaco 渲染上限（markerDecorationsService take:500，全 owner 桶共享）：
  // ruff 桶默认全 warning（卫生建议定位），长尾价值低——上限 50，把名额让给 lsp 桶的
  // error/类型诊断（实测实案：ruff 450 条 warning 挤掉了 lsp 的 parse-error 红线）
  handlers?.setMarkers(tab.path, capMarkersBySeverity(markers, 50), RUFF_OWNER);
}

/** 清空某文件的 ruff 标记（关闭 tab / 切到非 Python 文件） */
export function clearRuffMarkers(path: string): void {
  handlers?.setMarkers(path, [], RUFF_OWNER);
}

/** 复位（工作区切换：标记随 model 销毁，这里只需作废在途请求与定时器） */
export function resetRuffLint(): void {
  window.clearTimeout(timer);
  token++;
}
