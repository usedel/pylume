// 资源可观测（A-1，PyCharm 调研）：外壳 + 子进程的内存 / CPU 快照。
//
// 动机：PyCharm 最大的差评是「资源占用不可控且不可见」（resource pigs / space heater，
// 见 docs/pycharm_ux_review_and_proposal.md §3.1）。我们的架构结构性更轻，但「轻」必须
// **可感知**——本命令让用户（以及我们自己排查问题时）随时回答「现在是谁在吃内存」。
//
// 范围（M1 只观测，不 kill）：外壳自身 + 直接子进程（pyrefly/basedpyright、intel、
// debugpy、被运行脚本、uv 等都以本进程为父进程）。
//
// CPU 语义：sysinfo 的 cpu_usage 是「自上一次 refresh_processes 以来的百分比」——首次
// 调用恒为 0，前端按固定间隔（面板打开 2s / 芯片 30s）采样后即有意义的滑动值。

use std::sync::Mutex;

use serde::Serialize;
use sysinfo::{Pid, ProcessesToUpdate, System};

/// 复用同一个 System 实例：sysinfo 的 CPU 百分比靠两次 refresh 的差值，换实例就归零；
/// Mutex<Option<_>> 惰性初始化（首条命令到达前不做任何系统枚举）。
static SYS: Mutex<Option<System>> = Mutex::new(None);

/// 单个进程的资源信息
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    /// 常驻内存（MB）
    pub rss_mb: f64,
    /// CPU 百分比（相对上一次采样的滑动值；首次调用为 0）
    pub cpu: f64,
}

/// 一次资源快照
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcStats {
    /// 外壳自身
    pub shell: ProcInfo,
    /// 直接子进程，按内存降序（pyrefly / intel / debugpy / 被运行脚本…）
    pub children: Vec<ProcInfo>,
    /// 外壳 + 全部子进程的内存合计（MB；状态栏芯片显示这个）
    pub total_mb: f64,
}

fn to_info(pid: Pid, name: String, mem_bytes: u64, cpu: f32) -> ProcInfo {
    ProcInfo {
        pid: pid.as_u32(),
        name,
        rss_mb: (mem_bytes as f64 / 1024.0 / 1024.0 * 10.0).round() / 10.0, // 0.1MB 精度
        cpu: (cpu as f64 * 10.0).round() / 10.0,
    }
}

fn proc_stats_impl() -> Result<ProcStats, String> {
    // P2-9（2026-09-29 review，铁律 3）：poisoned 锁走 unpoison 恢复——一次持锁 panic
    // 不该让本命令永久失败（sysinfo 刷新失败后还能重建）。
    let mut guard = crate::util::unpoison(SYS.lock());
    let sys = guard.get_or_insert_with(System::new);
    // (ProcessesToUpdate::All, true)：全量刷新并移除已退出进程（防止 children 里残留死 PID）
    sys.refresh_processes(ProcessesToUpdate::All, true);

    let self_pid = Pid::from_u32(std::process::id());
    let me = sys
        .process(self_pid)
        .ok_or_else(|| "proc_stats: 自身进程不可见（异常环境）".to_string())?;
    let shell = to_info(self_pid, "Pylume（外壳）".into(), me.memory(), me.cpu_usage());

    let mut children: Vec<ProcInfo> = sys
        .processes()
        .values()
        .filter(|p| p.parent() == Some(self_pid))
        .map(|p| to_info(p.pid(), p.name().to_string_lossy().into_owned(), p.memory(), p.cpu_usage()))
        .collect();
    children.sort_by(|a, b| {
        b.rss_mb
            .partial_cmp(&a.rss_mb)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let total_mb = shell.rss_mb + children.iter().map(|c| c.rss_mb).sum::<f64>();
    Ok(ProcStats { shell, children, total_mb: (total_mb * 10.0).round() / 10.0 })
}

/// 当前外壳与子进程的资源快照
/// P1-5（2026-09-29 review，铁律 5）：refresh_processes(All) 全系统进程枚举可耗时数百
/// 毫秒，前端按固定间隔调用（面板 2s / 芯片 30s）——同步命令会在主线程周期性卡顿。
/// 改 async + spawn_blocking（与同文件 storage_usage 等重 IO 命令同纪律）。
#[tauri::command]
pub async fn proc_stats() -> Result<ProcStats, String> {
    tauri::async_runtime::spawn_blocking(proc_stats_impl)
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn to_info_rounds_to_tenth() {
        let info = to_info(Pid::from_u32(1), "x".into(), 1536 * 1024 * 1024, 3.14159);
        assert_eq!(info.rss_mb, 1536.0);
        assert_eq!(info.cpu, 3.1);
    }

    #[test]
    fn proc_stats_runs_and_contains_self() {
        // 真实调用一次：至少能看到外壳自身，且 total ≥ shell
        let st = proc_stats_impl().expect("proc_stats 应成功");
        assert!(st.shell.pid > 0);
        assert!(st.total_mb + 0.01 >= st.shell.rss_mb);
    }
}
