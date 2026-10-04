// English (US) 语言包「endpoints 域」：key 与 zh-CN/endpoints.ts 一一对应，Record<EndpointsKey, string> 在编译期强校验漏译。
import type { EndpointsKey } from "../zh-CN/endpoints";

export const endpoints: Record<EndpointsKey, string> = {
  // ---- endpoints ----
  "endpoints.copiedPrefix": "Copied: ",
  "endpoints.copyUrlAria": "Copy full URL",
  // ---- endpoints.countItems ----
  "endpoints.countItems.one": "{count} items",
  "endpoints.countItems.other": "{count} items",
  // ---- endpoints ----
  "endpoints.failCopy": "Copy",
  "endpoints.failOpenBrowser": "Open in browser",
  "endpoints.noUrlHint": "Service not running: cannot build the full URL (you can still copy the route)",
  "endpoints.noWorkspace": "No workspace open",
  "endpoints.noWorkspaceHint": "Open one and FastAPI / Flask endpoints will be listed here",
  "endpoints.none": "No endpoints",
  "endpoints.noneHint": "No @app.get / @router.get / @app.route declarations (FastAPI / Flask projects)",
  "endpoints.openAria": "Open in browser",
  "endpoints.openDocs": "Open /docs (Swagger UI; requires a running service)",
  "endpoints.openOpenapi": "Open /openapi.json (requires a running service)",
  "endpoints.openTip": "Open in browser (requires a running service)",
  "endpoints.rescan": "Rescan",
  "endpoints.scanFailed": "Scan failed: {error}",
  "endpoints.scanFailedShort": "Scan failed",
  "endpoints.scanning": "Scanning…",
  "endpoints.scanningHint": "Walking workspace files",
  "endpoints.serviceNotRunning": "Service not running: run the project first; usable once the ready line appears in the console",
  "endpoints.zeroItems": "0 items",
};
