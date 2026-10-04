// Git 状态存储（CR-25 从 git.ts 下沉的独立状态层，零依赖）：
// fileTree.ts 只需读这些状态做装饰，原本从 git.ts import 导致 fileTree ↔ git 循环。
// 写入方仍只有 git.ts（refreshGitStatus / resetGitState）；本模块只存状态 + 访问器，
// 不含任何 invoke / DOM / 其它模块引用（可安全被任何层 import）。

import { normalizePath } from "./util";

/** Git 状态缓存：相对路径 → 展示状态码（M/A/D/R/?/!）
 *  写入 key 为 git 输出的原始大小写（如 Foo.py）；读取经 normalizePath 大小写无关。 */
export const gitStatuses = new Map<string, string>();

/** 有变更的目录集合（相对路径，文件树目录高亮用） */
export const gitDirtyDirs = new Set<string>();

/** 是否为 git 仓库（文件树装饰总开关） */
export const gitRepoActive = { value: false };

/** 归一化索引（小写 key → 原始 key）：gitStatusOf 的大小写无关查询用（E2E 验收实测：
 *  写入侧原始大小写 + 调用方归一化小写 → 直接 Map.get 必 miss，git 右键菜单消失） */
const statusIndex = new Map<string, string>();

/** 重建归一化索引（git.ts 在 gitStatuses.clear + 重填后调用） */
export function rebuildStatusIndex(): void {
  statusIndex.clear();
  for (const key of gitStatuses.keys()) statusIndex.set(normalizePath(key), key);
}

/** 相对路径 → 状态码（fileTree 装饰用；大小写/分隔符无关） */
export function gitStatusOf(relPath: string): string | undefined {
  const direct = gitStatuses.get(relPath);
  if (direct !== undefined) return direct;
  const key = statusIndex.get(normalizePath(relPath));
  return key !== undefined ? gitStatuses.get(key) : undefined;
}

/** 目录是否有变更（fileTree 装饰用） */
export function isGitDirtyDir(relPath: string): boolean {
  return gitDirtyDirs.has(relPath);
}

/** 是否 git 仓库（fileTree 装饰用） */
export function isGitRepoActive(): boolean {
  return gitRepoActive.value;
}
