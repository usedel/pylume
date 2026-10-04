// PR-H（dx_features_backlog §6.6）：全局搜索的**纯筛选/匹配**——零 DOM、零 Tauri 依赖
// （与 saveCleanup.ts 同款下沉方式），供 search.ts 与单测共用。
//
// 两条正交开关：
//   · 匹配模式：子串（默认）/ 正则（C-类 Regex）；
//   · 文件掩码：PyCharm File mask 语义。
//
// ⚠ 掩码语义必须与 Rust 侧**保持一致**（见 fs_cmds.rs::collect_files_glob 注释）：
//   · 无斜杠（如 `*.py`）= 任意深度命中（gitignore 语义，等价于前缀 `**/`）；
//   · 含斜杠（如 `pkg/*.py`）= 按工作区相对路径锚定；
//   · `*` 不跨 `/`（单段），`**` 跨任意层级，`?` 匹配单个非 `/` 字符。
//   Rust 侧用 `ignore` 的 overrides 在**走查期剪枝**（大仓省一次全仓遍历），
//   这里只承担 scope 模式（当前文件 / 打开的标签）的少量路径过滤。

import { errMsg } from "./util";
import { t } from "./i18n"; // 第十批 i18n：筛选错误提示走语言包
import { localizeBackendError } from "./i18n/backendError";

/** 一次行内匹配：column 为 1 基字符列，length 为匹配长度（供结果高亮切片） */
export interface LineHit {
  column: number;
  length: number;
}

/** 行匹配器：返回该行的全部（非重叠）命中 */
export type LineMatcher = (line: string) => LineHit[];

export function buildLineMatcher(query: string, caseSensitive: boolean, useRegex: boolean): LineMatcher {
  if (useRegex) {
    let re: RegExp;
    try {
      re = new RegExp(query, caseSensitive ? "g" : "gi");
    } catch (e) {
      // 编译失败必须上报：静默退回子串匹配会让用户以为「正则没生效」（与 Rust 侧同一口径）
      throw new Error(t("search.filter.invalidRegex", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) }));
    }
    return (line: string): LineHit[] => {
      const hits: LineHit[] = [];
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      // 空匹配（如 `x*`）会让 lastIndex 不前进 → 手动 +1 防死循环
      while ((m = re.exec(line)) !== null) {
        hits.push({ column: m.index + 1, length: m[0].length });
        if (m.index === re.lastIndex) re.lastIndex++;
      }
      return hits;
    };
  }
  const needle = caseSensitive ? query : query.toLowerCase();
  return (line: string): LineHit[] => {
    if (!needle) return [];
    const hay = caseSensitive ? line : line.toLowerCase();
    const hits: LineHit[] = [];
    let idx = hay.indexOf(needle);
    while (idx >= 0) {
      hits.push({ column: idx + 1, length: needle.length });
      idx = hay.indexOf(needle, idx + needle.length);
    }
    return hits;
  };
}

/** 掩码 → 相对路径判定器；空掩码返回 null（不过滤）。语法错误时返回 error 而非抛出，
 *  让调用方决定呈现方式（UI 要走「搜索失败」提示而不是崩坏）。 */
export function compileFileMask(
  mask: string | undefined,
): { test: (relPath: string) => boolean; error?: string } | null {
  const raw = mask?.trim() ?? "";
  if (!raw) return null;
  const pattern = raw.replace(/\\/g, "/");
  let body = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        body += ".*";
        i++;
      } else {
        body += "[^/]*";
      }
    } else if (c === "?") {
      body += "[^/]";
    } else {
      body += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  // 无斜杠掩码 = 任意深度命中（与 Rust 侧 gitignore 语义对齐）
  const full = pattern.includes("/") ? `^${body}$` : `^(?:.*/)?${body}$`;
  try {
    const re = new RegExp(full);
    return { test: (relPath: string) => re.test(relPath.replace(/\\/g, "/")) };
  } catch (e) {
    return { test: () => true, error: t("search.filter.invalidMask", { error: localizeBackendError(errMsg(e instanceof Error ? e.message : String(e))) }) };
  }
}
