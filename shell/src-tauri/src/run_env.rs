// 运行环境装配（S3/S4 公共基建，偿还 tech-debt 第 8 条）：
// 把「一次 Python 运行需要注入什么」收敛成**单一来源**——`terminal::run_in_terminal`
// （portable-pty CommandBuilder）与 `dap.rs` 调试链路共用同一份装配结果，
// 杜绝两条路径的语义漂移（PYTHONPATH 四段约定：用户配置 → 继承 → 工作区根 → probe src）。
//
// 设计要点：
// - 返回 **envelope**（env 列表 + args + 告警），刻意不绑定 Command / CommandBuilder 类型，
//   两条路径各自套用（`cmd.env(k,v)` / `cb.env(k,v)`）；**顺序即优先级**（后写覆盖先写）。
// - 装配主体 [`assemble`] 是**纯函数**（不需要 AppHandle），顺序/合并规则可被单测直接锁定；
//   只有「probe/src 在哪」需要探测，由薄封装 [`build_run_env`] 负责。

use std::path::{Path, PathBuf};

use tauri::AppHandle;

use crate::env_cmds::{RunEntry, RunProfile};
use crate::tool_paths::{tool_command, ENV_UV};
use crate::util::resource_candidates;

/// 一次运行的环境装配结果（envelope）。
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RunEnv {
    /// 按注入顺序排列的环境变量：
    /// ① 默认注入（PYTHONIOENCODING / PYTHONUTF8 / PYTHONUNBUFFERED）
    /// ② PYTHONPATH 四段合并（见 [`assemble`]）
    /// ③ 运行配置的其余用户环境变量（用户值优先，覆盖 ①②）
    /// ④ probe 四件套（仅 probe_src 为 Some 时，§5.3 ⑤）
    pub(crate) env: Vec<(String, String)>,
    /// 脚本参数（`shell-words` 拆分结果，调用方追加在脚本名之后）
    pub(crate) args: Vec<String>,
    /// 非致命告警（如参数解析失败），由调用方回显给用户——不中断运行
    pub(crate) warnings: Vec<String>,
    /// probe/src 目录（None = 未开启采集或未找到；调用方据此决定是否提示「本次不采集」）
    pub(crate) probe_src: Option<PathBuf>,
}

/// 定位 probe/src 注入目录（含 sitecustomize.py 顶层模块），优先顺序：
/// 1) 环境变量 PYLUME_PROBE_SRC；
/// 2) 托管目录 <data_root>/runtime/probe/src（及 /probe 兼容）；
/// 3) Tauri 资源目录（打包分发）；
/// 4) dev 相对 exe 上溯仓库布局（probe/src）。
/// 找不到返回 None——运行照常，仅无采集（探针缺席绝不拖垮用户脚本）。
pub(crate) fn locate_probe_src(app: &AppHandle) -> Option<PathBuf> {
    let is_probe = |p: &Path| p.join("sitecustomize.py").is_file();

    if let Ok(p) = std::env::var("PYLUME_PROBE_SRC") {
        let p = PathBuf::from(p);
        if is_probe(&p) {
            return Some(p);
        }
    }

    let runtime = crate::tool_paths::runtime_dir();
    for cand in [runtime.join("probe").join("src"), runtime.join("probe")] {
        if is_probe(&cand) {
            return Some(cand);
        }
    }

    for dir in resource_candidates(app) {
        for cand in [
            dir.join("probe").join("src"),
            dir.join("resources").join("probe").join("src"),
        ] {
            if is_probe(&cand) {
                return Some(cand);
            }
        }
    }

    let mut dir = std::env::current_exe().ok()?;
    for _ in 0..5 {
        dir.pop();
        let cand = dir.join("probe").join("src");
        if is_probe(&cand) {
            return Some(cand);
        }
    }
    None
}

/// 装配一次运行的环境变量与脚本参数（`probe=false` 时的完整结果，两条运行路径共用）。
///
/// PYTHONPATH 合并顺序固化 §9 约定「用户值优先、probe src 追加在后」：
///
/// ```text
/// ① 用户运行配置 PYTHONPATH → ② 继承的既有 PYTHONPATH → ③ 工作区根 → ④ probe src（若开启）
/// ```
///
/// ③ 工作区根用于对齐 `check_missing_imports`（预检把 root 塞进 sys.path），消除「预检通过但运行
/// ModuleNotFoundError」的双标；④ probe 包名 `pylume_probe` 独占命名空间，置末不影响其可导入性，
/// 但能保证用户同名模块优先命中（不被探针遮蔽）。
///
/// **改动本函数前请先读上述约定**：这是两条运行路径一致性的唯一保证点。
pub(crate) fn build_run_env(
    app: &AppHandle,
    script_abs: &Path,
    workspace_root: Option<&str>,
    run_config: &RunProfile,
    probe: bool,
    instance: Option<&str>,
) -> RunEnv {
    let probe_src = if probe { locate_probe_src(app) } else { None };
    // TD-020：仅开启采集时才生成「每次运行唯一」的 run_id（父子共享、跨次运行不同），
    // 探针据此跨进程去重（重复摘要 / 观测翻倍）。
    let run_id = probe_src.as_ref().map(|_| generate_run_id());
    // ②-2 段（继承自 shell 的既有 PYTHONPATH）在此读取进程环境；作为显式入参下传，
    // 使四段合并顺序可被单测精确锁定，不受宿主机器环境变量干扰。
    let inherited = std::env::var("PYTHONPATH").ok().filter(|v| !v.is_empty());
    // P1-G：加载 .env 文件（有序；相对工作区根）。文件缺失仅告警不中断运行。
    let mut warnings: Vec<String> = Vec::new();
    let env_file_env = load_env_files(&run_config.env_files, workspace_root, &mut warnings);
    let mut out = assemble(script_abs, workspace_root, run_config, probe_src, inherited.as_deref(), &env_file_env, instance, run_id.as_deref());
    out.warnings.extend(warnings);
    out
}

/// 每次运行唯一的 run id（TD-020 跨进程去重键）。纯 std 生成：
/// 时间戳纳秒 + 进程 id + 进程内单调序号。只需保证「同一次运行的父子进程共享、
/// 不同次运行互不相同」，无需密码学随机。
fn generate_run_id() -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let pid = std::process::id() as u64;
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{now:x}-{pid:x}-{seq:x}")
}

/// 解析 `.env` 文件单行：`KEY=VALUE`（忽略空行/# 注释行；容忍 `export ` 前缀与成对引号包裹的值）。
fn parse_env_file_line(line: &str) -> Option<(String, String)> {
    let mut l = line.trim();
    if l.is_empty() || l.starts_with('#') {
        return None;
    }
    if let Some(rest) = l.strip_prefix("export ") {
        l = rest.trim_start();
    }
    let eq = l.find('=')?;
    let key = l[..eq].trim().to_string();
    if key.is_empty() {
        return None;
    }
    let mut value = l[eq + 1..].trim().to_string();
    // 剥去成对引号（单/双）；不成对则原样保留
    if value.len() >= 2
        && ((value.starts_with('"') && value.ends_with('"'))
            || (value.starts_with('\'') && value.ends_with('\'')))
    {
        value = value[1..value.len() - 1].to_string();
    }
    Some((key, value))
}

/// 依序加载 `.env` 文件（P1-G）：相对路径以工作区根为基准（绝对路径原样）。
/// 注入优先级：默认注入之后、用户显式 env 之前（文件不存在 / 无法读取 → 告警不中断）。
pub(crate) fn load_env_files(
    paths: &[String],
    workspace_root: Option<&str>,
    warnings: &mut Vec<String>,
) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    for raw in paths {
        let p = raw.trim();
        if p.is_empty() {
            continue;
        }
        let path = std::path::Path::new(p);
        let path = if path.is_absolute() {
            path.to_path_buf()
        } else {
            match workspace_root {
                Some(root) => std::path::Path::new(root).join(p),
                None => std::path::PathBuf::from(p),
            }
        };
        match std::fs::read_to_string(&path) {
            Ok(text) => {
                for (k, v) in text.lines().filter_map(parse_env_file_line) {
                    // 靠前的文件优先：同名键先到先得（对齐 PyCharm「有序列表逐个加载」语义）
                    if !out.iter().any(|(ek, _)| ek == &k) {
                        out.push((k, v));
                    }
                }
            }
            Err(e) => warnings.push(format!("[pylume] .env 文件无法读取：{}（{e}）\n", path.to_string_lossy())),
        }
    }
    out
}

/// 装配主体（纯函数：只依赖入参，可被单测直接锁定顺序与合并规则）。
pub(crate) fn assemble(
    script_abs: &Path,
    workspace_root: Option<&str>,
    run_config: &RunProfile,
    probe_src: Option<PathBuf>,
    inherited_pythonpath: Option<&str>,
    env_file_env: &[(String, String)],
    instance: Option<&str>,
    run_id: Option<&str>,
) -> RunEnv {
    let mut env: Vec<(String, String)> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    // ① 默认注入（P0 建议 3）：PYTHONUNBUFFERED=1 保证长任务 stdout 逐行实时刷新，不退化为
    //   「结束时一次性吐出」；两条运行分支（解释器直跑 / uv run）都生效——uv run 会把环境变量
    //   透传给子 Python；probe 采样也依赖脚本及时 flush，同样受益。
    env.push(("PYTHONIOENCODING".to_string(), "utf-8".to_string()));
    env.push(("PYTHONUTF8".to_string(), "1".to_string()));
    env.push(("PYTHONUNBUFFERED".to_string(), "1".to_string()));

    // ② PYTHONPATH 四段合并
    let sep = if cfg!(windows) { ";" } else { ":" };
    let mut path_parts: Vec<String> = Vec::new();
    // ②-1 用户自定义 PYTHONPATH（运行配置里单列，避免被下面通用 env 循环重复设置）
    let user_pythonpath = run_config
        .env
        .iter()
        .find(|kv| kv.key.eq_ignore_ascii_case("PYTHONPATH"))
        .map(|kv| kv.value.clone())
        .filter(|v| !v.trim().is_empty());
    if let Some(up) = &user_pythonpath {
        path_parts.push(up.clone());
    }
    // ②-1.5 .env 文件中的 PYTHONPATH（P1-G：紧随用户显式值之后，仍优先于继承值）
    if let Some((_, v)) = env_file_env.iter().find(|(k, _)| k.eq_ignore_ascii_case("PYTHONPATH")) {
        if !v.trim().is_empty() {
            path_parts.push(v.clone());
        }
    }
    // ②-2 继承自 shell 的既有 PYTHONPATH（同属用户值）
    if let Some(inherited) = inherited_pythonpath.filter(|v| !v.trim().is_empty()) {
        path_parts.push(inherited.to_string());
    }
    // ②-3 工作区根（P0 对齐依赖预检）
    if let Some(root) = workspace_root {
        path_parts.push(root.to_string());
    }
    // ②-4 probe src 追加在后
    if let Some(src) = &probe_src {
        path_parts.push(src.to_string_lossy().to_string());
    }
    if !path_parts.is_empty() {
        env.push(("PYTHONPATH".to_string(), path_parts.join(sep)));
    }

    // ③ .env 文件键值（P1-G：默认注入之后、用户显式 env 之前；靠前的文件优先）
    for (k, v) in env_file_env {
        if k.eq_ignore_ascii_case("PYTHONPATH") {
            continue; // 已并入 path_parts
        }
        env.push((k.clone(), v.clone()));
    }

    // ④ 其余用户自定义环境变量（用户值优先，覆盖前面的默认注入与 .env）
    for kv in &run_config.env {
        if kv.key.eq_ignore_ascii_case("PYTHONPATH") {
            continue; // 已并入 path_parts
        }
        if !kv.key.trim().is_empty() {
            env.push((kv.key.clone(), kv.value.clone()));
        }
    }

    // ④ probe 四件套（probe/src 已经 ②-4 进 PYTHONPATH，这里补 autostart 开关与元信息）。
    // PYLUME_PROBE_INSTANCE（§19-5 运行实例归属）：terminal::run_in_terminal 按会话 id
    // 注入（run-term-script / run-term-project-<N>），probe 落库时写 runs.instance——
    // 多实例并行时每次 trace 可归属到单次运行；None（调试链路 / 旧调用方）不注入。
    // PYLUME_PROBE_RUN_ID（TD-020）：每次运行唯一，probe 据此跨进程去重。
    if probe_src.is_some() {
        env.push(("PYLUME_PROBE_AUTOSTART".to_string(), "1".to_string()));
        env.push((
            "PYLUME_PROBE_SCRIPT".to_string(),
            script_abs.to_string_lossy().to_string(),
        ));
        env.push((
            "PYLUME_PROBE_HOME".to_string(),
            crate::util::pylume_home().to_string_lossy().to_string(),
        ));
        if let Some(inst) = instance {
            env.push(("PYLUME_PROBE_INSTANCE".to_string(), inst.to_string()));
        }
        if let Some(rid) = run_id.filter(|s| !s.is_empty()) {
            env.push(("PYLUME_PROBE_RUN_ID".to_string(), rid.to_string()));
        }
    }

    // 脚本参数（P3）：shell-words 拆分（支持引号/转义）；解析失败降级为「忽略参数 + 告警」，不中断运行
    let mut args: Vec<String> = Vec::new();
    if !run_config.args.trim().is_empty() {
        match shell_words::split(&run_config.args) {
            Ok(tokens) => args = tokens,
            Err(e) => warnings.push(format!("[pylume] 运行参数解析失败，已忽略 Parameters：{e}\n")),
        }
    }

    RunEnv { env, args, warnings, probe_src }
}

/// 运行命令解析结果（两条运行路径共用）：解释器直跑 或 `uv run` 兜底。
#[derive(Debug, PartialEq, Eq)]
pub(crate) struct RunCommand {
    /// 可执行程序（解释器绝对路径，或 uv 的解析结果 / 裸名 "uv"）
    pub(crate) program: String,
    /// 脚本之前的固定参数：解释器分支为 `[脚本绝对路径]`，uv 分支为 `["run", 文件名]`
    pub(crate) args: Vec<String>,
    /// 该命令自身需要的环境注入（uv 分支的 PyPI 镜像源；解释器分支为空）
    pub(crate) env: Vec<(String, String)>,
    /// 是否走 `uv run` 兜底（回显来源前缀 / 可诊断错误提示用）
    pub(crate) is_uv: bool,
}

/// 解析运行命令（P0-C）：入口二选一——
/// - script：选中解释器 → `<解释器> <脚本>`；未选中 → `uv run <文件名>` 兜底；
/// - module：选中解释器 → `<解释器> -m <模块名>`；未选中 → `uv run python -m <模块名>` 兜底。
/// v3.4 §18 裁决 3：`python_console`（-i 前置）随 v2 高级项删除——需要时手敲 `python -i <file>`。
/// 与 `run_script` 的历史分支完全一致，PTY 路径复用后不再有第二套解释器解析逻辑。
pub(crate) fn resolve_run_command(
    entry: &RunEntry,
    script_abs: &Path,
    file_name: &str,
    interpreter: Option<&str>,
) -> RunCommand {
    let module_args = || {
        let mut a = Vec::new();
        a.push("-m".to_string());
        a.push(entry.target_trimmed().to_string());
        a
    };
    match interpreter {
        Some(interp) => RunCommand {
            program: interp.to_string(),
            args: if entry.is_module() {
                module_args()
            } else {
                vec![script_abs.to_string_lossy().to_string()]
            },
            env: Vec::new(),
            is_uv: false,
        },
        None => {
            // 走 tool_command 以保持与 run_script 同一套 uv 解析（PYLUME_UV_BIN → ~/.local/bin → PATH）
            // 与 PyPI 镜像注入；这里把解析结果拆成 program + env，供 CommandBuilder 套用。
            let cmd = tool_command("uv", ENV_UV);
            let program = cmd.get_program().to_string_lossy().to_string();
            let env = cmd
                .get_envs()
                .filter_map(|(k, v)| {
                    Some((k.to_string_lossy().to_string(), v?.to_string_lossy().to_string()))
                })
                .collect();
            RunCommand {
                program,
                args: if entry.is_module() {
                    // uv run 把 "python" 当作环境内命令执行：`uv run python -m <模块>` 等价 `python -m`
                    let mut a = vec!["run".to_string(), "python".to_string()];
                    a.push("-m".to_string());
                    a.push(entry.target_trimmed().to_string());
                    a
                } else {
                    vec!["run".to_string(), file_name.to_string()]
                },
                env,
                is_uv: true,
            }
        }
    }
}

/// 解析运行工作目录（P0-D）：
/// - 显式配置：展开 `${workspaceRoot}` / `$PROJECT_DIR$` 宏；相对路径以**工作区根**为基准
///   （无工作区根时回退脚本目录，再退进程 cwd）；
/// - 空配置：module 入口 → 工作区根（`uvicorn main:app` 需在项目根导入 `main`）；
///   script 入口 → 脚本所在目录（历史行为，与 PyCharm 临时配置默认一致）。
pub(crate) fn resolve_run_cwd(
    cwd_cfg: &str,
    workspace_root: Option<&str>,
    script_dir: Option<&Path>,
    is_module: bool,
) -> PathBuf {
    let cfg = cwd_cfg.trim();
    if cfg.is_empty() {
        if is_module {
            if let Some(root) = workspace_root {
                return PathBuf::from(root);
            }
        }
        return script_dir
            .map(Path::to_path_buf)
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    }
    // 宏展开（两个宏语义等价：都指工作区根；不做更复杂的表达式引擎，见报告 §8）
    let expanded = cfg
        .replace("${workspaceRoot}", workspace_root.unwrap_or(""))
        .replace("$PROJECT_DIR$", workspace_root.unwrap_or(""));
    let p = PathBuf::from(expanded.trim());
    if p.is_absolute() {
        return p;
    }
    // 相对路径：以工作区根为基准（报告 §5-D：相对基准 = 工作区根）
    match workspace_root {
        Some(root) => PathBuf::from(root).join(p),
        None => script_dir
            .map(|d| d.join(&p))
            .unwrap_or(p),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env_cmds::{EnvVar, RunEntry};

    const SCRIPT: &str = if cfg!(windows) { "F:\\proj\\main.py" } else { "/proj/main.py" };

    fn rc(args: &str, env: Vec<EnvVar>) -> RunProfile {
        RunProfile { args: args.into(), env, ..Default::default() }
    }

    /// 装配（不挂 probe、无继承 PYTHONPATH、无 .env）——单测统一入口
    fn asm(cfg: &RunProfile, root: Option<&str>) -> RunEnv {
        assemble(Path::new(SCRIPT), root, cfg, None, None, &[], None, None)
    }

    /// §2.1 四段合并顺序的完整锁定：① 用户配置 → ② 继承 → ③ 工作区根 → ④ probe src
    #[test]
    fn pythonpath_four_segments_merge_in_fixed_order() {
        let cfg = rc("", vec![EnvVar { key: "PYTHONPATH".into(), value: "/user/lib".into() }]);
        let probe_src = PathBuf::from("/oc/probe/src");
        let e = assemble(
            Path::new(SCRIPT),
            Some("/ws/root"),
            &cfg,
            Some(probe_src.clone()),
            Some("/inherited/lib"),
            &[],
            None,
            None,
        );
        let pp = env_value(&e, "PYTHONPATH").expect("应注入 PYTHONPATH");
        let sep = if cfg!(windows) { ';' } else { ':' };
        let parts: Vec<&str> = pp.split(sep).collect();
        assert_eq!(
            parts,
            ["/user/lib", "/inherited/lib", "/ws/root", "/oc/probe/src"],
            "四段顺序即优先级：用户值优先命中，probe src 置末不遮蔽用户同名模块"
        );
    }

    #[test]
    fn inherited_blank_pythonpath_is_ignored() {
        let e = assemble(Path::new(SCRIPT), None, &rc("", vec![]), None, Some("   "), &[], None, None);
        assert!(env_value(&e, "PYTHONPATH").is_none());
    }

    fn env_value(env: &RunEnv, key: &str) -> Option<String> {
        env.env.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
    }

    #[test]
    fn defaults_are_injected_in_fixed_order() {
        let e = asm(&rc("", vec![]), None);
        let keys: Vec<&str> = e.env.iter().map(|(k, _)| k.as_str()).collect();
        // 无工作区根 / 无用户 env / 无 probe → 只剩默认三件套，且顺序固定
        assert_eq!(keys, ["PYTHONIOENCODING", "PYTHONUTF8", "PYTHONUNBUFFERED"]);
        assert_eq!(env_value(&e, "PYTHONIOENCODING").as_deref(), Some("utf-8"));
        assert_eq!(env_value(&e, "PYTHONUNBUFFERED").as_deref(), Some("1"));
    }

    #[test]
    fn workspace_root_goes_into_pythonpath() {
        // P0：对齐依赖预检——工作区根必须进 PYTHONPATH，否则「预检通过但运行 ModuleNotFoundError」
        let e = asm(&rc("", vec![]), Some(if cfg!(windows) { "F:\\proj" } else { "/proj" }));
        let pp = env_value(&e, "PYTHONPATH").expect("应注入 PYTHONPATH");
        assert!(pp.ends_with(if cfg!(windows) { "F:\\proj" } else { "/proj" }));
    }

    #[test]
    fn user_pythonpath_precedes_workspace_root_and_is_not_duplicated() {
        // §2.1 四段合并：用户值在前、工作区根在后；且 PYTHONPATH 只注入一次（不被通用 env 循环重复）
        let cfg = rc("", vec![EnvVar { key: "PYTHONPATH".into(), value: "/user/lib".into() }]);
        let e = asm(&cfg, Some("/ws/root"));
        let pp = env_value(&e, "PYTHONPATH").expect("应注入 PYTHONPATH");
        let sep = if cfg!(windows) { ';' } else { ':' };
        let parts: Vec<&str> = pp.split(sep).collect();
        assert_eq!(parts.first().unwrap(), &"/user/lib");
        assert_eq!(parts.last().unwrap(), &"/ws/root");
        assert_eq!(e.env.iter().filter(|(k, _)| k == "PYTHONPATH").count(), 1);
    }

    #[test]
    fn blank_user_pythonpath_is_ignored() {
        let cfg = rc("", vec![EnvVar { key: "PYTHONPATH".into(), value: "   ".into() }]);
        let e = asm(&cfg, None);
        assert!(env_value(&e, "PYTHONPATH").is_none());
    }

    /// P1-G：.env 键值注入位置 = 默认之后、用户显式 env 之前（用户值仍可覆盖 .env）
    #[test]
    fn env_file_env_sits_between_defaults_and_user_env() {
        let cfg = rc("", vec![EnvVar { key: "APP_MODE".into(), value: "user".into() }]);
        let env_file = vec![("APP_MODE".to_string(), "dotenv".to_string()), ("FROM_DOTENV".to_string(), "1".to_string())];
        let e = assemble(Path::new(SCRIPT), None, &cfg, None, None, &env_file, None, None);
        // 顺序即优先级：.env 先写、用户 env 后写覆盖
        let hits: Vec<&str> = e.env.iter().filter(|(k, _)| k == "APP_MODE").map(|(_, v)| v.as_str()).collect();
        assert_eq!(hits, ["dotenv", "user"]);
        assert_eq!(env_value(&e, "FROM_DOTENV").as_deref(), Some("1"));
        // 默认三件套仍在最前
        assert_eq!(e.env.first().map(|(k, _)| k.as_str()), Some("PYTHONIOENCODING"));
    }

    /// P1-G：.env 中的 PYTHONPATH 并入合并段（用户显式值之后、继承值之前）
    #[test]
    fn env_file_pythonpath_joins_merge_after_user_value() {
        let cfg = rc("", vec![EnvVar { key: "PYTHONPATH".into(), value: "/user/lib".into() }]);
        let env_file = vec![("PYTHONPATH".to_string(), "/dotenv/lib".to_string())];
        let e = assemble(Path::new(SCRIPT), Some("/ws/root"), &cfg, None, Some("/inherited/lib"), &env_file, None, None);
        let pp = env_value(&e, "PYTHONPATH").expect("应注入 PYTHONPATH");
        let sep = if cfg!(windows) { ';' } else { ':' };
        let parts: Vec<&str> = pp.split(sep).collect();
        assert_eq!(parts, ["/user/lib", "/dotenv/lib", "/inherited/lib", "/ws/root"]);
        // 通用 env 循环不重复注入
        assert_eq!(e.env.iter().filter(|(k, _)| k == "PYTHONPATH").count(), 1);
    }

    /// P1-G：.env 行解析——注释 / export 前缀 / 成对引号 / 空键
    #[test]
    fn parse_env_file_line_rules() {
        assert_eq!(parse_env_file_line("KEY=VALUE"), Some(("KEY".into(), "VALUE".into())));
        assert_eq!(parse_env_file_line("  KEY = v "), Some(("KEY".into(), "v".into())));
        assert_eq!(parse_env_file_line("export KEY=v"), Some(("KEY".into(), "v".into())));
        assert_eq!(parse_env_file_line("Q=\"hello world\""), Some(("Q".into(), "hello world".into())));
        assert_eq!(parse_env_file_line("Q='v'"), Some(("Q".into(), "v".into())));
        assert_eq!(parse_env_file_line("# comment"), None);
        assert_eq!(parse_env_file_line(""), None);
        assert_eq!(parse_env_file_line("NO_VALUE"), None);
        assert_eq!(parse_env_file_line("=empty_key"), None);
        assert_eq!(parse_env_file_line("URL=http://x?a=b"), Some(("URL".into(), "http://x?a=b".into())));
    }

    #[test]
    fn user_env_overrides_defaults_by_order() {
        // 顺序即优先级：用户把 PYTHONUNBUFFERED 改回 0 时，后写的用户值生效
        let cfg = rc("", vec![EnvVar { key: "PYTHONUNBUFFERED".into(), value: "0".into() }]);
        let e = asm(&cfg, None);
        let hits: Vec<&str> = e.env.iter().filter(|(k, _)| k == "PYTHONUNBUFFERED").map(|(_, v)| v.as_str()).collect();
        assert_eq!(hits, ["1", "0"]); // 套用方按序 env()，后者覆盖前者
        assert!(env_value(&e, "MY_MISSING").is_none());
    }

    #[test]
    fn blank_env_key_is_skipped() {
        let cfg = rc("", vec![EnvVar { key: "  ".into(), value: "x".into() }]);
        let e = asm(&cfg, None);
        assert_eq!(e.env.len(), 3); // 只有默认三件套
    }

    #[test]
    fn probe_trio_and_pythonpath_tail() {
        // probe/src 追加在 PYTHONPATH **末位**（用户同名模块优先命中，不被探针遮蔽）+ 四件套
        let probe_src = PathBuf::from(if cfg!(windows) { "F:\\oc\\probe\\src" } else { "/oc/probe/src" });
        let e = assemble(Path::new(SCRIPT), Some("/ws/root"), &rc("", vec![]), Some(probe_src.clone()), None, &[], None, None);
        let pp = env_value(&e, "PYTHONPATH").expect("应注入 PYTHONPATH");
        let sep = if cfg!(windows) { ';' } else { ':' };
        let parts: Vec<&str> = pp.split(sep).collect();
        assert_eq!(parts.first().unwrap(), &"/ws/root");
        assert_eq!(parts.last().unwrap(), &probe_src.to_string_lossy());
        assert_eq!(env_value(&e, "PYLUME_PROBE_AUTOSTART").as_deref(), Some("1"));
        assert_eq!(env_value(&e, "PYLUME_PROBE_SCRIPT").as_deref(), Some(SCRIPT));
        assert!(!crate::util::pylume_home().to_string_lossy().is_empty());
        assert!(env_value(&e, "PYLUME_PROBE_HOME").is_some());
        assert_eq!(e.probe_src.as_deref(), Some(probe_src.as_path()));
        // instance 未传 → 不注入（调试链路 / 无归属语义的调用方）
        assert!(env_value(&e, "PYLUME_PROBE_INSTANCE").is_none());
    }

    /// §19-5：instance 传入 → PYLUME_PROBE_INSTANCE 注入（runs.instance 归属键）
    #[test]
    fn probe_instance_env_injected_when_provided() {
        let probe_src = PathBuf::from(if cfg!(windows) { "F:\\oc\\probe\\src" } else { "/oc/probe/src" });
        let e = assemble(
            Path::new(SCRIPT),
            Some("/ws/root"),
            &rc("", vec![]),
            Some(probe_src),
            None,
            &[],
            Some("run-term-project-2"),
            None,
        );
        assert_eq!(env_value(&e, "PYLUME_PROBE_INSTANCE").as_deref(), Some("run-term-project-2"));
        // probe 关闭时 instance 一并不注入（四件套整体缺席）
        let e2 = asm(&rc("", vec![]), Some("/ws/root"));
        assert!(env_value(&e2, "PYLUME_PROBE_INSTANCE").is_none());
        assert!(env_value(&e2, "PYLUME_PROBE_AUTOSTART").is_none());
    }

    /// TD-020：run_id 传入 → PYLUME_PROBE_RUN_ID 注入（父子共享、跨进程去重键）
    #[test]
    fn probe_run_id_env_injected_when_provided() {
        let probe_src = PathBuf::from(if cfg!(windows) { "F:\\oc\\probe\\src" } else { "/oc/probe/src" });
        let e = assemble(
            Path::new(SCRIPT),
            Some("/ws/root"),
            &rc("", vec![]),
            Some(probe_src),
            None,
            &[],
            None,
            Some("run-abc123"),
        );
        assert_eq!(env_value(&e, "PYLUME_PROBE_RUN_ID").as_deref(), Some("run-abc123"));
        // probe 关闭 → 不注入
        let e2 = asm(&rc("", vec![]), Some("/ws/root"));
        assert!(env_value(&e2, "PYLUME_PROBE_RUN_ID").is_none());
        // run_id 为空串 → 不注入
        let e3 = assemble(
            Path::new(SCRIPT),
            Some("/ws/root"),
            &rc("", vec![]),
            Some(PathBuf::from(if cfg!(windows) { "F:\\oc\\probe\\src" } else { "/oc/probe/src" })),
            None,
            &[],
            None,
            Some(""),
        );
        assert!(env_value(&e3, "PYLUME_PROBE_RUN_ID").is_none());
    }

    #[test]
    fn args_split_supports_quotes() {
        let e = asm(&rc(r#"--name "hello world" --n=2"#, vec![]), None);
        assert_eq!(e.args, ["--name", "hello world", "--n=2"]);
        assert!(e.warnings.is_empty());
    }

    #[test]
    fn args_split_failure_degrades_to_warning() {
        // 未闭合引号 → 忽略参数并告警，不中断运行
        let e = asm(&rc(r#"--name "unclosed"#, vec![]), None);
        assert!(e.args.is_empty());
        assert_eq!(e.warnings.len(), 1);
        assert!(e.warnings[0].contains("运行参数解析失败"));
    }

    #[test]
    fn resolve_run_command_prefers_interpreter() {
        let script = Path::new(SCRIPT);
        let c = resolve_run_command(&RunEntry::default(), script, "main.py", Some("F:/proj/.venv/Scripts/python.exe"));
        assert!(!c.is_uv);
        assert_eq!(c.program, "F:/proj/.venv/Scripts/python.exe");
        // 解释器分支：脚本绝对路径就是唯一的前置参数（运行配置 args 由调用方追加在其后）
        assert_eq!(c.args, vec![script.to_string_lossy().to_string()]);
        assert!(c.env.is_empty());
    }

    #[test]
    fn resolve_run_command_falls_back_to_uv_run() {
        let c = resolve_run_command(&RunEntry::default(), Path::new(SCRIPT), "main.py", None);
        assert!(c.is_uv);
        assert_eq!(c.args, ["run".to_string(), "main.py".to_string()]);
        assert!(!c.program.is_empty()); // 裸名 "uv" 或解析到的绝对路径
    }

    /// P0-C：module 入口 = `python -m <模块>`；uv 兜底 = `uv run python -m <模块>`
    #[test]
    fn resolve_run_command_module_entry() {
        let script = Path::new(SCRIPT);
        let entry = RunEntry { kind: "module".into(), target: "uvicorn".into() };
        let c = resolve_run_command(&entry, script, "main.py", Some("F:/py/python.exe"));
        assert!(!c.is_uv);
        assert_eq!(c.program, "F:/py/python.exe");
        assert_eq!(c.args, ["-m".to_string(), "uvicorn".to_string()]);

        let c2 = resolve_run_command(&entry, script, "main.py", None);
        assert!(c2.is_uv);
        assert_eq!(c2.args, ["run".to_string(), "python".to_string(), "-m".to_string(), "uvicorn".to_string()]);
    }

    /// P0-D：cwd 解析——宏展开 / 相对基准工作区根 / 空值默认（module→根，script→脚本目录）
    #[test]
    fn resolve_run_cwd_rules() {
        let script_dir = Path::new(if cfg!(windows) { "F:\\proj\\pkg" } else { "/proj/pkg" });
        let root = if cfg!(windows) { "F:\\proj" } else { "/proj" };

        // 空配置 + script 入口 → 脚本目录（历史行为）
        assert_eq!(resolve_run_cwd("", Some(root), Some(script_dir), false), script_dir);
        // 空配置 + module 入口 → 工作区根
        assert_eq!(resolve_run_cwd("", Some(root), Some(script_dir), true), Path::new(root));
        // 宏展开（两种写法等价）
        let macro_v = if cfg!(windows) { "F:\\proj" } else { "/proj" };
        assert_eq!(resolve_run_cwd("${workspaceRoot}", Some(root), Some(script_dir), false), Path::new(macro_v));
        assert_eq!(resolve_run_cwd("$PROJECT_DIR$", Some(root), Some(script_dir), true), Path::new(macro_v));
        // 宏拼接子目录
        let sub = if cfg!(windows) { "F:\\proj\\src" } else { "/proj/src" };
        assert_eq!(resolve_run_cwd("${workspaceRoot}/src", Some(root), Some(script_dir), false), Path::new(sub));
        // 相对路径 → 以工作区根为基准
        assert_eq!(resolve_run_cwd("src", Some(root), Some(script_dir), false), Path::new(sub));
        // 无工作区根 + 相对路径 → 回退脚本目录
        let fallback = if cfg!(windows) { "F:\\proj\\pkg\\src" } else { "/proj/pkg/src" };
        assert_eq!(resolve_run_cwd("src", None, Some(script_dir), false), Path::new(fallback));
    }
}
