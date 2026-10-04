// Python 求值桥（PR-1，docs/python_library_support_dev_plan.md §3）：
// 受控脚本求值——前端各「库特别支持」面板（正则 / 格式串 / 参数表单）统一经本命令
// 在真实 Python 解释器下执行白名单脚本，**绝不执行任意用户代码**（定案 D-4）。
//
// 设计要点：
// - 脚本 `include_str!` 编译进二进制（R-3：不走 bundle resources，打包不遗漏）；
// - kind 白名单常量表，未命中 → `BadKind`，绝不拼字符串到命令行；
// - args_json 走 **stdin**（正则含引号/反斜杠/换行；Windows argv ~32K 限制与引号转义陷阱），kind 走 argv；
// - `python -I -X utf8`：-X utf8 强制 UTF-8 stdio（-I 屏蔽 PYTHONIOENCODING/PYTHONUTF8，
//   Windows locale 编码会破坏 stdout JSON），Rust 侧按 UTF-8 字节显式解码；
// - 解释器优先级：工作区配置/.venv（env_cmds::get_interpreter）→ 进程内缓存 → `uv python find`；
//   **仅缓存指向工作区 .venv 的 find 结果**（.venv 不存在时 find 返回系统解释器，缓存会跨工作区错配）；
// - 错误码：NoInterpreter / Timeout / BadKind / ScriptError（前端按码分流四态文案）。

use std::collections::HashMap;
use std::path::Path;
use std::process::Command;
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use crate::env_cmds;
use crate::tool_paths::{tool_command, ENV_UV};

const SCRIPT_REGEX_TEST: &str = include_str!("../scripts/regex_test.py");
const SCRIPT_FORMAT_PREVIEW: &str = include_str!("../scripts/format_preview.py");
const SCRIPT_AST_ARGPARSE: &str = include_str!("../scripts/ast_argparse.py");
const SCRIPT_AST_INTROSPECT: &str = include_str!("../scripts/ast_introspect.py");

/// kind 白名单脚本表（D-4：不开放任意代码执行）
const SCRIPTS: &[(&str, &str)] = &[
    ("regex_test", SCRIPT_REGEX_TEST),
    ("format_preview", SCRIPT_FORMAT_PREVIEW),
    ("ast_argparse", SCRIPT_AST_ARGPARSE),
    ("ast_introspect", SCRIPT_AST_INTROSPECT),
];

/// 直连求值超时（探针 P1：直连 126ms，3s 余量充足）
const EVAL_TIMEOUT: Duration = Duration::from_secs(3);
/// ast_argparse 解析较大脚本，放宽到 5s
const ARGPARSE_TIMEOUT: Duration = Duration::from_secs(5);
/// `uv python find` 首次冷启动超时（探针 P1b 冷启动实测 965ms，8s 余量）
const FIND_TIMEOUT: Duration = Duration::from_secs(8);

/// 解释器进程内缓存（key = 工作区根）：换工作区自然失效；换解释器走 get_interpreter 优先，不受影响。
/// 仅缓存指向工作区 .venv 的 find 结果（P1b 定案）。
static INTERPRETER_CACHE: LazyLock<Mutex<HashMap<String, String>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// kind → 受控脚本源码；白名单未命中返回 None
fn script_for(kind: &str) -> Option<&'static str> {
    SCRIPTS.iter().find(|(k, _)| *k == kind).map(|(_, s)| *s)
}

/// 求值超时（ast_argparse / ast_introspect 5s，其余 3s）
fn eval_timeout(kind: &str) -> Duration {
    if kind == "ast_argparse" || kind == "ast_introspect" {
        ARGPARSE_TIMEOUT
    } else {
        EVAL_TIMEOUT
    }
}

/// 求值执行期错误分类：超时 → Timeout，其余（spawn 失败等）→ NoInterpreter。
/// 非零退出 / 协议解析失败在调用点归 ScriptError。
fn classify_eval_err(e: String) -> String {
    if e.contains("超时") {
        format!("Timeout: {e}")
    } else {
        format!("NoInterpreter: {e}")
    }
}

/// 解释器解析：配置/.venv（get_interpreter）→ 进程内缓存 → uv python find（cwd = 工作区根）。
/// 失败一律 Err（调用点统一加 NoInterpreter 前缀）。
fn resolve_interpreter(root: &str) -> Result<String, String> {
    if let Some(p) = env_cmds::get_interpreter(root.to_string()).ok().flatten() {
        return Ok(p);
    }
    if let Some(p) = INTERPRETER_CACHE
        .lock()
        .unwrap_or_else(|p| p.into_inner())
        .get(root)
    {
        return Ok(p.clone());
    }
    let mut cmd = tool_command("uv", ENV_UV);
    cmd.args(["python", "find"]).current_dir(root);
    let (out, err, code) = env_cmds::run_with_timeout(&mut cmd, FIND_TIMEOUT)
        .map_err(|e| format!("uv python find 失败：{e}"))?;
    if code != Some(0) {
        let msg = format!("{out}{err}");
        let msg = msg.trim();
        return Err(if msg.is_empty() {
            format!("uv python find 异常退出（exit {code:?}）")
        } else {
            msg.to_string()
        });
    }
    let path = out.trim().to_string();
    if path.is_empty() || !Path::new(&path).is_file() {
        return Err(format!("uv python find 返回无效路径：{path}"));
    }
    // P1b：仅当 find 结果位于工作区 .venv 内才缓存（.venv 不存在时 find 返回系统解释器）
    let venv_dir = Path::new(root).join(".venv");
    if Path::new(&path).starts_with(&venv_dir) {
        INTERPRETER_CACHE
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .insert(root.to_string(), path.clone());
    }
    Ok(path)
}

/// 解析脚本 stdout 为输出协议 JSON：取最后一个非空行，校验含 ok 字段。
/// 失败归 ScriptError（脚本语义崩溃 / 协议被污染）。
fn parse_eval_output(stdout: &[u8]) -> Result<serde_json::Value, String> {
    let text = String::from_utf8_lossy(stdout);
    let line = text.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    let v: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|e| format!("ScriptError: 输出协议解析失败：{e}"))?;
    if v.get("ok").is_none() {
        return Err("ScriptError: 输出缺少 ok 字段".into());
    }
    Ok(v)
}

fn py_eval_impl(root: &str, kind: &str, args_json: &str) -> Result<String, String> {
    let script = script_for(kind).ok_or_else(|| format!("BadKind: {kind}"))?;
    // args_json 提前校验：非法 JSON 不启动子进程（前端传参 bug 快速暴露）
    let _: serde_json::Value = serde_json::from_str(args_json)
        .map_err(|e| format!("ScriptError: args_json 不是合法 JSON：{e}"))?;

    let interpreter = resolve_interpreter(root).map_err(|e| format!("NoInterpreter: {e}"))?;

    let mut cmd = Command::new(&interpreter);
    cmd.arg("-I")
        .arg("-X")
        .arg("utf8")
        .arg("-c")
        .arg(script)
        .arg(kind) // kind 走 argv（脚本侧可校验；args_json 走 stdin）
        .current_dir(root);
    if !root.is_empty() {
        cmd.env("PYLUME_WORKSPACE_ROOT", root); // 沿用 check_missing_imports_impl 先例
    }

    let (out, err, code) = env_cmds::run_with_timeout_bytes(&mut cmd, eval_timeout(kind), Some(args_json.as_bytes()))
        .map_err(classify_eval_err)?;
    if code != Some(0) {
        let msg = format!(
            "{}{}",
            String::from_utf8_lossy(&out),
            String::from_utf8_lossy(&err)
        );
        let msg = msg.trim();
        return Err(format!(
            "ScriptError: {}",
            if msg.is_empty() {
                format!("脚本异常退出（exit {code:?}）")
            } else {
                msg.to_string()
            }
        ));
    }
    parse_eval_output(&out).map(|v| v.to_string())
}

/// Python 求值桥入口（PR-1）：前端经 `invoke("py_eval", { workspace_root, kind, args_json })` 调用。
/// 成功返回 stdout 协议 JSON 单行（`{"ok":true,"data":…}` / `{"ok":false,"error":"…"}`）；
/// 基建失败返回 Err（`<错误码>: <详情>`）。
#[tauri::command]
pub async fn py_eval(workspace_root: String, kind: String, args_json: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || py_eval_impl(&workspace_root, &kind, &args_json))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmpdir(tag: &str) -> String {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("pylume-lib-cmds-{tag}-{nanos}"));
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().to_string()
    }

    /// 本机可用解释器（python / python3）；无则跳过子进程相关用例
    fn any_python() -> Option<String> {
        for cand in ["python", "python3"] {
            let mut cmd = Command::new(cand);
            cmd.arg("-I").arg("-c").arg("print(1)");
            if env_cmds::run_with_timeout(&mut cmd, Duration::from_secs(5))
                .map(|(_, _, c)| c)
                == Ok(Some(0))
            {
                return Some(cand.to_string());
            }
        }
        None
    }

    #[test]
    fn script_table_complete_and_wellformed() {
        let kinds: Vec<&str> = SCRIPTS.iter().map(|(k, _)| *k).collect();
        assert_eq!(
            kinds,
            vec!["regex_test", "format_preview", "ast_argparse", "ast_introspect"]
        );
        for (kind, src) in SCRIPTS {
            assert!(!src.trim().is_empty(), "{kind} 脚本为空");
            // 协议特征：stdin 进 JSON + stdout 出单行 JSON（{"ok" 出口存在）
            assert!(src.contains("json.loads(sys.stdin.read()"), "{kind} 未从 stdin 读参");
            assert!(src.contains("json.dumps(out"), "{kind} 未按协议输出");
            assert!(src.contains("\"ok\""), "{kind} 输出缺 ok 字段");
        }
    }

    #[test]
    fn bad_kind_rejected_before_subprocess() {
        // 白名单未命中 → BadKind，且在解释器解析之前拦截（空工作区即可测）
        let err = py_eval_impl(&tmpdir("badkind"), "__no_such_kind__", "{}").unwrap_err();
        assert!(err.starts_with("BadKind"), "实际错误：{err}");
        // 正常 kind 不会被误拒
        for (kind, _) in SCRIPTS {
            // 非法 args_json 的 ScriptError（而非 BadKind）证明 kind 已过白名单
            let err = py_eval_impl(&tmpdir("kindok"), kind, "not-json").unwrap_err();
            assert!(err.starts_with("ScriptError"), "kind={kind} 实际错误：{err}");
        }
    }

    #[test]
    fn eval_output_protocol_parse() {
        let ok = parse_eval_output(br#"{"ok":true,"data":{"a":1}}"#).unwrap();
        assert_eq!(ok["ok"], serde_json::json!(true));
        let fail = parse_eval_output(b"noise line\n{\"ok\":false,\"error\":\"re.error: x\"}\n").unwrap();
        assert_eq!(fail["error"], serde_json::json!("re.error: x"));
        // 缺 ok 字段 / 非 JSON → ScriptError
        assert!(parse_eval_output(b"{\"data\":1}").unwrap_err().starts_with("ScriptError"));
        assert!(parse_eval_output(b"garbage").unwrap_err().starts_with("ScriptError"));
        assert!(parse_eval_output(b"").unwrap_err().starts_with("ScriptError"));
    }

    #[test]
    fn eval_err_classification() {
        assert!(classify_eval_err("命令执行超时（3s）".into()).starts_with("Timeout"));
        assert!(classify_eval_err("program not found".into()).starts_with("NoInterpreter"));
    }

    #[test]
    fn stdin_utf8_roundtrip_with_real_python() {
        let Some(py) = any_python() else {
            eprintln!("本机无 Python，跳过 stdin/UTF-8 往返用例");
            return;
        };
        let script = "import sys, json; sys.stdout.write(json.dumps({'ok': True, 'data': sys.stdin.read()}, ensure_ascii=False))";
        let mut cmd = Command::new(&py);
        cmd.arg("-I").arg("-X").arg("utf8").arg("-c").arg(script);
        // 覆盖：换行 / 引号 / 反斜杠 / 中文 / re.X 多行模式等 stdin 传参场景
        let payload = "line1\nline2 \"q\" \\d+ 中文";
        let (out, _, code) =
            env_cmds::run_with_timeout_bytes(&mut cmd, Duration::from_secs(10), Some(payload.as_bytes())).unwrap();
        assert_eq!(code, Some(0));
        let v: serde_json::Value = serde_json::from_slice(&out).unwrap();
        assert_eq!(v["data"], serde_json::json!(payload));
    }

    #[test]
    fn eval_timeout_branch() {
        let Some(py) = any_python() else {
            eprintln!("本机无 Python，跳过超时分支用例");
            return;
        };
        let mut cmd = Command::new(&py);
        cmd.arg("-I").arg("-c").arg("import time; time.sleep(5)");
        let err = env_cmds::run_with_timeout_bytes(&mut cmd, Duration::from_secs(1), None).unwrap_err();
        assert!(err.contains("超时"), "实际错误：{err}");
        assert!(classify_eval_err(err).starts_with("Timeout"));
    }

    #[test]
    fn resolve_interpreter_reports_missing() {
        // 空临时目录：无配置解释器、无 .venv；uv python find 失败 → Err（调用点加 NoInterpreter 前缀）。
        // 注：本机装了 uv 时 find 会命中系统解释器 → Ok，此用例退化为「不 panic、结果可执行」。
        let root = tmpdir("noenv");
        match resolve_interpreter(&root) {
            Ok(p) => assert!(Path::new(&p).is_file(), "find 结果应存在：{p}"),
            Err(e) => {
                assert!(classify_eval_err(e).starts_with("NoInterpreter"));
            }
        }
    }
}
