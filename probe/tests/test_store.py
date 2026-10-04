"""SQLite trace 库（P2-T05）单测。"""
from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pylume_probe.config import ProbeConfig  # noqa: E402
from pylume_probe.sink import ObservationSink  # noqa: E402
from pylume_probe.store import db_path, load_summary, project_hash, save  # noqa: E402


def _fill(sink: ObservationSink):
    fid = sink.func_id("F:/proj/scraper.py", "parse_page", 17)
    sink.add_hit(fid)
    sink.add_hit(fid)
    sink.add_arg(fid, "html", "str", None)
    sink.add_arg(fid, "html", "str", None)
    sink.add_ret(fid, "dict[str, str|list[str]]", '["links","title"]')
    fid2 = sink.func_id("F:/proj/scraper.py", "fetch", 12)
    sink.add_hit(fid2)
    sink.add_arg(fid2, "url", "str", None)
    sink.add_exc(fid2, "requests.exceptions.ConnectionError")


def test_project_hash_stable():
    a = project_hash("F:/proj")
    assert a == project_hash("F:/proj/")
    assert a == project_hash("F:\\proj")
    assert a != project_hash("F:/other")


def test_project_hash_case_insensitive():
    # tech-debt #4：Windows 路径不区分大小写，大小写变体须落到同一 trace 库键
    # （对齐 shell/src-tauri/src/file_ops.rs::project_hash 的 to_lowercase / os.path.normcase）。
    assert project_hash("F:/proj") == project_hash("f:/PROJ")
    assert project_hash("F:\\Api\\Scraper") == project_hash("f:\\api\\scraper")


def test_db_path_layout(cfg):
    p = db_path(cfg, "F:/proj")
    assert p.parent == Path(cfg.db_dir)
    assert p.name == f"{project_hash('F:/proj')}.db"


def test_save_and_accumulate(cfg):
    sink = ObservationSink()
    _fill(sink)
    path = save(cfg, sink, "F:/proj", "scraper.py", 1.0, 0.5)
    assert path.is_file()

    conn = sqlite3.connect(path)
    try:
        runs = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
        assert runs == 1
        fns = dict(conn.execute("SELECT qualname, hits FROM functions").fetchall())
        assert fns == {"parse_page": 2, "fetch": 1}
        args = conn.execute(
            "SELECT arg, type_label, count FROM arg_types WHERE arg='html'").fetchall()
        assert args == [("html", "str", 2)]
        rets = conn.execute("SELECT type_label, shape, count FROM ret_types").fetchall()
        assert rets == [("dict[str, str|list[str]]", '["links","title"]', 1)]
        excs = conn.execute("SELECT exc_label FROM exc_types").fetchall()
        assert excs == [("requests.exceptions.ConnectionError",)]
    finally:
        conn.close()

    # 第二次运行：count 累加（「运行过的代码」沉淀观测）
    sink2 = ObservationSink()
    _fill(sink2)
    save(cfg, sink2, "F:/proj", "scraper.py", 2.0, 0.4)
    conn = sqlite3.connect(path)
    try:
        fns = dict(conn.execute("SELECT qualname, hits FROM functions").fetchall())
        assert fns == {"parse_page": 4, "fetch": 2}
        args = conn.execute(
            "SELECT count FROM arg_types WHERE arg='html'").fetchone()[0]
        assert args == 4
        runs = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
        assert runs == 2
    finally:
        conn.close()


def test_load_summary(cfg):
    sink = ObservationSink()
    _fill(sink)
    path = save(cfg, sink, "F:/proj", "scraper.py", 1.0, 0.5)
    rows = load_summary(path)
    assert len(rows) == 2
    by_name = {r["qualname"]: r for r in rows}
    pp = by_name["parse_page"]
    assert pp["hits"] == 2
    assert ("html", "str", 2) in pp["args"]
    assert pp["rets"] == [("dict[str, str|list[str]]", 1)]
    # pattern 过滤
    rows = load_summary(path, "fetch")
    assert [r["qualname"] for r in rows] == ["fetch"]
