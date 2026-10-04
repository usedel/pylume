// 集成终端（P2-7 多会话）：xterm.js 渲染 + PTY 桥接。
// 每个实例绑定一个后端会话 id；term-data / term-exit 事件由 main.ts 统一监听并按 id 分发
// 到 writeData / handleExit，避免多实例各自订阅全局事件的浪费。

import { Terminal, type ILink, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { app, DEFAULT_SETTINGS } from "./state";
import { TRACEBACK_RE, URL_RE, URL_TRAILING_PUNCT, type OutputLink } from "./output";
import { motionDisabled } from "./anim"; // UI-11：终端光标闪烁也归「减少动画」管（anim.ts 无依赖，导入不成环）
import { t } from "./i18n"; // 第五批 i18n：终端内提示文案走语言包（ANSI 控制序列留在代码侧，不进词条）
import { errMsg } from "./util";
import { localizeBackendError } from "./i18n/backendError";
import { shellThemeOf } from "./theme/tokens";

/** 终端配色随外壳主题（D1 P-01：浅色主题下不再固定深色终端；批 4 起判定走 shellThemeOf） */
function xtermTheme(): ITheme {
  if (shellThemeOf(app.settings.theme) === "light") {
    return { background: "#ececec", foreground: "#333333", cursor: "#333333", selectionBackground: "#add6ff" };
  }
  return { background: "#1b1b1b", foreground: "#d4d4d4", cursor: "#d4d4d4", selectionBackground: "#264f78" };
}

/** UI-29：终端字号 = 用户设置 font_size（与主编辑器同源，原硬编码 13 不跟随设置）。
 *  手改配置写坏（NaN/0）时回落出厂默认，避免 xterm 拿到非法值渲染异常。 */
function termFontSize(): number {
  const n = Number(app.settings.font_size);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_SETTINGS.font_size;
}

/** UI-29：终端字体族 = 用户设置 font_family（原为一份与 --mono token 重复维护的硬编码栈，
 *  UI-28 只统一了 CSS 侧，这里是 JS 侧的最后一处）；空值回落出厂默认栈。 */
function termFontFamily(): string {
  return app.settings.font_family.trim() || DEFAULT_SETTINGS.font_family;
}

/** traceback 链接的点击处理（由 main.ts 注入 `gotoFromLink`）。
 * 做成模块级而非实例级：shell 终端与运行终端都该能点——顺带让手敲 `uv run` 产生的
 * traceback 也可跳转（坑 4 里 PTY 路线的额外收益，不是纯成本）。 */
let linkHandler: ((link: OutputLink) => void) | null = null;

export function setTerminalLinkHandler(cb: (link: OutputLink) => void): void {
  linkHandler = cb;
}

/** 终端内 URL 的点击处理器（main.ts 注入 → invoke open_external，与 setOutputUrlHandler 同模式）。
 * 做成模块级而非实例级：shell 终端与运行终端都该能点开 uvicorn/FastAPI 等服务 URL。 */
let urlHandler: ((url: string) => void) | null = null;

export function setTerminalUrlHandler(cb: (url: string) => void): void {
  urlHandler = cb;
}

// ---------- 输出背压（P0：与 output.ts 的环形护栏同源） ----------
//
// 依据同 `docs/pycharm_ux_review_and_proposal.md` §3.3 / A-3：终端此前是
// `writeData → term.write()` 直通，脚本狂打印时每一帧都在同步解析并渲染几 MB 文本，
// 主线程被吃满 → 界面冻结、Ctrl+C 也发不出去（社区对 JetBrains 系最尖锐的批评之一）。
// 护栏：写入按帧合并 + 单帧字节预算，超预算的排队到下一帧（不丢数据，只削峰）。

/** 单帧写入 xterm 的字节上限（超出部分顺延到下一帧） */
const MAX_WRITE_BYTES_PER_FRAME = 256 * 1024;
/** 积压超过该字节数即提示一次「已限流」（洪峰结束才允许再次提示，防刷屏） */
const THROTTLE_WARN_BYTES = 1024 * 1024;
/** G-1：积压硬上限（超过即丢最旧输出）——背压只削峰不丢数据的前提是
 *  「生产速率低于排空速率」，`while true: print` 大块输出可超过 15MB/s 的排空上限，
 *  队列必须封顶防 OOM（推送前复核发现的缺口）。scrollback 只有 5000 行，
 *  丢弃最旧输出后真正可见的内容差异远小于数字。 */
const MAX_PENDING_BYTES = 4 * 1024 * 1024;
/** stop/exit 路径同步排空的总量上限（进程已死不会再有输入，超出部分截断并提示） */
const DRAIN_MAX_BYTES = 2 * 1024 * 1024;

export class IntegratedTerminal {
  readonly id: string;
  private term: Terminal;
  private fit: FitAddon;
  private container: HTMLElement;
  private started = false;
  private resizeObserver: ResizeObserver;
  private onExit?: () => void;
  /** 待写入的文本块队列（按帧合并，削峰不丢数据） */
  private pendingChunks: string[] = [];
  /** 队列当前字节数（与 pendingChunks 同步维护，避免每帧 reduce 大数组） */
  private pendingBytes = 0;
  /** 本帧是否已排了 flush */
  private flushScheduled = false;
  /** 本次洪峰是否已提示过限流（队列清空时复位） */
  private throttleNotified = false;
  /** 本次洪峰因硬上限丢弃的最旧输出字节数（队列清空时汇总提示后复位） */
  private droppedBytes = 0;

  constructor(id: string, container: HTMLElement) {
    this.id = id;
    this.container = container;
    this.term = new Terminal({
      // UI-29：字号/字体族读用户设置（原硬编码 fontSize:13 + 一份与 --mono 重复维护的字体栈）
      fontSize: termFontSize(),
      fontFamily: termFontFamily(),
      // UI-11：光标闪烁是终端里唯一常驻的动画，对前庭功能障碍用户正是需要消除的对象，
      // 而 CSS 的 --motion 倍率管不到 xterm 内部（它用 canvas/DOM 自绘），必须在此显式关闭。
      cursorBlink: !motionDisabled(),
      scrollback: 5000,
      theme: xtermTheme(),
    });
    this.fit = new FitAddon();
    this.term.loadAddon(this.fit);
    this.term.open(container);
    this.fit.fit();

    // 键盘输入 → PTY
    this.term.onData((data) => {
      void invoke("term_write", { id: this.id, data }).catch(() => undefined);
    });

    // S3（坑 4）：输出跑进 xterm 后没有「行元素」可挂点击，traceback 跳转会整个丢掉。
    // 改用 xterm 的 link provider，复用输出面板同一个 TRACEBACK_RE 与跳转逻辑；P2-L 顺带
    // 复用 URL_RE 让服务 URL（uvicorn/FastAPI 等）也可点击（注册一次，按需回调悬停/refresh）。
    this.term.registerLinkProvider({
      provideLinks: (bufferLine, callback) => callback(this.provideLinks(bufferLine)),
    });

    // 容器尺寸变化 → adapt fit + 同步 PTY 尺寸
    this.resizeObserver = new ResizeObserver(() => this.syncSize());
    this.resizeObserver.observe(container);
  }

  setOnExit(cb: () => void): void {
    this.onExit = cb;
  }

  /** 当前是否有一个存活的 shell 会话 */
  isRunning(): boolean {
    return this.started;
  }

  /** 面板展开 / 尺寸变化后手动触发重布局（fit + resize） */
  relayout(): void {
    this.syncSize();
  }

  /** 外壳主题切换后重套配色（D1） */
  applyTheme(): void {
    this.term.options.theme = xtermTheme();
  }

  /** UI-11：「减少动画」开关切换后重设光标闪烁。
   *  xterm 的 options 支持运行时赋值，无需销毁重建实例（与 applyTheme 同一套做法）。 */
  applyMotionPreference(): void {
    this.term.options.cursorBlink = !motionDisabled();
  }

  /** UI-29：设置保存（字号/字体族）后重套字体。
   *  改字号会改变字符度量 → cols/rows 随之变化，必须 refit 并同步 PTY 尺寸，
   *  否则后端按旧列宽折行、终端出现错位（syncSize 内部已含 term_resize）。 */
  applyFontPreference(): void {
    this.term.options.fontSize = termFontSize();
    this.term.options.fontFamily = termFontFamily();
    this.syncSize();
  }

  /** fit 当前尺寸并通知后端 resize（未启动时仅前端 fit） */
  private syncSize(): void {
    if (this.container.clientWidth === 0 || this.container.clientHeight === 0) return;
    this.fit.fit();
    if (this.started) {
      void invoke("term_resize", { id: this.id, cols: this.term.cols, rows: this.term.rows }).catch(() => undefined);
    }
  }

  /** 启动 shell（cwd 为终端工作目录，workspaceRoot 供 venv 检测）；幂等——重复调用会重启会话；返回激活的 venv 名。
   * `shell` 为显式别名（"auto"/"pwsh"/"powershell"/"cmd"）；缺省回退全局默认 `app.settings.terminal_shell`。 */
  async start(cwd: string | null, workspaceRoot: string | null, shell?: string): Promise<string | null> {
    if (this.started) {
      await invoke("term_kill", { id: this.id }).catch(() => undefined);
    }
    this.started = false;
    this.term.reset();
    this.started = true;

    const dims = this.fit.proposeDimensions();
    const cols = dims?.cols ?? 80;
    const rows = dims?.rows ?? 24;
    let venv: string | null = null;
    try {
      venv = await invoke<string | null>("term_spawn", {
        id: this.id,
        cols,
        rows,
        cwd,
        shell: shell ?? app.settings.terminal_shell ?? "auto",
        workspaceRoot,
      });
    } catch (e) {
      this.started = false;
      this.term.writeln(`\r\n\x1b[31m${t("run.term.startFailed", { error: localizeBackendError(errMsg(e)) })}\x1b[0m`);
      return null;
    }

    // 面板刚展开时容器尺寸可能未稳定，再同步一次
    requestAnimationFrame(() => this.syncSize());
    this.term.focus();
    return venv;
  }

  focus(): void {
    this.term.focus();
  }

  /** 程序化发送命令到终端（run=true 追加回车立即执行；否则仅插入文本供补参） */
  sendCommand(cmd: string, run: boolean): void {
    if (!this.started) return;
    const data = run ? cmd + "\r" : cmd;
    void invoke("term_write", { id: this.id, data }).catch(() => undefined);
    this.term.focus();
  }

  /** （外部事件分发）term-data → 排队，按帧合并后写入 xterm（背压，见文件头「输出背压」） */
  writeData(data: string): void {
    if (!data) return;
    this.pendingChunks.push(data);
    this.pendingBytes += data.length;
    // G-1：积压硬上限——丢最旧输出保响应（scrollback 有限，最旧内容本就即将滚出可视区）
    if (this.pendingBytes > MAX_PENDING_BYTES) {
      let dropped = 0;
      while (this.pendingBytes > MAX_PENDING_BYTES && this.pendingChunks.length > 1) {
        const head = this.pendingChunks.shift()!;
        this.pendingBytes -= head.length;
        dropped += head.length;
      }
      if (dropped > 0) this.droppedBytes += dropped;
    }
    // 积压过大时只提示一次：让用户知道「输出被削峰」而非「程序卡了」
    if (this.pendingBytes >= THROTTLE_WARN_BYTES && !this.throttleNotified) {
      this.throttleNotified = true;
      this.pendingChunks.push(`\r\n\x1b[33m${t("run.term.throttled")}\x1b[0m\r\n`);
    }
    this.scheduleFlush();
  }

  /** 排一帧 flush（已在队列中则跳过：同一帧内的多次 writeData 合并为一次渲染） */
  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    requestAnimationFrame(() => {
      this.flushScheduled = false;
      this.flushPending();
    });
  }

  /** 同步写出队列（按单帧字节预算削峰；剩余留到下一帧）。
   *  markStopped / handleExit 在写提示行前先调它，保证「进程输出 → 退出提示」的时序不乱。 */
  private flushPending(): void {
    if (this.pendingChunks.length === 0) return;
    let budget = MAX_WRITE_BYTES_PER_FRAME;
    let out = "";
    while (budget > 0 && this.pendingChunks.length > 0) {
      const head = this.pendingChunks[0];
      if (head.length <= budget) {
        out += head;
        budget -= head.length;
        this.pendingChunks.shift();
      } else {
        // 单块比预算还大：切一部分写入，剩下的留在队首
        out += head.slice(0, budget);
        this.pendingChunks[0] = head.slice(budget);
        budget = 0;
      }
    }
    this.pendingBytes -= out.length;
    if (this.pendingBytes < 0) this.pendingBytes = 0;
    this.term.write(out);
    if (this.pendingChunks.length === 0) {
      // 洪峰结束补一行收尾提示：洪峰中途那次提示会被后续输出冲出 scrollback（看不到），
      // 结束时没有后续输出，这一行才真正留得住。
      if (this.throttleNotified) {
        const droppedNote = this.droppedBytes > 0 ? t("run.term.droppedNote", { kb: Math.round(this.droppedBytes / 1024) }) : "";
        this.term.writeln(`\r\n\x1b[33m${t("run.term.peakEnded", { note: droppedNote })}\x1b[0m\r\n`);
        this.throttleNotified = false; // 允许下次洪峰再提示
        this.droppedBytes = 0;
      }
    }
    if (this.pendingChunks.length > 0) this.scheduleFlush(); // 还有积压 → 下一帧继续
  }

  /** 丢弃待写队列（startRun 的 reset / dispose 用：旧输出已无意义） */
  private dropPendingWrites(): void {
    this.pendingChunks = [];
    this.pendingBytes = 0;
    this.throttleNotified = false;
    this.droppedBytes = 0;
  }

  /** 同步排空全部待写队列（stop/exit 路径专用：进程已死不会再有新输入）。
   *  flushPending 单帧预算只有 256KB，直接调一次会让「退出提示」插进剩余输出中间
   *  （推送前复核发现）；此处按预算循环排空，总量超 DRAIN_MAX_BYTES 则截断并提示
   *  （scrollback 只有 5000 行，截断的部分本就留不住）。 */
  private drainPending(): void {
    let drained = 0;
    while (this.pendingChunks.length > 0 && drained < DRAIN_MAX_BYTES) {
      const beforeChunks = this.pendingChunks.length;
      const beforeBytes = this.pendingBytes;
      this.flushPending();
      const wrote = beforeBytes - this.pendingBytes;
      drained += wrote;
      if (this.pendingChunks.length === beforeChunks && wrote === 0) break; // 防御：无进展（理论不可达）
    }
    if (this.pendingChunks.length > 0) {
      const droppedKb = Math.max(1, Math.round(this.pendingBytes / 1024));
      this.pendingChunks = [];
      this.pendingBytes = 0;
      this.term.write(`\r\n\x1b[33m${t("run.term.stopDropped", { kb: droppedKb })}\x1b[0m\r\n`);
    }
    this.throttleNotified = false;
    this.droppedBytes = 0;
  }

  /** 为一整行终端缓冲提供全部链接（traceback + URL），供 registerLinkProvider 按需回调。
   * 两套匹配不重叠（`File "…"` 帧里不含 URL），合并后一次性回传 xterm。 */
  private provideLinks(bufferLine: number): ILink[] | undefined {
    const links = this.provideTracebackLinks(bufferLine) ?? [];
    const urls = this.provideUrlLinks(bufferLine);
    if (urls) links.push(...urls);
    return links.length > 0 ? links : undefined;
  }

  /** 为一行终端缓冲提供 URL 链接（P2-L 的终端落点：uvicorn/FastAPI 等服务 URL 可点击）。
   * xterm buffer 存的是已解析字符（不含 ANSI），整行直接跑 URL_RE 即可；列号按同一字符串计算。 */
  private provideUrlLinks(bufferLine: number): ILink[] | undefined {
    if (!urlHandler) return undefined;
    const text = this.term.buffer.active.getLine(bufferLine - 1)?.translateToString(true) ?? "";
    if (!text.includes("://")) return undefined;
    const links: ILink[] = [];
    URL_RE.lastIndex = 0; // 带 `g` 的全局态：复用前必须重置
    let m: RegExpExecArray | null;
    while ((m = URL_RE.exec(text)) !== null) {
      // 剥离句尾标点（与 output.ts::appendTextWithUrls 同口径）
      let url = m[0];
      let end = m.index + url.length;
      while (url.length > 0 && URL_TRAILING_PUNCT.includes(url[url.length - 1])) {
        url = url.slice(0, -1);
        end--;
      }
      if (!url) continue;
      links.push({
        range: { start: { x: m.index + 1, y: bufferLine }, end: { x: end, y: bufferLine } },
        text: url,
        activate: () => urlHandler?.(url),
        decorations: { pointerCursor: true, underline: true },
      });
    }
    return links.length > 0 ? links : undefined;
  }

  /** 为一行终端缓冲提供 traceback 链接（xterm 按需回调）。
   * PTY 路径不存在输出面板那种「chunk 切碎」问题——xterm 看的是完整行缓冲，
   * 因此这里直接对整行跑正则即可（§4.7 结论 5）。 */
  private provideTracebackLinks(bufferLine: number): ILink[] | undefined {
    if (!linkHandler) return undefined;
    // translateToString(true) 去掉行尾空白；列号按同一字符串计算，映射一致
    const text = this.term.buffer.active.getLine(bufferLine - 1)?.translateToString(true) ?? "";
    if (!text) return undefined;
    const links: ILink[] = [];
    TRACEBACK_RE.lastIndex = 0; // 带 `g` 的全局态：复用前必须重置，否则会漏掉行首的帧
    let m: RegExpExecArray | null;
    while ((m = TRACEBACK_RE.exec(text)) !== null) {
      const path = m[1];
      const line = parseInt(m[2], 10);
      links.push({
        // xterm 的列是 1-based，range 末列为闭区间；text 为悬停/激活时回传的链接文本
        range: {
          start: { x: m.index + 1, y: bufferLine },
          end: { x: m.index + m[0].length, y: bufferLine },
        },
        text: m[0],
        activate: () => linkHandler?.({ path, line }),
        // 注：@xterm/xterm 5.5 的 ILinkDecorations 尚无 tooltipCallback，这里只用它支持的装饰项
        decorations: { pointerCursor: true, underline: true },
      });
    }
    return links.length > 0 ? links : undefined;
  }

  /** S3：以「运行」语义启动 PTY 会话——后端 `run_in_terminal` 直接 spawn 解释器 + [脚本, ...参数]，
   * **不套 shell**（套 `pwsh -c python x.py` 会让 Ctrl+C 与退出码多一层语义损耗）。
   * v3.4 §17-12：`kind` = "script" | "project"（project 忽略 path 读项目配置）；
   * `probe` 缺省 = 后端按全局设置 probe_enabled 控制（选区运行传 false——片段不采样）。
   * @param banner 运行回显行（与运行按钮同一口径），在 reset 之后立即写入，保证排在脚本输出之前
   * @returns 后端的非致命告警（如 Parameters 解析失败）
   * @throws 启动失败（已写入终端提示），调用方负责复位运行态 */
  async startRun(
    path: string,
    workspaceRoot: string | null,
    banner: string,
    kind: "script" | "project" = "script",
    probe?: boolean,
  ): Promise<string[]> {
    if (this.started) {
      await invoke("term_kill", { id: this.id }).catch(() => undefined);
    }
    this.started = false;
    this.dropPendingWrites(); // reset 会清屏，上一轮残留的排队输出已无意义
    this.term.reset();
    this.term.write(`\x1b[90m${banner}\x1b[0m\r\n`);
    this.started = true;

    const dims = this.fit.proposeDimensions();
    const cols = dims?.cols ?? 80;
    const rows = dims?.rows ?? 24;
    let warnings: string[];
    try {
      warnings = await invoke<string[]>("run_in_terminal", { id: this.id, cols, rows, path, workspaceRoot, kind, probe });
    } catch (e) {
      this.started = false;
      this.term.writeln(`\r\n\x1b[31m${t("run.term.runFailed", { error: localizeBackendError(errMsg(e)) })}\x1b[0m`);
      throw e;
    }
    // 面板刚切过来时尺寸可能未稳定，再同步一次
    requestAnimationFrame(() => this.syncSize());
    this.term.focus();
    return warnings;
  }

  /** 外部主动停止（`term_kill` 不发 term-exit，只有自然退出才 notify）：复位会话态并留一行提示 */
  markStopped(): void {
    if (!this.started) return;
    this.started = false;
    this.drainPending(); // 先排空排队输出，再写提示行，时序才对
    this.term.writeln(`\r\n\x1b[90m${t("run.term.stopped")}\x1b[0m`);
  }

  /** （外部事件分发）term-exit → 提示退出 */
  handleExit(): void {
    this.started = false;
    this.drainPending(); // 同上：退出提示必须排在进程输出之后
    this.term.writeln(`\r\n\x1b[90m${t("run.term.exited")}\x1b[0m`);
    // 结论 5：写入完成后刷新可视区，让 link provider 立刻为已渲染的行提供 traceback 链接
    this.term.refresh(0, this.term.rows - 1);
    this.onExit?.();
  }

  /** 完全销毁（关闭某个终端 tab / 关闭工作区时调用） */
  async dispose(): Promise<void> {
    if (this.started) {
      this.started = false;
      await invoke("term_kill", { id: this.id }).catch(() => undefined);
    }
    this.dropPendingWrites();
    this.resizeObserver.disconnect();
    this.term.dispose();
  }
}