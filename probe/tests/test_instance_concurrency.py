"""§19-5（M4-4.1）：runs.instance 运行实例标识 + 多进程并发写库。

- instance 显式传参 / 环境变量 PYLUME_PROBE_INSTANCE / 双缺回落 ''；
- 旧库（无 instance 列）自动迁移；
- 多进程并发 save 同一 trace 库：WAL + busy_timeout 下全部落库成功、归属正确。
"""
from __future__ import annotations

import concurrent.futures
import os
import sqlite3
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pylume_probe.config import ProbeConfig  # noqa: E402
from pylume_probe.sink import ObservationSink  # noqa: E402
from pylume_probe.store import db_path, save  # noqa: E402


def _fill(sink: ObservationSink, hits: int = 1) -> None:
    fid = sink.func_id("F:/proj/app.py", "work", 3)
    for _ in range(hits):
        sink.add_hit(fid)
    sink.add_arg(fid, "x", "int", None)


def test_instance_explicit_param_beats_env(cfg, monkeypatch):
    monkeypatch.setenv("PYLUME_PROBE_INSTANCE", "run-term-project-2")
    path = save(cfg, ObservationSink(), "F:/proj", "app.py", 1.0, 0.1,
                instance="run-term-script")
    conn = sqlite3.connect(path)
    try:
        got = conn.execute("SELECT instance FROM runs").fetchall()
        assert got == [("run-term-script",)]
    finally:
        conn.close()


def test_instance_falls_back_to_env(cfg, monkeypatch):
    monkeypatch.setenv("PYLUME_PROBE_INSTANCE", "run-term-project-3")
    path = save(cfg, ObservationSink(), "F:/proj", "app.py", 1.0, 0.1)
    conn = sqlite3.connect(path)
    try:
        got = conn.execute("SELECT instance FROM runs").fetchall()
        assert got == [("run-term-project-3",)]
    finally:
        conn.close()


def test_instance_defaults_to_empty(cfg, monkeypatch):
    monkeypatch.delenv("PYLUME_PROBE_INSTANCE", raising=False)
    path = save(cfg, ObservationSink(), "F:/proj", "app.py", 1.0, 0.1)
    conn = sqlite3.connect(path)
    try:
        got = conn.execute("SELECT instance FROM runs").fetchall()
        assert got == [("",)]
    finally:
        conn.close()


def test_old_db_without_instance_column_migrates(cfg):
    """旧库（P2 布局，无 instance 列）：save 自动补列，旧行回落 ''。"""
    path = db_path(cfg, "F:/proj")
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            "CREATE TABLE runs("
            " id INTEGER PRIMARY KEY, started REAL NOT NULL, elapsed REAL NOT NULL,"
            " project TEXT NOT NULL, script TEXT NOT NULL, python TEXT NOT NULL,"
            " probe_version TEXT NOT NULL);"
            "CREATE TABLE functions("
            " fid INTEGER PRIMARY KEY, filename TEXT NOT NULL, qualname TEXT NOT NULL,"
            " lineno INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0,"
            " stale INTEGER NOT NULL DEFAULT 0,"
            " UNIQUE(filename, qualname, lineno));"
        )
        conn.execute(
            "INSERT INTO runs(started, elapsed, project, script, python, probe_version)"
            " VALUES(1.0, 0.1, 'F:/proj', 'old.py', '3.13.7', '0.x')")
        conn.commit()
    finally:
        conn.close()

    save(cfg, ObservationSink(), "F:/proj", "app.py", 2.0, 0.1,
         instance="run-term-script")
    conn = sqlite3.connect(path)
    try:
        rows = conn.execute("SELECT script, instance FROM runs ORDER BY started").fetchall()
        assert rows == [("old.py", ""), ("app.py", "run-term-script")]
    finally:
        conn.close()


# ---------- 多进程并发写库（§19-5 首版实测须覆盖并行场景） ----------

_CONCURRENCY_WORKER = '''
import sys
from pathlib import Path
sys.path.insert(0, r"{src}")
tag = sys.argv[1]
from pylume_probe.sink import ObservationSink
from pylume_probe.store import save
from pylume_probe.config import ProbeConfig

sink = ObservationSink()
fid = sink.func_id(r"F:/proj/app.py", "work_" + tag, 3)
for _ in range(50):
    sink.add_hit(fid)
sink.add_arg(fid, "x", "int", None)
save(ProbeConfig(db_dir=r"{db_dir}"), sink, "F:/proj", "app.py",
     1.0, 0.1, instance="run-term-" + tag)
'''


def test_concurrent_multi_process_saves_all_persist(cfg, tmp_path):
    """脚本 + N 项目实例并行落库：WAL + busy_timeout 下 8 进程全部成功、归属不串。

    这是对 §19-5「多进程同时写同一 SQLite trace 库」的自动化复刻——
    shell 多实例并行的写冲突面就是这条路径（进程数与 hits 放大冲突窗口）。
    """
    worker = _CONCURRENCY_WORKER.format(
        src=Path(__file__).resolve().parent.parent / "src",
        db_dir=cfg.db_dir,
    )
    worker_path = tmp_path / "_concurrency_worker.py"
    worker_path.write_text(worker, encoding="utf-8")

    tags = ["script", "project-1", "project-2", "project-3",
            "project-4", "project-5", "project-6", "project-7"]
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(tags)) as ex:
        futs = [ex.submit(
            subprocess.run, [sys.executable, "-u", str(worker_path), t],
            capture_output=True, text=True, env=env, encoding="utf-8", errors="replace",
            timeout=60,
        ) for t in tags]
        results = [f.result() for f in futs]

    for tag, r in zip(tags, results):
        assert r.returncode == 0, f"{tag}: {r.stderr}"

    path = db_path(cfg, "F:/proj")
    conn = sqlite3.connect(path)
    try:
        rows = conn.execute("SELECT instance FROM runs").fetchall()
        assert len(rows) == len(tags), "并发落库出现丢失（SQLITE_BUSY 未被 busy_timeout 兜住）"
        assert {r[0] for r in rows} == {f"run-term-{t}" for t in tags}, "实例归属串线"
        total_hits = conn.execute("SELECT SUM(hits) FROM functions").fetchone()[0]
        assert total_hits == len(tags) * 50
        # WAL 生效（journal_mode 持久化在库文件上）
        mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode.lower() == "wal"
    finally:
        conn.close()
