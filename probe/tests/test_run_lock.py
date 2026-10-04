"""TD-020：run_id 跨进程去重锁（O_CREAT|O_EXCL 墓碑）单元测试。

锁语义：同一 run_id 首个进程拿锁（True=负责落库+打印），后续同 run_id 进程
返回 False（跳过）；不同 run_id 各自一次；非法 run_id / OSError 保守放行。
"""
from __future__ import annotations

import os
import time
from pathlib import Path

from pylume_probe.autostart import (
    _LOCK_MAX_AGE,
    _acquire_run_lock,
    _cleanup_stale_locks,
)


def test_first_wins_second_skips(tmp_path: Path) -> None:
    lock_dir = tmp_path / "locks"
    assert _acquire_run_lock("run-1", lock_dir) is True
    assert _acquire_run_lock("run-1", lock_dir) is False  # 同 run_id 已有进程落库
    assert _acquire_run_lock("run-2", lock_dir) is True  # 不同 run_id 各自一次


def test_invalid_run_id_falls_back_to_allow(tmp_path: Path) -> None:
    lock_dir = tmp_path / "locks"
    # 含路径分隔符 / 点段 → 不去重，保守放行（绝不因锁失败吞掉采集）
    assert _acquire_run_lock("../../etc/passwd", lock_dir) is True
    assert _acquire_run_lock("a/b", lock_dir) is True


def test_cleanup_stale_locks_by_mtime(tmp_path: Path) -> None:
    lock_dir = tmp_path / "locks"
    lock_dir.mkdir(parents=True)
    fresh = lock_dir / "fresh-1.lock"
    fresh.write_text("", encoding="utf-8")
    old = lock_dir / "old-1.lock"
    old.write_text("", encoding="utf-8")
    stale_at = time.time() - _LOCK_MAX_AGE - 10
    os.utime(old, (stale_at, stale_at))

    _cleanup_stale_locks(lock_dir, time.time())

    assert fresh.exists()
    assert not old.exists()