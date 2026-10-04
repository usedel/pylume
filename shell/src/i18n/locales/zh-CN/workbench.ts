// 简体中文语言包「workbench 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、gen_domain.py 生成，勿手改（改动请回到源码与 data/workbench_zh.json）。
// 复数条目（含 {count}）自动展开 .one/.other 两份——中文两形同文。
export const workbench = {
  // ---- workbench.bookmarks ----
  "workbench.bookmarks.clearConfirm.one": "确认清空全部 {count} 个书签？此操作不可恢复。",
  "workbench.bookmarks.clearConfirm.other": "确认清空全部 {count} 个书签？此操作不可恢复。",
  "workbench.bookmarks.empty": "暂无书签",
  "workbench.bookmarks.emptyHint": "在目标行按 {key} 添加书签，可疑行与待办行一眼找回",
  "workbench.bookmarks.failClear": "清空书签",
  "workbench.bookmarks.failDelete": "删除书签",
  "workbench.bookmarks.failRead": "读取书签",
  "workbench.bookmarks.failToggle": "切换书签",
  "workbench.bookmarks.glyphTip": "书签（第 {line} 行）",
  "workbench.bookmarks.hint": "Enter 跳转 · Delete 删除 · Esc 关闭",
  "workbench.bookmarks.listAria": "书签列表",
  "workbench.bookmarks.noBinding": "书签键位（设置 → 快捷键）",
  "workbench.bookmarks.title": "书签",
  // ---- workbench.common ----
  "workbench.common.clear": "清空",
  // ---- workbench.history ----
  "workbench.history.clearMsg": "将删除 {name} 的全部历史快照，且不可恢复。",
  "workbench.history.clearTitle": "清空本地历史",
  "workbench.history.diffCurrent": "当前内容",
  "workbench.history.diffOriginal": "历史版本 {time}",
  "workbench.history.empty": "暂无历史",
  "workbench.history.emptyHint": "保存文件后会自动留下快照，也可点「标记当前」手动留一版",
  "workbench.history.emptyNoWs": "打开工作区后可用",
  "workbench.history.failClear": "清空历史",
  "workbench.history.failMark": "标记快照",
  "workbench.history.failRestore": "回滚历史版本",
  "workbench.history.needFile": "请先打开一个文件，再查看它的本地历史。",
  "workbench.history.noSelection": "未选择版本",
  "workbench.history.noSelectionHint": "在左侧选一个快照查看差异",
  "workbench.history.restoreConfirm": "将把 {name} 的内容替换为 {time} 的版本。",
  "workbench.history.restoreNote": "当前内容会先存为一版「回滚前」快照，可再次回滚。",
  "workbench.history.restoreOk": "回滚",
  "workbench.history.restoreTitle": "回滚到该版本",
  "workbench.history.tagManual": "手动标记",
  "workbench.history.tagRestore": "回滚前",
  "workbench.history.tagSave": "保存",
  "workbench.history.title": "本地历史",
  "workbench.history.unknownTime": "未知时间",
  // ---- workbench.problems ----
  "workbench.problems.baseLabel": "问题",
  "workbench.problems.empty": "没有发现问题",
  "workbench.problems.emptyHint": "运行 ruff / 引擎诊断后，问题会列在这里",
  "workbench.problems.filterAll": "全部",
  "workbench.problems.sevError": "错误",
  "workbench.problems.sevWarning": "警告",
  "workbench.problems.statusTip": "当前文件：{errors} 错误 / {warnings} 警告 · 点击查看问题面板（F8 逐个跳转）",
};

/** 本域文案 key：en-US/workbench.ts 的 Record<WorkbenchKey, string> 由它派生。 */
export type WorkbenchKey = keyof typeof workbench;
