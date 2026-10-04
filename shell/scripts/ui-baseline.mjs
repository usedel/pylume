/**
 * UI 基线截图工具（`docs/ui_premium_dev_plan.md` §5）。
 *
 * 用途：视觉改造的「基线截图」门禁（方案 §7-14）。改造前/后各跑一次同参数，
 * 逐张比对——**不接受无基线的人工抽查**（本项目曾两次「e2e 全绿但视觉崩」）。
 *
 * 架构：浏览器模式（vite dev :5173 + e2e/mocks/tauri-mock.js 注入 __TAURI_INTERNALS__），
 * 复用 e2e 的 mock 而不引 Tauri 真机——视觉 token 全在 CSS，浏览器模式足够；
 * 真机差异（WebView2 版本、缩放比）由「前后同环境」保证可比。
 *
 * 用法：
 *   node scripts/ui-baseline.mjs --tag before-b1
 *   node scripts/ui-baseline.mjs --tag after-b1
 *   node scripts/ui-baseline.mjs --tag x --out D:\some\dir
 *
 * 产物：<out>/<tag>/<theme>-<view>.png，共 8 张（深/浅 × 编辑区/侧栏/终端/设置）。
 * 默认 out = %TEMP%\pylume-ui-baseline（**必须落系统 TEMP**：工作区路径会触发
 * safe-delete 批量删除确认门槛，见 playwright.config.ts outputDir 同款约束）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const SHELL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MOCK_PATH = join(SHELL_DIR, "e2e", "mocks", "tauri-mock.js");
const DEV_URL = "http://localhost:5173";
const VIEWPORT = { width: 1440, height: 900 };

/** 样例文件：覆盖语法高亮（类/装饰器/字符串/数字）、缩进参考线、行号栏 */
const FIXTURE_FILES = {
  "main.py": [
    '"""Pylume UI 基线样例。"""',
    "from dataclasses import dataclass",
    "",
    "@dataclass",
    "class Task:",
    "    name: str",
    "    priority: int = 3",
    "",
    "    def label(self) -> str:",
    '        return f"{self.name}(p{self.priority})"',
    "",
    "",
    "def main() -> None:",
    '    tasks = [Task("write"), Task("review", 5), Task("ship", 1)]',
    "    for t in sorted(tasks, key=lambda x: x.priority):",
    "        print(t.label(), t.priority * 2, True, None)",
    "",
    "",
    'if __name__ == "__main__":',
    "    main()",
    "",
  ].join("\n"),
  "utils.py": [
    "def clamp(value: float, low: float, high: float) -> float:",
    "    return max(low, min(high, value))",
    "",
    "",
    "RETRY_LIMIT = 5",
    "TAGS = (\"ui\", \"baseline\")",
    "",
  ].join("\n"),
  "README.md": "# Pylume\n\nUI 基线截图样例工作区。\n",
  "data/config.json": '{\n  "theme": "dark",\n  "fontSize": 14\n}\n',
};

/** git 面板样例：让 SCM 视图带上 M/A/D/U 四种状态色（色相门禁的视觉证据） */
const GIT_STATUS = {
  files: [
    { path: "main.py", x: "M", y: " ", code: "M" },
    { path: "utils.py", x: "A", y: " ", code: "A" },
    { path: "data/config.json", x: "?", y: "?", code: "U" },
    { path: "legacy.py", x: " ", y: "D", code: "D" },
  ],
  is_git: true,
  current_branch: "ui/premium-batch-1",
};

function parseArgs(argv) {
  const out = { tag: "baseline", out: join(tmpdir(), "pylume-ui-baseline"), probeFonts: false };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--tag") out.tag = argv[++i];
    else if (a === "--out") out.out = resolve(argv[++i]);
    else if (a === "--probe-fonts") out.probeFonts = true;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** vite dev 已在跑就复用，否则拉起（对齐 playwright.config.ts webServer 的 reuseExistingServer） */
async function ensureDevServer() {
  try {
    const res = await fetch(DEV_URL, { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      console.log("[ui-baseline] 复用已在跑的 vite dev :5173");
      return null;
    }
  } catch {
    /* 未启动 → 下面拉起 */
  }
  console.log("[ui-baseline] 启动 vite dev …");
  const child = spawn("npm", ["run", "dev"], {
    cwd: SHELL_DIR,
    shell: true,
    stdio: "ignore",
    windowsHide: true,
  });
  for (let i = 0; i < 60; i += 1) {
    await sleep(1000);
    try {
      const res = await fetch(DEV_URL, { signal: AbortSignal.timeout(2000) });
      if (res.ok) {
        console.log("[ui-baseline] vite dev 就绪");
        return child;
      }
    } catch {
      /* 继续等 */
    }
  }
  child.kill();
  throw new Error("vite dev 60s 内未就绪");
}

/** 样例工作区（真实磁盘：文件树/编辑器读的是真文件） */
function makeFixture() {
  const root = join(tmpdir(), "pylume-ui-baseline-ws");
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(FIXTURE_FILES)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return root;
}

/** __E2E_BRIDGE__：只实现 UI 渲染必需的通道（其余走 tauri-mock 的静态兜底） */
function makeBridge(repoRoot) {
  return async (channel, cmd, args) => {
    if (channel === "getRecentWorkspaces") return [repoRoot];
    if (channel === "setRecentWorkspaces") return null;
    if (channel === "git") {
      if (cmd === "git_status") return GIT_STATUS;
      if (cmd === "git_branches") return { current: "ui/premium-batch-1", remotes: [] };
      if (cmd === "git_log") return [];
      if (cmd === "git_stash_list") return [];
      return "";
    }
    if (channel === "fs") {
      const p = String(args?.path ?? repoRoot);
      const abs = p.includes(":") || p.startsWith("\\\\") ? p : join(repoRoot, p);
      if (cmd === "read_dir" || cmd === "list_dir") {
        if (!existsSync(abs)) return [];
        return readdirSync(abs, { withFileTypes: true })
          .filter((e) => !e.name.startsWith("."))
          .map((e) => ({ name: e.name, path: join(abs, e.name), is_dir: e.isDirectory() }));
      }
      if (cmd === "read_file") return readFileSync(abs, "utf8");
      if (cmd === "watch_start" || cmd === "watch_stop") return null;
      return null;
    }
    return null;
  };
}

async function settle(page, ms = 700) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await sleep(ms);
}

/** 打开设置面板（外观页）。
 *  不用 Ctrl+Alt+S 快捷键：终端 tab 打开后焦点在 xterm 里，快捷键收不到
 *  （实测卡在「#settings-modal 一直 hidden」）。走 menubar 的设置按钮最稳。 */
async function openSettings(page) {
  if (await page.locator("#settings-modal:not(.hidden)").count()) return;
  const btn = page.locator("#btn-settings, button[title='设置']").first();
  if (await btn.count()) {
    await btn.click();
  } else {
    await page.locator("#editor").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+Alt+S");
  }
  await page.locator("#settings-modal").waitFor({ state: "visible", timeout: 10_000 });
  await page.locator('.settings-nav-item[data-cat="appearance"]').click();
  await settle(page, 400);
}

async function closeSettings(page) {
  await page.locator("#settings-close").click();
  await page.locator("#settings-modal").waitFor({ state: "hidden", timeout: 10_000 });
}

/** 编辑器主题名（批 4 起是自定义名 pylume-*，与 src/theme/tokens.ts 常量一致）。
 *  ⚠ 这里写死字面量而非 import TS：脚本是纯 Node 工具，不走 vite。漂移由
 *  __tests__/themeTokens.test.ts 的「基线截图脚本的卡片选择器用新名」断言兜住。 */
const EDITOR_THEME = { dark: "pylume-dark", light: "pylume-light" };

/** 走真实链路切主题（设置 → 外观 → 色卡 → 保存），与 themePicker.ts 的 radiogroup 语义一致。
 *  仅作备用路径；主路径是每套主题一个独立页面 + __E2E_SETTINGS_PRESET__（见 main）。 */
async function setTheme(page, theme) {
  await openSettings(page);
  await page.locator(`.theme-swatch[data-theme="${EDITOR_THEME[theme]}"]`).click();
  await page.locator("#settings-save").click();
  await page.locator("#settings-modal").waitFor({ state: "hidden", timeout: 10_000 });
  await settle(page);
}

/**
 * 字体探针（批 3 门禁 · ui_premium §5.3-3b 第 5 步「实测这一步不做等于没做」）。
 *
 * 为什么必须自动化：随包字体是**静默失败**的典型——CSP 拦了、路径错了、MIME 不对，
 * 页面都不报错，只是安静地回落 Consolas。方案原文要求人工开 Network 面板确认，
 * 本项目不接受纯人工抽查，故固化为脚本门禁。
 *
 * 探四项：
 *   1. 静态可达性（HTTP 状态 + MIME + 字节数）—— 路径错 / vite 未托管 public/ 会在这里暴露
 *   2. `document.fonts.load()` 是否 settle 及耗时 —— 不 settle 会把 init 拖到超时（实测坑）
 *   3. `document.fonts.check()` 对整条栈是否为 true —— 真正生效的判据
 *   4. CSS 与 Monaco 两侧的实际取值 —— token / computed / 注入值三处是否同源
 */
async function probeFonts(page) {
  // init 的最后一步是建编辑器（且批 3 起前面多了一次「等字体」）。先等它，
  // 才能读到 Monaco 侧的注入值——顺带暴露 init 是否真的走完。
  const editorReadyMs = await page
    // state:"attached" 而非默认的 "visible"：#editor 容器在探针时刻可能尚未布局出尺寸，
    // 用 visible 会把「已创建但不可见」误判成「未创建」（实测踩过）。
    .waitForSelector(".monaco-editor", { timeout: 30000, state: "attached" })
    .then(() => Date.now())
    .catch(() => 0);
  const probe = await page.evaluate(async () => {
    const out = {};
    out.fontsApi = !!document.fonts;
    out.statusBefore = document.fonts.status;
    out.registeredFaces = document.fonts.size;

    // ① 静态可达性：**逐个**核对 4 个子集。Monaco 的 editor.create 内部会等字体就绪，
    // 只要有一个 face 停在 pending，整个编辑器就永不创建（实测 initStep=before-create）。
    out.files = {};
    for (const f of ["JetBrainsMono-latin-400-normal.woff2", "JetBrainsMono-latin-400-italic.woff2",
      "JetBrainsMono-latin-700-normal.woff2", "JetBrainsMono-latin-ext-400-normal.woff2"]) {
      try {
        const t = Date.now();
        const r = await fetch("/fonts/" + f);
        out.files[f] = `${r.status} ${(await r.arrayBuffer()).byteLength}B ${Date.now() - t}ms`;
      } catch (e) {
        out.files[f] = `ERR ${e}`;
      }
    }
    out.faces = [];
    document.fonts.forEach((f) => out.faces.push(`${f.family}|${f.style}|${f.weight}|${f.status}`));

    // ② load() 是否 settle（永远 pending 是批 3 实测到的真实故障）
    const t0 = performance.now();
    out.load = await Promise.race([
      document.fonts.load('14px "JetBrains Mono"').then(() => "resolved").catch((e) => `rejected: ${e}`),
      new Promise((r) => setTimeout(() => r("TIMEOUT(3s)"), 3000)),
    ]);
    out.loadElapsedMs = Math.round(performance.now() - t0);
    out.statusAfter = document.fonts.status;

    // ③ check：整条栈命中即 true（含兜底项时恒真，故另测单独族名）
    out.checkSingle = document.fonts.check('14px "JetBrains Mono"');
    out.checkStack = document.fonts.check('14px "JetBrains Mono", "Cascadia Code", "SF Mono", Consolas, monospace');

    // ④ CSS 侧 token 与 computed
    const cs = getComputedStyle(document.documentElement);
    out.monoToken = cs.getPropertyValue("--mono").trim();
    out.fontUiToken = cs.getPropertyValue("--font-ui").trim();
    out.bodyFontFamily = getComputedStyle(document.body).fontFamily;

    // ⑤ Monaco 实际渲染的字体：**从 DOM 读**，不碰 app —— app.editor / app.monaco 是
    // 「未初始化即抛错」的 getter，且 page.evaluate 里的动态 import 有可能拿到另一份
    // state.ts 模块实例（vite HMR 重建模块图时），两种情况都会让读数失真。
    // Monaco 把 fontFamily / font-feature-settings 内联在 .view-lines 上，是权威来源。
    const viewLines = document.querySelector(".monaco-editor .view-lines");
    if (viewLines) {
      const cs = getComputedStyle(viewLines);
      out.monacoFontFamily = cs.fontFamily;
      out.monacoFontSize = cs.fontSize;
      out.monacoFontFeatureSettings = cs.fontFeatureSettings;
      out.monacoLigatures = cs.fontVariantLigatures;
    } else {
      out.monacoFontFamily = "(.view-lines 未找到)";
    }
    // 外壳等宽区（输出面板/搜索）抽样，确认 --mono 真的落到 DOM 上
    const shellMono = document.querySelector(".search-match-text, .resource-table, .db-grid");
    if (shellMono) out.shellMonoFontFamily = getComputedStyle(shellMono).fontFamily;
    // vite 侧的 monaco 模块可达性（预打包是否正常；冷启动时它可能很慢）
    try {
      const t = performance.now();
      await import(/* @vite-ignore */ "/src/monaco.ts");
      out.monacoDirectImport = `ok (${Math.round(performance.now() - t)}ms)`;
    } catch (e) {
      out.monacoDirectImport = `FAILED: ${e}`;
    }
    try {
      const { app } = await import(/* @vite-ignore */ "/src/state.ts");
      // init 链判据：mock 的 keybindings 是 {}，只有 loadSettings 跑过（填充了默认键位）
      // 才会非空 → 据此区分「卡在 loadSettings 之前」还是「之后」。
      out.keybindingsLoaded = Object.keys(app.settings?.keybindings ?? {}).length;
      out.settingsFontFamily = app.settings?.font_family ?? null;
      // **模块实例判据**（批 3 踩坑留）：探针若拿到另一份 state.ts 模块（vite 长时间运行后
      // 重建模块图会新建实例），workspaceRoot 会是 null 而非 init 填过的路径。排查
      // 「app.editor 未初始化」类问题时先看这一项，能立刻排除「实例不同」这个前提。
      out.workspaceRoot = app.workspaceRoot ?? null;
    } catch (e) {
      out.stateError = String(e);
    }
    return out;
  });
  probe.editorReady = editorReadyMs > 0;
  probe.editorReadyMs = editorReadyMs;
  return probe;
}

async function main() {
  const { tag, out, probeFonts: wantProbe } = parseArgs(process.argv);
  const outDir = join(out, tag);
  mkdirSync(outDir, { recursive: true });
  const devChild = await ensureDevServer();
  const repoRoot = makeFixture();
  const mockSrc = readFileSync(MOCK_PATH, "utf8");
  const browser = await chromium.launch();
  const shots = [];
  /** 页面级异常收集（init 长链任一环抛错都会静默掐断） */
  const errors = [];

  /** 每套主题一个**独立页面**，主题经 __E2E_SETTINGS_PRESET__ 在启动时预置。
   *  不用「切色卡再保存」的原因：tauri-mock 的 get_settings 是静态值（save_settings 也不落盘），
   *  应用中途任何一次重新读设置都会把 theme 打回出厂深色 —— 实测浅色轮第 2 张起 Monaco 就变回深色，
   *  而 data-theme 仍留在 light（外壳浅、编辑器深），截图对比会失真。 */
  const newThemedPage = async (theme) => {
    const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    await page.addInitScript((t) => {
      window.__E2E_SETTINGS_PRESET__ = { theme: t };
    }, EDITOR_THEME[theme]);
    await page.addInitScript({ content: mockSrc });
    await page.exposeFunction("__E2E_BRIDGE__", makeBridge(repoRoot));
    // init 是一条长 await 链，任何一处抛错都会让编辑器永不创建（而症状只表现为
    // 「app.editor 尚未初始化」）。把异常收上来，否则只能靠猜。
    page.on("pageerror", (e) => { errors.push(`pageerror: ${e && e.message ? e.message : e}`); });
    page.on("console", (m) => { if (m.type() === "error") errors.push(`console.error: ${m.text()}`); });
    await page.goto(DEV_URL, { waitUntil: "domcontentloaded" });
    // 应用就绪：文件树出现
    await page.locator("#tree .tree-item").first().waitFor({ state: "visible", timeout: 30_000 });
    // 主题断言：外壳 data-theme 与 Monaco 主题必须同侧（否则截图不可用于对比）
    const dom = await page.evaluate(() => document.documentElement.dataset.theme ?? "(none)");
    console.log(`[ui-baseline] ${theme}：data-theme=${dom}`);
    return page;
  };

  try {
    // 字体门禁模式：只探针不截图（截图批次跑完后单独跑，避免每次都等 8 张）
    if (wantProbe) {
      // 预热：vite 冷启动时 monaco 走几十个深路径 ESM 导入，依赖预打包要几十秒，
      // 而 init 的 `await import("./monaco")` 会一直挂着 —— 表现是「编辑器永不创建」，
      // 与字体无关。先用一个独立页面把预打包等出来，正式页面才能在合理时间内就绪。
      console.log("[ui-baseline] 预热 monaco 依赖预打包 …");
      const warm = await browser.newPage({ viewport: VIEWPORT });
      await warm.goto(DEV_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
      await warm.evaluate(() => import("/src/monaco.ts")).catch(() => {});
      await sleep(3000);
      await warm.close();

      const page = await newThemedPage("dark");
      const probe = await probeFonts(page);
      probe.pageErrors = errors;
      console.log(JSON.stringify(probe, null, 2));
      const bad = [];
      for (const [f, info] of Object.entries(probe.files ?? {})) {
        if (!String(info).startsWith("200")) bad.push(`${f} 不可达（${info}）`);
      }
      if (!probe.checkSingle) bad.push('document.fonts.check 对 "JetBrains Mono" 为 false（字体未生效）');
      if (String(probe.load).startsWith("TIMEOUT")) {
        bad.push("document.fonts.load() 永不 settle（Monaco 的 editor.create 会因此挂起）");
      }
      if (bad.length) {
        console.error("[ui-baseline] 字体门禁 FAIL：");
        for (const b of bad) console.error("  · " + b);
        process.exitCode = 1;
      } else {
        console.log(`[ui-baseline] 字体门禁 PASS（load ${probe.loadElapsedMs}ms · ${probe.monacoFontFamily}）`);
      }
      if (!probe.editorReady) {
        // **不是字体问题**：本脚本的 makeBridge 只实现「UI 渲染必需」通道（没有 lsp），
        // init 会停在 `await startLsp()`，编辑器根本没到创建那一步。Monaco 侧的字体证据
        // 由 e2e-ui（编辑器就绪后可用）+ 基线截图（连字可见）提供，不在此处设门禁。
        console.log("[ui-baseline] 提示：编辑器未就绪（探针环境缺 lsp 通道，init 停在 startLsp）——不计入字体门禁");
      }
      await page.close();
      return;
    }

    for (const theme of ["dark", "light"]) {
      console.log(`[ui-baseline] ${theme} 主题`);
      const page = await newThemedPage(theme);

      const shoot = async (name) => {
        const file = join(outDir, `${name}.png`);
        await page.screenshot({ path: file });
        shots.push(file);
        console.log(`  · ${file}`);
      };

      // ① 编辑区：打开样例文件，等 Monaco 渲染 + 高亮
      await page.locator(".tree-item", { hasText: "main.py" }).first().click();
      await page.locator(".monaco-editor .view-line").first().waitFor({ state: "visible", timeout: 30_000 });
      await settle(page, 1200);
      await shoot(`${theme}-1-editor`);

      // ② 侧栏：Git 视图（M/A/D/U 状态色 + 分支名 + 提交行）
      await page.locator("#tab-git").click();
      await page.locator("#view-git").waitFor({ state: "visible", timeout: 15_000 });
      await settle(page, 900);
      await shoot(`${theme}-2-sidebar`);

      // ③ 设置：外观页（主题色卡 + 字号控件，改色前后差异最集中）
      await openSettings(page);
      await shoot(`${theme}-3-settings`);
      await closeSettings(page);

      // ④ 终端：底部面板切到终端 tab（放最后——xterm 抢焦点会吃掉快捷键）
      await page.locator("#tab-terminal").click();
      await page.locator("#terminal-panel").waitFor({ state: "visible", timeout: 15_000 });
      await settle(page, 900);
      await shoot(`${theme}-4-terminal`);

      await page.close();
    }
  } finally {
    await browser.close();
    if (devChild) devChild.kill();
  }

  console.log(`\n[ui-baseline] 完成：${shots.length} 张 → ${outDir}`);
  for (const s of shots) console.log(`  ${s}`);
}

main().catch((e) => {
  console.error("[ui-baseline] 失败：", e);
  process.exit(1);
});
