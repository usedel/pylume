/**
 * E2E：PR-A 键位补齐组 + 复制 file:line（dx_features_backlog §6.1）
 *
 *  - E-DX-S1 删除行 Ctrl+Y（覆盖 Monaco/Windows 的「重做」内建）+ Ctrl+Shift+Z 重做仍可用
 *  - E-DX-S2 折叠全部 / 展开全部（Ctrl+Shift+- / Ctrl+Shift+=，单和弦——解析器不支持和弦故不取 VS Code 组合键）
 *  - E-DX-S3 括号匹配跳转 Ctrl+Shift+\（Monaco 内建同键，登记进键位表）
 *  - E-DX-S4 重新打开关闭的标签 Ctrl+Shift+Alt+T（Ctrl+Shift+T 已被 DevTools 占用）
 *  - E-DX-S5 tab 右键「复制 file:line 引用」（相对工作区根 + 当前行号）
 *
 * 键位用例全部走真实键盘事件（page.keyboard.press），覆盖 browserKeys 护栏 → Monaco 键位规则的完整链路。
 */
import { test, expect, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const SRC = "alpha = 1\nbeta = alpha + 2\nprint(beta)\n";
const INDENTED = "def main():\n    items = [1, 2, 3]\n    for i in items:\n        print(i)\n";

let repo: GitRepo;
const pageErrors: string[] = [];

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

async function setCaret(page: Page, line: number, column: number): Promise<void> {
  await page.evaluate(
    async ([l, c]) => {
      const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
      app.editor.setPosition({ lineNumber: l as number, column: c as number });
      app.editor.focus();
    },
    [line, column] as const,
  );
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
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("E-DX-S1 删除行：Ctrl+Y 删整行，undo/redo（Ctrl+Z / Ctrl+Shift+Z）链路完好", async ({ page }) => {
  await setCaret(page, 2, 1); // beta = alpha + 2
  await page.keyboard.press("Control+y");
  await expect
    .poll(async () => (await lines(page)).slice(0, 2), { timeout: 5_000 })
    .toEqual(["alpha = 1", "print(beta)"]);

  // Ctrl+Y 覆盖了 Monaco/Windows 重做的主键（primary KeyY）——重做必须仍经 secondary
  // Ctrl+Shift+Z 可达（redo 只重做「已撤销」的改动，故先 undo 再断言 redo）
  await page.keyboard.press("Control+z");
  await expect
    .poll(async () => (await lines(page)).slice(0, 3), { timeout: 5_000 })
    .toEqual(["alpha = 1", "beta = alpha + 2", "print(beta)"]);
  await page.keyboard.press("Control+Shift+z");
  await expect
    .poll(async () => (await lines(page)).slice(0, 2), { timeout: 5_000 })
    .toEqual(["alpha = 1", "print(beta)"]);
});

test("E-DX-S2 折叠全部 / 展开全部", async ({ page }) => {
  await page.locator("#tree .tree-item .name", { hasText: "indented.py" }).first().dblclick();
  await expect(page.locator(".view-line", { hasText: "print(i)" }).first()).toBeVisible({ timeout: 10_000 });
  // 键位规则带 when: editorTextFocus——必须先把焦点交给编辑器（与 E-BASIC 用例同款前置）
  await setCaret(page, 1, 1);

  const bodyLine = () => page.locator(".view-line", { hasText: "print(i)" }).count();
  await expect.poll(bodyLine, { timeout: 5_000 }).toBe(1); // 前置：可见

  // 折叠模型异步计算（debounce）：等折叠 gutter 图标出现再按键，否则 foldAll 空发（实测竞态）
  await expect(page.locator(".codicon-folding-expanded").first()).toBeVisible({ timeout: 10_000 });

  await page.keyboard.press("Control+Shift+Minus"); // 折叠全部 → def 体外全部隐藏
  // 折叠态的可靠标记：折叠首行的 afterContent 装饰 inline-folded（foldingDecorations.js）
  await expect(page.locator(".view-lines .inline-folded").first()).toBeVisible({ timeout: 5_000 });
  await expect.poll(bodyLine, { timeout: 5_000 }).toBe(0);

  await page.keyboard.press("Control+Shift+Equal"); // 展开全部
  await expect.poll(async () => page.locator(".view-lines .inline-folded").count(), { timeout: 5_000 }).toBe(0);
  await expect.poll(bodyLine, { timeout: 5_000 }).toBe(1);
});

test("E-DX-S3 括号匹配跳转：Ctrl+Shift+\\ 从 [ 跳到配对 ]", async ({ page }) => {
  await page.locator("#tree .tree-item .name", { hasText: "indented.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });

  // 「    items = [1, 2, 3]」：[ 在 col 13，配对 ] 在 col 21
  await setCaret(page, 2, 13);
  await page.keyboard.press("Control+Shift+Backslash");
  await expect
    .poll(
      async () =>
        page.evaluate(async () => {
          const { app } = (await import(/* @vite-ignore */ "/src/state.ts")) as any;
          return app.editor.getPosition()?.column;
        }),
      { timeout: 5_000 },
    )
    .toBe(21);
});

test("E-DX-S4 重开关闭的标签：Ctrl+F4 关闭后 Ctrl+Shift+Alt+T 恢复", async ({ page }) => {
  const tab = page.locator("#tabbar .tab", { hasText: "main.py" });
  await expect(tab).toBeVisible({ timeout: 5_000 });

  await page.keyboard.press("Control+F4"); // close_tab
  await expect(tab).toBeHidden({ timeout: 5_000 });

  await page.keyboard.press("Control+Shift+Alt+T"); // reopen_tab
  await expect(page.locator("#tabbar .tab", { hasText: "main.py" })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 10_000 });
  await expect(async () => expect(await lines(page)).toEqual(SRC.split("\n"))).toPass({ timeout: 10_000 });
});

test("E-DX-S5 tab 右键复制 file:line 引用（相对工作区根 + 当前行号）", async ({ page }) => {
  await setCaret(page, 2, 1); // 光标在第 2 行 → 期望 main.py:2
  await page.locator("#tabbar .tab", { hasText: "main.py" }).click({ button: "right" });
  const ctx = page.locator("#ctx-menu");
  await expect(ctx).toBeVisible({ timeout: 5_000 });
  await ctx.locator(".ctx-menu-item", { hasText: "复制 file:line 引用" }).first().click({ force: true });

  await expect
    .poll(async () => page.evaluate(() => (window as any).__E2E_COPIED__?.at(-1) ?? ""), { timeout: 5_000 })
    .toBe("main.py:2");
});
