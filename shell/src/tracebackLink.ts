// 输出链接跳转（TD-14 拆分，原 main.ts 的 gotoFromLink）：输出面板 / 终端里的
// traceback 链接 → 打开文件并定位；选区运行的临时文件先映射回源文件。
// openFile 经 setTracebackOpenFile 注入（main 在 init 中调用）——参照
// terminal.ts::setTerminalLinkHandler 的 handler 注入先例，避免与 main 循环依赖。

import { app, outputEl } from "./state";
import { joinPath } from "./util";
import { appendOutputLine, type OutputLink } from "./output";
import { selectionMetaOf } from "./runState";
import { toastFail } from "./toast";
import { t } from "./i18n"; // 第十六批 i18n：traceback 打开失败文案走语言包

type OpenFileFn = (path: string, revealLine?: number) => Promise<void>;

let openFileFn: OpenFileFn | null = null;

/** 注入 openFile（main 在 init 首行调用；所有链接点击都发生在 init 完成之后） */
export function setTracebackOpenFile(fn: OpenFileFn): void {
  openFileFn = fn;
}

export function gotoFromLink(link: OutputLink): void {
  let path = link.path;
  let line = link.line;
  // 选区运行 traceback 的临时文件 → 映射回源文件选区起始行
  //（v3.4 M3-3.3：多实例模型下按临时文件路径查找对应实例的 selection）
  const sel = selectionMetaOf(link.path);
  if (sel) {
    path = sel.sourcePath;
    line = sel.startLine + link.line - 1;
  }
  if (!/^[a-zA-Z]:[\\/]/.test(path) && app.workspaceRoot) {
    // CR-28：joinPath 而非硬编码 \\ 拼接（跨平台一致性）
    path = joinPath(app.workspaceRoot, path);
  }
  if (!openFileFn) return; // init 前不可能有链接点击（未接线即无面板输出）
  openFileFn(path, line).catch((e) => {
    appendOutputLine(outputEl, t("ide.traceback.openFailed", { path: link.path }), "stderr", gotoFromLink);
    toastFail(t("ide.traceback.openAction"), e);
  });
}
