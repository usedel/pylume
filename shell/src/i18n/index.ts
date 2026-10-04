// 国际化（i18n）运行时：语言包分发 + `t()` 取词 + DOM 批量套用 + 切换广播。
//
// 设计取舍（与本项目形态对齐，改动前请先读）：
// 1. **语言包扁平 key**（`menubar.file`）而非嵌套对象：`search.searchScope` 这类"既是叶子又是分支"
//    的 key 在嵌套结构里无法表达（一个字段不能同时是 string 和 object），扁平化从根上避开冲突；
//    同时让「词条集合对比」「漏译检查」退化为简单的 key 集合运算。
// 2. **zh-CN 是唯一真源**：`TKey` 由 `keyof typeof zhCN` 派生，en-US 声明为 `Record<TKey, string>`，
//    于是「漏译 / 多译 / 拼错 key」全部在 `tsc` 阶段炸掉，不依赖运行时兜底。
//    语言包按**功能域**分文件（`locales/<id>/{core,git,…}.ts` + `index.ts` 聚合）：全量抽取后
//    词条量在数千级，单文件无法维护；每个域文件的 en 侧各自对自己的域 Key 做 Record 约束。
// 3. **默认语言 = zh-CN**：本项目 `__tests__` 里有大量以中文文案做断言的用例（菜单、设置、toast…），
//    默认语言保持中文 = 存量断言零改动即可继续绿；英文由用户主动切换触发。这是本次改造
//    「不破坏既有测试」的前提，改默认值前必须先改测试断言。
// 4. **切换语言 ≠ 重渲染全部**：静态骨架由 `applyDomI18n()` 就地改写属性；动态内容（菜单项、文件树、
//    面板）由各域模块订阅 `onLocaleChange` 自行重绘——运行时不持有任何模块的渲染句柄，避免反向依赖。
// 5. **复数走 Intl，不走调用点**：带 `count` 的文案在语言包里提供 `<key>.one` / `<key>.other`，
//    由 `Intl.PluralRules` 选形。单复数规则是语言属性，写进业务代码就等于把英文语法钉死在调用点。
//
// 存储：`localStorage`（与 anim.ts 的「减少动画」、layout.ts 的布局尺寸同策略），不走 `Settings`
// ——语言是「本机的壳偏好」，与工作区无关，进 settings.json 会牵动 Rust `Settings` 结构的三处同步义务。

import { enUS } from "./locales/en-US";
import { zhCN, type TKey } from "./locales/zh-CN";

/** 支持的语言（新增语言：在此并入 + 补 `locales/<id>.ts` + 在 `PACKS` 登记） */
export type Locale = "zh-CN" | "en-US";

export const DEFAULT_LOCALE: Locale = "zh-CN";

/** 语言选择器的候选项（label 用各语言自称，不翻译——语言列表惯例） */
export const LOCALE_OPTIONS: { id: Locale; label: string }[] = [
  { id: "zh-CN", label: "简体中文" },
  { id: "en-US", label: "English" },
];

const STORE_KEY = "pylume.locale";

/** 语言包表：`Record<string, string>` 是刻意的——en-US 已经用 `Record<TKey, string>` 在编译期
 *  保证了与 zh-CN 同构，运行时再按字面量类型索引只会徒增类型体操开销。 */
const PACKS: Record<Locale, Record<string, string>> = {
  "zh-CN": zhCN as Record<string, string>,
  "en-US": enUS as Record<string, string>,
};

/** data-i18n* 属性 → 写入目标：`null` 表示写 textContent，其余为同名属性。
 *  与 HTML 约定一一对应（改这里必须同步 index.html 的标记用法）：
 *  `data-i18n` 文本 / `-tip` data-tip / `-aria` aria-label / `-ph` placeholder / `-title` title / `-alt` alt。 */
const DOM_ATTRS: [attr: string, target: string | null][] = [
  ["data-i18n", null],
  ["data-i18n-tip", "data-tip"],
  ["data-i18n-aria", "aria-label"],
  ["data-i18n-ph", "placeholder"],
  ["data-i18n-title", "title"],
  ["data-i18n-alt", "alt"],
];

let current: Locale | null = null;
const listeners = new Set<() => void>();

/** 读取持久化语言：localStorage 在 node 环境（部分单测）不存在，故整体包 try/catch。
 *  非法值（旧版本残留 / 手改）一律回落默认语言，不让坏值把 UI 变成一串 key。 */
function readStored(): Locale {
  try {
    const v = localStorage.getItem(STORE_KEY);
    if (v === "zh-CN" || v === "en-US") return v;
  } catch {
    /* 无 localStorage：用默认语言 */
  }
  return DEFAULT_LOCALE;
}

function persist(locale: Locale): void {
  try {
    localStorage.setItem(STORE_KEY, locale);
  } catch {
    /* 写不进也不影响本次会话的语言切换 */
  }
}

/**
 * 复数基键：语言包里只存 `xxx.one` / `xxx.other`，不存 `xxx`（存了就是永不被读取的死词条），
 * 但调用点写的是 `t("xxx", { count })`——故用模板字面量类型从 `.one` 反推出合法基键。
 * 这样既保持语言包干净，拼错 key 又依然在编译期被拦下。
 */
// 注意：必须经由泛型参数中转——直接写 `TKey extends ...` 时 TKey 是具体类型别名，
// 条件类型不分发，整个联合会被当成一个整体判否，结果是 never。
type PluralBaseOf<K> = K extends `${infer B}.one` ? B : never;
type PluralBase = PluralBaseOf<TKey>;

/** `t()` 接受的 key：普通词条 + 复数基键 */
export type TFuncKey = TKey | PluralBase;

/** 当前语言（惰性初始化：模块顶层不碰宿主环境，测试里 import 本模块不会因环境缺失而炸） */
export function getLocale(): Locale {
  if (!current) current = readStored();
  return current;
}

/** `{name}` 插值：只认单花括号占位，缺失的占位原样保留（便于发现漏传参数） */
function interpolate(text: string, params: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in params ? String(params[k]) : m));
}

/** PluralRules 按语言缓存：Intl 构造不算便宜，而语言只有两三种、切换极低频。 */
const RULES = new Map<Locale, Intl.PluralRules>();

function rulesFor(locale: Locale): Intl.PluralRules | null {
  const hit = RULES.get(locale);
  if (hit) return hit;
  try {
    const r = new Intl.PluralRules(locale);
    RULES.set(locale, r);
    return r;
  } catch {
    return null; // 宿主无完整 ICU：退回 other 形，不为此让整条提示挂掉
  }
}

/**
 * 复数选形：带 `count` 参数时，把 `key` 解析成 `<key>.one` / `<key>.other` 等变体。
 *
 * 为什么让 Intl 决定而不是在调用点写 `n === 1 ? … : …`：单复数规则是**语言属性**
 * （en-US 有 one/other；zh-CN 只有 other；将来接 ar 会有 six 种形式），写进业务代码
 * 等于把英文语法钉死在调用点，加一门语言要改遍所有调用点。
 * 中文侧因此也要提供 `.one`（内容通常与 `.other` 相同）——TKey 由中文派生，两侧 key 集合
 * 必须对称，否则英文的 `.one` 会变成编译期"多余属性"。
 *
 * 变体缺失时逐级回退：`<key>.<form>` → `<key>.other` → `<key>`。
 */
function pluralKey(key: TFuncKey, count: number): TKey {
  const form = rulesFor(getLocale())?.select(count) ?? "other";
  const pack = PACKS[getLocale()];
  const byForm = `${key}.${form}`;
  if (byForm in pack) return byForm as TKey;
  const other = `${key}.other`;
  return (other in pack ? other : key) as TKey;
}

/** 取词条：英文缺失回落中文，再缺回落 key 本身（宁可露 key 也不要空白 UI）。
 *  拼写错误的 key 由 `TKey` 类型在编译期拦下，运行时兜底只对付语言包尚未同步的中间态。
 *  传 `{ count }` 时走复数选形（见 pluralKey）。 */
export function t(key: TFuncKey, params?: Record<string, string | number>): string {
  const k = params && typeof params.count === "number" ? pluralKey(key, params.count) : (key as TKey);
  const raw = PACKS[getLocale()][k] ?? zhCN[k] ?? key;
  return params ? interpolate(raw, params) : raw;
}

/** 写文本：优先替换**直接子文本节点**，避免把按钮里的 `<i class="codicon">` 图标一并抹掉；
 *  没有文本子节点时（如空 span 占位）才整体设 textContent。 */
function setText(el: Element, text: string): void {
  for (const n of Array.from(el.childNodes)) {
    if (n.nodeType === Node.TEXT_NODE && n.textContent && n.textContent.trim()) {
      n.textContent = text;
      return;
    }
  }
  el.textContent = text;
}

/** 把语言包套用到 DOM：扫描 `data-i18n*` 标记就地改写。
 *  root 可传子树（局部刷新用），默认整篇 document。 */
export function applyDomI18n(root: ParentNode = document): void {
  for (const [attr, target] of DOM_ATTRS) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[${attr}]`))) {
      const key = el.getAttribute(attr);
      if (!key) continue;
      const text = t(key as TKey);
      if (target === null) setText(el, text);
      else el.setAttribute(target, text);
    }
  }
  // 顶层 root 自身带标记的情况（传子树进来时常见）
  if ("getAttribute" in root && (root as Element).hasAttribute?.("data-i18n")) {
    setText(root as Element, t((root as Element).getAttribute("data-i18n") as TKey));
  }
}

/** 订阅语言切换；返回取消订阅函数（调用方在 dispose 时调用，避免泄漏）。
 *  订阅者职责：重绘自己那块动态内容（菜单 / 面板 / 树…），不要指望运行时替你刷。 */
export function onLocaleChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** 切换语言：持久化 → 同步 `<html lang>` → 套用静态骨架 → 广播动态模块重绘。
 *  同值重复调用直接返回（切换是重量级操作，别让连点触发 N 次全量重绘）。 */
export function setLocale(locale: Locale): void {
  if (locale === getLocale()) return;
  current = locale;
  persist(locale);
  try {
    document.documentElement.lang = locale;
  } catch {
    /* 无 DOM 环境（单测）忽略 */
  }
  applyDomI18n();
  for (const cb of Array.from(listeners)) {
    try {
      cb();
    } catch (e) {
      // 单个订阅者重绘失败不能中断其余订阅者（否则一处崩 = 半个界面停在旧语言）
      console.error("[i18n] locale change listener failed", e);
    }
  }
}

/** 初始化：在 main.ts 尽早调用（静态骨架首屏即正确语言，避免中文闪一下再跳英文）。 */
export function initI18n(): void {
  const locale = getLocale();
  try {
    document.documentElement.lang = locale;
  } catch {
    /* 无 DOM 环境忽略 */
  }
  applyDomI18n();
}
