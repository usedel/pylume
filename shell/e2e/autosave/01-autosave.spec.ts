/**
 * E2E：自动保存（autosave delay/blur/off + 保存动作解耦 + git 次序）
 *
 * 对应改造（VSCode/PyCharm 调研结论落地）：
 *  - A-S-1 delay 模式：编辑静默 2s 落盘，脏点消失（出厂默认语义，产品默认值由
 *    state.ts DEFAULT_SETTINGS / settings.rs 单测锁定；mock 基线保持 off，
 *    本 spec 经 __E2E_SETTINGS_PRESET__ 显式开启）
 *  - A-S-2 每个脏 tab 独立计时：后台 tab 的编辑静默到期也落盘（旧实现只存 activeTab）
 *  - A-S-3 保存动作解耦：autosave 只写内容不跑 ruff（format_python 仅显式 Ctrl+S 触发，
 *    经 __TAURI_MOCK_INVOKE_LOG__ 命令流水断言）
 *  - A-S-4 blur 模式：编辑器失焦即落盘
 *  - A-S-5 off 模式：不落盘、脏点保留（与存量 spec 基线一致）
 *  - A-S-6 git 丢弃不复活：tracked 丢弃后磁盘为基线，等待 > delay 不被旧缓冲写回
 *  - A-S-7 未跟踪文件丢弃：tab 关闭 + 文件删除，autosave 不把缓冲写回复活文件
 */
import { test, expect, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { equipPage, makeGitRepo, makePlainDir, type GitRepo } from "../helpers";

const SRC = "alpha = 1\nbeta = alpha + 2\nprint(beta)\n";

let repo: GitRepo;
const pageErrors: string[] = [];

/** 预置设置覆写（addInitScript，先于应用启动生效） */
async function presetSettings(page: Page, settings: Record<string, unknown>): Promise<void> {
  await page.addInitScript((s) => {
    (window as unknown as { __E2E_SETTINGS_PRESET__?: unknown }).__E2E_SETTINGS_PRESET__ = s;
  }, settings);
}

/** invoke 命令流水（mock 记录，形如 "write_file(path,content)"） */
function invocations(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    ((window as unknown as { __TAURI_MOCK_INVOKE_LOG__?: string[] }).__TAURI_MOCK_INVOKE_LOG__ ?? []),
  );
}

/** 把光标放到 (line, column) 并聚焦编辑器（editor/03 同款） */
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

/** 打开文件 + 末尾追加标记行（产生 dirty） */
async function openAndEdit(page: Page, file: string, marker: string): Promise<void> {
  await page.locator("#tree .tree-item .name", { hasText: file }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 20_000 });
  await setCaret(page, 999, 1); // 超出行号 = Monaco 定到末行，稳妥
  await page.keyboard.press("Control+End");
  await page.keyboard.type(`\n${marker}\n`);
}

async function openWorkspace(page: Page, files: Record<string, string>): Promise<void> {
  repo = await makePlainDir(files);
  await equipPage(page, repo);
  await page.goto("/");
  await expect(page.locator("#tree .tree-item .name").first()).toBeVisible({ timeout: 20_000 });
}

test.beforeEach(async ({ page }) => {
  pageErrors.length = 0;
  page.on("pageerror", (e) => pageErrors.push(String(e)));
});

test.afterEach(() => {
  expect(pageErrors, pageErrors.join("\n")).toEqual([]);
});

test("A-S-1 delay 模式：编辑静默 2s 自动落盘，脏点消失", async ({ page }) => {
  await presetSettings(page, { autosave: "delay", autosave_delay: 2000 });
  await openWorkspace(page, { "main.py": SRC });
  await openAndEdit(page, "main.py", "# AUTOSAVED-1");
  await expect(page.locator("#tabbar .tab.active .dirty")).toBeVisible({ timeout: 5_000 });

  // 磁盘真身更新（write_file 经 bridge 落真实磁盘）
  await expect.poll(async () => repo.read("main.py"), { timeout: 8_000 }).toContain("AUTOSAVED-1");
  // 落盘后 dirty 清除
  await expect(page.locator("#tabbar .tab.active .dirty")).toBeHidden({ timeout: 5_000 });
  // 命令流水确有 write_file
  expect((await invocations(page)).some((l) => l.startsWith("write_file("))).toBe(true);
});

test("A-S-2 每个脏 tab 独立计时：切走后后台 tab 照样落盘", async ({ page }) => {
  await presetSettings(page, { autosave: "delay", autosave_delay: 2000 });
  await openWorkspace(page, { "main.py": SRC, "other.py": "x = 0\n" });
  await openAndEdit(page, "main.py", "# BACKGROUND-1");
  await expect(page.locator("#tabbar .tab.active .dirty")).toBeVisible({ timeout: 5_000 });

  // 打开 other.py（当前激活 tab 切走，main.py 成为后台脏 tab），期间不做任何编辑
  await page.locator("#tree .tree-item .name", { hasText: "other.py" }).first().dblclick();
  await expect(page.locator("#tabbar .tab.active[title*='other.py']")).toBeVisible({ timeout: 10_000 });

  // 后台 tab 的 autosave 计时器到期 → main.py 落盘（旧实现只存 activeTab，此用例锁死新语义）
  await expect.poll(async () => repo.read("main.py"), { timeout: 8_000 }).toContain("BACKGROUND-1");
  await expect(page.locator("#tabbar .tab[title*='main.py'] .dirty")).toBeHidden({ timeout: 5_000 });
});

test("A-S-3 保存动作解耦：autosave 不跑 ruff，显式 Ctrl+S 才跑", async ({ page }) => {
  await presetSettings(page, {
    autosave: "delay",
    autosave_delay: 2000,
    format_on_save: true,
    optimize_imports_on_save: false,
  });
  await openWorkspace(page, { "main.py": SRC });
  await openAndEdit(page, "main.py", "# DECOUPLED-1");

  // autosave 落盘：有 write_file，无 format_python（ruff format 只跟显式保存走）
  await expect.poll(async () => repo.read("main.py"), { timeout: 8_000 }).toContain("DECOUPLED-1");
  const logsAfterAutosave = await invocations(page);
  expect(logsAfterAutosave.some((l) => l.startsWith("write_file("))).toBe(true);
  expect(logsAfterAutosave.some((l) => l.startsWith("format_python("))).toBe(false);

  // 显式 Ctrl+S：保存动作触发（mock 未实现 format_python → 返回 null 不阻断，但命令有被调用）
  await page.keyboard.press("Control+s");
  await expect
    .poll(async () => (await invocations(page)).some((l) => l.startsWith("format_python(")), { timeout: 8_000 })
    .toBe(true);
});

test("A-S-4 blur 模式：编辑器失焦即落盘", async ({ page }) => {
  await presetSettings(page, { autosave: "blur" });
  await openWorkspace(page, { "main.py": SRC, "other.py": "x = 0\n" });
  await openAndEdit(page, "main.py", "# BLUR-SAVED");

  // 点文件树（编辑器失焦）→ 触发失焦保存
  await page.locator("#tree .tree-item .name", { hasText: "other.py" }).first().click();
  await expect.poll(async () => repo.read("main.py"), { timeout: 5_000 }).toContain("BLUR-SAVED");
  await expect(page.locator("#tabbar .tab[title*='main.py'] .dirty")).toBeHidden({ timeout: 5_000 });
});

test("A-S-5 off 模式：不落盘、脏点保留", async ({ page }) => {
  await openWorkspace(page, { "main.py": SRC }); // mock 基线 autosave=off（存量语义）
  await openAndEdit(page, "main.py", "# NEVER-SAVED");
  await expect(page.locator("#tabbar .tab.active .dirty")).toBeVisible({ timeout: 5_000 });

  await page.waitForTimeout(2_600); // 超过默认 delay 窗口
  expect(repo.read("main.py")).not.toContain("NEVER-SAVED");
  expect((await invocations(page)).some((l) => l.startsWith("write_file("))).toBe(false);
  await expect(page.locator("#tabbar .tab.active .dirty")).toBeVisible({ timeout: 5_000 });
});

test("A-S-6 git 丢弃不复活：丢弃后磁盘回到基线且不被 autosave 写回", async ({ page }) => {
  await presetSettings(page, { autosave: "delay", autosave_delay: 2000 });
  const gitRepo = await makeGitRepo({ files: { "main.py": SRC }, commitMsg: "baseline" });
  repo = gitRepo;
  await equipPage(page, gitRepo);
  await page.goto("/");
  await openAndEdit(page, "main.py", "# DIRTY-NOTES");

  // 丢弃整文件更改（scm-item 行内丢弃按钮，hover 显现）
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "main.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.hover();
  await item.locator(".scm-discard").click();
  await page.locator("#confirm-ok").click();
  await expect(page.locator(".toast--success").first()).toBeVisible({ timeout: 10_000 });

  // 磁盘回到基线；编辑器经重载后与磁盘一致（dirty 旧缓冲被覆盖）
  expect(gitRepo.read("main.py")).toBe(SRC);
  await page.locator('#tabbar .tab[title*="main.py"]:not([title^="diff:"])').first().click();
  await expect(page.locator("#editor .monaco-editor")).not.toContainText("DIRTY-NOTES", { timeout: 5_000 });
  await expect(page.locator("#tabbar .tab.active .dirty")).toBeHidden({ timeout: 5_000 });

  // 复活守卫：再等一个 autosave 窗口，磁盘仍为基线
  await page.waitForTimeout(2_600);
  expect(gitRepo.read("main.py")).toBe(SRC);
});

test("A-S-7 未跟踪文件丢弃：tab 关闭 + 文件删除，autosave 不复活", async ({ page }) => {
  await presetSettings(page, { autosave: "delay", autosave_delay: 2000 });
  const gitRepo = await makeGitRepo({ files: { "main.py": SRC }, commitMsg: "baseline" });
  gitRepo.write("new.py", "q = 1\n"); // 未跟踪
  repo = gitRepo;
  await equipPage(page, gitRepo);
  await page.goto("/");
  await openAndEdit(page, "new.py", "# GHOST-NOTES");
  await expect(page.locator("#tabbar .tab.active .dirty")).toBeVisible({ timeout: 5_000 });

  // 丢弃（删除未跟踪文件）
  await page.locator("#tab-git").click();
  const item = page.locator("#git-changes .scm-item", { hasText: "new.py" });
  await expect(item).toHaveCount(1, { timeout: 10_000 });
  await item.hover();
  await item.locator(".scm-discard").click();
  await page.locator("#confirm-ok").click();
  await expect(page.locator(".toast--success").first()).toBeVisible({ timeout: 10_000 });

  // 文件已删除 + 编辑器 tab 已关闭（closeTabOf：留历史快照后关闭，防缓冲复活）
  expect(existsSync(join(gitRepo.root, "new.py"))).toBe(false);
  await expect(page.locator('#tabbar .tab[title*="new.py"]')).toHaveCount(0, { timeout: 5_000 });

  // 复活守卫：等一个 autosave 窗口，文件不得被写回
  await page.waitForTimeout(2_600);
  expect(existsSync(join(gitRepo.root, "new.py"))).toBe(false);
});
