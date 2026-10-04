/**
 * E2E：批 4 · Monaco 自定义主题 pylume-dark / pylume-light。
 *
 * ## 为什么单测钉不住、必须上 e2e
 *
 * themeTokens.test.ts 能证明「映射表是对的」「变量两套都有定义」「没有残留出厂名」，
 * 但证明不了 **defineTheme 的色值真的落到了编辑器上**。而这一环恰恰最容易静默失效：
 * CSS 变量未定义 → defineTheme 静默跳过该槽位 → 编辑器用 base 主题（vs-dark）的颜色，
 * 界面看起来「正常」，只是所有表面色和语法色都悄悄退回出厂值。
 *
 * 断言选**出厂主题与本主题差异最大**的槽位，否则测不出真伪：
 *  · 选区 —— 出厂 #add6ff（蓝）vs 本项目 --selected #d3efeb（青绿染色，ADR-0005）；
 *    ⚠ 而 editor.background 浅色下两边都是纯白（--surface-2 = #ffffff），根本无法区分；
 *  · 缩进参考线 —— 出厂 #d3d3d3 / #404040 vs 本项目 --surface-3 #f7f7f8 / #2a2a30；
 *  · 语法色 —— 出厂 identifier #9cdcfe（浅蓝）vs 本项目 #7ce3cd（青绿），另有 keyword 紫轴。
 */
import { test, expect } from "@playwright/test";
import { equipPage, makePlainDir, type GitRepo } from "../helpers";
import { MONACO_COLOR_SLOTS } from "../../src/theme/tokens";

/** 深色侧 token 值（style.css :root；与 themeTokens.test.ts 同源） */
const DARK = {
  editorBg: "rgb(31, 31, 36)", // --surface-2 #1f1f24（0x24 = 36）
  selected: "rgb(38, 67, 63)", // --selected    #26433f
  lineHighlight: "rgb(36, 36, 41)", // --editor-line-highlight #242429（0x24=36, 0x29=41）
  syntaxVar: "rgb(124, 227, 205)", // --syntax-var    #7ce3cd 青绿
  syntaxKeyword: "rgb(197, 134, 192)", // --syntax-boolean #c586c0 紫
  legacyVar: "rgb(156, 220, 254)", // 旧 #9cdcfe 浅蓝 —— 必须不出现
  legacyKeyword: "rgb(86, 156, 214)", // 旧 #569cd6 蓝 —— 必须不出现
};

/** 浅色侧 token 值（style.css [data-theme="light"]） */
const LIGHT = {
  editorBg: "rgb(255, 255, 255)", // --surface-2 #ffffff
  selected: "rgb(211, 239, 235)", // --selected    #d3efeb
  indent: "rgb(247, 247, 248)", // --surface-3  #f7f7f8
  syntaxVar: "rgb(14, 114, 97)", // --syntax-var    #0e7261
  legacyVar: "rgb(0, 16, 128)", // 旧 #001080 深蓝 —— 必须不出现
  legacyKeyword: "rgb(0, 0, 255)", // 旧 #0000ff 纯蓝 —— 必须不出现
};

// 覆盖全部 7 类 token：变量名（identifier）/ 字符串 / 数字 / 关键字（keyword）/ 布尔 / 空 / 装饰器
const SRC = [
  "import os",
  "",
  "MAX = 42",
  "ok = True",
  "nothing = None",
  "",
  "def greet(name):",
  '    """doc"""',
  "    print(f'hi {name}')",
].join("\n");

let repo: GitRepo;

/** 打开工作区 + main.py，等 Monaco 真正渲染出带 token 的视图行 */
async function openPy(page: import("@playwright/test").Page): Promise<void> {
  await equipPage(page, repo);
  await page.goto("/");
  await page.locator("#tree .tree-item .name", { hasText: "main.py" }).first().dblclick();
  await expect(page.locator(".monaco-editor")).toBeVisible({ timeout: 30_000 });
  await expect(page.locator(".monaco-editor .view-lines").first()).toBeAttached({ timeout: 30_000 });
  // 语法着色需 token 化完成：任一 token span 出现即可（纯文本时 mtk1 不着色）
  await expect(page.locator(".monaco-editor .view-line span[class*='mtk']").first()).toBeAttached({ timeout: 30_000 });
}

/** 全选并返回选区元素的实际底色。
 *  ⚠ 必须**轮询到拿到非透明底色**为止：`toBeAttached` 通过 ≠ 元素仍带背景——
 *    Monaco 重建视图行（切主题、token 化完成、异步渲染）会把 .selected-text 整体替换掉，
 *    那一刻读到的 computed backgroundColor 是空字符串。首跑就踩到过一次
 *    （T-B4-5 收到 "" 而非某个错误色值），真机层同样要求读到实际色值。 */
async function selectionBg(page: import("@playwright/test").Page): Promise<string> {
  await page.locator(".monaco-editor .view-lines").first().click();
  await page.keyboard.press("Control+a");
  return page
    .waitForFunction(
      () => {
        const el = document.querySelector(".monaco-editor .selected-text");
        if (!el) return null;
        const c = getComputedStyle(el).backgroundColor;
        return c && c !== "rgba(0, 0, 0, 0)" ? c : null;
      },
      null,
      { timeout: 10_000 },
    )
    .then((h) => h.jsonValue() as Promise<string>);
}

/** 编辑器内所有 token 文本的实际渲染色（去重小写） */
async function tokenColors(page: import("@playwright/test").Page): Promise<string[]> {
  return page.evaluate(() => {
    const out = new Set<string>();
    for (const el of document.querySelectorAll(".monaco-editor .view-line span[class*='mtk']")) {
      out.add(getComputedStyle(el).color.toLowerCase());
    }
    return [...out];
  });
}

/** Monaco 主题服务注入的全部 `--vscode-*` 变量（主题 → CSS 变量的唯一通路）。
 *
 *  批 4 的教训是「defineTheme 的色值真的落到编辑器上」单测证不了；而修记 A 的红滚动条
 *  恰恰只发生在这条通路上（`StandaloneTheme` 把色值写成 `--vscode-<槽位>` 变量），
 *  所以这里读的是**注入结果**而不是主题定义。 */
async function injectedThemeVars(page: import("@playwright/test").Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const out: Record<string, string> = {};
    for (const sheet of Array.from(document.styleSheets)) {
      let rules: CSSRuleList | undefined;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // 跨域样式表读不到，跳过（Monaco 注入的是同源 <style>，不受影响）
      }
      for (const rule of Array.from(rules ?? [])) {
        const style = (rule as CSSStyleRule).style;
        if (!style) continue;
        for (const prop of Array.from(style)) {
          if (prop.startsWith("--vscode-")) out[prop] = style.getPropertyValue(prop).trim();
        }
      }
    }
    return out;
  });
}

/** 拆 `rgb(r, g, b)` / `rgba(r, g, b, a)` → 通道值（Monaco 注入的是这两种序列化形式） */
function parseRgb(value: string): { r: number; g: number; b: number; a: number } | null {
  const m = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}

/** 断言「我们的槽位一个都没被 Monaco 判成非法色」。
 *
 *  非法色 = 纯红 `#ff0000`：`Color.fromHex` 解析失败时**静默返回 `Color.red`**，
 *  不报错、不警告。红色在 IDE 里语义是「错误」，滑块变红会被读成「这个位置有错」。
 *  `rgba(255,0,0,…)` 一并算红——`minimapSlider.*` 的出厂默认是
 *  `transparent(scrollbarSlider.background, 0.5)`，会跟着坏值一起变红。 */
async function expectNoIllegalRed(page: import("@playwright/test").Page): Promise<void> {
  const vars = await injectedThemeVars(page);
  const isRed = (value: string): boolean => /^#ff0000$/i.test(value) || /^rgba\(\s*255\s*,\s*0\s*,\s*0\s*(,|\))/.test(value);
  const reds: string[] = [];
  for (const slot of Object.keys(MONACO_COLOR_SLOTS)) {
    const name = `--vscode-${slot.replace(/\./g, "-")}`;
    const value = vars[name];
    if (value && isRed(value)) reds.push(`${name} = ${value}`);
  }
  expect(reds, `这些槽位被 Monaco 判为非法色而静默变红：${reds.join("; ")}`).toEqual([]);
}

test.beforeEach(async () => {
  repo = await makePlainDir({ "main.py": SRC });
});

test.describe("深色主题 pylume-dark", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __E2E_SETTINGS_PRESET__?: Record<string, unknown> }).__E2E_SETTINGS_PRESET__ = {
        theme: "pylume-dark",
      };
    });
    await openPy(page);
  });

  test("T-B4-1 编辑器表面色与外壳 token 同源（不再是出厂 vs-dark）", async ({ page }) => {
    // ⚠ 当前行高亮只在编辑器**有焦点**时才绘制（Monaco 的 _shouldRenderInContent 判 focused），
    //   故先点一下再读——否则元素根本不存在，用例会因 null 而红，且与主题是否生效无关。
    await page.locator(".monaco-editor .view-lines").first().click();
    const probe = await page.evaluate(() => {
      const pick = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : null;
      };
      return {
        editor: pick(".monaco-editor"),
        margin: pick(".monaco-editor .margin"),
        // ⚠ 选择器必须带 .view-overlays 前缀：Monaco 只对
        //   `.monaco-editor .view-overlays .current-line` 生成底色规则（见 currentLineHighlight.js
        //   的 registerThemingParticipant），gutter 侧那个 .current-line 由另一条规则管。
        //   用无前缀选择器会命中 gutter 元素并读到 transparent，误判成「主题没生效」。
        currentLine: pick(".monaco-editor .view-overlays .current-line"),
      };
    });
    expect(probe.editor, "editor.background 应取 --surface-2").toBe(DARK.editorBg);
    // gutter 底色：Monaco 把 editorGutter.background 设在 .margin 上；.margin-view-overlays
    // 本身透明（它只承载行号与折角控件）。
    expect(probe.margin, "editorGutter.background 应与画布同档").toBe(DARK.editorBg);
    expect(probe.currentLine, "editor.lineHighlightBackground 应取 --editor-line-highlight").toBe(DARK.lineHighlight);
    // 边框必须已去掉：Monaco 原生给当前行画 2px 描边，与「层级靠表面差、不靠描边」冲突
    expect(
      await page.evaluate(() => {
        const el = document.querySelector(".monaco-editor .view-overlays .current-line-exact");
        return el ? getComputedStyle(el).borderTopColor : null;
      }),
      "editor.lineHighlightBorder 应为透明（去掉 VS Code 那条描边）",
    ).toBe("rgba(0, 0, 0, 0)");
  });

  test("T-B4-2 选区是青绿染色而非出厂蓝（本批最醒目的判据）", async ({ page }) => {
    const bg = await selectionBg(page);
    expect(bg, "editor.selectionBackground 应取 --selected（ADR-0005 青绿）").toBe(DARK.selected);
    // 出厂 vs-dark 选区是 #264f78；若映射失效这里会拿到它
    expect(bg).not.toBe("rgb(38, 79, 120)");
  });

  test("T-B4-3 语法色已青绿化：identifier 青绿 + keyword 紫，旧蓝不得出现", async ({ page }) => {
    const colors = await tokenColors(page);
    expect(colors, "identifier 应渲染色为青绿 --syntax-var").toContain(DARK.syntaxVar);
    expect(colors, "keyword 应渲染色为紫 --syntax-boolean").toContain(DARK.syntaxKeyword);
    expect(colors, "旧的浅蓝 identifier 不应再出现").not.toContain(DARK.legacyVar);
    expect(colors, "旧的蓝 keyword 不应再出现").not.toContain(DARK.legacyKeyword);
  });

  test("T-B4-7 滚动条不是红色（修记 A：Monaco 只认 hex，rgba 曾被静默判成 #ff0000）", async ({ page }) => {
    await expectNoIllegalRed(page);
    const vars = await injectedThemeVars(page);
    // 正向判据：滚动条滑块取到的是 --scrollbar-thumb（白 14% 半透明），不是纯红
    expect(vars["--vscode-scrollbarSlider-background"], "scrollbarSlider.background 应已注入").toBeTruthy();
    expect(vars["--vscode-scrollbarSlider-background"]).not.toBe("#ff0000");
    // minimapSlider 的出厂默认由 scrollbarSlider 派生，故一并验（半透明红也是坏值）
    expect(vars["--vscode-minimapSlider-background"], "minimapSlider.background 应已注入").toBeTruthy();
    expect(vars["--vscode-minimapSlider-background"]).not.toMatch(/^rgba\(\s*255\s*,\s*0\s*,\s*0/);
  });

  test("T-B4-11 映射表的槽位全部被 Monaco 真实注入（防「id 未注册 → 死映射」）", async ({ page }) => {
    // 真机 R-FIXA-1 抓到的那类缺陷：`defineTheme` 收下任意键，但生成 CSS 变量的循环
    // 只遍历 Monaco **已注册**的颜色 id —— 未注册的槽位永不注入，编辑器悄悄吃出厂色
    // （`editorGutter.foreground` 就是如此，行号在浅色下一直是出厂蓝 #237893）。
    // 单测证不了这件事（它只能证明「映射表自身没写错」），必须读注入结果。
    const vars = await injectedThemeVars(page);
    // ⚠ 假阴性防线：先证明读法有效（0 个变量 = 扫描器坏了，不是全通过）
    expect(Object.keys(vars).length, "应读到 Monaco 注入的 CSS 变量").toBeGreaterThan(0);
    const missing = Object.keys(MONACO_COLOR_SLOTS).filter(
      (slot) => !vars[`--vscode-${slot.replace(/\./g, "-")}`],
    );
    expect(missing, `这些槽位在 Monaco 里未注册，映射是死的：${missing.join("; ")}`).toEqual([]);
  });
});

test.describe("浅色主题 pylume-light", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __E2E_SETTINGS_PRESET__?: Record<string, unknown> }).__E2E_SETTINGS_PRESET__ = {
        theme: "pylume-light",
      };
    });
    await openPy(page);
  });

  test("T-B4-4 外壳与编辑器同步切浅色（外壳 data-theme 与 Monaco 主题成对）", async ({ page }) => {
    const shellTheme = await page.evaluate(() => document.documentElement.dataset.theme);
    expect(shellTheme).toBe("light");
    const editorBg = await page.evaluate(() => {
      const el = document.querySelector(".monaco-editor");
      return el ? getComputedStyle(el).backgroundColor : null;
    });
    expect(editorBg).toBe(LIGHT.editorBg);
  });

  test("T-B4-5 浅色下选区与语法色取浅色覆盖层的值", async ({ page }) => {
    const bg = await selectionBg(page);
    expect(bg, "浅色选区应为 #d3efeb（出厂 vs 是蓝 #add6ff）").toBe(LIGHT.selected);
    expect(bg).not.toBe("rgb(173, 214, 255)");
    const colors = await tokenColors(page);
    expect(colors, "浅色 identifier 应为青绿 #0e7261").toContain(LIGHT.syntaxVar);
    expect(colors, "旧的深蓝 identifier 不应再出现").not.toContain(LIGHT.legacyVar);
    expect(colors, "旧的纯蓝 keyword 不应再出现").not.toContain(LIGHT.legacyKeyword);
  });

  test("T-B4-8 浅色下滚动条同样不是红色（rgba → hex 归一与主题无关）", async ({ page }) => {
    await expectNoIllegalRed(page);
    const vars = await injectedThemeVars(page);
    // 浅色 --scrollbar-thumb 是黑 18%，Monaco 注入后应是「无彩色 + 低 alpha」
    const value = vars["--vscode-scrollbarSlider-background"];
    expect(value, "scrollbarSlider.background 应已注入").toBeTruthy();
    const rgb = parseRgb(value);
    if (rgb) {
      expect(Math.max(rgb.r, rgb.g, rgb.b) - Math.min(rgb.r, rgb.g, rgb.b), `实际 ${value}`).toBeLessThanOrEqual(2);
    } else {
      expect(value, "浅色滚动条应是中性灰黑，不得是彩色").toMatch(/^#[0-9a-f]{6,8}$/);
    }
  });
});

test.describe("存量设置迁移（旧出厂主题名 → 自定义名）", () => {
  // 这条是批 4 最大的静默风险：Monaco 对未注册的主题名**不报错**，
  // 静默回落到出厂 vs-dark。不迁移的症状是「用户升级后编辑器悄悄变回原厂主题且无提示」。
  test("T-B4-6 存量 theme=\"vs\" 迁移为 pylume-light 并真正生效", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __E2E_SETTINGS_PRESET__?: Record<string, unknown> }).__E2E_SETTINGS_PRESET__ = {
        theme: "vs", // 批 4 之前用户 settings.json 里的真实存量值
      };
    });
    await openPy(page);
    const migrated = await page.evaluate(() => {
      const el = document.querySelector(".monaco-editor");
      return {
        shell: document.documentElement.dataset.theme,
        editor: el ? getComputedStyle(el).backgroundColor : null,
      };
    });
    expect(migrated.shell, "存量 vs 应被迁移成浅色外壳").toBe("light");
    expect(migrated.editor, "迁移后编辑器必须是浅色画布").toBe(LIGHT.editorBg);
    // 浅色画布与出厂 vs 相同，故再验一次选区——那是唯一能区分两者的槽位
    expect(await selectionBg(page), "迁移后选区应是青绿染色").toBe(LIGHT.selected);
  });
});

/* 修记 A：滚动条的 DOM 侧真判据。上面两条读的是 Monaco 注入的变量（确定性强），
   这一条读**用户真正看到的那块像素**：滑块元素的 computed 底色。
   单独一个 describe + 自己的长文件仓库——滚动条只在**内容溢出**时才有可见滑块，
   拿 9 行的样例文件去断言只会得到 0×0 的隐藏滑块（假阴性）。 */
test.describe("修记 A · 编辑器滚动条真实底色（长文件，滚动条可见）", () => {
  const LONG = Array.from({ length: 300 }, (_, i) => `VALUE_${i} = ${i}  # 行 ${i}`).join("\n");
  let longRepo: GitRepo;

  test.beforeEach(async () => {
    longRepo = await makePlainDir({ "long.py": LONG });
  });

  test("T-B4-9 滑块底色是无彩色半透明（不是纯红）", async ({ page }) => {
    await page.addInitScript(() => {
      (window as unknown as { __E2E_SETTINGS_PRESET__?: Record<string, unknown> }).__E2E_SETTINGS_PRESET__ = {
        theme: "pylume-dark",
      };
    });
    await equipPage(page, longRepo);
    await page.goto("/");
    await page.locator("#tree .tree-item .name", { hasText: "long.py" }).first().dblclick();
    await expect(page.locator(".monaco-editor .view-line").first()).toBeVisible({ timeout: 30_000 });
    // 悬停 + 滚一下，让 0.52 的 auto-hide 滚动条从 hidden 切到 visible
    await page.locator(".monaco-editor").first().hover();
    await page.mouse.wheel(0, 1200);
    const bg = await page
      .waitForFunction(
        () => {
          const el = document.querySelector(".monaco-editor .scrollbar.vertical .slider");
          if (!el || el.getBoundingClientRect().height === 0) return null; // 仍是隐藏态
          return getComputedStyle(el).backgroundColor;
        },
        null,
        { timeout: 10_000 },
      )
      .then((h) => h.jsonValue() as Promise<string>);
    const rgb = parseRgb(bg);
    expect(rgb, `滚动条底色应是 rgb()/rgba() 形式，实际 ${bg}`).not.toBeNull();
    const spread = Math.max(rgb!.r, rgb!.g, rgb!.b) - Math.min(rgb!.r, rgb!.g, rgb!.b);
    expect(spread, `滚动条应是无彩色（灰白），实际 ${bg} 三通道跨度 ${spread}`).toBeLessThanOrEqual(2);
    expect(rgb!.a, `滚动条应是低 alpha 的半透明材质，实际 ${bg}`).toBeLessThanOrEqual(0.5);
  });

  test("T-B4-10 滑块宽度 10px（Monaco 出厂 14px 比外壳 8px 明显粗，ui_premium §7.9）", async ({ page }) => {
    await equipPage(page, longRepo);
    await page.goto("/");
    await page.locator("#tree .tree-item .name", { hasText: "long.py" }).first().dblclick();
    await expect(page.locator(".monaco-editor .view-line").first()).toBeVisible({ timeout: 30_000 });
    await page.locator(".monaco-editor").first().hover();
    await page.mouse.wheel(0, 1200);
    // 量滚动条**容器**宽度（滑块宽度默认跟随该值，容器在隐藏态也存在，可不依赖显形时序）
    const width = await page.evaluate(() => {
      const el = document.querySelector(".monaco-editor .scrollbar.vertical");
      return el ? el.getBoundingClientRect().width : null;
    });
    expect(width, "应能取到编辑器垂直滚动条容器").not.toBeNull();
    expect(width, `垂直滚动条应为 10px（出厂 14px），实际 ${width}`).toBe(10);
  });
});
