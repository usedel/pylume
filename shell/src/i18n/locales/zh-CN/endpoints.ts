// 简体中文语言包「endpoints 域」（真源）：由 tools/i18n/apply_ts.py 从源码抽取、gen_domain.py 生成，勿手改（改动请回到源码与 data/endpoints_zh.json）。
// 复数条目（含 {count}）自动展开 .one/.other 两份——中文两形同文。
export const endpoints = {
  // ---- endpoints ----
  "endpoints.copiedPrefix": "已复制：",
  "endpoints.copyUrlAria": "复制完整 URL",
  // ---- endpoints.countItems ----
  "endpoints.countItems.one": "{count} 项",
  "endpoints.countItems.other": "{count} 项",
  // ---- endpoints ----
  "endpoints.failCopy": "复制",
  "endpoints.failOpenBrowser": "打开浏览器",
  "endpoints.noUrlHint": "服务未运行：无法拼出完整 URL（可先复制路由）",
  "endpoints.noWorkspace": "未打开工作区",
  "endpoints.noWorkspaceHint": "打开后此处列出 FastAPI / Flask 端点",
  "endpoints.none": "没有端点",
  "endpoints.noneHint": "暂无 @app.get / @router.get / @app.route 声明（FastAPI / Flask 项目）",
  "endpoints.openAria": "在浏览器打开",
  "endpoints.openDocs": "打开 /docs（Swagger UI，需服务运行中）",
  "endpoints.openOpenapi": "打开 /openapi.json（需服务运行中）",
  "endpoints.openTip": "在浏览器打开（需服务运行中）",
  "endpoints.rescan": "重新扫描",
  "endpoints.scanFailed": "扫描失败：{error}",
  "endpoints.scanFailedShort": "扫描失败",
  "endpoints.scanning": "扫描中…",
  "endpoints.scanningHint": "正在遍历工作区文件",
  "endpoints.serviceNotRunning": "服务未运行：先运行项目，待控制台出现就绪行后可用",
  "endpoints.zeroItems": "0 项",
};

/** 本域文案 key：en-US/endpoints.ts 的 Record<EndpointsKey, string> 由它派生。 */
export type EndpointsKey = keyof typeof endpoints;
