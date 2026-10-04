// 会话恢复（A-5，PyCharm 调研）：重开工作区后恢复标签页 / 光标位置 / 未保存草稿。
//
// 对标 PyCharm 的「重开项目还在原处」：PyCharm 关掉项目再打开，标签、光标、未保存的
// 编辑都还在。我们此前是「关工作区 = 一切消失」（main.ts::teardownCurrent 直接关所有 tab，
// 只留一句「将丢失」警告）。本模块补齐这一层：
//   - 快照落 Rust 侧 <data_root>/sessions/<project_hash>.json（覆盖式，与断点/书签同口径）
//   - 路径存**工作区相对路径**（换盘符/大小写不影响）
//   - 只恢复「现场」，不做版本回退（那是本地历史 history.rs 的职责）
//
// 与 main.ts 的耦合走 handler 注入（setSessionHandlers），避免反向 import 成环。

import { invoke } from "@tauri-apps/api/core";
import { app } from "./state";
import { relativePathRaw, joinPath, samePath } from "./util";

export interface SessionTab {
  /** 工作区相对路径 */
  path: string;
  line: number;
  column: number;
  /** 未保存草稿（仅脏标签携带）；null = 与磁盘一致 */
  draft: string | null;
}

export interface SessionState {
  tabs: SessionTab[];
  active: string | null;
}

interface SessionHandlers {
  openFile(path: string, revealLine?: number): Promise<void>;
  activateTabByPath(path: string): void;
  renderTabs(): void;
}

let handlers: SessionHandlers | null = null;

/** main.ts 注入（openFile / activateTabByPath / renderTabs），避免反向依赖 */
export function setSessionHandlers(h: SessionHandlers): void {
  handlers = h;
}

/** 防抖窗口：切 tab、移光标、敲字都会触发，合并成一次落盘 */
const SAVE_DEBOUNCE_MS = 800;
/** 单文件草稿上限（G-1 红线：持久化必须有界；超大文件不进快照，只留「打开过」） */
const MAX_DRAFT_CHARS = 512 * 1024;

let saveTimer: number | null = null;
let restoring = false;

/** 绝对路径 → 工作区相对路径；不在工作区内返回 null */
function toRel(abs: string): string | null {
  const root = app.workspaceRoot;
  if (!root) return null;
  return relativePathRaw(root, abs);
}

/** 工作区相对路径 → 绝对路径。
 *  用 joinPath 按 root 的分隔符风格拼接（Windows 下与 Rust 文件树返回的反斜杠路径
 *  字符串一致）。此前用 "/" 硬拼产生 D:\proj/src/a.py 混合分隔符路径，与文件树点击
 *  传入的路径字符串不等，openFile 查重落空 → 同一文件开出第二个标签。 */
function toAbs(rel: string): string | null {
  const root = app.workspaceRoot;
  if (!root) return null;
  return joinPath(root, rel);
}

/** 当前现场 → 快照；无工作区返回 null */
function snapshot(): SessionState | null {
  if (!app.workspaceRoot) return null;
  const tabs: SessionTab[] = [];
  for (const t of app.tabs) {
    if (t.kind && t.kind !== "file") continue; // diff 标签不入快照
    const rel = toRel(t.path);
    if (!rel) continue;
    const pos = t === app.activeTab ? app.editor?.getPosition() : undefined;
    let draft: string | null = null;
    if (t.dirty) {
      const text = t.model.getValue();
      draft = text.length <= MAX_DRAFT_CHARS ? text : null; // 超大草稿放弃（文件本身仍在快照里）
    }
    tabs.push({ path: rel, line: pos?.lineNumber ?? 1, column: pos?.column ?? 1, draft });
  }
  return { tabs, active: app.activeTab ? toRel(app.activeTab.path) : null };
}

/** 立即落盘（关闭工作区 / 防抖到期时用）。失败静默——快照失败不该打断用户操作。 */
export async function saveSessionNow(): Promise<void> {
  const root = app.workspaceRoot;
  if (!root || restoring) return;
  const state = snapshot();
  if (!state) return;
  try {
    await invoke("save_session", { root, state });
  } catch (e) {
    // G-3 最小可见降级：不打断操作，但连续失败（磁盘满/权限）时「重开工作区东西没了」
    // 必须有排查线索——console 留痕是底线（快照属后台行为，不弹 toast 打扰）。
    console.warn("[session] 会话快照写入失败：", e);
  }
}

/** 防抖落盘（切 tab / 移光标 / 编辑 / 关 tab 时调用） */
export function scheduleSessionSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveTimer = null;
    void saveSessionNow();
  }, SAVE_DEBOUNCE_MS);
}

/** 取消挂起的防抖保存（切工作区时用，避免用旧 root 写错文件） */
export function cancelPendingSessionSave(): void {
  if (saveTimer !== null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
}

/** 打开文件后按快照还原：光标 + 草稿（草稿覆盖 model 内容并置脏） */
function applyTabState(tabPath: string, t: SessionTab): void {
  const tab = app.tabs.find((x) => samePath(x.path, tabPath));
  if (!tab) return;
  if (t.draft != null) {
    tab.model.setValue(t.draft);
    tab.dirty = true;
  }
  if (app.activeTab === tab) {
    const line = Math.max(1, t.line);
    app.editor?.setPosition({ lineNumber: line, column: Math.max(1, t.column) });
    app.editor?.revealLineInCenter(line);
  }
}

/** 恢复上次现场（openWorkspace 成功后调用） */
export async function restoreSession(): Promise<void> {
  const root = app.workspaceRoot;
  const h = handlers;
  if (!root || !h) return;
  restoring = true; // 恢复过程中的编辑不应触发快照（否则半恢复状态会被写回去）
  try {
    const st = await invoke<SessionState>("get_session", { root });
    if (!st || !Array.isArray(st.tabs) || st.tabs.length === 0) return;
    for (const t of st.tabs) {
      const abs = toAbs(t.path);
      if (!abs) continue;
      try {
        await h.openFile(abs, t.line);
      } catch {
        continue; // 文件被外部删除 / 读取失败 → 跳过，不影响其余标签
      }
      applyTabState(abs, t);
    }
    // 激活上次活动的标签（openFile 会逐个激活，这里补回正确的那个）
    if (st.active) {
      const abs = toAbs(st.active);
      if (abs) {
        h.activateTabByPath(abs);
        const meta = st.tabs.find((x) => x.path === st.active);
        if (meta) applyTabState(abs, meta);
      }
    }
    h.renderTabs(); // 草稿置脏后刷新标签上的脏标记
  } catch (e) {
    // G-3：恢复失败同样留痕（否则用户只会觉得「上次打开的东西没了」无从排查）
    console.warn("[session] 会话快照恢复失败：", e);
  } finally {
    restoring = false;
  }
}
