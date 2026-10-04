// Monaco 主题门禁（ui_premium 批 4 · 设计报告 §5.4 / dev_plan §6.4）。
//
// ## 为什么批 4 必须有独立门禁
//
// 批 4 的症状全部是**静默**的：
//   · 主题名没迁移 → Monaco 对未注册名不报错，回落出厂 vs-dark，「升级后编辑器变回原厂主题且无提示」；
//   · 浅色判定漏改一处 → 外壳浅色 / 终端深色的「半深半浅」界面，截图才发现；
//   · 映射表引用的 CSS 变量在某主题下没定义 → var() 在 computed-value time 失效 →
//     该槽位颜色 unset，**继承父级**（不是回退到 :root 值），排查时看不出任何报错；
//   · 两处色值各写一份 → 改 style.css 不动 TS，两边都是合法颜色，任何静态检查都发现不了漂移。
//
// 本文件把这些从「注释里的承诺」变成会红的断言。全部读源码文本 + 纯函数调用，不依赖浏览器。

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EDITOR_THEME_DARK,
  EDITOR_THEME_LIGHT,
  LEGACY_EDITOR_THEMES,
  MONACO_COLOR_SLOTS,
  MONACO_TOKEN_SLOTS,
  THEME_BASES,
  isLightEditorTheme,
  resolveEditorTheme,
  shellThemeOf,
  toMonacoHexColor,
} from "../theme/tokens";
import { DEFAULT_SETTINGS, migrateLegacyThemeSettings } from "../state";

function readRepoFile(rel: string): string {
  for (const prefix of ["", "shell/"]) {
    const p = resolve(process.cwd(), prefix + rel);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  throw new Error(`找不到 ${rel}（cwd=${process.cwd()}）`);
}

const css = readRepoFile("src/style.css");
const rust = readRepoFile("src-tauri/src/settings.rs");

/** 剥注释后再做结构解析。
 *  ⚠ 批 2b 的教训：注释里出现过 `[data-theme="light"]` 字样，不剥注释会 indexOf 到注释那一行，
 *    取出的是一段散文而不是 CSS 块——正是当时选择器级扫描器返回「0 命中」假阴性的同款成因。 */
const bareCss = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 按花括号配对取某个选择器块的 body（CSS 解析必须字符级，不能按行切块——单行规则会被丢） */
function blockBody(selector: string): string {
  const i = bareCss.indexOf(selector);
  if (i < 0) throw new Error(`style.css 未找到选择器块 ${selector}`);
  const open = bareCss.indexOf("{", i);
  let depth = 0;
  for (let j = open; j < bareCss.length; j++) {
    if (bareCss[j] === "{") depth++;
    else if (bareCss[j] === "}") {
      depth--;
      if (depth === 0) return bareCss.slice(open + 1, j);
    }
  }
  throw new Error(`style.css 的 ${selector} 块未闭合`);
}

/** 某选择器块内定义的 CSS 自定义属性名集合 */
function definedVars(selector: string): Set<string> {
  const body = blockBody(selector);
  const out = new Set<string>();
  for (const m of body.matchAll(/(--[A-Za-z0-9-]+)\s*:/g)) out.add(m[1]);
  return out;
}

const rootVars = definedVars(":root");
const lightVars = definedVars('[data-theme="light"]');

/** 某选择器块内某自定义属性的 authored 值（**取最后一条**声明，与 CSS 层叠一致）。
 *  顺带解 `var(--x)` 引用——computed-value time 会把它替换成被引 token 的值，
 *  而 Monaco 拿到的正是替换后的结果（`--border: var(--border-subtle)` 就是这种写法）。 */
function tokenValue(selector: string, name: string, depth = 0): string {
  const body = blockBody(selector);
  let value: string | null = null;
  for (const m of body.matchAll(new RegExp(`${name}\\s*:\\s*([^;]+);`, "g"))) value = m[1].trim();
  if (value === null) throw new Error(`${selector} 下未找到 ${name}`);
  const ref = value.match(/^var\(\s*(--[A-Za-z0-9-]+)\s*\)$/);
  if (!ref) return value;
  if (depth >= 4) throw new Error(`${selector} 的 ${name} var() 引用成环或过深：${value}`);
  return tokenValue(selector, ref[1], depth + 1);
}

/** 映射表里允许内联硬编码的槽位（Monaco 需要一个「透明」色值，没有任何 CSS token 对应） */
const INLINE_HEX_SLOTS = new Set(["editor.lineHighlightBorder"]);

describe("批 4 · 主题名与迁移（存量 vs-dark / vs）", () => {
  it("三种存量出厂名都映射到新名（方案只列了 vs-dark / vs-light，漏掉真实存量的 vs）", () => {
    expect(resolveEditorTheme("vs-dark")).toBe(EDITOR_THEME_DARK);
    expect(resolveEditorTheme("vs")).toBe(EDITOR_THEME_LIGHT);
    expect(resolveEditorTheme("vs-light")).toBe(EDITOR_THEME_LIGHT);
  });

  it("新名幂等（迁移可重复执行，不产生第二套名字）", () => {
    expect(resolveEditorTheme(EDITOR_THEME_DARK)).toBe(EDITOR_THEME_DARK);
    expect(resolveEditorTheme(EDITOR_THEME_LIGHT)).toBe(EDITOR_THEME_LIGHT);
  });

  it("未知值兜底深色而不是原样保留（Monaco 对未注册名静默回落 vs-dark）", () => {
    for (const bad of ["hc-black", "", "monokai", "vscode"]) {
      expect(resolveEditorTheme(bad)).toBe(EDITOR_THEME_DARK);
    }
  });

  it("浅色判定只有一个真源函数，三处调用方共用", () => {
    expect(isLightEditorTheme(EDITOR_THEME_LIGHT)).toBe(true);
    expect(isLightEditorTheme(EDITOR_THEME_DARK)).toBe(false);
    expect(shellThemeOf("vs")).toBe("light");
    expect(shellThemeOf("vs-dark")).toBe("dark");
    expect(shellThemeOf(EDITOR_THEME_LIGHT)).toBe("light");
    expect(shellThemeOf("garbage")).toBe("dark");
  });

  it("migrateLegacyThemeSettings 只碰 theme 字段", () => {
    const s = { theme: "vs", font_size: 18, font_ligatures: true };
    const out = migrateLegacyThemeSettings(s);
    expect(out.theme).toBe(EDITOR_THEME_LIGHT);
    expect(out.font_size).toBe(18);
    expect(out.font_ligatures).toBe(true);
  });

  it("迁移映射表不含新名（否则新名会被当成旧名再映射一次）", () => {
    for (const legacy of Object.keys(LEGACY_EDITOR_THEMES)) {
      expect(legacy).not.toBe(EDITOR_THEME_DARK);
      expect(legacy).not.toBe(EDITOR_THEME_LIGHT);
    }
  });
});

describe("批 4 · 前后端出厂主题名一致", () => {
  it("state.ts DEFAULT_SETTINGS.theme === pylume-dark", () => {
    expect(DEFAULT_SETTINGS.theme).toBe(EDITOR_THEME_DARK);
  });

  it("settings.rs Settings::default 的 theme 与前端一致（不跨语言漂移）", () => {
    // 取 default() 里 theme 那一行；要求出现且值为 pylume-dark
    const m = rust.match(/theme:\s*"([^"]+)"\.into\(\)/);
    expect(m).not.toBeNull();
    expect(m?.[1]).toBe(EDITOR_THEME_DARK);
    // 两处 Rust 测试断言里不得再有旧名
    expect(rust).not.toMatch(/assert_eq!\([sd]\.theme,\s*"vs/);
  });
});

describe("批 4 · 接线点完整性（改名后不得有残留出厂名判定）", () => {
  // tokens.ts 自身持有 LEGACY_EDITOR_THEMES（「vs」是故意保留的映射键），故不在扫描范围。
  const WIRES = [
    "src/main.ts",
    "src/settingsPanel.ts",
    "src/terminal.ts",
    "src/markdownPreview.ts",
    "src/themePicker.ts",
  ];

  it("产品代码里不再有 `=== \"vs\"` / `\"vs-dark\"` 这类浅色或主题判定字面量", () => {
    const bad: string[] = [];
    for (const f of WIRES) {
      const text = readRepoFile(f);
      // 剥掉行注释与块注释后再扫：注释里为了说明历史会提到旧名
      const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      if (/["']vs["']/.test(code) || /["']vs-dark["']/.test(code) || /["']vs-light["']/.test(code)) {
        bad.push(f);
      }
    }
    expect(bad, `这些文件仍有出厂主题名字面量：${bad.join(", ")}`).toEqual([]);
  });

  it("e2e mock 的默认主题也是新名（否则整套 e2e 跑在出厂主题上，批 4 的断言全失真）", () => {
    const mock = readRepoFile("e2e/mocks/tauri-mock.js");
    expect(mock).toContain(EDITOR_THEME_DARK);
    expect(mock).not.toMatch(/theme:\s*["']vs/);
  });

  it("基线截图脚本的卡片选择器用新名（用旧名会点不到卡片，浅色基线全部拍成深色）", () => {
    const script = readRepoFile("scripts/ui-baseline.mjs");
    expect(script).toContain(EDITOR_THEME_DARK);
    expect(script).toContain(EDITOR_THEME_LIGHT);
  });

  it("themePicker 的兜底主题是深色新名（getSelectedTheme 的空态回落实）", () => {
    const tp = readRepoFile("src/themePicker.ts");
    expect(tp).toMatch(/FALLBACK_THEME\s*=\s*EDITOR_THEME_DARK/);
  });
});

describe("批 4 · 色值真源单一性（tokens.ts 不得长出色值副本）", () => {
  it("映射表里的每个取值都是 CSS 变量，内联 hex 仅限 lineHighlightBorder", () => {
    const offenders: string[] = [];
    for (const [slot, token] of Object.entries(MONACO_COLOR_SLOTS)) {
      if (!token.startsWith("--") && !INLINE_HEX_SLOTS.has(slot)) offenders.push(`${slot} → ${token}`);
    }
    expect(offenders, `这些槽位应改走 CSS 变量：${offenders.join("; ")}`).toEqual([]);
  });

  it("token 槽位一律走 CSS 变量（无任何内联色值）", () => {
    for (const [token, cssVar] of Object.entries(MONACO_TOKEN_SLOTS)) {
      expect(cssVar, `token ${token} 必须走 CSS 变量`).toMatch(/^--[A-Za-z0-9-]+$/);
    }
  });

  it("深浅两套共用一份映射（不按主题分叉——差异全在 CSS 覆盖层）", () => {
    // 映射表按设计只有一个；此断言是防「有人为深浅各建一张表」——那会让浅色覆盖层失去控制权。
    expect(Object.keys(MONACO_COLOR_SLOTS).length).toBeGreaterThan(15);
    expect(Object.keys(MONACO_TOKEN_SLOTS).length).toBeGreaterThan(8);
  });
});

describe("批 4 · 映射引用的 CSS 变量必须两套主题都有定义", () => {
  const referenced = [
    ...new Set([
      ...Object.values(MONACO_COLOR_SLOTS).filter((v) => v.startsWith("--")),
      ...Object.values(MONACO_TOKEN_SLOTS),
    ]),
  ];

  it(":root 下全部有定义", () => {
    const missing = referenced.filter((v) => !rootVars.has(v));
    expect(missing, `:root 缺定义（var() 会 unset）: ${missing.join(", ")}`).toEqual([]);
  });

  it("[data-theme=\"light\"] 下全部有定义", () => {
    const missing = referenced.filter((v) => !lightVars.has(v));
    expect(missing, `浅色覆盖层缺定义（var() 在 computed-value time 失效 → 颜色继承父级）: ${missing.join(", ")}`).toEqual([]);
  });

  it("批 4 新增的 --editor-line-highlight 深浅两套都有值", () => {
    for (const set of [rootVars, lightVars]) expect(set.has("--editor-line-highlight")).toBe(true);
  });

  it("THEME_BASES：深色垫 vs-dark、浅色垫 vs（Monaco 没有内置 vs-light）", () => {
    expect(THEME_BASES[EDITOR_THEME_DARK]).toBe("vs-dark");
    expect(THEME_BASES[EDITOR_THEME_LIGHT]).toBe("vs");
  });
});

describe("批 4 · 语法色已与 Monaco rules 同批改（唯二偏蓝的两项）", () => {
  /** 取某主题块里 --syntax-xxx 的值 */
  function syntaxValue(selector: string, name: string): string {
    const body = blockBody(selector);
    const m = body.match(new RegExp(`${name}\\s*:\\s*([^;]+);`));
    if (!m) throw new Error(`${selector} 下未找到 ${name}`);
    return m[1].trim();
  }

  it("--syntax-var 深色已青绿（不再是浅蓝 #9cdcfe）", () => {
    expect(syntaxValue(":root", "--syntax-var")).toBe("#7ce3cd");
  });

  it("--syntax-var 浅色已青绿（不再是深蓝 #001080）", () => {
    expect(syntaxValue('[data-theme="light"]', "--syntax-var")).toBe("#0e7261");
  });

  it("--syntax-boolean 深色已转紫轴（不再是蓝 #569cd6）", () => {
    expect(syntaxValue(":root", "--syntax-boolean")).toBe("#c586c0");
  });

  it("--syntax-boolean 浅色已转紫轴（不再是 #0000ff）", () => {
    expect(syntaxValue('[data-theme="light"]', "--syntax-boolean")).toBe("#a0519f");
  });

  it("其余 5 个语法色未被改动（多色相是 token 区分度的功能需求，不得连坐）", () => {
    expect(syntaxValue(":root", "--syntax-string")).toBe("#ce9178");
    expect(syntaxValue(":root", "--syntax-number")).toBe("#b5cea8");
    expect(syntaxValue(":root", "--syntax-null")).toBe("#808080");
    expect(syntaxValue(":root", "--syntax-object")).toBe("#e8c07d");
    expect(syntaxValue(":root", "--syntax-array")).toBe("#d19a66");
  });

  it("Python 关键字走 keyword 槽位（Monarch 把 True/False 与 def/class 合并，故用紫轴）", () => {
    expect(MONACO_TOKEN_SLOTS.keyword).toBe("--syntax-boolean");
    // 变量名走 var 槽位（青绿亮档）——代码区最高频 token
    expect(MONACO_TOKEN_SLOTS.identifier).toBe("--syntax-var");
  });
});

/* ------------------------------------------------------------------------- *
 * 修记 A（2026-10-03）：色值格式归一 —— 滚动条变红
 *
 * 症状：编辑器右侧滚动条是**纯红**，缩略图滑块是半透明红，红在 IDE 里语义是「错误」，
 *      用户会误以为滑块位置指向出错行。
 * 根因：Monaco 主题色只接受 hex（`parseHex` 只认 #RGB/#RGBA/#RRGGBB/#RRGGBBAA），
 *      `rgba()` 一律判为非法并**静默返回 `Color.red`**。本项目 token 大量用 rgba，
 *      `--scrollbar-thumb` / `--border` 首当其冲。详见 theme/tokens.ts::toMonacoHexColor。
 * 本组断言把「凡是喂给 Monaco 的色值必须可解析」钉成门禁——否则同类静默变红会再次发生。
 * ------------------------------------------------------------------------- */
describe("修记 A · toMonacoHexColor（Monaco 只认 hex，rgba 会被判非法并变红）", () => {
  it("6/8 位 hex 原样透传（大小写归一）", () => {
    expect(toMonacoHexColor("#1F1F24")).toBe("#1f1f24");
    // ⚠ lineHighlightBorder 的透明值就是 8 位 hex，走的是同一分支（改动前它没变红过）
    expect(toMonacoHexColor("#00000000")).toBe("#00000000");
  });

  it("3/4 位短 hex 展开（Monaco 只认这两种长度，展开后才 parse 得到）", () => {
    expect(toMonacoHexColor("#abc")).toBe("#aabbcc");
    expect(toMonacoHexColor("#abcd")).toBe("#aabbccdd");
  });

  it("rgba → 8 位 hex 带 alpha（本 bug 的直接修复点）", () => {
    // 深色 --scrollbar-thumb：白 14% → 0.14*255 = 35.7 → 0x24
    expect(toMonacoHexColor("rgba(255, 255, 255, 0.14)")).toBe("#ffffff24");
    // 浅色 --scrollbar-thumb：黑 18% → 0.18*255 = 45.9 → 0x2e
    expect(toMonacoHexColor("rgba(0, 0, 0, 0.18)")).toBe("#0000002e");
  });

  it("rgb / alpha=1 → 6 位 hex（不补 ff，parseHex 两种长度都吃）", () => {
    expect(toMonacoHexColor("rgb(31, 31, 36)")).toBe("#1f1f24");
    expect(toMonacoHexColor("rgba(0, 0, 0, 1)")).toBe("#000000");
  });

  it("现代语法（空格分隔 + 斜杠 alpha）与百分比通道也能解析", () => {
    expect(toMonacoHexColor("rgb(255 255 255 / 0.14)")).toBe("#ffffff24");
    expect(toMonacoHexColor("rgb(100% 100% 100% / 50%)")).toBe("#ffffff80");
  });

  it("无法解析的一律返回 null（绝不能原样传给 defineTheme——那会静默变红）", () => {
    for (const bad of ["", "   ", "transparent", "red", "var(--scrollbar-thumb)", "#12345", "rgb(1,2)", "rgb(a,b,c)"]) {
      expect(toMonacoHexColor(bad), `${bad} 应被拒`).toBeNull();
    }
  });
});

describe("修记 A · 所有映射槽位在两套主题下的取值都能被 Monaco 解析", () => {
  const colorTokens = [...new Set(Object.values(MONACO_COLOR_SLOTS).filter((v) => v.startsWith("--")))];
  const tokenTokens = [...new Set(Object.values(MONACO_TOKEN_SLOTS))];

  it.each([
    [":root", "深色"],
    ['[data-theme="light"]', "浅色"],
  ])("%s（%s）下 color 槽位引用的每个 token 都可解析", (selector) => {
    const bad: string[] = [];
    for (const token of colorTokens) {
      const raw = tokenValue(selector, token);
      if (toMonacoHexColor(raw) === null) bad.push(`${token}: ${raw}`);
    }
    expect(bad, `这些取值会让 Monaco 槽位静默变红：${bad.join("; ")}`).toEqual([]);
  });

  it.each([
    [":root", "深色"],
    ['[data-theme="light"]', "浅色"],
  ])("%s（%s）下语法色引用的每个 token 都可解析", (selector) => {
    const bad: string[] = [];
    for (const token of tokenTokens) {
      const raw = tokenValue(selector, token);
      if (toMonacoHexColor(raw) === null) bad.push(`${token}: ${raw}`);
    }
    expect(bad, `这些取值会让语法色静默变红：${bad.join("; ")}`).toEqual([]);
  });

  it("内联的 lineHighlightBorder 是 8 位 hex（唯一允许的硬编码色值）", () => {
    expect(toMonacoHexColor(MONACO_COLOR_SLOTS["editor.lineHighlightBorder"])).toBe("#00000000");
  });
});
