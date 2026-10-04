"""注入模式引导：进程启动即挂探针，atexit 落库。

sitecustomize 在主脚本之前执行——这里只挂监控、注册 atexit 收尾，
不接管主脚本执行（避免重复运行）。主脚本的正常退出 / sys.exit() /
未捕获异常，atexit 都会触发落库（异常路径的 trace 最有价值）。

argv[0] 守卫：multiprocessing spawn 子进程等会带着同样的环境变量重启，
但 argv[0] 不是目标脚本——跳过，避免重复采集。
"""
from __future__ import annotations

import atexit
import os
import re
import sys
import time
from pathlib import Path

# TD-020：同一次运行的父子进程共用同一个 run_id，退出时用 O_CREAT|O_EXCL 墓碑文件
# 保证「只落库+打印一次」，消除重复摘要与观测翻倍。纯标准库实现（架构第一原则：零第三方依赖）。
_RUN_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_LOCK_SUFFIX = ".lock"
_LOCK_MAX_AGE = 24 * 3600  # 墓碑保留一天的秒数（覆盖同 run 内后续进程退出，按 mtime 惰性清理）


def _cleanup_stale_locks(lock_dir: Path, now: float) -> None:
    """清理过期墓碑（mtime 超过 _LOCK_MAX_AGE），防止锁文件无限累积。"""
    try:
        names = os.listdir(lock_dir)
    except OSError:
        return
    for name in names:
        if not name.endswith(_LOCK_SUFFIX):
            continue
        p = lock_dir / name
        try:
            if now - os.path.getmtime(p) > _LOCK_MAX_AGE:
                os.unlink(p)
        except OSError:
            pass


def _acquire_run_lock(run_id: str, lock_dir: Path) -> bool:
    """跨进程原子去重锁：True=本进程负责落库+打印；False=同 run_id 已有进程落库。

    - run_id 非法（含路径分隔符等）→ 保守放行（True），绝不因锁失败吞掉采集；
    - 任何 OSError（权限/盘满）→ 放行（True），采集正确性优先于去重。
    """
    if not _RUN_ID_RE.match(run_id):
        return True
    try:
        lock_dir.mkdir(parents=True, exist_ok=True)
    except OSError:
        return True
    _cleanup_stale_locks(lock_dir, time.time())
    try:
        fd = os.open(lock_dir / f"{run_id}{_LOCK_SUFFIX}",
                     os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except FileExistsError:
        return False
    except OSError:
        return True
    os.close(fd)
    return True


def bootstrap() -> None:
    script = os.environ.get("PYLUME_PROBE_SCRIPT", "")
    if not script or not os.path.isfile(script):
        return  # 非目标进程（如 uv 内部调用）——静默跳过
    # argv[0] 守卫：仅主脚本进程挂探针
    # CR-19：os.path.normcase 归一化大小写（Windows 上 argv[0] 与 script 的大小写
    # 可能因启动方式不同而不同，严格相等会误判主进程为子进程而跳过采集）
    try:
        if os.path.normcase(os.path.abspath(sys.argv[0])) != os.path.normcase(os.path.abspath(script)):
            return
    except (IndexError, ValueError):
        return
    # PEP 669（sys.monitoring）需要 Python 3.12+：低版本明确提示后跳过采集，
    # 不让 AttributeError 从 Monitor.start() 深处冒出来（P1-BUG-003）
    if sys.version_info < (3, 12):
        print(f"[pylume-probe] ⚠ 当前 Python {sys.version.split()[0]} < 3.12，"
              f"无 sys.monitoring（PEP 669），本次运行不采集（脚本正常运行不受影响）",
              file=sys.stderr)
        return
    from .config import load_config, probe_home
    from .monitor import Monitor
    from .sink import ObservationSink
    from .store import save

    cfg = load_config()
    project_root = os.path.dirname(os.path.abspath(script))
    lock_dir = probe_home() / "locks"
    sink = ObservationSink()
    mon = Monitor(cfg, sink, project_root)

    wall_started = time.time()
    perf_started = time.perf_counter()
    mon.start()

    def _finalize() -> None:
        try:
            # TD-020：同一 run_id 的父子进程退出时都触发 _finalize，仅首个进程落库+打印
            run_id = os.environ.get("PYLUME_PROBE_RUN_ID", "").strip()
            if run_id and not _acquire_run_lock(run_id, lock_dir):
                return
            mon.stop()
            elapsed = time.perf_counter() - perf_started
            path = save(cfg, sink, project_root, script, wall_started, elapsed)
            if not cfg.quiet:
                print(f"[pylume-probe] ✓ {sink.func_count} 函数 · "
                      f"{sink.observation_count} 类型观测 · {elapsed:.3f}s → {path}",
                      file=sys.stderr)
        except Exception as e:  # noqa: BLE001 - 落库失败绝不改写用户进程退出码
            print(f"[pylume-probe] ⚠ 落库失败：{e}", file=sys.stderr)

    atexit.register(_finalize)
