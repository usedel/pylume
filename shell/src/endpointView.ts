// 端点工具窗（F1/F2/F4，docs/pycharm_framework_support_report.md §8.3）：
// Rust 静态扫描（`fs_cmds::scan_endpoints`：@app.get / @router.get / @app.route /
// APIRouter(prefix=) / include_router 合并前缀，纯文本正则级、零子进程），
// 本模块只负责渲染与动作（照 todoView.ts 先例）：
// - 按 HTTP 方法分组（GET / POST / … / WS，组序见 METHOD_ORDER），点击跳转声明；
// - F2：行内「浏览器打开」= lastServiceBaseUrl() + route（无 base 提示先运行）+ 复制 URL；
// - F4：工具条固定入口 /docs 与 /openapi.json（FastAPI 自带，复用 open_external，零新依赖）。

import { invoke } from "@tauri-apps/api/core";
import { app, $ } from "./state";
import { basename, codicon, emptyState, errMsg } from "./util";
import { t } from "./i18n"; // 第十五批 i18n：端点视图动态文案走语言包
import { localizeBackendError } from "./i18n/backendError";
import { fullEndpointUrl } from "./frameworks";
import { lastServiceBaseUrl } from "./termUi";
import { toast, toastFail } from "./toast";

export interface EndpointMatch {
  /** "fastapi" | "flask" | "unknown" */
  framework: string;
  /** 大写方法；多方法 "GET/POST"；websocket = "WS" */
  method: string;
  /** 合并后的完整路由（如 "/v1/api/users/{uid}"） */
  route: string;
  /** 声明文件（相对工作区根，正斜杠） */
  file: string;
  /** 声明行号（1 起） */
  line: number;
  handler: string;
}

/** 分组展示顺序（未登记的方法按字典序排在最后） */
const METHOD_ORDER = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "WS"];

/** 方法徽章类名后缀（CSS 侧 .ep-badge-<method 小写>） */
const badgeClass = (method: string): string => `ep-badge ep-badge-${method.toLowerCase()}`;

// ---------- handlers 注入（同 todoView 先例） ----------

export interface EndpointViewHandlers {
  /** 点击条目 → 打开声明并定位（main.ts 的 openFile） */
  openFile: (path: string, line: number) => void;
}

let handlers: EndpointViewHandlers | null = null;

export function setEndpointViewHandlers(h: EndpointViewHandlers): void {
  handlers = h;
}

// ---------- 状态 ----------

let results: EndpointMatch[] = [];
/** 刷新令牌：并发/连续刷新时旧结果不得覆盖新结果（同 todoView） */
let epToken = 0;
let loading = false;

/** 初始化端点视图 DOM（init 时调用一次；#view-endpoints 容器已在 index.html 声明） */
export function initEndpointView(): void {
  const root = $("view-endpoints");
  root.textContent = "";

  const toolbar = document.createElement("div");
  toolbar.id = "ep-toolbar";
  const summary = document.createElement("span");
  summary.id = "ep-summary";
  summary.textContent = "—";
  const mkBtn = (id: string, tip: string, icon: string, onClick: () => void): HTMLElement => {
    const b = document.createElement("button");
    b.id = id;
    b.className = "btn btn--ghost btn--icon";
    b.dataset.tip = tip;
    b.setAttribute("aria-label", tip);
    b.appendChild(codicon(icon));
    b.addEventListener("click", onClick);
    return b;
  };
  const refresh = mkBtn("ep-refresh", t("endpoints.rescan"), "refresh", () => void refreshEndpoints());
  // F4：FastAPI 自带的 Swagger UI 与 OpenAPI 规范（服务运行后可用；无 base 提示先运行）
  const docs = mkBtn("ep-open-docs", t("endpoints.openDocs"), "book", () =>
    void openServicePath("/docs"),
  );
  const openapi = mkBtn("ep-open-openapi", t("endpoints.openOpenapi"), "json", () =>
    void openServicePath("/openapi.json"),
  );
  toolbar.append(summary, openapi, docs, refresh);

  const list = document.createElement("div");
  list.id = "ep-results";

  root.append(toolbar, list);
  renderEndpointPanel();
}

/** F2/F4 共用：用系统浏览器打开 服务 base + 服务路径；无 base 提示先运行 */
async function openServicePath(path: string): Promise<void> {
  const url = fullEndpointUrl(lastServiceBaseUrl(), path);
  if (!url) {
    toast(t("endpoints.serviceNotRunning"), "info");
    return;
  }
  try {
    await invoke("open_external", { url });
  } catch (e) {
    toastFail(t("endpoints.failOpenBrowser"), e);
  }
}

/** 端点完整 URL（F2）；无运行中的服务返回 null */
function endpointUrl(route: string): string | null {
  return fullEndpointUrl(lastServiceBaseUrl(), route);
}

/** 重新扫描工作区（视图 onShow 与刷新按钮共用） */
export async function refreshEndpoints(): Promise<void> {
  const list = document.getElementById("ep-results");
  const summary = document.getElementById("ep-summary");
  if (!app.workspaceRoot) {
    results = [];
    renderEndpointPanel();
    return;
  }
  const token = ++epToken;
  loading = true;
  if (summary) summary.textContent = t("endpoints.scanning");
  if (list) list.textContent = "";
  let got: EndpointMatch[];
  try {
    got = await invoke<EndpointMatch[]>("scan_endpoints", { root: app.workspaceRoot });
  } catch (e) {
    if (token !== epToken) return;
    results = [];
    loading = false;
    renderEndpointPanel(t("endpoints.scanFailed", { error: localizeBackendError(errMsg(e)) }));
    return;
  }
  if (token !== epToken) return; // 已有更新一轮的扫描，丢弃旧结果
  results = got;
  loading = false;
  renderEndpointPanel();
}

/** 工作区切换 / 关闭时复位（避免旧工作区结果残留） */
export function resetEndpointView(): void {
  epToken++;
  results = [];
  loading = false;
  renderEndpointPanel();
}

/** 渲染面板（error 非空时显示为空态 + 错误说明） */
export function renderEndpointPanel(error?: string): void {
  const list = document.getElementById("ep-results");
  const summary = document.getElementById("ep-summary");
  if (!list) return;

  if (summary) {
    if (error) summary.textContent = t("endpoints.scanFailedShort");
    else if (loading) summary.textContent = t("endpoints.scanning");
    else if (results.length === 0) summary.textContent = t("endpoints.zeroItems");
    else summary.textContent = t("endpoints.countItems", { count: results.length });
  }

  list.textContent = "";
  if (error) {
    list.appendChild(emptyState("globe", t("endpoints.scanFailedShort"), error, true));
    return;
  }
  if (loading) {
    list.appendChild(emptyState("loading", t("endpoints.scanning"), t("endpoints.scanningHint"), true));
    return;
  }
  if (!app.workspaceRoot) {
    list.appendChild(emptyState("globe", t("endpoints.noWorkspace"), t("endpoints.noWorkspaceHint"), true));
    return;
  }
  if (results.length === 0) {
    // S4 空态教学：补一句这面板属于谁（FastAPI / Flask 项目），非 Python Web 用户不困惑
    list.appendChild(
      emptyState("globe", t("endpoints.none"), t("endpoints.noneHint"), true),
    );
    return;
  }

  // 按方法分组（保持 METHOD_ORDER；未登记的方法排在最后，按字典序）
  const groups = new Map<string, EndpointMatch[]>();
  for (const m of results) {
    const arr = groups.get(m.method);
    if (arr) arr.push(m);
    else groups.set(m.method, [m]);
  }
  const methods = [...groups.keys()].sort((a, b) => {
    const ia = METHOD_ORDER.indexOf(a);
    const ib = METHOD_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  for (const method of methods) {
    const items = groups.get(method)!;
    const header = document.createElement("div");
    header.className = "todo-group-header";
    const badge = document.createElement("span");
    badge.className = badgeClass(method);
    badge.textContent = method;
    const count = document.createElement("span");
    count.className = "todo-group-count";
    count.textContent = String(items.length);
    header.append(badge, count);
    list.appendChild(header);

    for (const m of items) {
      list.appendChild(buildEndpointRow(m));
    }
  }
}

function buildEndpointRow(m: EndpointMatch): HTMLElement {
  const row = document.createElement("div");
  row.className = "todo-item";
  const route = document.createElement("span");
  route.className = "ep-route";
  route.textContent = m.route;
  route.title = `${m.route}　·　${m.file}:${m.line}${m.handler ? `　·　${m.handler}()` : ""}`;
  const loc = document.createElement("span");
  loc.className = "todo-loc";
  loc.textContent = `${basename(m.file)}:${m.line}`;
  loc.title = m.file;

  const open = document.createElement("span");
  open.className = "ep-action";
  open.setAttribute("role", "button");
  open.tabIndex = 0;
  open.setAttribute("aria-label", t("endpoints.openAria"));
  open.dataset.tip = t("endpoints.openTip");
  open.appendChild(codicon("globe"));
  const openUrl = (): void => {
    const url = endpointUrl(m.route);
    if (!url) {
      toast(t("endpoints.serviceNotRunning"), "info");
      return;
    }
    void invoke("open_external", { url }).catch((e) => toastFail(t("endpoints.failOpenBrowser"), e));
  };
  open.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openUrl();
  });
  open.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      ev.stopPropagation();
      openUrl();
    }
  });

  const copy = document.createElement("span");
  copy.className = "ep-action";
  copy.setAttribute("role", "button");
  copy.tabIndex = 0;
  copy.setAttribute("aria-label", t("endpoints.copyUrlAria"));
  copy.dataset.tip = t("endpoints.copyUrlAria");
  copy.appendChild(codicon("copy"));
  const copyUrl = (): void => {
    const url = endpointUrl(m.route);
    if (!url) {
      toast(t("endpoints.noUrlHint"), "info");
      return;
    }
    void invoke("copy_to_clipboard", { text: url })
      .then(() => toast(t("endpoints.copiedPrefix") + url, "success"))
      .catch((e) => toastFail(t("endpoints.failCopy"), e));
  };
  copy.addEventListener("click", (ev) => {
    ev.stopPropagation();
    copyUrl();
  });
  copy.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      ev.stopPropagation();
      copyUrl();
    }
  });

  row.append(route, loc, open, copy);
  // UI-16：可点击行补 button 语义 + 键盘激活（跳转声明是主动作）
  row.setAttribute("role", "button");
  row.tabIndex = 0;
  row.setAttribute("aria-label", `${m.method} ${m.route}，${basename(m.file)}:${m.line}`);
  const jump = (): void => handlers?.openFile(m.file, m.line);
  row.addEventListener("click", jump);
  row.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      jump();
    }
  });
  return row;
}
