// 等宽字体四方一致门禁（ui_premium 批 3 · ui_premium_dev_plan §6.3）。
//
// 为什么需要它：批 3 的方案原文把杠杆 3 写成「改一行 CSS」，v1.2 修正为**五处改动**。
// 这五处一旦漂移，症状全部是**静默**的：改 state.ts 不会动 style.css，改 index.html 不会动
// Rust 侧，测试全绿、门禁全绿，只是「某些用户看到的编辑器字体和预期不同」。
// 本文件把「同步义务」从注释里的承诺变成会红的断言。
//
// 四方各自的职责：
//   1. state.ts DEFAULT_FONT_FAMILY        —— 前端出厂值（经 settings.json → Monaco）
//   2. settings.rs Settings::default       —— 后端出厂值（新装用户的 settings.json 来源）
//   3. style.css --mono                    —— 外壳等宽真源（Monaco 不读它）
//   4. index.html 字体族 preset 首选项       —— 设置面板的「默认」候选，命中它才写入输入框
// 另加 style.css 的 4 条 @font-face 与 public/fonts/ 的实际文件、OFL 许可证。
//
// 断言全部读源码文本，不依赖浏览器生效——纯 Node 环境即可跑。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_FONT_FAMILY, DEFAULT_SETTINGS, LEGACY_FONT_FAMILY, migrateLegacyFontSettings } from "../state";
import { EDITOR_THEME_LIGHT } from "../theme/tokens";

/** 读仓库内文件（vitest 的 cwd 通常是 shell/；兼容从仓库根 --root 启动） */
function readRepoFile(rel: string): string {
  for (const prefix of ["", "shell/"]) {
    const p = resolve(process.cwd(), prefix + rel);
    if (existsSync(p)) return readFileSync(p, "utf-8");
  }
  throw new Error(`找不到 ${rel}（cwd=${process.cwd()}）`);
}

const css = readRepoFile("src/style.css");
const html = readRepoFile("index.html");
const rust = readRepoFile("src-tauri/src/settings.rs");

/** 去掉注释后再匹配，避免注释里的旧值/示例干扰（与 styleTokens.test.ts 同款） */
const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** 字体栈归一化：只去多余空白，不动引号——引号是栈语义的一部分 */
function norm(stack: string): string {
  return stack.replace(/\s+/g, " ").trim();
}

/** Rust 字符串字面量 → JS 字符串（只需处理 \" 与 \\，足够覆盖 font_family） */
function unescapeRust(lit: string): string {
  return lit.replace(/\\(["\\])/g, "$1");
}

function cssVar(name: string): string {
  const m = new RegExp(`--${name}\\s*:\\s*([^;]+);`).exec(bare);
  if (!m) throw new Error(`style.css 里找不到 --${name}`);
  return norm(m[1]);
}

/** Rust Default 里的 font_family 字面量 */
function rustDefaultFontFamily(): string {
  const m = /font_family:\s*"((?:[^"\\]|\\.)*)"\.into\(\)/.exec(rust);
  if (!m) throw new Error("settings.rs 里找不到 Default 的 font_family");
  return norm(unescapeRust(m[1]));
}

/** index.html 字体族 preset 的「默认」选项 value */
function presetDefaultValue(): string {
  const block = /<select[^>]*id="settings-font-family-preset"[\s\S]*?<\/select>/.exec(html);
  if (!block) throw new Error("index.html 里找不到 #settings-font-family-preset");
  const opt = /<option[^>]*fontFamilyPreset\.default[^>]*value='([^']*)'/.exec(block[0]);
  if (!opt) throw new Error("字体族 preset 里找不到默认项（fontFamilyPreset.default）");
  return norm(opt[1]);
}

interface Face {
  family: string;
  style: string;
  weight: string;
  url: string;
}

function parseFaces(): Face[] {
  const out: Face[] = [];
  const re = /@font-face\s*\{([^}]*)\}/g;
  for (let m = re.exec(bare); m; m = re.exec(bare)) {
    const body = m[1];
    const pick = (re2: RegExp): string => re2.exec(body)?.[1]?.trim() ?? "";
    out.push({
      family: pick(/font-family:\s*([^;]+);/),
      style: pick(/font-style:\s*([^;]+);/),
      weight: pick(/font-weight:\s*([^;]+);/),
      url: pick(/src:\s*url\(\s*["']?([^"')]+)["']?\s*\)/),
    });
  }
  return out;
}

const faces = parseFaces();

describe("等宽字体四方一致 · 出厂栈", () => {
  it("state.ts / settings.rs / style.css --mono / index.html preset 四处字面完全相同", () => {
    const expected = norm(DEFAULT_FONT_FAMILY);
    expect(cssVar("mono"), "style.css --mono").toBe(expected);
    expect(rustDefaultFontFamily(), "settings.rs Settings::default").toBe(expected);
    expect(presetDefaultValue(), "index.html 字体族 preset 首选项").toBe(expected);
  });

  it("栈首项必须是随包的 JetBrains Mono（排在前面才有意义——Consolas 只是兜底）", () => {
    expect(norm(DEFAULT_FONT_FAMILY).startsWith('"JetBrains Mono"')).toBe(true);
    // 旧栈把 Consolas 排第一，正是批 3 要纠正的取值
    expect(LEGACY_FONT_FAMILY.startsWith("Consolas")).toBe(true);
    expect(LEGACY_FONT_FAMILY).not.toBe(DEFAULT_FONT_FAMILY);
  });

  it("连字出厂默认开，且前后端一致（settings.json 缺字段时回落到 Rust Default）", () => {
    expect(DEFAULT_SETTINGS.font_ligatures).toBe(true);
    expect(/font_ligatures:\s*true/.test(rust), "settings.rs Default 应为 true").toBe(true);
  });

  it("style.css 不得再出现以 Consolas 开头的裸栈（旧出厂串残留 = 某处漏改）", () => {
    expect(bare).not.toMatch(/font-family:\s*Consolas/);
    expect(bare).not.toContain('Consolas, "Cascadia Code", "JetBrains Mono"');
  });

  it("body 走 --font-ui token 而非裸栈（FOUC 块之外的第二处 UI 字体真源）", () => {
    const bodyBlock = /(?:^|\n)\s*(?:html,\s*)?body\s*\{([^}]*)\}/.exec(bare);
    expect(bodyBlock, "style.css 应有 body 规则").not.toBeNull();
    expect(bodyBlock![1]).toContain("font-family: var(--font-ui)");
  });
});

describe("等宽字体四方一致 · @font-face 与随包文件", () => {
  it("必须恰好 4 条 face，且全部声明 JetBrains Mono", () => {
    // latin 400 normal / latin 400 italic / latin 700 normal / latin-ext 400 normal
    expect(faces).toHaveLength(4);
    for (const f of faces) expect(f.family).toBe('"JetBrains Mono"');
  });

  it("字体家族名必须与出厂栈首项同名（family 名对不上，@font-face 永远不会被命中）", () => {
    const first = norm(DEFAULT_FONT_FAMILY).split(",")[0].replace(/["']/g, "");
    for (const f of faces) expect(f.family.replace(/["']/g, "")).toBe(first);
  });

  it("字重 / 斜体覆盖：Monaco 的注释用 italic、部分 token 用 bold，缺一就退到合成字形", () => {
    const has = (style: string, weight: string): boolean =>
      faces.some((f) => f.style === style && f.weight === weight);
    expect(has("normal", "400"), "正文体").toBe(true);
    expect(has("italic", "400"), "真斜体（Monaco 默认注释是 italic）").toBe(true);
    expect(has("normal", "700"), "真粗体（合成粗体在等宽字体上几乎不可读）").toBe(true);
  });

  it("每条 face 引用的 woff2 都必须真实存在于 public/fonts/（静默 404 → 回落 Consolas）", () => {
    for (const f of faces) {
      expect(f.url, "src 必须是 /fonts/ 下的绝对路径（dev/prod 同为 'self'，CSP 无需放开）")
        .toMatch(/^\/fonts\/[\w-]+\.woff2$/);
      const p = resolve(process.cwd(), `public${f.url}`);
      const p2 = resolve(process.cwd(), `shell/public${f.url}`);
      expect(existsSync(p) || existsSync(p2), `缺少字体文件 ${f.url}`).toBe(true);
    }
  });

  it("OFL 许可证必须随包（JetBrains Mono 是 SIL OFL 1.1，随包分发有硬性义务）", () => {
    const p = [resolve(process.cwd(), "public/fonts/OFL.txt"), resolve(process.cwd(), "shell/public/fonts/OFL.txt")];
    const hit = p.find((x) => existsSync(x));
    expect(hit, "public/fonts/OFL.txt 缺失").toBeTruthy();
    expect(readFileSync(hit!, "utf-8")).toContain("SIL OPEN FONT LICENSE");
  });
});

describe("等宽字体四方一致 · 存量设置迁移", () => {
  const base = () => ({ font_family: LEGACY_FONT_FAMILY });

  it("等于旧出厂串 → 替换为新栈（不迁移的话随包字体对老用户 100% 无效）", () => {
    expect(migrateLegacyFontSettings(base()).font_family).toBe(DEFAULT_FONT_FAMILY);
  });

  it("用户自定义过的一律保留、绝不覆盖", () => {
    for (const custom of ['"Fira Code"', "Consolas", '"Cascadia Code"', "monospace", '"MyFont", monospace']) {
      expect(migrateLegacyFontSettings({ font_family: custom }).font_family).toBe(custom);
    }
  });

  it("空串（= Monaco 内置默认）保持空串", () => {
    expect(migrateLegacyFontSettings({ font_family: "" }).font_family).toBe("");
  });

  it("幂等：已是新栈再跑一次不变（每次启动都会跑）", () => {
    const once = migrateLegacyFontSettings(base());
    expect(migrateLegacyFontSettings(once).font_family).toBe(DEFAULT_FONT_FAMILY);
  });

  it("只碰 font_family，不动其他字段", () => {
    const s = { font_family: LEGACY_FONT_FAMILY, font_size: 18, theme: EDITOR_THEME_LIGHT };
    const out = migrateLegacyFontSettings(s);
    expect(out.font_size).toBe(18);
    expect(out.theme).toBe(EDITOR_THEME_LIGHT);
  });
});
