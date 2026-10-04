// 三方一致门禁：shell/src/style.css ↔ index.html FOUC 块 ↔ [data-theme="light"] 覆盖层。
//
// 为什么需要它（ui_premium_dev_plan §4 门禁 5）：这三处是**静默 diverge** 的高发区——
// 改了任何一处另两处都不会报错、不会红、测试全绿，只是「慢慢地与新调色板脱节」。
// 项目里已经吃过一次同类亏：Monaco Python 高亮因 Vite 预打包 chunk hash 漂移而 404，
// 症状是「只有 py 没高亮、无其它报错」，最终靠用户看终端日志才定位。
//
// 三方各自的职责：
//   1. style.css :root        —— 深色真源
//   2. style.css light 覆盖层  —— 浅色真源（**故意与深色不同**，不是复制）
//   3. index.html FOUC 内联块  —— 首帧兜底，字面值，必须与 ① 逐项对齐
//
// 批 4 会引入第四方（Monaco 主题 theme/tokens.ts），本文件届时扩为四方。
// 断言全部读源码文本，不依赖浏览器生效——纯 Node 环境即可跑。
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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

/** 去掉注释后再做块解析，避免注释里的 token 名/旧色值干扰 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}
const bare = stripComments(css);

/** 抽 :root / [data-theme="light"] 的声明表（同款多块合并） */
function decls(selector: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = new RegExp(selector.replace(/[[\]]/g, "\\$&") + "\\s*\\{", "g");
  for (let m = re.exec(bare); m; m = re.exec(bare)) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < bare.length && depth > 0; i++) {
      if (bare[i] === "{") depth++;
      else if (bare[i] === "}") depth--;
    }
    for (const chunk of bare.slice(m.index + m[0].length, i - 1).split(";")) {
      const c = chunk.indexOf(":");
      if (c < 0) continue;
      const name = chunk.slice(0, c).trim();
      if (name.startsWith("--")) out.set(name, chunk.slice(c + 1).trim());
    }
  }
  return out;
}

const root = decls(":root");
const light = decls('[data-theme="light"]');

/** 顺着 var() 链解析到字面量（只看单层链，够用且不引 CSS 解析器）。
 *  scope 缺该 token 时回退 :root——浅色覆盖层通常只写「要改的那几个」。 */
function resolveVar(name: string, scope: Map<string, string> = root): string {
  let v = scope.get(name) ?? root.get(name);
  for (let i = 0; i < 8 && v && v.startsWith("var("); i++) {
    const inner = /^var\(\s*(--[a-z0-9-]+)\s*(?:,[^)]*)?\)$/.exec(v)?.[1];
    if (!inner) break;
    v = (scope.get(inner) ?? root.get(inner));
  }
  return (v ?? "").trim();
}

/** #rrggbb → [r,g,b] 0-255 */
function parseHex(value: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) throw new Error(`不是字面量色值：${value}`);
  const h = m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const hex = (v: string): string => v.toLowerCase();

/** WCAG 相对亮度（与 tools/ui/audit_tokens.py 同公式） */
function luminance(value: string): number {
  const [r8, g8, b8] = parseHex(value);
  const ch = (v8: number): number => {
    const s = v8 / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * ch(r8) + 0.7152 * ch(g8) + 0.0722 * ch(b8);
}

/** WCAG 相对亮度对比度 */
function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)];
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe("token 三方一致 · style.css 深色真源", () => {
  it(":root 必须定义表面五档阶梯（批 2a 的地基）", () => {
    for (let i = 0; i < 5; i++) expect(root.has(`--surface-${i}`)).toBe(true);
  });

  it("语义别名必须指向阶梯，不得再出现裸色值", () => {
    for (const name of ["--bg", "--bg-chrome", "--bg-panel", "--bg-alt"]) {
      expect(root.get(name), `${name} 应为 var(--surface-*) 别名`).toMatch(/^var\(--surface-\d\)$/);
    }
  });

  it("brand 阶梯是单一色相（五个档都落在青绿轴上）", () => {
    // 断言用「G 最高且 G/B ≤ 1.6」表达青绿轴；精确色相差门禁在 tools/ui/audit_tokens.py（ΔE ≤ 15°）
    for (const name of ["--brand-1", "--brand-2", "--brand-3", "--brand-4", "--brand-5"]) {
      const [r, g, b] = parseHex(resolveVar(name));
      expect(g, `${name} 绿通道应最高`).toBeGreaterThan(r);
      expect(g, `${name} 绿通道应高于蓝通道（青绿轴）`).toBeGreaterThan(b);
      expect(g / b, `${name} 色相应贴近青绿（G/B ≤ 1.6）`).toBeLessThanOrEqual(1.6);
    }
  });

  it("--accent 三角色齐备且各司其职（ADR-0005）", () => {
    const accent = resolveVar("--accent");
    const emph = resolveVar("--accent-emphasis");
    const fill = resolveVar("--accent-fill");
    expect(accent).not.toBe(emph);   // ≤S3 面用 accent
    expect(fill).not.toBe(accent);   // 实心按钮底用 fill
    // emphasis 必须比 accent 亮（同一色相、更高对比的那一档）
    expect(luminance(emph)).toBeGreaterThan(luminance(accent));
    // 白字 on fill ≥ AA 4.5
    expect(contrast("#ffffff", fill), "白字 on --accent-fill").toBeGreaterThanOrEqual(4.5);
  });

  it("投影四档齐备且 --shadow 走 --elev-*（深色下双轨：投影 + 顶边高光）", () => {
    for (let i = 1; i <= 4; i++) {
      const v = resolveVar(`--elev-${i}`);
      expect(v, `--elev-${i} 应有定义`).toBeTruthy();
      // 深色侧必须带 inset 高光——那是「浮起来」的真正信号源
      expect(v, `--elev-${i} 深色侧应含 inset 顶边高光`).toMatch(/inset/);
    }
    expect(root.get("--shadow")).toMatch(/^var\(--elev-\d\)$/);
  });

  it("阶梯对比度按轴达标（画布轴 ≥1.15 是用户能感知的那一刀）", () => {
    const s = (i: number): string => resolveVar(`--surface-${i}`);
    expect(contrast(s(0), s(2)), "深色 S0↔S2 画布轴").toBeGreaterThanOrEqual(1.15);
    expect(contrast(s(2), s(3)), "深色 S2↔S3 组件轴").toBeGreaterThanOrEqual(1.12);
    expect(contrast(s(3), s(4)), "深色 S3↔S4 浮层轴").toBeGreaterThanOrEqual(1.12);
    // chrome 与面板底必须分离：#menubar / #sidebar 同色会让 chrome 层糊成一片
    expect(contrast(resolveVar("--bg-chrome"), resolveVar("--bg-panel"))).toBeGreaterThanOrEqual(1.05);
  });

  it("深色 --fg-dim 在四档表面上全部 ≥ AA（抬升面用 --fg-muted）", () => {
    for (let i = 0; i < 4; i++) {
      expect(contrast(resolveVar("--fg-dim"), resolveVar(`--surface-${i}`)), `S${i} 上的 --fg-dim`)
        .toBeGreaterThanOrEqual(4.5);
    }
    expect(root.has("--fg-muted"), "抬升面专用的 --fg-muted 应已定义").toBe(true);
    expect(contrast(resolveVar("--fg-muted"), resolveVar("--surface-3")), "--fg-muted on S3")
      .toBeGreaterThanOrEqual(4.5);
  });
});

describe("token 三方一致 · 浅色覆盖层", () => {
  it("浅色必须覆盖表面五档 + 三个语义别名（否则浅色会停在深色阶梯上）", () => {
    for (let i = 0; i < 5; i++) expect(light.has(`--surface-${i}`), `light 缺 --surface-${i}`).toBe(true);
    for (const name of ["--bg", "--bg-chrome", "--bg-panel", "--bg-alt"]) {
      expect(light.get(name), `light ${name} 应显式覆盖`).toMatch(/^var\(--surface-\d\)$/);
    }
  });

  it("浅色侧投影不得带 inset 高光（白底上无意义，反而显脏）", () => {
    for (let i = 1; i <= 4; i++) {
      expect(light.get(`--elev-${i}`), `light --elev-${i} 不该有 inset`).not.toMatch(/inset/);
    }
    expect(light.get("--shadow")).toMatch(/^var\(--elev-\d\)$/);
  });

  it("浅色 accent 族必须显式覆盖（ADR-0005 推翻了「accent 跨主题一致」这条旧裁决）", () => {
    for (const name of ["--accent", "--accent-fill", "--accent-emphasis", "--accent-soft", "--accent-faint"]) {
      expect(light.has(name), `light 缺 ${name}——青绿在白底需更深，不能继承深色值`).toBe(true);
    }
  });

  it("主题预览色卡 8 值必须钉死且不随当前主题变化（不进 light 覆盖层）", () => {
    for (let i = 1; i <= 4; i++) {
      expect(root.has(`--theme-pv-dark-bg`) || i === 1).toBe(true);
    }
    for (const name of ["--theme-pv-dark-bg", "--theme-pv-dark-side", "--theme-pv-dark-fg", "--theme-pv-dark-border",
      "--theme-pv-light-bg", "--theme-pv-light-side", "--theme-pv-light-fg", "--theme-pv-light-border"]) {
      expect(root.has(name), `缺 ${name}`).toBe(true);
      expect(light.has(name), `${name} 不该出现在 light 覆盖层（覆盖掉就失去预览意义）`).toBe(false);
    }
  });

  it("预览色卡值必须与两套主题的真实表面一致（改了阶梯要回来同步）", () => {
    expect(hex(resolveVar("--theme-pv-dark-bg", root))).toBe(hex(resolveVar("--bg")));
    expect(hex(resolveVar("--theme-pv-dark-side", root))).toBe(hex(resolveVar("--bg-panel")));
    // 色卡定义在 :root（不进 light 覆盖层），比对时用 light 作用域解析 --bg / --bg-panel
    expect(hex(resolveVar("--theme-pv-light-bg", root))).toBe(hex(resolveVar("--bg", light)));
    expect(hex(resolveVar("--theme-pv-light-side", root))).toBe(hex(resolveVar("--bg-panel", light)));
  });

  it("浅色 --fg-dim 在四档表面上全部 ≥ AA（杠杆 9 的收口）", () => {
    for (let i = 0; i < 4; i++) {
      expect(contrast(resolveVar("--fg-dim", light), resolveVar(`--surface-${i}`, light)), `L${i}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });

  it("浅色必须也定义 --fg-muted，且与 --fg-dim 同值（批 2b 的刻意偏离）", () => {
    // 方案 §5.2.1 的注原本说「浅色不需要 --fg-muted，省一个 token」——
    // 那条判断的前提是「浅色继续用 --fg-dim」。但批 2b 落地了**选择器级纪律**
    // 「抬升面上禁用 --fg-dim，一律 --fg-muted」，若浅色不定义该 token，
    // var(--fg-muted) 会 invalid at computed-value time → color 变 unset（继承父级），
    // 「次要文字」会变成「正文」，比不改更坏。故浅色显式给出同值定义。
    expect(light.has("--fg-muted"), "浅色缺 --fg-muted 会让 9 处抬升面文字 unset").toBe(true);
    expect(hex(resolveVar("--fg-muted", light))).toBe(hex(resolveVar("--fg-dim", light)));
    // 该 token 在浅色各面上同样达标（不能因为「同值」就假定达标）
    for (let i = 0; i < 4; i++) {
      expect(contrast(resolveVar("--fg-muted", light), resolveVar(`--surface-${i}`, light)), `L${i}`)
        .toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe("token 三方一致 · index.html FOUC 块", () => {
  /** FOUC 块必须用字面值（var() 在那时还不存在），逐项与 :root 对齐 */
  it("FOUC 的背景色必须等于 --bg 的解析值（漏改会闪一帧旧底色）", () => {
    const bg = /html,\s*body\s*\{[^}]*background:\s*(#[0-9a-fA-F]{3,8})/s.exec(html);
    expect(bg, "FOUC 块里应能找到 html, body 的 background 字面值").not.toBeNull();
    expect(hex(bg![1])).toBe(hex(resolveVar("--bg")));
  });

  it("FOUC 的文字色 / 字号 / 字体栈 / 浅色底色必须与 :root 对齐（共 6 项同步义务）", () => {
    const block = /html,\s*body\s*\{([\s\S]*?)\}/.exec(html)![1];
    const fg = /color:\s*(#[0-9a-fA-F]{3,8})/.exec(block)![1];
    expect(hex(fg)).toBe(hex(resolveVar("--fg")));
    expect(/font-size:\s*13px/.test(block)).toBe(true);
    // 浅色兜底两值
    const lightRule = /html\[data-theme="light"\][^{]*\{[\s\S]*?background:\s*(#[0-9a-fA-F]{3,8});[\s\S]*?color:\s*(#[0-9a-fA-F]{3,8})/.exec(html);
    expect(lightRule, "FOUC 块应含浅色主题兜底规则").not.toBeNull();
    expect(hex(lightRule![1])).toBe(hex(resolveVar("--bg", light)));
    expect(hex(lightRule![2])).toBe(hex(resolveVar("--fg", light)));
  });

  it("FOUC 同步义务注释必须列全 6 项（font-family 是第 6 项，批 3 改字体前已预登记）", () => {
    const note = /⚠[^<]*同步义务[^<]*/.exec(html)?.[0] ?? "";
    expect(note).toContain("font-family");
    for (const token of ["--bg", "--fg", "--text-base"]) {
      expect(note, `注释里应登记 ${token}`).toContain(token);
    }
  });
});

/* ══════════════════════ 批 5a · 动效曲线与焦点环（方案 §5.6 / §5.8） ══════════════════════ */

describe("批 5a · 动效曲线分级（方案 §5.6）", () => {
  it("三档曲线 token 齐备（dec / standard / accelerate）", () => {
    expect(resolveVar("--ease-out")).toBe("cubic-bezier(0.16, 1, 0.3, 1)");
    expect(resolveVar("--ease-in-out")).toBe("cubic-bezier(0.4, 0, 0.2, 1)");
    expect(resolveVar("--ease-in")).toBe("cubic-bezier(0.4, 0, 1, 1)");
  });

  it("四个时长档都内置 --motion 倍率（减少动画开关必须能整体归零）", () => {
    for (const t of ["--transition-fast", "--transition-base", "--transition-slow", "--transition-exit"]) {
      expect(root.get(t), `${t} 应在 :root 定义`).toBeDefined();
      expect(root.get(t), `${t} 必须内置 var(--motion)`).toContain("var(--motion)");
    }
  });

  it("入场走 decelerate、出场走 accelerate（曲线语义与用途绑定，不可对调）", () => {
    expect(root.get("--transition-fast")).toContain("var(--ease-out)");
    expect(root.get("--transition-base")).toContain("var(--ease-out)");
    expect(root.get("--transition-exit")).toContain("var(--ease-in)");
    // 结构性动画（面板/模态）是唯一放宽到 240ms 的一档
    expect(root.get("--transition-slow")).toContain("var(--ease-in-out)");
  });

  it("除白名单外，transition / animation 的时间函数全部走 --ease-*", () => {
    // 判定式同 audit_tokens.py 门禁 20：先剥 var(--ease-…) 再找裸关键字，否则会命中自身
    const offenders: string[] = [];
    for (const m of bare.matchAll(/(?<![-\w])(transition|animation)\s*:\s*([^;]+);/g)) {
      const probe = m[2].replace(/var\(--ease-[a-z-]+\)/g, "");
      if (/\b(ease-in-out|ease-out|ease-in|linear|cubic-bezier)\b/.test(probe)) {
        offenders.push(`${m[1]}: ${m[2].trim().slice(0, 50)}`);
      }
    }
    expect(offenders, `仍有裸缓动：${offenders.join(" | ")}`).toEqual([]);
  });

  it("进度条循环动画是唯一豁免 --motion 的动效，且双通道压制已就位", () => {
    // 不能靠「时长 × var(--motion)」压制：motion=0 → duration=0 → infinite 循环高频闪糊。
    // 故豁免它并要求 animation:none 双通道（系统 media + 应用内 html[data-reduce-motion]）。
    const spin = /\.rx-progress::after\s*\{([^}]*)\}/.exec(bare)?.[1] ?? "";
    expect(spin).toContain("rx-progress-slide");
    expect(spin).not.toContain("var(--motion)");
    expect(bare).toContain("html[data-reduce-motion] .rx-progress::after");
    expect(bare).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.rx-progress::after/);
  });
});

describe("批 5a · 焦点环双环（方案 §5.8）", () => {
  /** 取某个 focus-visible 规则块的声明体 */
  function ruleBody(selector: string): string {
    const i = bare.indexOf(selector);
    if (i < 0) throw new Error(`未找到规则 ${selector}`);
    const open = bare.indexOf("{", i);
    let depth = 0;
    for (let j = open; j < bare.length; j++) {
      if (bare[j] === "{") depth++;
      else if (bare[j] === "}") {
        depth--;
        if (depth === 0) return bare.slice(open + 1, j);
      }
    }
    throw new Error(`${selector} 块未闭合`);
  }

  it("--focus-gap 两套主题都有定义（深色用暗环、浅色用淡影）", () => {
    expect(resolveVar("--focus-gap")).toBeDefined();
    expect(light.get("--focus-gap"), "浅色必须覆盖 --focus-gap（否则 var() unset → 环失去隔离带）").toBeDefined();
  });

  it("外扩焦点环是 spread-only 双环，且 outline 写 transparent 而非 none", () => {
    // outline:none 会让 Windows 强制高亮模式（HCM）用户彻底失去焦点指示 —— 可访问性回归
    for (const sel of [".tree-item:focus-visible", ".tool-radio:focus-visible"]) {
      const body = ruleBody(sel);
      expect(body, `${sel} 应走双环`).toMatch(/box-shadow:[^;]*var\(--focus-gap\)[^;]*var\(--focus-ring\)/);
      expect(body, `${sel} 的 outline 必须是 transparent`).toMatch(/outline:\s*2px solid transparent/);
      expect(body, `${sel} 不得残留单环 outline`).not.toMatch(/outline:\s*\d+px solid var\(--focus-ring\)/);
    }
  });

  it("小尺寸内缩组保留 1px 内描边并显式关掉双环（box-shadow 不受 outline-offset 影响）", () => {
    const body = ruleBody(".tab .close:focus-visible");
    expect(body).toMatch(/outline:\s*1px solid var\(--focus-ring\)/);
    expect(body).toMatch(/outline-offset:\s*-1px/);
    expect(body, "必须显式 box-shadow:none，否则会被上方双环牵连").toMatch(/box-shadow:\s*none/);
  });

  it("双环与滚动条宽度都不再是裸值（材质细节走 token）", () => {
    expect(bare).toMatch(/::-webkit-scrollbar\s*\{\s*width:\s*8px/);
    expect(root.get("--radius-lg"), "滚动条圆角走圆角 token").toBeDefined();
  });
});

/* ══════════════════════ 批 5b · 边框三档 alpha（方案 §5.5） ══════════════════════ */

describe("批 5b · 边框 alpha 叠色", () => {
  it("三档在两套主题下都定义，且都是 alpha 叠色（实色是本批要消灭的对象）", () => {
    for (const scope of [root, light]) {
      for (const name of ["--border-hairline", "--border-subtle", "--border-strong"]) {
        const v = scope.get(name);
        expect(v, `${name} 必须两套主题都定义（缺一 → 引用它的规则颜色 unset 并继承父级）`).toBeDefined();
        expect(v, `${name} 必须是 rgba(…, a) 叠色，实得 ${v}`).toMatch(/^rgba\(/);
      }
    }
  });

  it("alpha 递增：hairline < subtle < strong（两套主题各自单调）", () => {
    const alphaOf = (v: string) => Number(/,\s*([\d.]+)\s*\)$/.exec(v)![1]);
    for (const scope of [root, light]) {
      const h = alphaOf(scope.get("--border-hairline")!);
      const s = alphaOf(scope.get("--border-subtle")!);
      const g = alphaOf(scope.get("--border-strong")!);
      expect(h, `hairline ${h} 应 < subtle ${s}`).toBeLessThan(s);
      expect(s, `subtle ${s} 应 < strong ${g}`).toBeLessThan(g);
    }
  });

  it("兼容别名指向正确档位（--border 150 处 + --border-soft 24 处，指错等于静默改 174 处）", () => {
    for (const scope of [root, light]) {
      expect(scope.get("--border")?.trim()).toBe("var(--border-subtle)");
      expect(scope.get("--border-soft")?.trim()).toBe("var(--border-hairline)");
    }
  });

  it("浮层容器边框走 hairline（投影已表达层级，边框退居辅助）", () => {
    // 方案 §5.5 配套：.ctx-menu / .oc-tooltip / .modal-card / .palette
    for (const sel of [".modal-card", ".ctx-menu", ".oc-tooltip", ".interp-popover"]) {
      // ⚠ 必须**行首**匹配：`.modal:not(.hidden) .modal-card { animation: … }` 这类**子选择器**
      //   的结尾也是 `.modal-card {`，用 indexOf(sel + " {") 会命中它并读到 animation 块。
      const i = bare.indexOf("\n" + sel + " {");
      expect(i, `未找到顶层规则 ${sel}`).toBeGreaterThan(-1);
      const body = bare.slice(i, bare.indexOf("}", i));
      expect(body, `${sel} 边框应为 hairline`).toMatch(/border:\s*1px solid var\(--border-hairline\)/);
      // 浮层必须同时有投影，否则「边框退居辅助」的前提不成立
      expect(body, `${sel} 应有 --elev-* 投影`).toMatch(/box-shadow:\s*var\(--elev-/);
    }
  });
});

/* ══════════════════════ 批 5c · 圆角档位（方案 §5.7） ══════════════════════ */

describe("批 5c · 圆角五档", () => {
  const RADIUS = ["--radius-xs", "--radius-sm", "--radius-md", "--radius-lg", "--radius-xl"];

  it("五档值即方案 §5.7 的裁决（3 / 6 / 8 / 10 / 16）", () => {
    expect(root.get("--radius-xs")).toBe("3px");
    expect(root.get("--radius-sm")).toBe("6px");
    expect(root.get("--radius-md")).toBe("8px");
    expect(root.get("--radius-lg")).toBe("10px");
    expect(root.get("--radius-xl")).toBe("16px");
  });

  it("档位严格递增，且必须是显式 px（相对单位会让「圆角占高度比例」的推理失效）", () => {
    const vals = RADIUS.map((n) => {
      const v = root.get(n)!;
      expect(v, `${n} 必须是显式 px`).toMatch(/^\d+px$/);
      return Number(/(\d+)px/.exec(v)![1]);
    });
    for (let i = 1; i < vals.length; i++) {
      expect(vals[i - 1], `${RADIUS[i - 1]}(${vals[i - 1]}px) 应 < ${RADIUS[i]}(${vals[i]}px)`).toBeLessThan(vals[i]);
    }
  });

  it("浮层容器圆角不得小于 md 档（浮层比控件更「软」；菜单/tooltip 用 md、模态用 lg）", () => {
    // 存量设计是分档的：.modal-card 用 lg（最大的容器），.ctx-menu / .oc-tooltip /
    // .interp-popover 用 md（菜单比模态小一档）。本批**不改**这个分配——它是合理的，
    // 断言只守住下界「不得回退到 sm/xs」，那才是「浮层看起来太硬」的回归。
    for (const sel of [".modal-card", ".ctx-menu", ".oc-tooltip", ".interp-popover"]) {
      const i = bare.indexOf("\n" + sel + " {");
      expect(i, `未找到顶层规则 ${sel}`).toBeGreaterThan(-1);
      const body = bare.slice(i, bare.indexOf("}", i));
      expect(body, `${sel} 圆角应为 md 或 lg 档`).toMatch(/border-radius:\s*var\(--radius-(md|lg)\)/);
    }
  });

  it("小尺寸元素（高度 ≤24px）一律 xs 档 —— 6px 圆角配 14px 高会读成胶囊", () => {
    // 方案 §5.7 只说「sm 是控件主档」，没说「主档要按元素尺寸校验」；
    // 这 15 处是批 5c 实测后归位的（门禁 audit_tokens.py 门禁 26 同步守住）。
    const SMALL = [
      ".tab .close", ".term-tab-close", ".term-tab-stop", ".env-pkg-line > button",
      ".git-section-title .scm-section-action", ".scm-item .scm-action", ".scm-item .scm-discard",
      ".clone-progress-bar", ".new-project-preview", ".lt-badge", ".surround-num",
      ".ew-recent-clear", ".ew-recent-remove", ".pkg-drift-tag", ".storage-badge",
    ];
    for (const sel of SMALL) {
      const i = bare.indexOf("\n" + sel + " {");
      expect(i, `未找到规则 ${sel}`).toBeGreaterThan(-1);
      const body = bare.slice(i, bare.indexOf("}", i));
      expect(body, `${sel} 应走 xs 档`).toMatch(/border-radius:\s*var\(--radius-xs\)/);
      expect(body, `${sel} 不应再用 sm 及以上`).not.toMatch(/border-radius:\s*var\(--radius-(sm|md|lg|xl)\)/);
    }
  });

  it("存量 7 处裸圆角已归档：5 处归 token，2 处光学值保留并登记", () => {
    // 归档：.debug-bp-dot-log(菱形指示点) / .out-chip-count(计数徽标) /
    //      #db-filter-input / #db-data-filter（硬编码旧 sm 值）/ .oc-rename-ghost
    for (const sel of [".debug-bp-dot-log", "#db-filter-input", "#db-data-filter", ".oc-rename-ghost"]) {
      const i = bare.indexOf("\n" + sel + " {");
      const body = bare.slice(i, bare.indexOf("}", i));
      expect(body, `${sel} 应走 token`).toMatch(/border-radius:\s*var\(--radius-/);
    }
    // 保留：2px 宽指示条与 2px 高进度条的半宽圆角（改成 3px 反而变半圆）
    for (const sel of [".activity-item.active::before", ".rx-progress"]) {
      expect(bare, `${sel} 的 1px 光学值应保留`).toMatch(
        new RegExp("\\n" + sel.replace(/[.[\]()]/g, "\\$&") + "\\s*\\{[^}]*border-radius:\\s*1px"),
      );
    }
  });

  it("Monaco 侧圆角缺口已登记（0.52 无 *.borderRadius 主题槽位，不做 CSS 覆盖）", () => {
    const tokensSrc = readRepoFile("src/theme/tokens.ts");
    expect(tokensSrc, "缺口必须写进 tokens.ts 注释，避免后人以为漏了").toContain("borderRadius");
    expect(tokensSrc).toContain("0.52");
  });
});
