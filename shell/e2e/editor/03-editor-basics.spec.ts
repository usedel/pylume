/**
 * E2E：编辑器基本功 P1（对标调研 C-1 / C-2）
 *
 *  - E-BASIC-1 智能选区扩展/收缩（PyCharm Ctrl+W / Ctrl+Shift+W）
 *  - E-BASIC-2 行上下移动（PyCharm Ctrl+Shift+↑/↓）
 *  - E-BASIC-3 Ctrl+W 的放行契约（browserKeys.ts CLAIMED_IN_MONACO）：
 *    编辑器内**必须仍然 preventDefault**（否则 WebView 会关窗口），
 *    但**不得 stopPropagation**（否则 Monaco 收不到、键位形同虚设）
 *
 * 全部走真实键盘事件（page.keyboard.press），覆盖 browserKeys 护栏 → Monaco 键位规则的完整链路。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const SRC = "alpha = 1\nbeta = alpha + 2\nprint(beta)\n";
/** 带缩进的源码（缩进参考线 / 括号彩色化需要嵌套结构才渲染得出来） */
const INDENTED = "def main():\n    items = [1, 2, 3]\n    for i in items:\n        print(i)\n";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 读取当前活动编辑器的模型文本（按行） */
function lines(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const m = app.editor.getModel();
    const n = m.getLineCount();
    const out: string[] = [];
    for (let i = 1; i <= n; i++) out.push(m.getLineContent(i));
    return out;
  });
}

/** 当前选中的文本 */
function selection(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
    const ed = app.editor;
    const sel = ed.getSelection();
    if (!sel || sel.isEmpty()) return "";
    return ed.getModel().getValueInRange(sel);
  });
}

/** 把光标放到 (line, column) 并确保编辑器拿到焦点 */
async function setCaret(page: Page, line: number, column: number): Promise<void> {
  await page.evaluate(
    async ([l, c]) => {
      const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
      app.editor.setPosition({ lineNumber: l as number, column: c as number });
      app.editor.focus();
    },
    [line, column] as const,
  );
  // 真实键盘事件要求焦点确实落在 Monaco 的 textarea 上
  await expect(page.locator(".monaco-editor textarea")).toBeFocused({ timeout: 5_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
  repo = await makePlainDir({ "main.py": SRC, "indented.py": INDENTED });
  await equipPage(page, repo);
  await page.goto("/");
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  // 注：SRC 以 \n 结尾 → Monaco model 是 4 行（末行为空串），断言按 model 口径
  await expect(async () => expect(await lines(page)).toEqual(SRC.split("\n"))).toPass({
    timeout: 10_000,
  });
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-BASIC-1 智能选区：Ctrl+W 逐级扩大，Ctrl+Shift+W 缩小", async ({ page }) => {
  await setCaret(page, 1, 3); // alpha 的第三个字符处
  const before = await selection(page);
  expect(before).toBe(""); // 前置：无选区

  await page.keyboard.press("Control+w");
  const s1 = await selection(page);
  expect(s1.length).toBeGreaterThan(0); // 第一次：选中当前词

  await page.keyboard.press("Control+w");
  const s2 = await selection(page);
  expect(s2.length).toBeGreaterThan(s1.length); // 第二次：扩大到更大语法单元
  expect(s2).toContain(s1);

  await page.keyboard.press("Control+Shift+w");
  const s3 = await selection(page);
  expect(s3.length).toBeLessThan(s2.length); // 缩小回去
});

test("E-BASIC-2 移动行：Ctrl+Shift+↓ 交换两行，Ctrl+Shift+↑ 复原", async ({ page }) => {
  await setCaret(page, 1, 1);
  await page.keyboard.press("Control+Shift+ArrowDown");
  await expect
    .poll(async () => (await lines(page)).slice(0, 2), { timeout: 5_000 })
    .toEqual(["beta = alpha + 2", "alpha = 1"]);

  await page.keyboard.press("Control+Shift+ArrowUp");
  await expect
    .poll(async () => (await lines(page)).slice(0, 2), { timeout: 5_000 })
    .toEqual(["alpha = 1", "beta = alpha + 2"]);
});

test("E-BASIC-3 Ctrl+W 放行契约：编辑器内仍阻止浏览器动作，但事件继续传播给 Monaco", async ({ page }) => {
  await setCaret(page, 1, 3);
  const r = await page.evaluate(() => {
    const target = document.querySelector(".monaco-editor textarea") as HTMLElement | null;
    if (!target) throw new Error("未找到编辑器 textarea");
    let bubbled = false;
    const onDoc = () => {
      bubbled = true;
    };
    document.addEventListener("keydown", onDoc);
    const ev = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(ev);
    document.removeEventListener("keydown", onDoc);
    return { prevented: ev.defaultPrevented, bubbled };
  });
  expect(r.prevented).toBe(true); // 浏览器动作（关窗口）被拦
  expect(r.bubbled).toBe(true); // 但事件未被 stopPropagation —— Monaco 收得到

  // 编辑器外（侧栏输入框）仍应彻底吞掉：既不执行浏览器动作，也不冒泡
  await page.locator("#tab-search").click();
  await expect(page.locator("#search-input")).toBeVisible({ timeout: 5_000 });
  const outside = await page.evaluate(() => {
    const el = document.querySelector("#search-input") as HTMLElement | null;
    if (!el) throw new Error("未找到 #search-input");
    let bubbled = false;
    const onDoc = () => {
      bubbled = true;
    };
    document.addEventListener("keydown", onDoc);
    const ev = new KeyboardEvent("keydown", {
      key: "w",
      code: "KeyW",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    el.dispatchEvent(ev);
    document.removeEventListener("keydown", onDoc);
    return { prevented: ev.defaultPrevented, bubbled };
  });
  expect(outside.prevented).toBe(true);
  expect(outside.bubbled).toBe(false);
});

test("E-BASIC-4 可读性配置：缩进参考线可在设置里关掉再打开（默认开）", async ({ page }) => {
  await page.locator("#tree .tree-item .name", { hasText: "indented.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  await expect(page.locator(".view-line", { hasText: "print(i)" }).first()).toBeVisible({ timeout: 10_000 });

  const guideCount = () => page.locator(".monaco-editor .core-guide").count();
  await expect.poll(guideCount, { timeout: 5_000 }).toBeGreaterThan(0); // 默认开 → 有缩进线

  // 关掉：设置 → 编辑器 → 取消「缩进参考线」→ 保存
  await page.keyboard.press("Control+Alt+S");
  await expect(page.locator("#settings-modal, .modal:has(#settings-save)").first()).toBeVisible({ timeout: 5_000 });
  await page.locator('.settings-nav-item[data-cat="editor"]').click();
  await expect(page.locator("#settings-indent-guides")).toBeVisible({ timeout: 5_000 });
  await page.locator("#settings-indent-guides").uncheck();
  await page.locator("#settings-save").click();
  await expect.poll(guideCount, { timeout: 5_000 }).toBe(0);

  // 再打开：勾选 → 保存 → 缩进线回来
  await page.keyboard.press("Control+Alt+S");
  await page.locator('.settings-nav-item[data-cat="editor"]').click();
  await page.locator("#settings-indent-guides").check();
  await page.locator("#settings-save").click();
  await expect.poll(guideCount, { timeout: 5_000 }).toBeGreaterThan(0);
});
