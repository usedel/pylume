// Pydantic 构造校验诊断（阶段 4 子项 1b · 诊断第四桶，docs/pyrefly_pydantic_support_plan.md §3.4.2）。
//
// 与 ruffLint.ts 同款形态：owner 隔离的被动诊断桶——Rust 拉取式扫描（scan_pydantic_issues）
// → marker 注入（owner = pylume-pydantic），与静态引擎 / intel / ruff 四桶并存互补。
// 触发：① 工作区打开时 detect_pydantic_stack 命中后全量一次；② 文件保存后防抖增量。
// 开关：settings.pydantic_diagnostics（默认开；关闭即清空且不再扫描）。
// 非 Pydantic 栈工作区零扫描零诊断（detect_pydantic_stack 门控）。

import { invoke } from "@tauri-apps/api/core";
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { app } from "./state";

/** 诊断 owner（第四桶；marker 按 owner 独立管理，不覆盖引擎诊断） */
export const PYDANTIC_OWNER = "pylume-pydantic";

/** 保存后防抖窗口（ms）：与 ruffLint 的 800ms 同量级，取 1.5s（跨文件校验，频率更低） */
const RESCAN_DEBOUNCE_MS = 1500;

export interface PydanticIssue {
  file: string;
  line: number;
  column: number;
  end_column: number;
  kind: "missing" | "unknown" | "type" | string;
  message: string;
  field: string;
  model: string;
}

export interface PydanticDiagnosticsHandlers {
  setMarkers: (path: string, markers: MonacoApi.editor.IMarkerData[], owner: string) => void;
}

let handlers: PydanticDiagnosticsHandlers | null = null;
let timer: number | undefined;
let token = 0;
/** 本会话是否已确认 Pydantic 栈（detect_pydantic_stack 命中且未关闭） */
let stackHit = false;

export function setPydanticDiagnosticsHandlers(h: PydanticDiagnosticsHandlers): void {
  handlers = h;
}

/** 工作区打开时调用：判定 Pydantic 栈并做首次全量扫描（开关关闭时仅记录栈状态不扫描） */
export async function initPydanticDiagnostics(root: string): Promise<void> {
  stackHit = await invoke<boolean>("detect_pydantic_stack", { workspaceRoot: root }).catch(() => false);
  if (stackHit && app.settings.pydantic_diagnostics !== false) {
    await rescanAll();
  }
}

/** 保存后防抖增量（全量重扫——Rust 侧 ~6ms 级，增量剪枝不值得引入状态） */
export function schedulePydanticRescan(): void {
  if (!stackHit || app.settings.pydantic_diagnostics === false) return;
  window.clearTimeout(timer);
  timer = window.setTimeout(() => void rescanAll(), RESCAN_DEBOUNCE_MS);
}

async function rescanAll(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root) return;
  if (app.settings.pydantic_diagnostics === false) {
    clearAllPydanticMarkers();
    return;
  }
  const my = ++token;
  let issues: PydanticIssue[];
  try {
    issues = await invoke<PydanticIssue[]>("scan_pydantic_issues", { root });
  } catch (e) {
    console.warn("[pydantic] 构造校验扫描失败（不影响其他诊断）:", e);
    return;
  }
  if (my !== token) return; // 已有更新的扫描
  // 按文件分组（key 归一化：Rust 返回正斜杠 / tab 可能反斜杠，同文件双形态会漏清）
  const byFile = new Map<string, { path: string; markers: MonacoApi.editor.IMarkerData[] }>();
  for (const it of issues) {
    const key = normKey(it.file);
    const entry = byFile.get(key) ?? { path: it.file, markers: [] };
    entry.markers.push(toMarker(it));
    byFile.set(key, entry);
  }
  // 先对账清空消失文件（用缓存里的真实路径形态），再注入 + 更新缓存
  for (const [key, prev] of cachedMarkers) {
    if (!byFile.has(key)) handlers?.setMarkers(prev.path, [], PYDANTIC_OWNER);
  }
  for (const entry of byFile.values()) {
    handlers?.setMarkers(entry.path, entry.markers, PYDANTIC_OWNER);
  }
  cachedMarkers.clear();
  for (const [key, entry] of byFile) cachedMarkers.set(key, entry);
}

/** 路径归一化 key（斜杠 + 小写；对齐 lsp/client 的 normPath 语义） */
function normKey(p: string): string {
  return p.replace(/\\/g, "/").toLowerCase();
}

/** 各文件最新 marker（normKey → markers）：打开文件时回放——文件未开时 setMarkers
 *  找不到 tab 会被丢弃（main.setMarkers 只对已开 tab 生效），第四桶必须自带缓存，
 *  这是与 LSP 桶（diagnosticsCache）对称的机制（E2E 抓到的时序缺口，2026-09-29） */
const cachedMarkers = new Map<string, { path: string; markers: MonacoApi.editor.IMarkerData[] }>();

/** 打开文件时回放缓存的第四桶诊断（main.openFile 调用；无缓存零开销） */
export function applyPydanticMarkersOnOpen(path: string): void {
  if (!stackHit) return;
  const entry = cachedMarkers.get(normKey(path));
  if (entry) handlers?.setMarkers(entry.path, entry.markers, PYDANTIC_OWNER);
}

function toMarker(it: PydanticIssue): MonacoApi.editor.IMarkerData {
  // missing 整行级（column=0）：落在行首 1 列，范围到字段名后；其余落在参数名上
  const col = it.column > 0 ? it.column : 1;
  const endCol = it.column > 0 ? Math.max(it.end_column, it.column + 1) : col + Math.max(it.field.length, 1);
  const S = app.monaco.MarkerSeverity;
  return {
    startLineNumber: it.line,
    startColumn: col,
    endLineNumber: it.line,
    endColumn: endCol,
    message: it.message,
    severity: it.kind === "unknown" ? S.Warning : S.Error, // unknown 可能是动态字段，降 Warning
    source: "pylume-pydantic",
  };
}

/** 清空某文件标记（关闭 tab 时；缓存保留——重开 tab 时回放仍有效？不：文件未变诊断
 *  未变，缓存留着，重开文件回放。显式清空仅用于内容变更场景） */
export function clearPydanticMarkers(path: string): void {
  handlers?.setMarkers(path, [], PYDANTIC_OWNER);
}

/** 清空全部已注入标记（设置关闭 / 工作区关闭） */
function clearAllPydanticMarkers(): void {
  for (const [, prev] of cachedMarkers) handlers?.setMarkers(prev.path, [], PYDANTIC_OWNER);
  cachedMarkers.clear();
}

/** 设置保存后即时生效：开→立扫，关→清空（UI-11/29 范式：不能等下次保存才反应） */
export function refreshPydanticDiagnostics(): void {
  if (!stackHit) return;
  if (app.settings.pydantic_diagnostics === false) {
    window.clearTimeout(timer);
    token++;
    clearAllPydanticMarkers();
    return;
  }
  void rescanAll();
}

/** 复位（工作区切换：作废在途请求与定时器；标记随 model 销毁） */
export function resetPydanticDiagnostics(): void {
  window.clearTimeout(timer);
  token++;
  stackHit = false;
  cachedMarkers.clear();
}
