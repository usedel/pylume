/**
 * E2E：批 5a · 动效可降级（方案 §7-16）+ 焦点环双环（§5.8）。
 *
 * ## 为什么要上 e2e（单测与门禁脚本都覆盖不到的部分）
 *
 * ① `--motion` 归零是**计算值行为**：`--transition-base` 写的是 `calc(0.15s * var(--motion))`，
 *    单测只能断言「字符串里有 var(--motion)」，无法证明浏览器真的算出了 0s。
 *    方案 §7-16 要求「prefers-reduced-motion 下全部动效仍为 0」，此前**只有代码审查、没有实测**。
 * ② 焦点环是 `spread-only` 双环（`0 0 0 2px` + `0 0 0 4px`）。单测能断言声明文本，
 *    但「两层 spread 是否真的叠成两圈可见的环」要读 computed。
 *
 * 焦点环用**真实键盘 Tab** 触发：`:focus-visible` 只在键盘导航时匹配，
 * `element.focus()` 这类编程式聚焦不会触发（那正是该伪类的设计目的）。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

let repo: GitRepo;

test.beforeEach(async () => {
  repo = await makePlainDir({ "main.py": "def f():\n    return 1\n" });
});

test("T-B5A-1 减少动画开关使 transition 时长真正归零（方案 §7-16）", async ({ page }) => {
  await equipPage(page, repo);
  await page.goto("/");

  const read = () =>
    page.evaluate(() => {
      // #sidebar 恒在（transition: width var(--transition-base)），不像 .tab .close
      // 要先打开文件、标签页出现后才存在——用恒存元素断言，避免选择器随 UI 状态漂移。
      const el = document.querySelector("#sidebar");
      const root = getComputedStyle(document.documentElement);
      return {
        motion: root.getPropertyValue("--motion").trim(),
        duration: el ? getComputedStyle(el).transitionDuration : null,
      };
    });

  const before = await read();
  expect(before.duration, "#sidebar 应存在且有 transition").not.toBeNull();
  expect(before.motion, "默认应启用动效（--motion: 1）").toBe("1");
  expect(before.duration, "默认应有非零过渡时长").not.toBe("0s");

  // ⚠ 必须等应用 init 完成（settings 已应用）后再改状态。
  // 首跑失败诊断：`setAttribute` 之后 `hasAttr` 已是 false —— 应用在 init 阶段按
  // settings 调 `applyReduceMotion(false)`（默认关 → 移除属性），把测试设的值冲掉了。
  // 也就是说：**在应用就绪前改它的状态，会与启动流程竞争**（真机层同样受此约束）。
  await expect(page.locator("#tree .tree-item").first()).toBeVisible({ timeout: 30_000 });

  // 走应用内开关的等价 DOM 状态（applyReduceMotion 做的就是这一件事）
  await page.evaluate(() => document.documentElement.setAttribute("data-reduce-motion", ""));
  const after = await read();
  const hasAttr = await page.evaluate(() => document.documentElement.hasAttribute("data-reduce-motion"));
  expect(hasAttr, "data-reduce-motion 应仍在（若被应用移除说明 init 尚未完成）").toBe(true);
  expect(after.motion, "开启后 --motion 应为 0").toBe("0");
  expect(after.duration, "开启后过渡时长必须归零（calc(0.15s * 0) = 0s）").toBe("0s");
});

test("T-B5A-2 键盘焦点环是双环且 outline 为 transparent（HCM 通道）", async ({ page }) => {
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#tree .tree-item").first()).toBeVisible({ timeout: 30_000 });

  // Tab 顺序取决于 UI 状态（menubar / 活动栏 / 工具栏各有多少可聚焦项），
  // 故不指定元素：**逐个 Tab 直到撞上带焦点环的控件**，任何一个都行。
  // :focus-visible 只认键盘导航，element.focus() 这类编程式聚焦不触发（那正是该伪类目的）。
  const ACCENT = "rgb(42, 168, 143)"; // --accent #2aa88f
  type Ring = { cls: string; boxShadow: string; outlineColor: string; outlineWidth: string };
  let ring: Ring | null = null;
  for (let i = 0; i < 60 && !ring; i++) {
    await page.keyboard.press("Tab");
    const info = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const cs = getComputedStyle(el);
      return { cls: el.className || el.tagName, boxShadow: cs.boxShadow, outlineColor: cs.outlineColor, outlineWidth: cs.outlineWidth };
    });
    if (info?.boxShadow.includes(ACCENT)) ring = info;
  }
  expect(ring, "60 次 Tab 内应聚焦到某个带焦点环的控件").not.toBeNull();

  // 双环 = 两个色值叠的 spread（gap 环 + accent 环）；单环只有一个
  const got = (ring as unknown as Ring).boxShadow;
  const layers = got.split(/,(?![^(]*\))/).filter((s) => s.includes("rgb"));
  expect(layers.length, `双环应有 2 层，实际 ${got}`).toBe(2);
  // 外圈 = --accent #2aa88f（we probed by it），内圈 = --focus-gap（半透明暗环）
  expect(got).toContain(ACCENT);
  expect(got).toContain("rgba(0, 0, 0, 0.55)"); // --focus-gap 深色

  // outline 保留但透明：Windows 强制高亮模式（HCM）靠 it 绘制系统焦点框
  expect((ring as unknown as Ring).outlineWidth).not.toBe("0px");
  expect((ring as unknown as Ring).outlineColor, "常态下 outline 应为透明（可见的是双环）").toBe("rgba(0, 0, 0, 0)");
});
