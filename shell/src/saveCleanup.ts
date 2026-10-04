// 保存时清理（PR-C · dx_features_backlog §6.3）：行尾空白 + 最终换行。
//
// 归属：独立纯函数模块（TD-014；无 DOM/无 Monaco 依赖，可直接 vitest）。
// 纪律：与 format/整理 imports 同一批「显式保存才跑」的钩子——调用方必须以
// `opts.runOnSaveActions !== false` 门控（autosave/失焦/运行前/git 落盘四个消费方跳过）。
// 应用方式沿用 saveTab 内 isort/format 的先例：内容变化时**单次 setValue**，
// Ctrl+Z 整体撤销本次保存动作（而非逐处微编辑污染撤销栈）。

export interface SaveCleanupOptions {
  /** 清理行尾空白（空格 / Tab） */
  trimTrailing: boolean;
  /** 缺最终换行时补齐（不收敛已有的多余空行） */
  finalNewline: boolean;
}

/**
 * 纯函数：按选项清理文件内容。
 * - 行尾空白只剥空格/Tab，**保留 \r**（CRLF 文件按 \r\n 整行归一处理，不破坏 EOL）；
 * - EOL 以 Monaco model 的归一结果为准（createModel 时按内容多数 EOL 探测并统一全部
 *   行尾，getValue() 不会给出混合 EOL），此处 split/join 往返是 EOL 保真的；
 * - finalNewline 只保证「以恰好至少一个换行结束」，不折叠结尾多余空行（同 PyCharm 语义）；
 * - 空文件不动（避免把空文件写成单个换行）。
 */
export function cleanupSaveContent(content: string, opts: SaveCleanupOptions): string {
  if (!opts.trimTrailing && !opts.finalNewline) return content;
  if (content.length === 0) return content;

  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  let out = content;
  if (opts.trimTrailing) {
    const lines = out.split(/\r?\n/);
    out = lines.map((l) => l.replace(/[ \t]+$/, "")).join(eol);
  }
  if (opts.finalNewline && !out.endsWith("\n")) {
    out += eol;
  }
  return out;
}
