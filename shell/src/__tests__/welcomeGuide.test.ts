// @vitest-environment happy-dom
// welcomeGuide 纯函数测试（onboarding plan §5 vitest 基线）：
//   forceWelcome 状态机（置位/解除/动作按钮自动解除全覆盖）· 三步卡键位标签（改键跟随）·
//   巡礼策展数据卫生（quickOpenId 在命令注册表、keybindingId 在键位表——防两侧改名后静默失效）·
//   完成态 localStorage 读写/容错/计数 · runTourAction id 查不到降级。
//
// quickOpenId 存在性验证方式：main.ts::buildQuickOpenActions 是模块私有且 main.ts import 即
// 执行 init，不可直接引入——改用读 main.ts 源码文本提取 `{ id: "..." }` 清单做静态断言
//（id 字符串改名必然改动源码文本，同样能锁漂移）。
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { KEYBINDING_META } from "../keybindingDefaults";
import { registerQuickOpenActions } from "../quickOpen";
import { app } from "../state";
import {
  TOUR_ITEMS,
  consumeWelcomeForce,
  dismissWelcomeOverlay,
  isTourDone,
  isWelcomeForced,
  renderQuickstartCards,
  renderTour,
  resetTourProgress,
  runTourAction,
  setTourCollapsed,
  showWelcomeOverlay,
  tourDoneCount,
  tourDoneKey,
} from "../welcomeGuide";

// happy-dom 环境下 import.meta.url 是 http scheme，fileURLToPath 会抛错——
// vitest 的 cwd 即 vite root（shell/），用 process.cwd() 定位 main.ts。
const MAIN_TS = resolve(join(process.cwd(), "src", "main.ts"));
/** 从 main.ts 提取命令注册表静态 id（`{ id: "xxx", label:` 形态；动态前缀条目不在巡礼清单内） */
function quickOpenIdsInMain(): Set<string> {
  const src = readFileSync(MAIN_TS, "utf8");
  const ids = new Set<string>();
  for (const m of src.matchAll(/\{ id: "([a-z0-9_]+)", label:/g)) ids.add(m[1]);
  return ids;
}

/** 挂欢迎页引导区所需的最小 DOM 骨架（$ 找不到即抛错，测试须先就位） */
function mountWelcomeDom(): void {
  document.body.innerHTML = [
    '<div id="ew-quickstart"><div id="ew-quickstart-steps"></div></div>',
    '<div id="ew-tour-section"><div id="ew-tour-header"></div><div id="ew-tour-count"></div>'
    + '<div id="ew-tour-body"></div><div id="ew-tour-foot"></div></div>',
  ].join("");
}

beforeEach(() => {
  mountWelcomeDom();
  resetTourProgress();
  setTourCollapsed(false);
  registerQuickOpenActions([]);
  // 键位恢复出厂默认（个别用例改键后不污染后续）
  for (const m of KEYBINDING_META) app.settings.keybindings[m.id] = m.def;
});

describe("forceWelcome 状态机（PR-S2c）", () => {
  it("默认未置位；showWelcomeOverlay 置位、dismissWelcomeOverlay 解除", () => {
    expect(isWelcomeForced()).toBe(false);
    showWelcomeOverlay();
    expect(isWelcomeForced()).toBe(true);
    dismissWelcomeOverlay();
    expect(isWelcomeForced()).toBe(false);
  });

  it("consumeWelcomeForce：force 态下动作按钮点击自动解除；非 force 态无副作用", () => {
    consumeWelcomeForce();
    expect(isWelcomeForced()).toBe(false); // 幂等，不误置位
    showWelcomeOverlay();
    consumeWelcomeForce();
    expect(isWelcomeForced()).toBe(false);
  });

  it("重复 show 幂等；dismiss 后可再次 show", () => {
    showWelcomeOverlay();
    showWelcomeOverlay();
    expect(isWelcomeForced()).toBe(true);
    dismissWelcomeOverlay();
    showWelcomeOverlay();
    expect(isWelcomeForced()).toBe(true);
    dismissWelcomeOverlay();
  });
});

describe("三步卡渲染（PR-S2a）", () => {
  it("渲染三张卡，键位标签读键位系统", () => {
    renderQuickstartCards();
    const cards = document.querySelectorAll(".ew-qs-step");
    expect(cards.length).toBe(3);
    // 「运行脚本」卡应含出厂键位 Ctrl+F10
    const runCard = cards[1] as HTMLElement;
    expect(runCard.querySelector("kbd")?.textContent).toBe("Ctrl+F10");
    // 「新建项目」无键位列
    expect((cards[0] as HTMLElement).querySelector("kbd")).toBeNull();
  });

  it("改键跟随：改 run_script 键位后重渲标签同步", () => {
    app.settings.keybindings.run_script = "Ctrl+Alt+R";
    renderQuickstartCards();
    const cards = document.querySelectorAll(".ew-qs-step");
    expect((cards[1] as HTMLElement).querySelector("kbd")?.textContent).toBe("Ctrl+Alt+R");
  });
});

describe("巡礼策展数据卫生（单一数据源锁定，方案 §6 决策 6）", () => {
  it("条目数在 4~12 上下限内（防清单一句话复读机化 / 爆炸化）", () => {
    expect(TOUR_ITEMS.length).toBeGreaterThanOrEqual(4);
    expect(TOUR_ITEMS.length).toBeLessThanOrEqual(12);
  });

  it("quickOpenId 唯一且存在于命令注册表（main.ts 静态提取；改名即红）", () => {
    const ids = new Set(TOUR_ITEMS.map((t) => t.quickOpenId));
    expect(ids.size).toBe(TOUR_ITEMS.length);
    const registered = quickOpenIdsInMain();
    for (const t of TOUR_ITEMS) {
      expect(registered.has(t.quickOpenId), `quickOpenId "${t.quickOpenId}" 不在命令注册表`).toBe(true);
    }
  });

  it("keybindingId（若有）存在于键位表 KEYBINDING_META（防键位改名后巡礼失真）", () => {
    const known = new Set(KEYBINDING_META.map((m) => m.id));
    for (const t of TOUR_ITEMS) {
      if (t.keybindingId) {
        expect(known.has(t.keybindingId), `keybindingId "${t.keybindingId}" 不在键位表`).toBe(true);
      }
    }
  });

  it("blurb 非空且不是功能名复读（有内容长度下限）", () => {
    for (const t of TOUR_ITEMS) expect(t.blurb.length).toBeGreaterThan(6);
  });
});

describe("巡礼完成态（点即完成，localStorage 持久化）", () => {
  it("isTourDone / tourDoneKey / tourDoneCount 读写闭环", () => {
    expect(isTourDone("open_devtools")).toBe(false);
    localStorage.setItem(tourDoneKey("open_devtools"), "1");
    expect(isTourDone("open_devtools")).toBe(true);
    expect(tourDoneCount()).toBe(1);
  });

  it("resetTourProgress 清空全部完成态", () => {
    for (const t of TOUR_ITEMS) localStorage.setItem(tourDoneKey(t.quickOpenId), "1");
    expect(tourDoneCount()).toBe(TOUR_ITEMS.length);
    resetTourProgress();
    expect(tourDoneCount()).toBe(0);
  });

  it("localStorage 异常时容错（值异常按未完成处理）", () => {
    localStorage.setItem(tourDoneKey("todo_panel"), "yes"); // 非 "1"
    expect(isTourDone("todo_panel")).toBe(false);
  });
});

describe("runTourAction（试一下执行路径）", () => {
  it("注册表命中时执行 run 并返回 true", () => {
    let ran = 0;
    registerQuickOpenActions([{ id: "open_devtools", label: "开发工具面板", run: () => { ran += 1; } }]);
    expect(runTourAction("open_devtools")).toBe(true);
    expect(ran).toBe(1);
  });

  it("id 查不到（注册表重构后条目消失）返回 false——降级路径不静默失效", () => {
    expect(runTourAction("gone_feature")).toBe(false);
  });
});

describe("巡礼渲染与折叠（退场律）", () => {
  it("渲染条目行 + 计数 0/N；未完成条目带「试一下」按钮", () => {
    renderTour();
    expect(document.querySelectorAll(".ew-tour-item").length).toBe(TOUR_ITEMS.length);
    expect(document.querySelectorAll(".ew-tour-item .btn").length).toBe(TOUR_ITEMS.length);
    expect(document.getElementById("ew-tour-count")?.textContent).toBe(`0/${TOUR_ITEMS.length} 已体验`);
  });

  it("折叠态：整区收成一行（body/foot 隐藏类由 CSS 接管），计数仍显示", () => {
    setTourCollapsed(true);
    renderTour();
    const section = document.getElementById("ew-tour-section");
    expect(section?.classList.contains("collapsed")).toBe(true);
    expect(document.getElementById("ew-tour-count")?.textContent).toBe(`0/${TOUR_ITEMS.length} 已体验`);
    setTourCollapsed(false);
  });

  it("完成条目淡化 + 勾选，不再渲染「试一下」", () => {
    localStorage.setItem(tourDoneKey("todo_panel"), "1");
    renderTour();
    const items = [...document.querySelectorAll(".ew-tour-item")] as HTMLElement[];
    expect(items[2].classList.contains("done")).toBe(true);
    expect(items[2].querySelector(".btn")).toBeNull();
    expect(document.getElementById("ew-tour-count")?.textContent).toBe(`1/${TOUR_ITEMS.length} 已体验`);
  });
});
