// 简体中文语言包「filetree 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、gen_domain.py 生成，勿手改（改动请回到源码与 data/filetree_zh.json）。
// 复数条目（含 {count}）自动展开 .one/.other 两份——中文两形同文。
export const filetree = {
  // ---- filetree.btn ----
  "filetree.btn.followOff": "切换文件时自动定位（已关）",
  "filetree.btn.followOn": "切换文件时自动定位（已开）",
  "filetree.btn.hideHidden": "隐藏 dot 文件",
  "filetree.btn.showHidden": "显示 dot 文件",
  // ---- filetree.delete ----
  "filetree.delete.confirmMany.one": "确认删除 {count} 个选中项？",
  "filetree.delete.confirmMany.other": "确认删除 {count} 个选中项？",
  "filetree.delete.confirmOne": "确认删除「{path}」？",
  "filetree.delete.recycleHint": "删除后将移入系统回收站（可恢复）。",
  // ---- filetree.inline ----
  "filetree.inline.title": "Enter 确认 · Esc 取消",
  // ---- filetree.menu ----
  "filetree.menu.blame": "Blame（逐行溯源）",
  "filetree.menu.copy": "复制",
  "filetree.menu.copyAbsPath": "复制绝对路径",
  "filetree.menu.copyMany.one": "复制 {count} 项",
  "filetree.menu.copyMany.other": "复制 {count} 项",
  "filetree.menu.copyName": "复制文件名",
  "filetree.menu.copyRelPath": "复制相对路径",
  "filetree.menu.cut": "剪切",
  "filetree.menu.cutMany.one": "剪切 {count} 项",
  "filetree.menu.cutMany.other": "剪切 {count} 项",
  "filetree.menu.delete": "删除",
  "filetree.menu.deleteMany.one": "删除 {count} 项",
  "filetree.menu.deleteMany.other": "删除 {count} 项",
  "filetree.menu.diffClipboard": "与剪贴板对比",
  "filetree.menu.gitFileHistory": "Git 文件历史",
  "filetree.menu.localHistory": "本地历史",
  "filetree.menu.newFile": "新建文件",
  "filetree.menu.newFolder": "新建文件夹",
  "filetree.menu.newPyFile": "新建 Python 文件",
  "filetree.menu.newPyPackage": "新建 Python 包",
  "filetree.menu.openDiff": "打开差异",
  "filetree.menu.openPreview": "打开预览",
  "filetree.menu.openTerminal": "在终端中打开",
  "filetree.menu.paste": "粘贴",
  "filetree.menu.rename": "重命名",
  "filetree.menu.revealInExplorer": "在资源管理器中显示",
  "filetree.menu.runScript": "运行脚本",
  "filetree.menu.stageChanges": "暂存更改",
  "filetree.menu.stageNew": "暂存新文件",
  // ---- filetree.op ----
  "filetree.op.copyPath": "复制路径",
  "filetree.op.deleteFailed.one": "删除 {count} 项失败：{names}",
  "filetree.op.deleteFailed.other": "删除 {count} 项失败：{names}",
  "filetree.op.dropMove": "拖拽移动",
  "filetree.op.moveExists": "目标目录已存在同名项「{name}」，已取消移动（不支持覆盖）",
  "filetree.op.moveIntoSelf": "不能把文件夹移动到它自己的子目录里",
  "filetree.op.pasteFailed.one": "粘贴 {count} 项失败：{names}",
  "filetree.op.pasteFailed.other": "粘贴 {count} 项失败：{names}",
  "filetree.op.pasteSkipped": "目标目录已存在同名项，已跳过：{names}（移动不支持覆盖）",
  "filetree.op.revealExplorer": "打开资源管理器",
  // ---- filetree.reveal ----
  "filetree.reveal.noActiveFile": "没有活动文件可定位",
  // ---- filetree.tree ----
  "filetree.tree.empty": "（空）",
};

/** 本域文案 key：en-US/filetree.ts 的 Record<FiletreeKey, string> 由它派生。 */
export type FiletreeKey = keyof typeof filetree;
