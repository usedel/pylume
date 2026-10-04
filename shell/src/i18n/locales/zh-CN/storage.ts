// 简体中文语言包「storage 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、gen_domain.py 生成，勿手改（改动请回到源码与 data/storage_zh.json）。
// 复数条目（含 {count}）自动展开 .one/.other 两份——中文两形同文。
export const storage = {
  // ---- storage.action ----
  "storage.action.clean": "清理",
  "storage.action.cleanAll": "全部清理",
  "storage.action.deepClean": "深度清理",
  "storage.action.delete": "删除",
  // ---- storage ----
  "storage.cleanFailed": "清理失败",
  "storage.done": "完成。",
  "storage.exampleDir": "例如 D:\\\\pylume-data",
  // ---- storage.firstRun ----
  "storage.firstRun.saveFail": "保存首启设置",
  "storage.firstRun.setMsg": "数据根已指向 {dir}。重启后生效（首启尚无数据，重启无损失）。现在重启？",
  "storage.firstRun.setTitle": "数据位置已设置",
  // ---- storage ----
  "storage.freed": "已释放 {size}。",
  "storage.freedKeepLogs": "已释放 {size}（当前日志文件保留）。",
  // ---- storage.migration ----
  "storage.migration.askRestart": "现在重启应用使新位置生效？",
  "storage.migration.copyTo": "将把当前数据根完整复制到 {target}，并把数据根指针指向该目录。",
  "storage.migration.done": "数据已复制到 {root}。{note}",
  "storage.migration.doneTitle": "迁移完成",
  "storage.migration.failed": "迁移失败",
  "storage.migration.incompleteMsg": "数据根 {root} 存在迁移中断标记。可在「设置 → 存储」重新执行迁移，或删除该目录中的 .migration-in-progress 标记后忽略。",
  "storage.migration.incompleteTitle": "检测到未完成的迁移",
  "storage.migration.oldDir": "旧目录 {root} 不会被自动删除，重启并确认无误后可手工删除。",
  "storage.migration.restartNote": "重启后生效，期间请勿关闭应用。继续？",
  "storage.migration.restartNow": "立即重启",
  "storage.migration.skippedNote.one": "有 {count} 个被占用文件未复制（详见新目录 .migration-skipped.txt）。",
  "storage.migration.skippedNote.other": "有 {count} 个被占用文件未复制（详见新目录 .migration-skipped.txt）。",
  "storage.migration.start": "开始迁移",
  "storage.migration.title": "迁移数据",
  // ---- storage ----
  "storage.needTargetDir": "请填写目标目录",
  "storage.openDataDir": "打开数据目录",
  "storage.pickDirFail": "选择目录",
  "storage.setFailed": "设置失败",
  // ---- storage.state ----
  "storage.state.cleaning": "清理中…",
  "storage.state.deepCleaning": "深度清理中…",
  "storage.state.measuring": "统计中…",
  "storage.state.migrating": "迁移中…",
  // ---- storage.tag ----
  "storage.tag.nonDeletable": "不可删",
  "storage.tag.partiallyRenewable": "部分可再生",
  "storage.tag.renewable": "可再生",
  // ---- storage.trace ----
  "storage.trace.allLabel": "（全部 trace）",
  "storage.trace.cleanAllMsg": "将删除所有项目的运行时类型采样库（重新运行脚本即可重新采样）。继续？",
  "storage.trace.cleanAllTitle": "清理全部 trace 库",
  "storage.trace.cleanOneMsg": "将删除该项目的 trace 库（重新运行脚本即可重新采样）。继续？",
  "storage.trace.cleanOneTitle": "删除该 trace 库",
  // ---- storage ----
  "storage.usageFailed": "占用统计失败：{error}",
  // ---- storage.uv ----
  "storage.uv.deepMsg": "将删除全部 uv 缓存（已装环境不受影响；之后重装包会重新下载落盘）。继续？",
  "storage.uv.deepTitle": "uv 缓存深度清理",
  "storage.uv.msg": "将清理 uv 缓存中的无效/悬空条目。继续？",
  "storage.uv.note": "uv（用户自有位置，Pylume 不代管）",
  "storage.uv.title": "uv 缓存清理",
  // ---- storage.webview ----
  "storage.webview.msg": "将删除 WebView2 的缓存子目录（登录态等文件保留）。继续？",
  "storage.webview.title": "清理 WebView 缓存",
};

/** 本域文案 key：en-US/storage.ts 的 Record<StorageKey, string> 由它派生。 */
export type StorageKey = keyof typeof storage;
