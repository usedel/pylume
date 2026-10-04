// 导航历史（P1，PyCharm Ctrl+Alt+Left/Right 对标）：跳转定义后能原路返回。
//
// 我们对标的是 PyCharm 的「跳转闭环」而非浏览器的「页面历史」，故模型取
// **位置栈 + 游标**（history[] + index）：
//   · 每次导航先记「离开前的位置」（pushCurrent），再记「到达的位置」（noteOpen）；
//   · 后退 / 前进只移动游标，不改写栈——所以来回横跳不会把历史压扁；
//   · 在中间位置发生新导航时，截断前进段（与浏览器一致）。
//
// 抑制标志 `applying`：后退/前进本身会触发 openFile，若不加抑制就会把「回退到的位置」
// 又当成一次新导航压回栈里，历史立刻自我破坏（这是该模型唯一的坑，务必保留）。

import { app } from "./state";
import { samePath } from "./util";
import { toast } from "./toast";
import { t } from "./i18n"; // 第十二批 i18n：导航历史动态文案走语言包

export interface NavLocation {
  path: string;
  line: number;
  column: number;
}

export interface NavHistoryHandlers {
  /** 打开并定位（main.ts 的 openFile） */
  openFile: (path: string, line: number) => Promise<void>;
}

let handlers: NavHistoryHandlers | null = null;

export function setNavHistoryHandlers(h: NavHistoryHandlers): void {
  handlers = h;
}

/** 栈容量上限（超出从头部淘汰，防止长会话无限增长） */
const MAX_HISTORY = 200;

const history: NavLocation[] = [];
let index = -1;
/** 后退/前进期间置位：其间的 openFile 不得再入栈 */
let applying = false;

function sameLoc(a: NavLocation, b: NavLocation): boolean {
  return samePath(a.path, b.path) && a.line === b.line;
}

/** 入栈：与栈顶相同则只更新列（原地停留不产生新条目）；否则截断前进段后追加 */
function push(loc: NavLocation): void {
  const top = history[index];
  if (top && sameLoc(top, loc)) {
    history[index] = { ...top, column: loc.column };
    return;
  }
  history.splice(index + 1);
  history.push(loc);
  if (history.length > MAX_HISTORY) history.splice(0, history.length - MAX_HISTORY);
  index = history.length - 1;
}

/** 导航发生**前**调用：记下离开前的位置（编辑器当前光标） */
export function pushCurrent(): void {
  if (applying) return;
  const tab = app.activeTab;
  if (!tab) return;
  const pos = app.editor.getPosition();
  push({ path: tab.path, line: pos?.lineNumber ?? 1, column: pos?.column ?? 1 });
}

/**
 * 导航完成**后**调用：记下到达的位置。
 * main.ts 的 doOpenFile 末尾调用；后退/前进期间被 `applying` 抑制。
 */
export function noteOpen(path: string, line: number): void {
  if (applying) return;
  push({ path, line: Math.max(1, line), column: 1 });
}

export function canGoBack(): boolean {
  return index > 0;
}

export function canGoForward(): boolean {
  return index >= 0 && index < history.length - 1;
}

/** 移动游标并跳转；无法移动返回 false。
 *  P1（UX 审查）：到尽头时给 toast 反馈——原先返回值被调用方忽略，用户按 Ctrl+Alt+Left
 *  毫无反应时不明白原因（键盘与菜单两条路径共用此唯一实现，反馈只写一处）。 */
async function move(delta: number): Promise<boolean> {
  const next = index + delta;
  if (next < 0 || next >= history.length) {
    toast(delta < 0 ? t("editor.nav.oldest") : t("editor.nav.newest"));
    return false;
  }
  index = next;
  const loc = history[next];
  applying = true;
  try {
    await handlers?.openFile(loc.path, loc.line);
    app.editor.setPosition({ lineNumber: loc.line, column: loc.column });
    app.editor.revealLineInCenter(loc.line);
    app.editor.focus();
  } finally {
    applying = false;
  }
  return true;
}

export function goBack(): Promise<boolean> {
  return move(-1);
}

export function goForward(): Promise<boolean> {
  return move(1);
}

/** 工作区切换 / 关闭时清空（跨工作区的历史没有意义） */
export function resetNavHistory(): void {
  history.length = 0;
  index = -1;
  applying = false;
}

/** 当前栈长度（测试与诊断用） */
export function navHistorySize(): number {
  return history.length;
}
