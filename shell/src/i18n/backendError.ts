// 后端（Rust）错误文案的翻译层。
//
// 为什么单独一层而不并入语言包：Rust 侧的错误是「带格式占位的模板」（`工作区目录不存在：{root}`、
// `文件过大（{:.1} MB）…`），参数在 Rust 里就已填好，前端拿到的是**已填充的整句**。语言包的词条
// 是「key → 整句模板」，靠 `t(key, params)` 插值；后端错误没有 key、只有中文原文，只能反过来
// 「按模板匹配 → 抽参数 → 套英文模板」。两者机制不同，硬塞进 zh-CN.ts 会让 t() 的 key 空间
// 被 103 条后端模板污染，且参数顺序（英文常与中文不同）无法表达。
//
// 契约：
// 1. 中文模板必须与 src-tauri 里的字面量**逐字一致**（含 `{}` 占位个数与顺序）——由
//    `tools/i18n_scan_rust.py` 做漂移锁：后端改文案而这里没同步，脚本会报未登记条目。
// 2. 英文模板的占位个数与顺序必须与中文一致（脚本同样校验）。
// 3. 未命中一律原样返回中文——宁可露原文，也不要把错误吞成空串或 key。
//
// 覆盖范围：`Err("<中文>"…)` / `Err(format!("<中文>"…))` 形态（命令返回值 → 前端 toast/alert）。
// 日志与内部 unwrap 文案不在范围内（用户不可见）。

import { getLocale } from "./index";

interface ErrPattern {
  /** Rust 侧中文模板（真源） */
  zh: string;
  /** 英文模板，占位顺序与 zh 一致 */
  en: string;
}

/**
 * 真源是 `tools/i18n/data/backend_err.json`（zh → en 映射表）；本数组是它的 TS 镜像。
 * 新增后端文案的流程：① 把 zh/en 两条写进 JSON；② 在下面按同样顺序补一行；
 * ③ 跑 `python3 tools/i18n/scan_rust.py` 验漂移锁（退出码 0 = Rust 侧与 JSON 一致）。
 * 已知覆盖盲区：脚本只扫 `Err("…")` / `Err(format!("…"))` 形态，
 * `.map_err(|e| format!("DbSqlError:任务执行异常：{e}"))` 这类闭包内文案扫不到——
 * 因此**不要**把未登记的闭包文案写进 JSON（会被判为「已失效映射」）。
 */
const PATTERNS: ErrPattern[] = [
  { zh: "Content-Length 超上限（{len} > {MAX_DAP_FRAME_LEN}）", en: "Content-Length exceeds the limit ({len} > {MAX_DAP_FRAME_LEN})" },
  { zh: "已有调试会话在运行", en: "A debug session is already running" },
  { zh: "已有脚本在运行", en: "A script is already running" },
  { zh: "运行配置选择了模块入口，但模块名为空", en: "The run configuration uses a module entry, but the module name is empty" },
  { zh: "调试会话状态冲突，请重试", en: "Debug session state conflict, please retry" },
  { zh: "被调试脚本已启动", en: "The script being debugged has already started" },
  { zh: "编辑历史事件过多（{}>{}）", en: "Too many edit history events ({}>{})" },
  { zh: "打开编辑历史文件失败", en: "Failed to open the edit history file" },
  { zh: "命令执行超时（{}s）", en: "Command timed out ({}s)" },
  { zh: "uv venv 异常退出（exit {code}）", en: "uv venv exited abnormally (exit {code})" },
  { zh: "工作区不存在：{workspace_root}", en: "Workspace does not exist: {workspace_root}" },
  { zh: "未选择解释器，无法安装（无 pyproject.toml 时走 uv pip install 需要解释器；可先生成 pyproject.toml 改走 uv add）", en: "No interpreter selected, cannot install (without pyproject.toml, uv pip install needs an interpreter; generate pyproject.toml first to use uv add)" },
  { zh: "忽略条目不能为空", en: "Ignore entry cannot be empty" },
  { zh: "未知断边组：{edge}（合法值 e1~e4）", en: "Unknown broken-edge group: {edge} (valid values: e1~e4)" },
  { zh: "修复动作缺少包名", en: "The fix action is missing a package name" },
  { zh: "外部管理器项目：声明层同步已禁用（仅缺失包安装可用）", en: "Externally managed project: manifest sync is disabled (only installing missing packages works)" },
  { zh: "项目无声明文件，无可同步", en: "The project has no manifest file, nothing to sync" },
  { zh: "外部管理器项目：声明写入已禁用（建议迁移到 uv）", en: "Externally managed project: writing the manifest is disabled (migrating to uv is recommended)" },
  { zh: "项目无 pyproject.toml，无法写入声明——请先迁移到 pyproject", en: "The project has no pyproject.toml, cannot write the manifest — migrate to pyproject first" },
  { zh: "仅 pyproject 项目需要刷新 uv.lock", en: "Only pyproject projects need to refresh uv.lock" },
  { zh: "外部管理器项目：不适用 requirements 迁移引导", en: "Externally managed project: the requirements migration guide does not apply" },
  { zh: "未知修复动作：{other}", en: "Unknown fix action: {other}" },
  { zh: "另一个依赖修复动作正在执行，请等待其完成", en: "Another dependency fix action is running, please wait for it to finish" },
  { zh: "文件已存在：{path}", en: "File already exists: {path}" },
  { zh: "路径已存在：{path}", en: "Path already exists: {path}" },
  { zh: "源路径不存在：{old_path}", en: "Source path does not exist: {old_path}" },
  { zh: "目标路径已存在：{new_path}", en: "Target path already exists: {new_path}" },
  { zh: "当前平台不支持的资源管理器操作", en: "This file manager operation is not supported on the current platform" },
  { zh: "仅允许 http/https 链接：{u}", en: "Only http/https links are allowed: {u}" },
  { zh: "当前平台不支持打开外部链接", en: "Opening external links is not supported on the current platform" },
  { zh: "路径是目录而非文件：{}", en: "Path is a directory, not a file: {}" },
  { zh: "文件过大（{:.1} MB），超过 10 MB 上限，编辑器不支持打开", en: "File is too large ({:.1} MB), over the 10 MB limit; the editor cannot open it" },
  { zh: "文件过大（{:.1} MB），超过 32 MB 上限，无法内联为 data URI", en: "File is too large ({:.1} MB), over the 32 MB limit; cannot be inlined as a data URI" },
  { zh: "未知配置层：{scope}", en: "Unknown config layer: {scope}" },
  { zh: "项目名称非法：{name:?}（不能为空，不能包含 \\ / : * ? \" < > | 等字符）", en: "Invalid project name: {name:?} (cannot be empty or contain \\ / : * ? \" < > |)" },
  { zh: "位置不存在或不是文件夹：{parent_dir}", en: "Location does not exist or is not a folder: {parent_dir}" },
  { zh: "目标已存在：{}", en: "Target already exists: {}" },
  { zh: "草稿文件过多（已到 scratch-999），请清理草稿目录后再试", en: "Too many scratch files (reached scratch-999); clean up the scratch directory and try again" },
  { zh: "工作区目录不存在：{root}", en: "Workspace directory does not exist: {root}" },
  { zh: "删除文件失败：{p}（{e}）", en: "Failed to delete file: {p} ({e})" },
  { zh: "提交信息不能为空", en: "Commit message cannot be empty" },
  { zh: "分支名不能为空", en: "Branch name cannot be empty" },
  { zh: "提交哈希不能为空", en: "Commit hash cannot be empty" },
  { zh: "路径不能为空", en: "Path cannot be empty" },
  { zh: "拒绝绝对路径：{path}", en: "Absolute path rejected: {path}" },
  { zh: "路径不得包含 ..：{path}", en: "Path must not contain ..: {path}" },
  { zh: "路径越出仓库范围：{path}", en: "Path is outside the repository: {path}" },
  { zh: "patch 不能为空", en: "Patch cannot be empty" },
  { zh: "未知 mode：{other}", en: "Unknown mode: {other}" },
  { zh: "未知 reset 模式：{other}", en: "Unknown reset mode: {other}" },
  { zh: "未知操作：{other}", en: "Unknown operation: {other}" },
  { zh: "标签名不能为空", en: "Tag name cannot be empty" },
  { zh: "已取消", en: "Cancelled" },
  { zh: "git 网络操作超时（{}s）", en: "Git network operation timed out ({}s)" },
  { zh: "{msg}\n\n远程需要认证。可在终端配置凭据缓存后重试：\n  git config --global credential.helper store\n（首次 push/pull 时输入一次密码，之后记住；或改用 SSH 远程地址）", en: "{msg}\n\nThe remote requires authentication. Configure credential caching in a terminal and retry:\n  git config --global credential.helper store\n(enter the password once on the first push/pull and it will be remembered; or switch the remote to an SSH URL)" },
  { zh: "远程名与 URL 不能为空", en: "Remote name and URL cannot be empty" },
  { zh: "远程名不能为空", en: "Remote name cannot be empty" },
  { zh: "文件路径不能为空", en: "File path cannot be empty" },
  { zh: "worktree 路径不能为空", en: "worktree path cannot be empty" },
  { zh: "worktree 路径不得包含 ..", en: "worktree path must not contain .." },
  { zh: "非法的历史快照 id：{id}", en: "Invalid history snapshot id: {id}" },
  { zh: "uv python find 返回无效路径：{path}", en: "uv python find returned an invalid path: {path}" },
  { zh: "ScriptError: 输出缺少 ok 字段", en: "ScriptError: output is missing the ok field" },
  { zh: "Content-Length 超上限（{len} > {MAX_FRAME_LEN}）", en: "Content-Length exceeds the limit ({len} > {MAX_FRAME_LEN})" },
  { zh: "文档名不合法：{name}", en: "Invalid document name: {name}" },
  { zh: "插件 id 不合法：{id}（须字母数字开头，可含点/下划线/连字符）", en: "Invalid plugin id: {id} (must start with a letter or digit, may contain dots, underscores or hyphens)" },
  { zh: "插件名称不能为空", en: "Plugin name cannot be empty" },
  { zh: "未知模板：{template}（panel / inline / blank）", en: "Unknown template: {template} (panel / inline / blank)" },
  { zh: "目录已存在：{}（不覆盖已有插件）", en: "Directory already exists: {} (existing plugins are not overwritten)" },
  { zh: "插件文件路径必须是相对路径", en: "Plugin file path must be relative" },
  { zh: "插件文件路径不允许包含 \`..\`", en: "Plugin file path must not contain \`..\`" },
  { zh: "插件文件路径越界", en: "Plugin file path is out of bounds" },
  { zh: "插件文件不存在: {rel}", en: "Plugin file does not exist: {rel}" },
  { zh: "插件 id 不合法：{plugin_id}", en: "Invalid plugin id: {plugin_id}" },
  { zh: "插件目录不存在：{plugin_dir}", en: "Plugin directory does not exist: {plugin_dir}" },
  { zh: "创建文件失败：{e}", en: "Failed to create file: {e}" },
  { zh: "插件目录名无效", en: "Invalid plugin directory name" },
  { zh: "插件目录为空", en: "Plugin directory is empty" },
  { zh: "zip 条目数超过上限（{} > {}）", en: "Too many zip entries ({} > {})" },
  { zh: "zip 条目名非法（路径逃逸）：{}", en: "Illegal zip entry name (path escape): {}" },
  { zh: "条目 {} 超过 10MB 上限", en: "Entry {} exceeds the 10 MB limit" },
  { zh: "zip 累计解压量超过 64MB 上限", en: "Cumulative zip extraction exceeds the 64 MB limit" },
  { zh: "zip 结构不对：应只有一个顶层目录（插件 id）", en: "Invalid zip structure: expected exactly one top-level directory (the plugin id)" },
  { zh: "顶层目录名不是合法插件 id：{plugin_id}", en: "The top-level directory name is not a valid plugin id: {plugin_id}" },
  { zh: "插件目录缺少 pylume.plugin.json", en: "The plugin directory is missing pylume.plugin.json" },
  { zh: "manifest.id（{manifest_id}）与目录名（{plugin_id}）不一致", en: "manifest.id ({manifest_id}) does not match the directory name ({plugin_id})" },
  { zh: "插件 {plugin_id} 已存在（不覆盖；如需更新请先在插件目录删除旧版）", en: "Plugin {plugin_id} already exists (not overwritten; to update, delete the old version from the plugin directory first)" },
  { zh: "落盘失败：{e}", en: "Failed to write to disk: {e}" },
  { zh: "读取 manifest 失败：{e}", en: "Failed to read the manifest: {e}" },
  { zh: "非法的 trace 标识", en: "Invalid trace identifier" },
  { zh: "uv 命令超时", en: "uv command timed out" },
  { zh: "等待 uv 失败：{e}", en: "Failed to wait for uv: {e}" },
  { zh: "uv 命令失败（exit {}）：{}", en: "uv command failed (exit {}): {}" },
  { zh: "未检测到 uv，无法清理缓存", en: "uv not found, cannot clean the cache" },
  { zh: "路径为空", en: "Path is empty" },
  { zh: "目标目录与当前数据根相同", en: "The target directory is the same as the current data root" },
  { zh: "目标目录不能位于当前数据根内部", en: "The target directory must not be inside the current data root" },
  { zh: "复制数据失败：{e}", en: "Failed to copy data: {e}" },
  { zh: "运行终端会话 id 必须以 \`{RUN_TERM_PREFIX}\` 开头（前后端约定，用于与普通 shell 会话区分）", en: "Run terminal session id must start with \`{RUN_TERM_PREFIX}\` (front/back-end convention, to tell it apart from normal shell sessions)" },
  { zh: "项目配置选择了模块入口，但模块名为空", en: "The project configuration uses a module entry, but the module name is empty" },
  { zh: "未选择解释器且未找到 uv，无法在终端中运行（可在状态栏选择解释器，或先安装 uv）", en: "No interpreter selected and uv not found, cannot run in the terminal (select an interpreter in the status bar, or install uv first)" },
  { zh: "命令执行超时（{} 秒）", en: "Command timed out ({} seconds)" },
  { zh: "等待进程失败：{e}", en: "Failed to wait for the process: {e}" },
  // B3（docs/sqlite_tool_dev_plan.md）SQLite 工具窗错误码：Db* 前缀是前后端约定的分类码，
  // 英文模板保留前缀（前端按 `前缀:` 切分做 UI 分流，不依赖文案）。
  { zh: "DbCancelled:查询已取消", en: "DbCancelled:Query cancelled" },
  { zh: "DbReadOnly:只读模式下不允许写操作", en: "DbReadOnly:Write operations are not allowed in read-only mode" },
  { zh: "DbSqlError:一次只能执行一条查询语句（多条写语句可一次性批处理）", en: "DbSqlError:Only one query statement can be run at a time (multiple write statements can be batched)" },
  // git clone（迭代 6 · P3-1）历史遗漏：文案在 Rust 侧存在但一直未登记（英文界面会露中文）
  { zh: "克隆 URL 不能为空", en: "Clone URL cannot be empty" },
  { zh: "URL 格式无效：缺少协议（如 https:// 或 git@）", en: "Invalid URL format: missing scheme (e.g. https:// or git@)" },
  { zh: "不支持的 URL 协议：{scheme}", en: "Unsupported URL scheme: {scheme}" },
  { zh: "目标路径不能为空", en: "Target path cannot be empty" },
  { zh: "目标路径不得包含 ..", en: "Target path must not contain .." },
  { zh: "目标路径必须是绝对路径", en: "Target path must be an absolute path" },
];

/** 已编译的匹配器：中文模板按占位切分后拼成 `^固定(.*?)固定$`，用于从已填充的整句里捞回参数。 */
interface Compiled {
  re: RegExp;
  en: string;
}

let compiled: Compiled[] | null = null;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function compileAll(): Compiled[] {
  if (compiled) return compiled;
  compiled = PATTERNS.map((p) => {
    const frags = p.zh.split(/\{[^}]*\}/);
    let src = "^";
    frags.forEach((f, i) => {
      src += escapeRe(f);
      // 最后一段前用贪婪，其余用非贪婪：多参数时避免第一段吃掉全部
      if (i < frags.length - 1) src += i === frags.length - 2 ? "(.*)" : "(.*?)";
    });
    return { re: new RegExp(src + "$"), en: p.en };
  });
  return compiled;
}

/** 把后端错误消息翻成当前语言：命中模板则按参数套英文；未命中或当前为中文则原样返回。 */
export function localizeBackendError(msg: string): string {
  // 中文是后端文案的源语言：直接返回，既省掉 103 次正则匹配，也保证默认语言下行为与改造前完全一致。
  if (getLocale() === "zh-CN" || !msg) return msg;
  for (const c of compileAll()) {
    const m = c.re.exec(msg);
    if (!m) continue;
    let i = 1;
    return c.en.replace(/\{[^}]*\}/g, () => m[i++] ?? "");
  }
  return msg;
}
