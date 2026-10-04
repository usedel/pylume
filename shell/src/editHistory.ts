// 编辑历史采集（低延迟编辑预测数据源，V1）。
//
// 采集「行对」事件：当光标离开某行、且该行自上次定型后被编辑过（dirty），
// 把该行记为一次「定型」，提取（上一非空行 → 本行）配对，逐条落盘到 Rust 端
// append 的 JSONL（<data_root>/edit_history/events.jsonl）。
//
// 设计要点：
// - 只采 python；仅「真正编辑过的行」定型时才采（dirty 集合），方向键上下浏览
//   不产生噪音数据；
// - 逐条 invoke（频率≈「每行一次」，远低于逐键），无缓冲丢失问题；
// - 采集失败静默降级，绝不干扰编辑主流程；
// - 纯逻辑（LineCollector / eventAt）不依赖 DOM / 编辑器实例，便于单测。

import type * as MonacoApi from "monaco-editor/esm/vs/editor/editor.api";
import { invoke } from "@tauri-apps/api/core";

/** 与 Rust edit_history.rs::EditEvent 契约一致，字段名不得变更（JSONL 持久化契约）。 */
export interface EditEvent {
  ts: number;
  lang: string;
  indent: number;
  prev: string | null;
  line: string;
}

/**
 * 行定型状态机（纯逻辑，可单测）。
 * 维护「上次光标所在行」与「自上次定型后被编辑过的行集合」，光标换行时把旧行定型。
 */
export class LineCollector {
  private lastLine: number | null = null;
  private dirty = new Set<number>();

  /** 光标移动到 line；若离开的旧行 dirty，返回该行号（待采集），否则返回 null。 */
  cursorMoved(line: number): number | null {
    const prev = this.lastLine;
    this.lastLine = line;
    if (prev === null || prev === line) return null;
    if (!this.dirty.has(prev)) return null;
    this.dirty.delete(prev);
    return prev;
  }

  /** 内容变更涉及 [startLine, endLine] 区间，标记 dirty。 */
  changed(startLine: number, endLine: number): void {
    for (let l = startLine; l <= endLine; l++) this.dirty.add(l);
  }

  /** 重置状态并锚定当前光标行基线（atLine 为 null 表示无基线，如模型关闭）。 */
  reset(atLine: number | null = null): void {
    this.lastLine = atLine;
    this.dirty.clear();
  }
}

/** 行内容最小时源码（结构类型，真 Monaco model 与测试桩均可满足）。 */
interface LineSource {
  getLanguageId(): string;
  getLineCount(): number;
  getLineContent(lineNumber: number): string;
}

/**
 * 从源码提取某行的「行对」事件（纯函数，可单测）。
 * 返回 null 表示该行无需采集（非 python / 空行 / 越界）。
 */
export function eventAt(
  now: number,
  source: LineSource,
  lineNumber: number,
): EditEvent | null {
  if (source.getLanguageId() !== "python") return null;
  const lineCount = source.getLineCount();
  if (lineNumber < 1 || lineNumber > lineCount) return null;

  const raw = source.getLineContent(lineNumber);
  const line = raw.trim();
  if (!line) return null;

  const indent = raw.length - raw.trimStart().length;

  // 上一非空行（向上回看，至多 5 行，避免跨越空行/代码块引入无关上下文）
  let prev: string | null = null;
  const MAX_LOOKBACK = 5;
  const lower = Math.max(1, lineNumber - MAX_LOOKBACK);
  for (let l = lineNumber - 1; l >= lower; l--) {
    const p = source.getLineContent(l).trim();
    if (p) {
      prev = p;
      break;
    }
  }

  return { ts: now, lang: "python", indent, prev, line };
}

/** 逐条落盘（fire-and-forget；频率低，无缓冲丢失问题；失败静默） */
function append(ev: EditEvent): void {
  void invoke("edit_history_append", { events: [ev] }).catch(() => {
    /* 采集失败静默，绝不干扰编辑主流程 */
  });
}

/**
 * 初始化采集器：挂内容变更 / 光标移动 / 模型切换三个监听。
 * 编辑器是单例、与 WebView 同生命周期，监听随之常驻，无需额外 dispose 钩子
 * （与 gutterHover.ts 的编辑器级监听同惯例）。
 */
export function initEditHistory(editor: MonacoApi.editor.IStandaloneCodeEditor): void {
  const collector = new LineCollector();

  // 锚定当前光标行作为基线（初始化 + 模型切换后各一次，不触发采集）
  const anchor = () => collector.reset(editor.getPosition()?.lineNumber ?? null);
  anchor();

  editor.onDidChangeModelContent((e) => {
    for (const ch of e.changes) {
      const start = ch.range.startLineNumber;
      // range.endLineNumber 不覆盖「纯插入多行」新增的行，按插入换行数扩展。
      const addedLines = ch.text.match(/\n/g)?.length ?? 0;
      const end = Math.max(ch.range.endLineNumber, ch.range.endLineNumber + addedLines);
      collector.changed(start, end);
    }
  });

  editor.onDidChangeCursorPosition((e) => {
    const model = editor.getModel();
    if (!model) return;
    const settled = collector.cursorMoved(e.position.lineNumber);
    if (settled === null) return;
    const ev = eventAt(Date.now(), model, settled);
    if (ev) append(ev);
  });

  editor.onDidChangeModel(() => {
    anchor();
  });
}