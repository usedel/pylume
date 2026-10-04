"""P2-T07 trace 库管理单测：陈旧标记 + clean 命令。"""
from __future__ import annotations

import os
import sqlite3
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pylume_probe.config import ProbeConfig  # noqa: E402
from pylume_probe.sink import ObservationSink  # noqa: E402
from pylume_probe.store import clean, db_path, load_summary, save  # noqa: E402


def _fill(sink: ObservationSink, filename: str = "F:/proj/scraper.py"):
    fid = sink.func_id(filename, "parse_page", 17)
    sink.add_hit(fid)
    sink.add_arg(fid, "html", "str", None)
    sink.add_ret(fid, "dict[str, str|list[str]]", '["links","title"]')


def _stale_of(path: Path, qualname: str) -> int:
    conn = sqlite3.connect(path)
    try:
        return conn.execute(
            "SELECT stale FROM functions WHERE qualname=?", (qualname,)).fetchone()[0]
    finally:
        conn.close()


def test_stale_marked_when_file_modified_after_run(cfg, tmp_path):
    """运行 1 采集 → 修改文件 mtime → 运行 2（不覆盖该文件）→ 标陈旧。"""
    f = tmp_path / "scraper.py"
    f.write_text("x = 1\n", encoding="utf-8")
    sink = ObservationSink()
    _fill(sink, str(f))
    path = save(cfg, sink, str(tmp_path), "scraper.py", 1.0, 0.5)
    assert _stale_of(path, "parse_page") == 0

    # 模拟代码变更：mtime 推到未来
    future = time.time() + 100
    os.utime(f, (future, future))

    # 运行 2：sink 只含另一个文件的函数（不覆盖 scraper.py）
    sink2 = ObservationSink()
    fid = sink2.func_id(str(tmp_path / "other.py"), "other_fn", 1)
    sink2.add_hit(fid)
    save(cfg, sink2, str(tmp_path), "other.py", 2.0, 0.5)
    assert _stale_of(path, "parse_page") == 1  # 已标陈旧


def test_stale_cleared_when_file_rerun(cfg, tmp_path):
    """陈旧函数所在文件再次运行 → 清回 stale=0。"""
    f = tmp_path / "scraper.py"
    f.write_text("x = 1\n", encoding="utf-8")
    sink = ObservationSink()
    _fill(sink, str(f))
    path = save(cfg, sink, str(tmp_path), "scraper.py", 1.0, 0.5)

    future = time.time() + 100
    os.utime(f, (future, future))
    sink2 = ObservationSink()
    fid = sink2.func_id(str(tmp_path / "other.py"), "other_fn", 1)
    sink2.add_hit(fid)
    save(cfg, sink2, str(tmp_path), "other.py", 2.0, 0.5)
    assert _stale_of(path, "parse_page") == 1

    # 运行 3：再次覆盖 scraper.py → 清回 0
    sink3 = ObservationSink()
    _fill(sink3, str(f))
    save(cfg, sink3, str(tmp_path), "scraper.py", 3.0, 0.5)
    assert _stale_of(path, "parse_page") == 0


def test_stale_when_file_deleted(cfg, tmp_path):
    """文件被删除 → mtime 不可得 → 标陈旧（观测对应的代码已不存在）。"""
    f = tmp_path / "scraper.py"
    f.write_text("x = 1\n", encoding="utf-8")
    sink = ObservationSink()
    _fill(sink, str(f))
    path = save(cfg, sink, str(tmp_path), "scraper.py", 1.0, 0.5)

    f.unlink()
    sink2 = ObservationSink()
    fid = sink2.func_id(str(tmp_path / "other.py"), "other_fn", 1)
    sink2.add_hit(fid)
    save(cfg, sink2, str(tmp_path), "other.py", 2.0, 0.5)
    assert _stale_of(path, "parse_page") == 1


def test_no_stale_when_file_untouched(cfg, tmp_path):
    """文件未修改（mtime < 末次 run）→ 不标陈旧。"""
    f = tmp_path / "scraper.py"
    f.write_text("x = 1\n", encoding="utf-8")
    # 文件 mtime 设为过去（真实时间语义：文件在运行前就存在且未改）
    past = time.time() - 1000
    os.utime(f, (past, past))
    sink = ObservationSink()
    _fill(sink, str(f))
    path = save(cfg, sink, str(tmp_path), "scraper.py", time.time() - 500, 0.5)

    sink2 = ObservationSink()
    fid = sink2.func_id(str(tmp_path / "other.py"), "other_fn", 1)
    sink2.add_hit(fid)
    save(cfg, sink2, str(tmp_path), "other.py", time.time() - 100, 0.5)
    assert _stale_of(path, "parse_page") == 0


def test_load_summary_includes_stale(cfg, tmp_path):
    """load_summary 输出 stale 字段（Phase 3 消费接口）。"""
    f = tmp_path / "scraper.py"
    f.write_text("x = 1\n", encoding="utf-8")
    sink = ObservationSink()
    _fill(sink, str(f))
    path = save(cfg, sink, str(tmp_path), "scraper.py", 1.0, 0.5)
    rows = load_summary(path)
    assert rows[0]["stale"] is False


def test_clean_stale_functions(cfg, tmp_path):
    """clean --stale：删除陈旧函数及其观测。"""
    f = tmp_path / "scraper.py"
    f.write_text("x = 1\n", encoding="utf-8")
    sink = ObservationSink()
    _fill(sink, str(f))
    path = save(cfg, sink, str(tmp_path), "scraper.py", 1.0, 0.5)

    future = time.time() + 100
    os.utime(f, (future, future))
    sink2 = ObservationSink()
    fid = sink2.func_id(str(tmp_path / "other.py"), "other_fn", 1)
    sink2.add_hit(fid)
    save(cfg, sink2, str(tmp_path), "other.py", 2.0, 0.5)

    stats = clean(cfg, str(tmp_path), stale=True)
    assert stats["functions_deleted"] == 1
    assert stats["stale_functions"] == 0
    assert stats["functions"] == 1  # other_fn 保留
    conn = sqlite3.connect(path)
    try:
        # 陈旧函数的观测一并删除
        assert conn.execute("SELECT COUNT(*) FROM arg_types").fetchone()[0] == 0
        assert conn.execute("SELECT COUNT(*) FROM ret_types").fetchone()[0] == 0
    finally:
        conn.close()


def test_clean_days_and_all_runs(cfg, tmp_path):
    """clean --days / --all-runs：runs 行清理，观测保留。"""
    f = tmp_path / "scraper.py"
    f.write_text("x = 1\n", encoding="utf-8")
    sink = ObservationSink()
    _fill(sink, str(f))
    path = save(cfg, sink, str(tmp_path), "scraper.py", 1.0, 0.5)

    stats = clean(cfg, str(tmp_path), days=0)  # 0 天前 = 全部 runs
    assert stats["runs_deleted"] == 1
    assert stats["runs"] == 0
    assert stats["functions"] == 1  # 观测保留

    stats = clean(cfg, str(tmp_path), all_runs=True)
    assert stats["runs_deleted"] == 0  # 已清空


def test_clean_not_found(cfg):
    stats = clean(cfg, "F:/nonexistent-proj-xyz")
    assert stats["error"] == "not_found"


def test_old_db_migration_adds_stale_column(cfg, tmp_path):
    """P2-T07 前的旧库（无 stale 列）自动迁移。"""
    f = tmp_path / "scraper.py"
    f.write_text("x = 1\n", encoding="utf-8")
    sink = ObservationSink()
    _fill(sink, str(f))
    path = save(cfg, sink, str(tmp_path), "scraper.py", 1.0, 0.5)

    # 手动降级为旧 schema（删 stale 列——SQLite 不支持 DROP COLUMN 前的版本可重建表）
    conn = sqlite3.connect(path)
    try:
        conn.executescript("""
        CREATE TABLE functions_old(
          fid INTEGER PRIMARY KEY, filename TEXT NOT NULL, qualname TEXT NOT NULL,
          lineno INTEGER NOT NULL, hits INTEGER NOT NULL DEFAULT 0,
          UNIQUE(filename, qualname, lineno));
        INSERT INTO functions_old SELECT fid, filename, qualname, lineno, hits FROM functions;
        DROP TABLE functions;
        ALTER TABLE functions_old RENAME TO functions;
        """)
        conn.commit()
    finally:
        conn.close()

    # 再次 save：自动补 stale 列并正常工作
    sink2 = ObservationSink()
    _fill(sink2, str(f))
    save(cfg, sink2, str(tmp_path), "scraper.py", 2.0, 0.5)
    assert _stale_of(path, "parse_page") == 0
