// Git gutter 装饰（迭代 2 · P0-5）：活动文件 vs HEAD 的行级变更指示。
// 行号槽画 绿条（新增）/蓝条（修改）/红三角（删除，标在删除点上方行）——对标 VS Code。
//
// 数据源：git_diff_hunks（工作区 vs HEAD 的 hunk 列表）。hunk 只有行号区间，
// 行级「新增 vs 修改」的区分：hunk 内新增行（new 侧多出的行）需看 diff 的 +/- 行。
// 简化实现（首版）：按 hunk 的 new_start/new_lines 给区间画蓝条（修改），
// 纯新增文件（old_lines=0）整区间画绿条，删除区间（new_lines=0）在 old_start 位置画红标。
// 精确到行（+绿/-红）的版本需要解析 diff 正文，留给后续打磨。
//
// 刷新时机（同 runGutter/debugGutter 模式）：切 tab / 内容变化防抖 / git 状态刷新后。
import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";
import { app, type MonacoModule } from "./state";
import { gitStatusOf } from "./gitStatusState";

let decorations: MonacoApi.editor.IEditorDecorationsCollection | null = null;
let editorRef: MonacoApi.editor.IStandaloneCodeEditor | null = null;
let monacoRef: MonacoModule | null = null;
/** 防抖 + 乱序令牌（慢响应不得覆盖新文件的结果） */
let refreshToken = 0;
let debounceTimer = 0;

export function wireGitGutter(editor: MonacoApi.editor.IStandaloneCodeEditor, monaco: MonacoModule): void {
  editorRef = editor;
  monacoRef = monaco;
}

/** 相对路径（大小写归一，匹配 gitStatusState 的 key）；不在工作区内返回 null */
function activeRelPath(): string | null {
  const tab = app.activeTab;
  const root = app.workspaceRoot;
  if (!tab || !root) return null;
  const norm = (p: string): string => p.replace(/\\/g, "/").toLowerCase();
  const nRoot = norm(root).replace(/\/+$/, "");
  const nTab = norm(tab.path);
  if (!nTab.startsWith(nRoot + "/")) return null;
  return tab.path.slice(root.length).replace(/^[\\/]+/, "");
}

/** 重算当前文件的 gutter 装饰（切 tab / 内容变化 / git 状态变化后调用） */
export function refreshGitGutter(): void {
  const token = ++refreshToken;
  // 清旧装饰（无匹配状态时也保持清空）
  if (decorations) {
    decorations.clear();
    decorations = null;
  }
  const editor = editorRef;
  const monaco = monacoRef;
  const rel = activeRelPath();
  if (!editor || !monaco || !rel) return;
  // 只为「有 git 状态的已跟踪变更文件」装饰（无变更文件不跑 git diff，省子进程）
  if (gitStatusOf(rel.toLowerCase()) === undefined) return;
  void invoke<{ hunks: Hunk[] }>("git_diff_hunks", { root: app.workspaceRoot, path: rel, ignoreWhitespace: false })
    .then((r) => {
      if (token !== refreshToken) return; // 已有新一轮刷新
      if (r.hunks.length === 0) return;
      const decos: MonacoApi.editor.IModelDeltaDecoration[] = [];
      for (const h of r.hunks) {
        // 纯新增（old_lines=0）：整区间绿条
        if (h.old_lines === 0 && h.new_lines > 0) {
          if (h.new_start >= 1) {
            decos.push({
              range: new monaco.Range(h.new_start, 1, h.new_start + h.new_lines - 1, 1),
              options: { linesDecorationsClassName: "git-gutter-added" },
            });
          }
          continue;
        }
        // 纯删除（new_lines=0）：在删除点上方行（old_start，夹到文件行数内）画红三角
        if (h.new_lines === 0) {
          const total = app.activeTab?.model.getLineCount() ?? 0;
          const anchor = Math.min(Math.max(h.new_start, 1), Math.max(total, 1));
          decos.push({
            range: new monaco.Range(anchor, 1, anchor, 1),
            options: { linesDecorationsClassName: "git-gutter-deleted" },
          });
          continue;
        }
        // 修改（两侧都有行）：区间蓝条
        decos.push({
          range: new monaco.Range(h.new_start, 1, h.new_start + h.new_lines - 1, 1),
          options: { linesDecorationsClassName: "git-gutter-modified" },
        });
      }
      if (decos.length > 0) decorations = editor.createDecorationsCollection(decos);
    })
    .catch(() => { /* 子文件无 diff（如冲突标记态）静默 */ });
}

/** 防抖版刷新（编辑器内容变化 300ms 后） */
export function scheduleGitGutter(): void {
  window.clearTimeout(debounceTimer);
  debounceTimer = window.setTimeout(() => refreshGitGutter(), 300);
}

/** 清空装饰（关闭工作区 / 切工作区时） */
export function clearGitGutter(): void {
  refreshToken++;
  window.clearTimeout(debounceTimer);
  decorations?.clear();
  decorations = null;
}

interface Hunk { old_start: number; old_lines: number; new_start: number; new_lines: number }
