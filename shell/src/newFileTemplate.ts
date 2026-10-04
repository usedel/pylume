/** PR-K（dx_features_backlog §6.6）：新建 .py 文件自动插 header 文件头模板的门控纯函数。
 *  独立模块（零 DOM/Monaco 依赖）以便单测；fileTree.ts 的两个新建入口共用，禁止逻辑两处漂移。 */

/** 新建的文件是否应插入 header 模板：开关开 且 后缀为 .py/.pyw（大小写不敏感）。
 *  其余类型（.md/.txt/无后缀…）一律不插；草稿（newScratch）不走新建文件流程，天然豁免。 */
export function headerTemplateApplies(path: string, enabled: boolean): boolean {
  if (!enabled) return false;
  return /\.(py|pyw)$/i.test(path);
}
