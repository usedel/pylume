// 新手引导域（onboarding dev plan v1.2，PR-S1 + PR-S2）：
//   S1  openOnboardingGuide()——新手指南单一入口（复用 pluginsTab::openGuide 先例：
//       ?raw 打包 → get_data_doc_path 定位数据根 docs/ → write_file 覆写 → openFile，
//       .md 自动开预览；每次覆写即最新，无版本陈旧问题）。
//   S2  欢迎页三步卡（教学 + 键位展示，不代触发）+ 功能巡礼（数据驱动 checklist，
//       挂命令面板注册表「单一数据源」）+ force-show 欢迎页（MB-13 收口）。
//
// 设计准绳（方案 §2.0 友好性三定律）：在对的时刻出现 / 一步可体验 / 可结束。
// 工程红线：巡礼条目与「试一下」直接挂 quickOpen 注册表（findQuickOpenAction 按 id
// 实时查 run），发现层只维护策展数据（选哪些 + 一句话），绝不复制第二份功能清单。
//
// force-show 是纯显示层覆盖（方案 §6 决策 4）：不动 workspaceRoot / activeTab / session，
// 只有一个模块级布尔位 + updateEditorOverlay 的前置分支；用户点任何动作按钮即解除。

import { invoke } from "@tauri-apps/api/core";
import { bindingLabel, type KeybindingId } from "./keybindings";
import { findQuickOpenAction } from "./quickOpen";
import { $, $btn } from "./state";
import { codicon, errMsg } from "./util";
import { toast } from "./toast";
import { onLocaleChange, t } from "./i18n"; // 第九批 i18n：欢迎域动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";
// 指南源（仓库 docs/，经 ?raw 打包进产物）：src/ → 仓库根是一级上溯
import guideRaw from "../../docs/onboarding_guide.md?raw";

// ---------- S1：新手指南入口 ----------

/** 指南落盘后打开文件的能力（main.ts 注入 openFile；handler 注入模式防循环依赖） */
let openGuideFile: ((path: string) => Promise<unknown>) | null = null;

/** 注入「打开文件」能力（main.ts init；wireNewProject 同款模式） */
export function setWelcomeGuideHandlers(h: { openFile: (path: string) => Promise<unknown> }): void {
  openGuideFile = h.openFile;
}

/** 写文件到数据根 docs/（复用 fs write_file；路径 = <data_root>/docs/<name>，带逃逸校验） */
async function writeDataDoc(name: string, content: string): Promise<string> {
  const path = await invoke<string>("get_data_doc_path", { name });
  await invoke("write_file", { path, content });
  return path;
}

/** 打开新手指南（落盘数据根 docs → openFile → .md 自动开预览）。
 *  帮助菜单「新手指南」/ 命令面板 onboarding_guide / 欢迎页「查看完整指南」链接共用此入口。 */
export async function openOnboardingGuide(): Promise<void> {
  if (!openGuideFile) return;
  try {
    const path = await writeDataDoc("onboarding_guide.md", guideRaw);
    await openGuideFile(path);
  } catch (e) {
    toast(t("welcome.guide.openFailed", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) }), "error");
  }
}

// ---------- S2a：三步卡（教学文案 + 键位展示，不代触发） ----------

interface QuickstartStep {
  /** 序号图标（codicon） */
  icon: string;
  /** 步骤名 */
  title: string;
  /** 一句话说明（含动作语义；键位单独读键位系统跟随改键） */
  desc: string;
  /** 键位表 id（有键位才传；「新建项目」无键位列） */
  kb?: KeybindingId;
  /** 卡 ① 点击直达动作（打开文件夹 / 新建项目这类空工作区有意义的入口） */
  action?: () => void;
}

/** 三步卡步骤（v1.2 §3.2a：②③ 只做键位教学不代触发——运行/调试需要目标文件，空工作区点了没意义）。
 *  i18n：构建函数 + let 缓存，语言切换时重建（见 wireWelcomeGuide 的订阅）。 */
function buildQuickstart(): QuickstartStep[] { return [
  {
    icon: "add",
    title: t("welcome.guide.qsNewProject"),
    desc: t("welcome.guide.qsNewProjectDesc"),
  },
  {
    icon: "play",
    title: t("welcome.guide.qsRunScript"),
    desc: t("welcome.guide.qsRunScriptDesc"),
    kb: "run_script",
  },
  {
    icon: "debug-alt",
    title: t("welcome.guide.qsDebug"),
    desc: t("welcome.guide.qsDebugDesc"),
    kb: "debug",
  },
];
}
let QUICKSTART = buildQuickstart();


/** 渲染三步卡（幂等：全量重建）。调用点：wireWelcomeGuide 一次 + updateEditorOverlay（覆盖层显示时）。 */
export function renderQuickstartCards(): void {
  const wrap = $("ew-quickstart-steps");
  wrap.textContent = "";
  for (const step of QUICKSTART) {
    const card = document.createElement("div");
    card.className = "ew-qs-step";
    const head = document.createElement("div");
    head.className = "ew-qs-head";
    const badge = document.createElement("span");
    badge.className = "ew-qs-badge";
    badge.appendChild(codicon(step.icon));
    const title = document.createElement("span");
    title.className = "ew-qs-title";
    title.textContent = step.title;
    head.append(badge, title);
    if (step.kb) {
      const kbd = document.createElement("kbd");
      kbd.textContent = bindingLabel(step.kb) || t("welcome.guide.unbound");
      head.appendChild(kbd);
    }
    const desc = document.createElement("div");
    desc.className = "ew-qs-desc";
    desc.textContent = step.desc;
    card.append(head, desc);
    wrap.appendChild(card);
  }
}

// ---------- S2b：功能巡礼（数据驱动 checklist） ----------

/** 巡礼条目（v1.2 字段定稿，方案 §3.2b）：quickOpenId 与 keybindingId 分离——两者不总一致 */
export interface TourItem {
  /** 命令面板注册表 id（main.ts::buildQuickOpenActions 条目 id）——「试一下」直接调其 run */
  quickOpenId: string;
  /** 键位表 id；有键位才传，无键位功能省略（键位列自动不渲染） */
  keybindingId?: KeybindingId;
  /** 一句话价值描述（不是功能名复读） */
  blurb: string;
}

/** 首批 6 条（v1.2 定稿，id/键位均已核实存在；数据卫生测试锁两侧存在性）。
 *  策展依据：不选运行/调试/git（三步卡已覆盖）· 不选设置类 · 选「打开即见内容、体验闭环最短」的。 */
function buildTourItems(): TourItem[] { return [
  { quickOpenId: "open_devtools", keybindingId: "open_devtools", blurb: t("welcome.guide.devtools") },
  { quickOpenId: "template_palette", keybindingId: "template_palette", blurb: t("welcome.guide.liveTemplates") },
  { quickOpenId: "todo_panel", blurb: t("welcome.guide.todo") },
  { quickOpenId: "bookmark_list", keybindingId: "bookmark_list", blurb: t("welcome.guide.bookmarks") },
  { quickOpenId: "run_history", keybindingId: "run_history", blurb: t("welcome.guide.runHistory") },
  { quickOpenId: "local_history", keybindingId: "local_history", blurb: t("welcome.guide.localHistory") },
];
}
/** i18n：导出绑定随语言切换重建（ES live binding，外部遍历方无需感知） */
export let TOUR_ITEMS: TourItem[] = buildTourItems();

/** 完成态 localStorage key（按条目持久化；key = quickOpenId） */
const TOUR_KEY_PREFIX = "pylume.tour.";

export function tourDoneKey(quickOpenId: string): string {
  return TOUR_KEY_PREFIX + quickOpenId;
}

/** 读单条完成态（localStorage 不可用 / 值异常时按未完成处理） */
export function isTourDone(quickOpenId: string): boolean {
  try {
    return localStorage.getItem(tourDoneKey(quickOpenId)) === "1";
  } catch {
    return false;
  }
}

/** 写单条完成态（「点即完成」语义，方案 §6 决策 7） */
function markTourDone(quickOpenId: string): void {
  try {
    localStorage.setItem(tourDoneKey(quickOpenId), "1");
  } catch {
    // localStorage 满 / 隐私模式：完成态记不住就算了，不影响功能
  }
}

/** 清空全部巡礼完成态（测试 / 「重新体验」入口用） */
export function resetTourProgress(): void {
  try {
    for (const item of TOUR_ITEMS) localStorage.removeItem(tourDoneKey(item.quickOpenId));
  } catch {
    // 同上
  }
}

/** 已完成条目数 */
export function tourDoneCount(): number {
  return TOUR_ITEMS.reduce((n, t) => n + (isTourDone(t.quickOpenId) ? 1 : 0), 0);
}

/** 「试一下」执行路径（v1.2 定稿）：经 quickOpen 注册表按 id 实时查 run 并调用。
 *  查不到（注册表重构后 id 消失）返回 false——调用方降级显示「该功能已变更」，不静默失效。 */
export function runTourAction(quickOpenId: string): boolean {
  const action = findQuickOpenAction(quickOpenId);
  if (!action) return false;
  action.run();
  return true;
}

/** 巡礼区折叠态（「全部完成 / 不感兴趣」→ 折叠成一行；模块级，会话内保持） */
let tourCollapsed = false;

export function isTourCollapsed(): boolean {
  return tourCollapsed;
}

export function setTourCollapsed(v: boolean): void {
  tourCollapsed = v;
}

/** 渲染功能巡礼区（幂等：全量重建）。调用点同 renderQuickstartCards。 */
export function renderTour(): void {
  const section = $("ew-tour-section");
  const body = $("ew-tour-body");
  const countEl = $("ew-tour-count");
  const done = tourDoneCount();
  countEl.textContent = t("welcome.guide.progress", { done: done, total: TOUR_ITEMS.length });

  // 折叠态：整区收成一行（标题 + 计数 + 展开箭头），可重新展开（退场律）
  section.classList.toggle("collapsed", tourCollapsed);
  if (tourCollapsed) return;

  body.textContent = "";
  for (const item of TOUR_ITEMS) {
    const row = document.createElement("div");
    row.className = "ew-tour-item";
    const checked = isTourDone(item.quickOpenId);
    row.classList.toggle("done", checked);

    const box = document.createElement("span");
    box.className = "ew-tour-check";
    box.appendChild(codicon(checked ? "check" : "circle-large-outline"));
    const desc = document.createElement("span");
    desc.className = "ew-tour-desc";
    desc.textContent = item.blurb;
    row.append(box, desc);

    if (!checked) {
      const tryBtn = document.createElement("button");
      tryBtn.className = "btn btn--sm";
      tryBtn.textContent = t("welcome.guide.tryIt");
      tryBtn.addEventListener("click", () => {
        if (!runTourAction(item.quickOpenId)) {
          // 注册表条目消失（功能重构）：显式降级提示，不静默失效
          toast(t("welcome.guide.changedToast"), "info");
          return;
        }
        markTourDone(item.quickOpenId);
        renderTour(); // 计数与勾选即时刷新
      });
      row.appendChild(tryBtn);
    }

    if (item.keybindingId) {
      const kbd = document.createElement("kbd");
      kbd.textContent = bindingLabel(item.keybindingId) || t("welcome.guide.unbound");
      row.appendChild(kbd);
    }
    body.appendChild(row);
  }

  // 底部收口链接（退场律：能关掉它）。「不感兴趣，收起」/「全部完成，收起」都折叠成一行；
  // 全完成时另给「重新体验」重置入口（否则只能清 localStorage 才能重来）。
  const foot = $("ew-tour-foot");
  foot.textContent = "";
  const allDone = done === TOUR_ITEMS.length;
  const link = document.createElement("a");
  link.className = "ew-tour-fold";
  link.textContent = allDone ? t("welcome.guide.collapseDone") : t("welcome.guide.collapseDismiss");
  link.setAttribute("role", "button");
  link.tabIndex = 0;
  const fold = (): void => {
    setTourCollapsed(true);
    renderTour();
  };
  link.addEventListener("click", fold);
  link.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fold();
    }
  });
  foot.appendChild(link);
  if (allDone) {
    const redo = document.createElement("a");
    redo.className = "ew-tour-fold";
    redo.textContent = t("welcome.guide.redo");
    redo.setAttribute("role", "button");
    redo.tabIndex = 0;
    const reset = (): void => {
      resetTourProgress();
      renderTour();
    };
    redo.addEventListener("click", reset);
    redo.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        reset();
      }
    });
    foot.appendChild(redo);
  }
}

/** 折叠态下标题行的展开箭头（wireWelcomeGuide 绑定；渲染仅切类） */
export function expandTour(): void {
  setTourCollapsed(false);
  renderTour();
}

// ---------- S2c：force-show 欢迎页（MB-13 收口） ----------

let forceWelcome = false;

export function isWelcomeForced(): boolean {
  return forceWelcome;
}

/** 显示完整版欢迎页（尊重 activeTab / workspaceRoot 的显示层覆盖） */
export function showWelcomeOverlay(): void {
  forceWelcome = true;
  onWelcomeVisibilityChanged?.();
}

/** 解除 force 态（帮助菜单再点一次 toggle / 关闭按钮 / 用户点了任何动作按钮） */
export function dismissWelcomeOverlay(): void {
  forceWelcome = false;
  onWelcomeVisibilityChanged?.();
}

/** force 态变化时通知 main 刷新覆盖层（updateEditorOverlay 注入，防循环依赖） */
let onWelcomeVisibilityChanged: (() => void) | null = null;

export function setWelcomeOverlayRefresh(fn: () => void): void {
  onWelcomeVisibilityChanged = fn;
}

/** 动作按钮点击后自动解除（方案 §3.2c 关闭途径 ③）：ew-open-folder / ew-new-project / 最近工作区行 */
export function consumeWelcomeForce(): void {
  if (forceWelcome) dismissWelcomeOverlay();
}

// ---------- 接线 ----------

/** 欢迎页引导接线（main.ts init 调一次；§8 P3：事件绑定自包含，main 只加一行） */
export function wireWelcomeGuide(): void {
  // 语言切换：重建文案数组并重绘欢迎层内的动态区（元素缺失时跳过——覆盖层未挂载即无文本残留）
  onLocaleChange(() => {
    QUICKSTART = buildQuickstart();
    TOUR_ITEMS = buildTourItems();
    if (document.getElementById("ew-quickstart-steps")) renderQuickstartCards();
    if (document.getElementById("ew-tour-section")) renderTour();
  });

  // 指南链接（三步卡下方）
  $("ew-guide-link").addEventListener("click", () => void openOnboardingGuide());

  // force 态右上角关闭按钮（仅 force 态显示，显隐由 updateEditorOverlay 同步）
  $btn("ew-force-close").addEventListener("click", () => dismissWelcomeOverlay());

  // 动作按钮点击 → 自动解除 force（打开文件夹 / 新建项目）
  $("ew-open-folder").addEventListener("click", () => consumeWelcomeForce());
  $("ew-new-project").addEventListener("click", () => consumeWelcomeForce());

  // 最近工作区行由 main 渲染（renderEditorWelcomeRecents），force 解除挂在容器级点击委托上：
  // 行点击本身会 openWorkspace，此时 force 若不解除，切完工作区覆盖层仍盖在编辑器上。
  $("ew-recent-list").addEventListener("click", () => consumeWelcomeForce());

  // 巡礼折叠态标题行点击展开
  $("ew-tour-header").addEventListener("click", () => {
    if (isTourCollapsed()) expandTour();
  });

  // 首次渲染（键位出厂值；设置加载后由 updateEditorOverlay 刷新为真实值，同 welcomeShortcuts）
  renderQuickstartCards();
  renderTour();
}
