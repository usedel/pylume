// @ts-check
// inline 变换模板（脚手架生成）：声明 inline 的工具无需写 mount——
// 用户选中编辑器文本 → 命令面板搜「问候选区」→ 原地替换（toast 可撤销）。
// 想不选文本就调试？在 Pylume 里打开这个工具，会自动出现「调试台」面板。

/**
 * inline 变换：选中文本 → 返回替换文本；抛错则保留原文并 toast 报错
 * @param {string} text 选区文本
 * @param {ToolHost} host 无 root/kit 的轻量 host（inline 可能从未打开面板）
 * @returns {string}
 */
export function helloSelection(text, host) {
  host.log("变换输入：" + text.slice(0, 50));
  return "你好，" + text + "！";
}
