/**
 * 阶段 4 · 自研 Pydantic 语义层 E2E 验收（docs/pyrefly_pydantic_support_plan.md §5）。
 *
 * 覆盖：
 *  1. 子项 1b：Pydantic 栈工作区打开 → 第四桶诊断（pylume-pydantic）渲染为红线
 *     （type / missing）+ DOM 层 squiggly 波浪线；非 Pydantic 栈零注入（门控）。
 *  2. 保存后防抖重扫：预置清空 → 保存 → marker 清空。
 *  3. 设置开关（PR-2 修复项）：设置面板关闭 pydantic_diagnostics → 保存 → 即时清空。
 *  4. 子项 1c（PR-3 修复项）：引擎切换 pyrefly→basedpyright→pyrefly 后第四桶诊断不丢。
 *  5. 子项 2b：改名传播——__E2E_RENAME_SCOPE__="single" 复刻 pyrefly 缺陷行为
 *     （rename 只改声明文件），验证补充路径把跨文件 `User(name=` 调用点一并修改落盘。
 *  6. 阶段 2：rename BaseModel 字段时「不传播调用处」toast 提示。
 *
 * mock 面板：__E2E_FRAMEWORK_PRESET__（pydanticStack）+ __E2E_PYDANTIC_PRESET__
 * （issues / ctorRefs，形状对齐 fs_cmds.rs）+ __E2E_RENAME_SCOPE__。
 */
import { expect, test, type Page } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";

const MODELS_PY = [
  "from pydantic import BaseModel",
  "",
  "",
  "class User(BaseModel):",
  "    id: int",
  "    name: str",
  "",
].join("\n");

const USAGE_PY = [
  "from models import User",
  "",
  'good = User(id=1, name="Alice")',
  'bad = User(id="not-an-int", name="Steve")',
  "missing = User(id=1)",
  "",
].join("\n");

/** 打开文件（03-codevision-rename 同款范式） */
async function openFile(page: Page, name: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: name }).first().dblclick();
  await expect(page.locator(`#tabbar .tab`, { hasText: name })).toBeVisible({ timeout: 10_000 });
}

/** 光标定位到指定行的第 n 个字符（Home + N 次 ArrowRight） */
async function gotoWord(page: Page, lineText: string, rights: number): Promise<void> {
  const line = page.locator("#editor .monaco-editor .view-line", { hasText: lineText }).first();
  await line.click();
  await page.keyboard.press("Home");
  for (let i = 0; i < rights; i++) await page.keyboard.press("ArrowRight");
}

/** 当前第四桶 marker 数（经 DOM 代理：Monaco 渲染 error 级 marker 必产 .squiggly-error）。
 *  精确性保障：测试工作区只有 pydantic 桶会产 error 波浪线（mock 引擎诊断只报
 *  nonexistent 前缀 import 的缺包错，用例文件不含此类 import）。 */
async function pydSquiggleCount(page: Page): Promise<number> {
  return page.locator(".squiggly-error").count();
}

/** 通用装配：Pydantic 栈 + 诊断/引用预置（file 已替换为正斜杠绝对路径，对齐 Rust 形态） */
async function equip(page: Page, opts: { issues?: unknown[]; ctorRefs?: unknown[]; stack?: boolean } = {}): Promise<GitRepo> {
  const repo = await makePlainDir({ "models.py": MODELS_PY, "usage.py": USAGE_PY });
  // 路径替换必须先于 addInitScript（其参数在此刻序列化快照，事后改对象不进页面）
  const rootFwd = repo.root.replace(/\\/g, "/");
  const issues = (opts.issues as { file?: string }[] | undefined)?.map((it) => ({ ...it, file: `${rootFwd}/usage.py` }));
  const ctorRefs = (opts.ctorRefs as { file?: string }[] | undefined)?.map((r) => ({ ...r, file: `${rootFwd}/usage.py` }));
  const stack = opts.stack !== false;
  await page.addInitScript(
    ([o, stackOn]) => {
      const w = window as unknown as Record<string, unknown>;
      if (stackOn) w.__E2E_FRAMEWORK_PRESET__ = { pydanticStack: true };
      w.__E2E_PYDANTIC_PRESET__ = {
        issues: (o as { issues?: unknown[] }).issues ?? [],
        ctorRefs: (o as { ctorRefs?: unknown[] }).ctorRefs ?? [],
      };
    },
    [{ issues, ctorRefs }, stack] as const,
  );
  await equipPage(page, repo);
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto("/");
  await expect(page.locator("#editor")).toBeVisible({ timeout: 15_000 });
  return repo;
}

test.describe("子项 1b：构造校验诊断（第四桶）", () => {
  test("01 Pydantic 栈 → type/missing 诊断渲染 + DOM 波浪线", async ({ page }) => {
    await equip(page, {
      issues: [
        { file: "", line: 4, column: 16, end_column: 20, kind: "type", message: "Pydantic：字段 id 期望 int，传入 not-an-int", field: "id", model: "User" },
        { file: "", line: 5, column: 0, end_column: 0, kind: "missing", message: "Pydantic：构造 User 缺少必填字段 name", field: "name", model: "User" },
      ],
    });
    await openFile(page, "usage.py");
    // 工作区打开即扫描 + 打开文件回放缓存 → 两处 error 波浪线渲染
    await expect.poll(() => pydSquiggleCount(page), { timeout: 8_000 }).toBe(2);
  });

  test("02 非 Pydantic 栈 → 门控生效零诊断（预置存在也不注入）", async ({ page }) => {
    await equip(page, {
      stack: false,
      issues: [{ file: "", line: 4, column: 16, end_column: 20, kind: "type", message: "x", field: "id", model: "User" }],
    });
    await openFile(page, "usage.py");
    await page.waitForTimeout(1_200);
    expect(await pydSquiggleCount(page)).toBe(0);
  });

  test("03 保存后防抖重扫：预置清空 → marker 清空", async ({ page }) => {
    await equip(page, {
      issues: [{ file: "", line: 4, column: 16, end_column: 20, kind: "type", message: "Pydantic：字段 id 期望 int", field: "id", model: "User" }],
    });
    await openFile(page, "usage.py");
    await expect.poll(() => pydSquiggleCount(page), { timeout: 8_000 }).toBe(1);
    await page.evaluate(() => {
      (window as unknown as { __E2E_PYDANTIC_PRESET__?: { issues: unknown[] } }).__E2E_PYDANTIC_PRESET__!.issues = [];
    });
    await page.keyboard.press("Control+s");
    // 防抖 1.5s + 扫描往返
    await expect.poll(() => pydSquiggleCount(page), { timeout: 8_000 }).toBe(0);
  });
});

test.describe("设置开关与引擎切换", () => {
  test("04 设置面板关闭 pydantic_diagnostics → 保存后即时清空", async ({ page }) => {
    await equip(page, {
      issues: [{ line: 4, column: 16, end_column: 20, kind: "type", message: "Pydantic：字段 id 期望 int", field: "id", model: "User" }],
    });
    await openFile(page, "usage.py");
    await expect.poll(() => pydSquiggleCount(page), { timeout: 8_000 }).toBe(1);
    // 设置面板（Ctrl+Alt+S）→ 切「编辑器」分类 → 取消勾选 → 保存
    await page.keyboard.press("Control+Alt+s");
    await page.locator(".settings-nav-item", { hasText: "编辑器" }).click();
    const box = page.locator("#settings-pydantic-diagnostics");
    await expect(box).toBeVisible({ timeout: 5_000 });
    await box.uncheck();
    await page.locator("#settings-save").click();
    await expect.poll(() => pydSquiggleCount(page), { timeout: 5_000 }).toBe(0);
  });

  test("05 引擎切换不丢第四桶诊断（子项 1c：owner 感知 clear + 就绪重放）", async ({ page }) => {
    await equip(page, {
      issues: [{ file: "", line: 4, column: 16, end_column: 20, kind: "type", message: "Pydantic：字段 id 期望 int", field: "id", model: "User" }],
    });
    await openFile(page, "usage.py");
    await expect.poll(() => pydSquiggleCount(page), { timeout: 8_000 }).toBe(1);
    // 状态栏 chip → 菜单 → basedpyright（引擎重启，LSP 桶清空；第四桶须保留）
    await page.locator("#status-engine").click();
    await page.locator("#ctx-menu .ctx-menu-item", { hasText: "basedpyright" }).first().click();
    await page.waitForTimeout(1_500);
    expect(await pydSquiggleCount(page)).toBe(1);
    // 切回 pyrefly：就绪重放后仍在
    await page.locator("#status-engine").click();
    await page.locator("#ctx-menu .ctx-menu-item", { hasText: "pyrefly" }).first().click();
    await page.waitForTimeout(1_500);
    expect(await pydSquiggleCount(page)).toBe(1);
  });
});

test.describe("子项 2b：改名传播补充", () => {
  test("06 rename User.name → 声明处 + 跨文件构造调用点一并落盘", async ({ page }) => {
    const repo = await equip(page, {
      ctorRefs: [
        // usage.py 行3 `good = User(id=1, name="Alice")`：name 的 1 基列 = 19（0 基 18）
        // 行4 `bad = User(id="not-an-int", name="Steve")`：name 1 基列 = 29
        { file: "", line: 3, column: 19, len: 4, model: "User", field: "name" },
        { file: "", line: 4, column: 29, len: 4, model: "User", field: "name" },
      ],
    });
    // 复刻 pyrefly 缺陷：引擎 rename 只改当前文件（声明处），跨文件靠补充路径
    await page.evaluate(() => {
      (window as unknown as { __E2E_RENAME_SCOPE__?: string }).__E2E_RENAME_SCOPE__ = "single";
    });
    await openFile(page, "models.py");
    // 两个文件都打开（usage.py 的编辑走「已打开 model」路径）
    await openFile(page, "usage.py");
    await openFile(page, "models.py");
    // 光标到 name 声明（行6 `    name: str`）：Monaco smartHome 直接落到缩进后词首（n），
    // 无需再右移——03-codevision 的 rights 语义是「顶格 def 声明」专用
    await gotoWord(page, "name: str", 0);
    await page.keyboard.press("Shift+F6");
    const input = page.locator(".oc-rename-widget .oc-rename-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await expect(input).toHaveValue("name");
    await input.fill("full_name");
    await page.keyboard.press("Enter");
    // 引擎（single）改 models.py 声明 1 处；补充路径加回 usage.py 2 处 → 跨文件确认
    const dialog = page.locator("#confirm-modal");
    await expect(dialog).toBeVisible({ timeout: 8_000 });
    await expect(dialog).toContainText("usage.py × 2 处");
    await page.locator("#confirm-ok").click();
    // 落盘验证：两文件都改了
    await expect.poll(() => repo.read("usage.py"), { timeout: 8_000 }).toContain('User(id="not-an-int", full_name="Steve")');
    await expect.poll(() => repo.read("usage.py"), { timeout: 8_000 }).toContain('User(id=1, full_name="Alice")');
    await expect.poll(() => repo.read("models.py"), { timeout: 8_000 }).toContain("full_name: str");
  });

  test("07 rename Pydantic 字段 → 「不传播调用处」toast（阶段 2 提示，会话去重一次）", async ({ page }) => {
    await equip(page, {});
    await openFile(page, "models.py");
    await gotoWord(page, "name: str", 0);
    await page.keyboard.press("Shift+F6");
    await expect(page.locator(".oc-rename-widget .oc-rename-input")).toBeVisible({ timeout: 5_000 });
    // 阶段 2：pyrefly 引擎下 rename BaseModel 字段 → toast 提示
    await expect(page.locator(".toast", { hasText: "暂不传播" })).toBeVisible({ timeout: 3_000 });
    await page.keyboard.press("Escape");
    await expect(page.locator(".oc-rename-widget")).toHaveCount(0);
  });

  test("08 rename 类名（非字段）→ 不触发补充路径", async ({ page }) => {
    const repo = await equip(page, {
      ctorRefs: [{ line: 3, column: 20, len: 2, model: "User", field: "id" }],
    });
    await openFile(page, "models.py");
    // 顶格 `class User(BaseModel):`：Home 后 6 次 Right 到 User 词首
    await gotoWord(page, "class User(BaseModel):", 6);
    await page.keyboard.press("Shift+F6");
    const input = page.locator(".oc-rename-widget .oc-rename-input");
    await expect(input).toBeVisible({ timeout: 5_000 });
    await input.fill("Account");
    await page.keyboard.press("Enter");
    // 类名 rename：isPydanticFieldDecl 不命中 → 无补充；mock 默认全文档模式但 usage.py
    // 未打开（无镜像）→ 单文件 1 处 → 不弹跨文件确认（#confirm-modal 常驻 DOM，断言不可见）
    await expect(page.locator("#confirm-modal")).toBeHidden({ timeout: 3_000 });
    await expect(page.locator(".toast", { hasText: "1 个文件 1 处" })).toBeVisible({ timeout: 5_000 });
    await expect.poll(() => repo.read("models.py"), { timeout: 8_000 }).toContain("class Account(BaseModel):");
  });
});
