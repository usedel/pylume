/**
 * 真机 CDP 验收 · UI 主题（ui_premium 批 1–5c + 修记 A 收口）
 *
 * ## 为什么浏览器层 e2e 已全绿还要跑真机
 *
 * 批 1–5c 的产物几乎全是 CSS 变量与自定义属性，浏览器层 e2e（Chromium fresh profile）能覆盖
 * 绝大多数 computed style 断言。真机层补的是**浏览器层原理上测不到**的四类：
 *   ① WebView2 与 Chromium 的渲染差异——`:focus-visible` 匹配时机、outline 在
 *      forced-colors 下的绘制，都与宿主相关；
 *   ② devicePixelRatio——125%/150% 系统缩放下圆角与 1px alpha 边框的呈现；
 *   ③ 真实数据根 + 真实 settings.json——浏览器层用 mock 预置，本轮走完整
 *      「打开设置 → 切色卡 → 保存」用户路径；
 *   ④ 随包字体的真实可达性——`public/fonts/` 走 vite 托管（打包链路另测）。
 *
 * ## 修记 A 为什么必须在真机补（§ E2 / R-FIXA-*）
 *
 * 滚动条变红那次（`ui_premium_dev_plan.md` §7.9）的真机验收停在 `ae62b73`，**早于**修记 A
 * 的提交 `e2107df`，且脚本里从头到尾没有滚动条 / 滑块 / 浮层边框的断言——即修记 A 修的三类
 * （滑块纯红、缩略图滑块派生红、三条浮层红边框）与顺带的 `verticalScrollbarSize 14→10px`
 * 在真机层既没跑过也没断言。浏览器层有 T-B4-7~10 覆盖，真机层补的是它测不到的两点：
 *   ⑤ WebView2 下 Monaco 注入样式表的**实际序列化形式**（读 `cssRules`，不是 DOM 快照）；
 *   ⑥ 125% 系统缩放（dpr 1.25）下滑块底色与滚动条宽度的真实呈现。
 *
 * 用法：
 *   node e2e-real/ui-real.cjs                      # 完整验收（自起 tauri dev，结束清理）
 *   OC_KEEP_APP=1 node e2e-real/ui-real.cjs        # 保留窗口人工复核
 *   OC_CDP_TIMEOUT=900 node e2e-real/ui-real.cjs   # 首次 cargo 编译慢时调大
 *
 * ## 首跑踩到的两个真机独有陷阱（浏览器层原理上测不到）
 *
 * ① **Monaco 会吞掉 Tab**。编辑器聚焦时按 Tab 不移出焦点，`document.activeElement`
 *    永远是隐藏的 `TEXTAREA.inputarea`。故任何「Tab 遍历 → 找焦点元素」的断言都必须在
 *    **点过编辑器之后**先 `blur()`，否则读 60 次都是同一个 textarea。
 *    浏览器层的 `editor/12-motion-focus.spec.ts` 没踩到纯粹因为它没点过编辑器——
 *    这类「测试通过但理由不成立」的偶然，必须在真机层复核一遍才算数。
 *
 * ② **只声明单边 border 的元素，读另一边的 border-color 会拿到 currentColor**。
 *    `#sidebar` 只写 `border-left`，读它的 `borderTopColor` 得到的是
 *    `rgb(212,212,212)` = `--fg`，看起来像「边框是实色灰」，实则 border-color 的
 *    initial 值就是 currentColor。验「边框色是否 alpha」必须挑**四边都设了 border** 的元素。
 */
'use strict';

const { writeFileSync, mkdirSync, readFileSync } = require('fs');
const path = require('path');
const { runWithRealApp, record, sleep, dismissBlockingModals } = require('./lib/real-env.cjs');

// 覆盖 7 类 token：变量名 / 字符串 / 数字 / 关键字 / 布尔 / 空 / f-string
const SRC = [
  'MAX = 42',
  'ok = True',
  'nothing = None',
  '',
  'def greet(name):',
  '    """doc"""',
  "    print(f'hi {name}')",
].join('\n');

/** 修记 A 的滑块断言需要**内容溢出**的文件：9 行的 main.py 下滚动条是 0×0 隐藏态 → 假阴性 */
const LONG_SRC = Array.from({ length: 300 }, (_, i) => `VALUE_${i} = ${i}  # 行 ${i}`).join('\n');

/** CSS 颜色归一化比较：浏览器 getPropertyValue 返回**声明值**，`0.10` 不会规范化成 `0.1` */
function colorEq(actual, expected) {
  if (actual == null) return false;
  const grab = (s) => {
    const m = String(s).match(/rgba?\(([^)]+)\)/);
    if (!m) return String(s).trim().toLowerCase();
    return JSON.stringify(
      m[1].split(',').map((x) => {
        const t = x.trim();
        return t.includes('.') ? parseFloat(t) : t;
      }),
    );
  };
  return grab(actual) === grab(expected);
}

// ── 修记 A · 工具 ────────────────────────────────────────────────────
// Monaco 主题服务的色值**唯一通路**是「把色值写成 `--vscode-<槽位>` 的 CSS 变量」。
// 修记 A 的红滚动条只发生在这条通路上（解析失败静默回落 Color.red），所以要读**注入结果**。

/** `--vscode-<槽位>`：`editor.background` → `--vscode-editor-background` */
function slotVarName(slot) {
  return `--vscode-${slot.replace(/\./g, '-')}`;
}

/** 从 `src/theme/tokens.ts` 的 COLOR_SLOTS 解析槽位名单——硬编码会随映射表扩展而过期。
 *  解析失败（文件挪位 / 写法变更）返回空数组，由调用方兜底为内建名单并如实记录。 */
function monacoSlotNames() {
  try {
    const text = readFileSync(path.join(__dirname, '..', 'src', 'theme', 'tokens.ts'), 'utf8');
    const block = text.match(/const COLOR_SLOTS[^=]*=\s*\{([\s\S]*?)\n\};/);
    if (!block) return [];
    // 键有两种写法：`"editor.background":` 与 `focusBorder:`（无引号）
    const re = /^\s*"?([A-Za-z][\w.]*)"?:\s*"/gm;
    const out = [];
    let m;
    while ((m = re.exec(block[1])) !== null) out.push(m[1]);
    return out;
  } catch {
    return [];
  }
}

/** 兜底名单（tokens.ts 解析不出时用）：修记 A 实测受害的 9 个槽位 */
const FALLBACK_SLOTS = [
  'scrollbarSlider.background', 'scrollbarSlider.hoverBackground', 'scrollbarSlider.activeBackground',
  'editorWidget.border', 'editorHoverWidget.border', 'editorSuggestWidget.border',
];

/** Monaco 注入的全部 `--vscode-*` 变量（读注入的 <style> 的 cssRules） */
function injectedThemeVars(page) {
  return page.evaluate(() => {
    const out = {};
    for (const sheet of Array.from(document.styleSheets)) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue; // 跨域样式表读不到；Monaco 注入的是同源 <style>，不受影响
      }
      for (const rule of Array.from(rules || [])) {
        const style = rule.style;
        if (!style) continue;
        for (const prop of Array.from(style)) {
          if (prop.startsWith('--vscode-')) out[prop] = style.getPropertyValue(prop).trim();
        }
      }
    }
    return out;
  });
}

/** 非法色 = 纯红。Monaco 的 `Color.fromHex` 解析失败时**静默**返回 `Color.red`。 */
function isRedValue(value) {
  return /^#ff0000$/i.test(value) || /^rgba\(\s*255\s*,\s*0\s*,\s*0\s*(,|\))/.test(value);
}

/** 拆 `rgb()` / `rgba()` → 通道（Monaco 注入的是这两种序列化形式） */
function parseRgb(value) {
  const m = String(value).match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (!m) return null;
  return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
}

const DARK = {
  surface2: '#1f1f24',
  selected: 'rgb(38, 67, 63)',      // #26433f
  lineHi: 'rgb(36, 36, 41)',        // --editor-line-highlight #242429
  syntaxVar: 'rgb(124, 227, 205)',  // #7ce3cd 青绿
  syntaxKw: 'rgb(197, 134, 192)',   // #c586c0 紫
  legacyVar: 'rgb(156, 220, 254)',  // 旧 #9cdcfe 浅蓝——必须不出现
  accent: '#2aa88f',
  borderSubtle: 'rgba(255, 255, 255, 0.10)',
};
const LIGHT = {
  surface2: '#ffffff',
  selected: 'rgb(211, 239, 235)',   // #d3efeb
  syntaxVar: 'rgb(14, 114, 97)',    // #0e7261
  legacyVar: 'rgb(0, 16, 128)',     // 旧 #001080 深蓝——必须不出现
  borderSubtle: 'rgba(0, 0, 0, 0.12)',
  focusGap: 'rgba(0, 0, 0, 0.14)',
};

runWithRealApp(
  {
    tmpPrefix: 'oc-ui-real-',
    logName: '.tauri-dev-ui-real.log',
    summaryTitle: '真机 CDP · UI 主题验收（批 1–5c + 修记 A）',
    setupFixtures({ workspace, dataRoot }) {
      mkdirSync(workspace, { recursive: true });
      writeFileSync(path.join(workspace, 'main.py'), SRC, 'utf8');
      // 修记 A 的滑块断言需要内容溢出的长文件（见 LONG_SRC 注释）
      writeFileSync(path.join(workspace, 'long.py'), LONG_SRC, 'utf8');
      // ⚠ 必须预置 recent-workspaces.json，否则启动后不会自动恢复到该工作区，
      // 文件树是空的 → 后续 `#tree .tree-item` 全部超时（首跑就踩了）。
      // 形态对齐 debug-real.cjs：数组元素是工作区绝对路径。
      writeFileSync(
        path.join(dataRoot, 'config', 'recent-workspaces.json'),
        JSON.stringify([workspace]),
        'utf8',
      );
      console.log(`[环境] 工作区: ${workspace}`);
    },
  },
  async (s) => {
    const { page } = s;
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(String(e)));
    await dismissBlockingModals(page);

    // 打开 main.py 并等 Monaco token 化完成（否则取不到语法色）
    await page.locator('#tree .tree-item .name', { hasText: 'main.py' }).first().dblclick();
    await page.locator('.monaco-editor').waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator(".monaco-editor .view-line span[class*='mtk']").first()
      .waitFor({ state: 'attached', timeout: 60_000 });

    // ⚠ 当前行高亮必须在**选区为空**时读：Monaco 的 _shouldRenderInContent 判
    // `selectionIsEmpty`，全选状态下根本不渲染 .current-line（初版先 Ctrl+A 再读 → null）。
    // 顺序：先读当前行 → 再全选读选区。
    const currentLine = await page.evaluate(() => {
      const el = document.querySelector('.monaco-editor .view-overlays .current-line');
      return el ? getComputedStyle(el).backgroundColor : null;
    });

    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+a');
    await sleep(400);

    // ── A. 真机环境 ─────────────────────────────────────────────
    const env = await page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      ua: navigator.userAgent,
      forced: matchMedia('(forced-colors: active)').matches,
    }));
    record('R-ENV-1', '真机 devicePixelRatio（系统缩放下圆角与 1px 边框的呈现）', true, `dpr=${env.dpr}`);
    record('R-ENV-2', '确认真机 WebView2 而非浏览器层 Chromium',
      /Chrome\/|Edg\//.test(env.ua), env.ua);
    record('R-ENV-3', 'forced-colors 未激活（本机未开高对比度，故 HCM 通道只能验 CSS 声明）',
      env.forced === false, `forced-colors=${env.forced}`);

    // ── B. 批 3 · 随包等宽字体 ─────────────────────────────────
    const fonts = await page.evaluate(() => {
      const faces = [];
      document.fonts.forEach((f) => {
        if (f.family.includes('JetBrains')) faces.push(`${f.family}/${f.weight}/${f.style}=${f.status}`);
      });
      const el = document.querySelector('.monaco-editor .view-lines');
      return {
        check: document.fonts.check('14px "JetBrains Mono"'),
        faces,
        monacoFont: el ? getComputedStyle(el).fontFamily : '',
      };
    });
    record('R-FONT-1', '随包 JetBrains Mono 已在真机加载（document.fonts.check）',
      fonts.check === true, `check=${fonts.check}`);
    record('R-FONT-2', 'Monaco 实际渲染该字体（.view-lines 的 computed font-family，不只 CSS 声明）',
      fonts.monacoFont.includes('JetBrains Mono'), fonts.monacoFont.slice(0, 56));
    record('R-FONT-3', '字体子集全部 status=loaded（4 个 woff2 无静默 404）',
      fonts.faces.length >= 4 && fonts.faces.every((f) => f.endsWith('loaded')),
      `${fonts.faces.length} 面：${fonts.faces[0] || '(无)'}`);

    // ── C. 批 4 · Monaco 自定义主题（深色）──────────────────────
    const dark = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : null;
      };
      const colors = new Set();
      for (const el of document.querySelectorAll(".monaco-editor .view-line span[class*='mtk']")) {
        colors.add(getComputedStyle(el).color.toLowerCase());
      }
      const cs = getComputedStyle(document.documentElement);
      const tok = (n) => cs.getPropertyValue(n).trim();
      return {
        editor: pick('.monaco-editor'),
        gutter: pick('.monaco-editor .margin'),
        selection: pick('.monaco-editor .selected-text'),
        colors: [...colors],
        surface2: tok('--surface-2'),
        accent: tok('--accent'),
        borderSubtle: tok('--border-subtle'),
        radiusSm: tok('--radius-sm'),
        radiusXs: tok('--radius-xs'),
        sidebarBorder: (() => {
          // ⚠ 两处坑，缺一都会读到假值：
          // ① 必须挑**四边都设了 border** 的元素：#sidebar 只声明 `border-left`，
          //    读它的 borderTopColor 会拿到 currentColor（= --fg #d4d4d4），
          //    看起来像「边框是实色灰」，实则是 border-color 的 initial 值。
          // ② 必须排除 `.btn--ghost`（`border-color: transparent`）：DOM 里第一个 `.btn`
          //    往往就是幽灵按钮（模态关闭钮），初版读到 `rgba(0,0,0,0)` 却因判据只查
          //    「以 rgba 开头」而通过 —— 全透明边框什么都没证明，是假阴性。
          const el = document.querySelector('.btn:not(.btn--ghost)') || document.querySelector('#tree-filter-input');
          if (!el) return null;
          const cs = getComputedStyle(el);
          return { prop: 'borderTopColor', value: cs.borderTopColor, all: cs.border };
        })(),
        filterRadius: (() => {
          const el = document.querySelector('#tree-filter-input');
          return el ? getComputedStyle(el).borderRadius : null;
        })(),
        closeRadius: (() => {
          const el = document.querySelector('.tab .close');
          return el ? getComputedStyle(el).borderRadius : null;
        })(),
      };
    });
    record('R-MONACO-1', '编辑器画布取 --surface-2（不再是出厂 vs-dark #1e1e1e）',
      dark.editor === 'rgb(31, 31, 36)', dark.editor);
    record('R-MONACO-2', 'gutter 与画布同档', dark.gutter === 'rgb(31, 31, 36)', dark.gutter);
    record('R-MONACO-3', '当前行高亮取 --editor-line-highlight #242429（选区为空时才渲染）',
      currentLine === DARK.lineHi, String(currentLine));
    record('R-MONACO-4', '选区是青绿染色（出厂 vs-dark 是蓝 #264f78）',
      dark.selection === DARK.selected, dark.selection);
    record('R-MONACO-5', 'identifier 语法色 = 青绿 #7ce3cd',
      dark.colors.includes(DARK.syntaxVar), `${dark.colors.length} 种 token 色`);
    record('R-MONACO-6', 'keyword = 紫 #c586c0', dark.colors.includes(DARK.syntaxKw), '');
    record('R-MONACO-7', '旧浅蓝 #9cdcfe 已消失（真机尤其要确认动态 python.js 正常加载）',
      !dark.colors.includes(DARK.legacyVar), '');

    // ── D. 批 1/2/5b · 表面阶梯 + 边框 alpha ────────────────────
    record('R-SURF-1', '--surface-2 深色 #1f1f24', colorEq(dark.surface2, DARK.surface2), dark.surface2);
    record('R-SURF-2', '--accent 青绿 #2aa88f（批 1 消除了出厂蓝）',
      colorEq(dark.accent, DARK.accent), dark.accent);
    record('R-BORDER-1', '--border-subtle = alpha 叠色（实色是批 5b 要消灭的对象）',
      colorEq(dark.borderSubtle, DARK.borderSubtle), dark.borderSubtle);
    // ⚠ 判据必须是「rgba 且 alpha 在 (0, 0.5]」：只查「以 rgba 开头」会让
    //   `rgba(0,0,0,0)`（幽灵按钮的 transparent）也通过，等于没验。
    const borderRgb = parseRgb(String(dark.sidebarBorder && dark.sidebarBorder.value));
    record('R-BORDER-2', '真实元素四边边框的 computed 是半透明 alpha（不是实色，也不是全透明）',
      borderRgb !== null && borderRgb.a > 0 && borderRgb.a <= 0.5,
      `${String(dark.sidebarBorder && dark.sidebarBorder.all).slice(0, 60)}`);

    // ── E. 批 5c · 圆角 ────────────────────────────────────────
    record('R-RADIUS-1', '--radius-sm 主档 6px', dark.radiusSm === '6px', dark.radiusSm);
    record('R-RADIUS-2', '真实输入框圆角 = 6px', dark.filterRadius === '6px', String(dark.filterRadius));
    record('R-RADIUS-3', '小元素（标签关闭钮 16px）走 xs 3px 而非主档（否则读成胶囊）',
      dark.closeRadius === '3px', `${String(dark.closeRadius)}（xs=${dark.radiusXs}）`);

    // ── E2. 修记 A · 滚动条 / 缩略图滑块 / 浮层边框（真机层此前未覆盖）────────
    const parsedSlots = monacoSlotNames();
    const slots = parsedSlots.length >= 6 ? parsedSlots : FALLBACK_SLOTS;
    // minimap 三个槽位不在映射表里，但出厂默认由 scrollbarSlider 派生（transparent(x,.5)），
    // 坏值会连坐 → 必须一并验。
    const targets = [
      ...slots,
      'minimapSlider.background',
      'minimapSlider.hoverBackground',
      'minimapSlider.activeBackground',
    ];
    const vars1 = await injectedThemeVars(page);
    const missing = targets.filter((n) => !vars1[slotVarName(n)]);
    const reds = targets.filter((n) => vars1[slotVarName(n)] && isRedValue(vars1[slotVarName(n)]))
      .map((n) => `${n} = ${vars1[slotVarName(n)]}`);

    record('R-FIXA-1', `注入变量可达（槽位表 ${slots.length} 项${parsedSlots.length ? '，由 tokens.ts 解析' : '，⚠ 解析失败用兜底名单'}）`,
      missing.length === 0 && Object.keys(vars1).length > 0,
      `注入 --vscode-* 共 ${Object.keys(vars1).length} 个；缺 ${missing.length} 项${missing.length ? '：' + missing.slice(0, 4).join(', ') : ''}`);
    // ⚠ 假阴性防线：上面那条先证伪「0 命中」，这条才敢断言「无一为红」
    record('R-FIXA-2', '我们映射的槽位 + minimap 派生槽位无一被 Monaco 判成非法色（静默回落 #ff0000）',
      reds.length === 0, reds.length ? reds.join('; ').slice(0, 160) : `${targets.length} 项全部非红`);

    const overlayBorders = ['editorWidget.border', 'editorHoverWidget.border', 'editorSuggestWidget.border'];
    const borders = overlayBorders.map((n) => ({ n, v: vars1[slotVarName(n)] }));
    record('R-FIXA-3', '三条浮层边框（补全框 / hover 框 / 通用 widget）不是红边（--border computed 是 rgba）',
      borders.every((b) => b.v && !isRedValue(b.v)),
      borders.map((b) => `${b.n.replace('editor', '').replace('Widget', '')}=${b.v || '(未注入)'}`).join(' · '));

    // 用户真正看到的那块像素：长文件 + 悬停滚动，等滑块高度 > 0 再读 computed
    await page.locator('#tree .tree-item .name', { hasText: 'long.py' }).first().dblclick();
    await page.locator('.monaco-editor .view-line').first().waitFor({ state: 'visible', timeout: 60_000 });
    await page.locator('.monaco-editor').first().hover();
    await page.mouse.wheel(0, 1200);
    const sliderBg = await page
      .waitForFunction(
        () => {
          const el = document.querySelector('.monaco-editor .scrollbar.vertical .slider');
          if (!el || el.getBoundingClientRect().height === 0) return null; // 仍是隐藏态
          return getComputedStyle(el).backgroundColor;
        },
        null,
        { timeout: 15_000 },
      )
      .then((h) => h.jsonValue())
      .catch(() => null);
    const sb = sliderBg ? parseRgb(sliderBg) : null;
    const spread = sb ? Math.max(sb.r, sb.g, sb.b) - Math.min(sb.r, sb.g, sb.b) : -1;
    record('R-FIXA-4', '滑块 computed 底色是无彩色 + 低 alpha（不是纯红；红色在 IDE 里语义是「错误」）',
      sb !== null && spread <= 2 && sb.a <= 0.5,
      sb ? `${sliderBg}（通道跨度 ${spread}，alpha ${sb.a}）` : `未取到可见滑块：${String(sliderBg)}`);

    const sbWidth = await page.evaluate(() => {
      const el = document.querySelector('.monaco-editor .scrollbar.vertical');
      return el ? el.getBoundingClientRect().width : null;
    });
    record('R-FIXA-5', '垂直滚动条容器 10px（出厂 14px 比外壳 8px 明显粗；量容器不依赖滑块显形时序）',
      sbWidth === 10, `width=${sbWidth}（dpr=${env.dpr}）`);

    // 回到 main.py：后续浅色段要读 7 类 token 的语法色
    await page.locator('#tree .tree-item .name', { hasText: 'main.py' }).first().dblclick();
    await page.locator(".monaco-editor .view-line span[class*='mtk']").first()
      .waitFor({ state: 'attached', timeout: 60_000 });

    // ── F. 批 5a · 焦点环双环（真机 WebView2 的 :focus-visible）──
    // ⚠ 真机诊断（首跑 60 次 Tab 全部停在 `TEXTAREA.inputarea monaco-mouse-cursor-text`）：
    //   **Monaco 会吞掉 Tab** —— 编辑器聚焦时 Tab 不移出焦点，困在隐藏输入区里。
    //   浏览器层 e2e（editor/12）没踩到是因为它没点过编辑器，焦点还在 body。
    //   故必须先把焦点移出 Monaco 再遍历，否则读到的永远是那个 textarea。
    await page.evaluate(() => {
      const el = document.activeElement;
      if (el && el instanceof HTMLElement && typeof el.blur === 'function') el.blur();
    });
    await sleep(250);

    const stops = [];
    let ring = null;
    for (let i = 0; i < 60; i++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => {
        const el = document.activeElement;
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          tag: el.tagName,
          cls: (el.className || '').toString().slice(0, 40),
          box: cs.boxShadow,
          oc: cs.outlineColor,
          ow: cs.outlineWidth,
        };
      });
      if (info) {
        stops.push(`${info.tag}.${info.cls}${info.box.includes('42, 168, 143') ? '★' : ''}`);
        if (info.box.includes('42, 168, 143') && !ring) ring = info;
      }
      if (ring) break;
    }
    const ringLayers = ring ? ring.box.split(/,(?![^(]*\))/).filter((x) => x.includes('rgb')).length : 0;
    const trace = stops.slice(0, 8).join(' → ');
    record('R-FOCUS-1', '真机 Tab 触发 :focus-visible 并拿到双环（外圈青绿 + 内圈隔离带）',
      ringLayers === 2,
      ring ? ring.box.slice(0, 88)
        : `60 次 Tab 未撞上（停靠点 ${stops.length} 个：${trace || '(activeElement 恒为空)'}）`);
    record('R-FOCUS-2', 'outline 保留且透明（HCM 强制高亮模式仍能绘制系统焦点框）',
      ring !== null && ring.ow !== '0px' && ring.oc === 'rgba(0, 0, 0, 0)',
      ring ? `${ring.ow} / ${ring.oc}` : `n/a（停靠点：${trace}）`);

    // ── G. 批 5a · reduce-motion 归零（真机计算值）──────────────
    await page.evaluate(() => document.documentElement.setAttribute('data-reduce-motion', ''));
    await sleep(250);
    const motion = await page.evaluate(() => {
      const el = document.querySelector('#sidebar');
      return {
        token: getComputedStyle(document.documentElement).getPropertyValue('--motion').trim(),
        dur: el ? getComputedStyle(el).transitionDuration : null,
      };
    });
    record('R-MOTION-1', '真机开启「减少动画」后过渡时长归零（calc(0.15s * 0) = 0s）',
      motion.token === '0' && motion.dur === '0s', `--motion=${motion.token} duration=${motion.dur}`);
    await page.evaluate(() => document.documentElement.removeAttribute('data-reduce-motion'));

    // ── H. 浅色主题（走真实用户路径：设置 → 色卡 → 保存）───────
    await page.locator('#btn-settings').click();
    await page.locator('#settings-modal').waitFor({ state: 'visible', timeout: 15_000 });
    await page.locator('.settings-nav-item[data-cat="appearance"]').click();
    await page.locator('.theme-swatch[data-theme="pylume-light"]').click();
    await page.locator('#settings-save').click();
    await page.locator('#settings-modal').waitFor({ state: 'hidden', timeout: 20_000 });
    await sleep(1500); // 等 applyEditorTheme 重注册 + setTheme 落地

    // 切主题会重建视图行，需重做选区
    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+a');
    await sleep(400);

    const light = await page.evaluate(() => {
      const pick = (sel) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : null;
      };
      const colors = new Set();
      for (const el of document.querySelectorAll(".monaco-editor .view-line span[class*='mtk']")) {
        colors.add(getComputedStyle(el).color.toLowerCase());
      }
      const cs = getComputedStyle(document.documentElement);
      const tok = (n) => cs.getPropertyValue(n).trim();
      return {
        theme: document.documentElement.dataset.theme,
        editor: pick('.monaco-editor'),
        selection: pick('.monaco-editor .selected-text'),
        colors: [...colors],
        borderSubtle: tok('--border-subtle'),
        focusGap: tok('--focus-gap'),
        surface2: tok('--surface-2'),
      };
    });
    record('R-LIGHT-1', '外壳切到 light（走设置面板色卡 → 保存的完整用户路径）',
      light.theme === 'light', `data-theme=${light.theme}`);
    record('R-LIGHT-2', 'Monaco 画布随浅色（自定义主题与外壳成对切换，不是「外壳浅 / 编辑器深」）',
      light.editor === 'rgb(255, 255, 255)', light.editor);
    record('R-LIGHT-3', '选区取浅色覆盖层的青绿染色 #d3efeb',
      light.selection === LIGHT.selected, light.selection);
    record('R-LIGHT-4', 'identifier 语法色 = 浅色青绿 #0e7261',
      light.colors.includes(LIGHT.syntaxVar), '');
    record('R-LIGHT-5', '旧深蓝 #001080 已消失', !light.colors.includes(LIGHT.legacyVar), '');
    record('R-LIGHT-6', '--border-subtle 浅色值 = rgba(0,0,0,.12)',
      colorEq(light.borderSubtle, LIGHT.borderSubtle), light.borderSubtle);
    record('R-LIGHT-7', '--focus-gap 浅色值 = 淡影 rgba(0,0,0,.14)（不是深色侧的暗环）',
      colorEq(light.focusGap, LIGHT.focusGap), light.focusGap);
    record('R-LIGHT-8', '浅色覆盖层重定义 --surface-2（两套主题各有真值，不靠继承）',
      colorEq(light.surface2, LIGHT.surface2), light.surface2);

    // 切主题会**重新注册** Monaco 主题（色值是注册那一刻从 CSS 读的快照），故浅色侧必须重验一遍
    const vars2 = await injectedThemeVars(page);
    const lightReds = targets
      .filter((n) => vars2[slotVarName(n)] && isRedValue(vars2[slotVarName(n)]))
      .map((n) => `${n} = ${vars2[slotVarName(n)]}`);
    const thumb2 = vars2['--vscode-scrollbarSlider-background'];
    const thumbRgb = thumb2 ? parseRgb(thumb2) : null;
    record('R-LIGHT-9', '切浅色后重新注册的槽位同样无一为红（修记 A 与主题无关，两套都要验）',
      lightReds.length === 0 && Object.keys(vars2).length > 0,
      lightReds.length ? lightReds.join('; ').slice(0, 160) : `scrollbarSlider=${thumb2}`);
    record('R-LIGHT-10', '浅色滚动条滑块是中性灰黑（--scrollbar-thumb 黑 18%，不是彩色）',
      thumbRgb !== null && Math.max(thumbRgb.r, thumbRgb.g, thumbRgb.b) - Math.min(thumbRgb.r, thumbRgb.g, thumbRgb.b) <= 2,
      `scrollbarSlider.background=${thumb2}`);

    // ── I. 收尾 ─────────────────────────────────────────────────
    record('R-END-1', '全程无未捕获页面异常', pageErrors.length === 0,
      pageErrors.length ? pageErrors.slice(0, 3).join(' | ').slice(0, 160) : '');
  },
);
