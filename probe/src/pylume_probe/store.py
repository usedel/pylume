"""SQLite trace 库（P2-T05 + P2-T07）：~/.pylume/traces/<project-hash>.db，按项目哈希隔离。

多次运行累积（count 累加）——「运行过的代码」沉淀类型观测，正是 Phase 3 的输入。
写入只发生在运行结束（运行期零 I/O）。

P2-T07 陈旧标记：functions.stale = 1 表示该函数所在文件在末次运行后被修改过
（文件 mtime > 末次 run.started），Phase 3 消费时可降权或忽略。
"""
from __future__ import annotations

import hashlib
import json
import os
import sqlite3
import time
from pathlib import Path

from . import __version__
from .config import ProbeConfig, probe_home
from .sink import ObservationSink

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs(
  id INTEGER PRIMARY KEY,
  started REAL NOT NULL,
  elapsed REAL NOT NULL,
  project TEXT NOT NULL,
  script TEXT NOT NULL,
  python TEXT NOT NULL,
  probe_version TEXT NOT NULL,
  instance TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS functions(
  fid INTEGER PRIMARY KEY,
  filename TEXT NOT NULL,
  qualname TEXT NOT NULL,
  lineno INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  stale INTEGER NOT NULL DEFAULT 0,
  UNIQUE(filename, qualname, lineno)
);
CREATE TABLE IF NOT EXISTS arg_types(
  fid INTEGER NOT NULL REFERENCES functions(fid),
  arg TEXT NOT NULL,
  type_label TEXT NOT NULL,
  shape TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(fid, arg, type_label, shape)
);
CREATE TABLE IF NOT EXISTS ret_types(
  fid INTEGER NOT NULL REFERENCES functions(fid),
  type_label TEXT NOT NULL,
  shape TEXT,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(fid, type_label, shape)
);
CREATE TABLE IF NOT EXISTS exc_types(
  fid INTEGER NOT NULL REFERENCES functions(fid),
  exc_label TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(fid, exc_label)
);
CREATE INDEX IF NOT EXISTS idx_functions_qualname ON functions(qualname);
CREATE INDEX IF NOT EXISTS idx_functions_filename ON functions(filename);
"""


def _ensure_stale_column(conn: sqlite3.Connection) -> None:
    """旧库迁移：functions 无 stale 列则补（P2-T07 前的库）。"""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(functions)")}
    if "stale" not in cols:
        conn.execute("ALTER TABLE functions ADD COLUMN stale INTEGER NOT NULL DEFAULT 0")


def _ensure_instance_column(conn: sqlite3.Connection) -> None:
    """旧库迁移：runs 无 instance 列则补（§19-5 运行实例标识，M4 前的库）。
    旧行回落 ''（无法归属到单次运行——观测数据本身跨运行累加，不受影响）。"""
    cols = {row[1] for row in conn.execute("PRAGMA table_info(runs)")}
    if "instance" not in cols:
        conn.execute("ALTER TABLE runs ADD COLUMN instance TEXT NOT NULL DEFAULT ''")


def project_hash(project_root: str) -> str:
    """项目根 realpath 的 sha1 前 12 位（库文件名隔离键）。

    normcase 统一大小写：Windows 路径不区分大小写（`F:\\Proj` 与 `f:\\proj` 是同一目录），
    不归一会产生两个 trace 库，shell 与 probe 错位（tech-debt #4）。POSIX 上 normcase 恒等，无副作用。
    shell 侧对应实现见 `shell/src-tauri/src/file_ops.rs::project_hash`（Windows 下 to_lowercase）。
    """
    return hashlib.sha1(
        os.path.normcase(os.path.normpath(os.path.realpath(project_root))).encode("utf-8")
    ).hexdigest()[:12]


def db_path(cfg: ProbeConfig, project_root: str) -> Path:
    d = Path(cfg.db_dir) if cfg.db_dir else probe_home() / "traces"
    return d / f"{project_hash(project_root)}.db"


def _set_pragmas(conn: sqlite3.Connection, read_only: bool = False) -> None:
    """写入/并发友好 pragma：WAL 提升读写并发、busy_timeout 缓解 SQLITE_BUSY。

    读写连接开 WAL（持久化到库文件）；只读连接只设 busy_timeout（`journal_mode=WAL`
    需要写权限，ro 连接跳过）。
    """
    conn.execute("PRAGMA busy_timeout=5000")
    if not read_only:
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA synchronous=NORMAL")


def save(cfg: ProbeConfig, sink: ObservationSink, project_root: str, script: str,
         started: float, elapsed: float, instance: str | None = None) -> Path:
    """聚合观测批量 upsert 到 trace 库（单事务，失败抛异常由调用方兜底）。

    P2-T07 陈旧标记：本次运行覆盖到的函数清回 stale=0（观测与当前代码一致）；
    未覆盖但所在文件 mtime > 本次 run.started 的函数标 stale=1。

    §19-5 instance（可空）：运行实例标识（shell 注入的会话 id，如
    `run-term-script` / `run-term-project-2`）——多实例并行时每次落库可归属到
    单次运行；None 时读环境变量 PYLUME_PROBE_INSTANCE（注入模式零改动兼容），
    两者皆缺则落 ''（CLI 直接运行等场景，无归属语义）。
    """
    if instance is None:
        instance = os.environ.get("PYLUME_PROBE_INSTANCE", "")
    path = db_path(cfg, project_root)
    path.parent.mkdir(parents=True, exist_ok=True)
    import sys
    conn = sqlite3.connect(path)
    try:
        _set_pragmas(conn)
        conn.executescript(SCHEMA)
        _ensure_stale_column(conn)
        _ensure_instance_column(conn)
        # P2-T07：本次运行前库内末次 run 时刻（陈旧检测的比较基准）
        prev_max_started = conn.execute("SELECT MAX(started) FROM runs").fetchone()[0]
        conn.execute(
            "INSERT INTO runs(started, elapsed, project, script, python, probe_version, instance)"
            " VALUES(?,?,?,?,?,?,?)",
            (started, elapsed, os.path.normpath(os.path.realpath(project_root)),
             script, sys.version.split()[0], __version__, instance),
        )
        # functions：INSERT OR IGNORE 建行，再 UPDATE 累加 hits
        # （fid 是 sink 内存编号，跨运行不稳定——用 (filename, qualname, lineno) 做自然键，
        #   库内 fid 由 rowid 重新分配）
        fid_map: dict[int, int] = {}
        for (filename, qualname, lineno), mem_fid in sink.funcs.items():
            # 单条 UPSERT 用 RETURNING 拿回 fid，省去再按自然键 SELECT 一次（N 次往返 → 1 次）
            row = conn.execute(
                "INSERT INTO functions(filename, qualname, lineno, hits, stale)"
                " VALUES(?,?,?,?,0) ON CONFLICT(filename, qualname, lineno)"
                " DO UPDATE SET hits = hits + excluded.hits, stale = 0"
                " RETURNING fid",
                (filename, qualname, lineno, sink.hits.get(mem_fid, 0)),
            ).fetchone()
            fid_map[mem_fid] = row[0]
        # P2-T07：本次未覆盖的函数，若所在文件在库内末次运行后被修改 → 标陈旧
        _mark_stale(conn, prev_max_started, {fn for (fn, _q, _l) in sink.funcs})
        # shape 用空串而非 NULL：SQLite 唯一约束对 NULL 不生效（NULL != NULL），
        # ON CONFLICT 会失效导致重复行
        conn.executemany(
            "INSERT INTO arg_types(fid, arg, type_label, shape, count) VALUES(?,?,?,?,?)"
            " ON CONFLICT(fid, arg, type_label, shape)"
            " DO UPDATE SET count = count + excluded.count",
            [(fid_map[mf], a, t, s or "", c) for (mf, a, t, s), c in sink.args.items()],
        )
        conn.executemany(
            "INSERT INTO ret_types(fid, type_label, shape, count) VALUES(?,?,?,?)"
            " ON CONFLICT(fid, type_label, shape)"
            " DO UPDATE SET count = count + excluded.count",
            [(fid_map[mf], t, s or "", c) for (mf, t, s), c in sink.rets.items()],
        )
        conn.executemany(
            "INSERT INTO exc_types(fid, exc_label, count) VALUES(?,?,?)"
            " ON CONFLICT(fid, exc_label)"
            " DO UPDATE SET count = count + excluded.count",
            [(fid_map[mf], e, c) for (mf, e), c in sink.excs.items()],
        )
        conn.commit()
    finally:
        conn.close()
    return path


def _mark_stale(conn: sqlite3.Connection, prev_max_started: float | None,
                touched_files: set[str]) -> None:
    """陈旧检测：文件 mtime > 库内末次 run.started 且本次未覆盖 → stale=1。

    prev_max_started 为 None（空库）时无陈旧可言。
    mtime 不可得（文件已删/移动）也标陈旧——观测对应的代码已不存在。
    """
    if prev_max_started is None:
        return
    rows = conn.execute(
        "SELECT DISTINCT f.filename FROM functions f WHERE f.stale = 0",
    ).fetchall()
    stale_files: list[str] = []
    for (filename,) in rows:
        if filename in touched_files:
            continue
        try:
            mtime = os.path.getmtime(filename)
        except OSError:
            mtime = float("inf")  # 文件已不存在：观测对应的代码已消失
        if mtime > prev_max_started:
            stale_files.append(filename)
    # 汇总后批量 UPDATE（stale 文件通常少量，比逐文件一条 UPDATE 往返少）
    conn.executemany(
        "UPDATE functions SET stale = 1 WHERE filename = ? AND stale = 0",
        [(fn,) for fn in stale_files],
    )


def clean(cfg: ProbeConfig, project_root: str, days: int | None = None,
          stale: bool = False, all_runs: bool = False) -> dict:
    """trace 库清理（P2-T07 clean 命令）。

    - days=N：删除 N 天前的 runs 行（观测数据保留——「运行过的代码」沉淀不因时间丢失）；
    - stale：删除 stale=1 的函数及其全部观测（代码已变更，旧观测无价值）；
    - all_runs：清空 runs 表（保留 functions/观测——重置新鲜度基线）。
    返回操作统计 dict。
    """
    path = db_path(cfg, project_root)
    if not path.is_file():
        return {"db": str(path), "error": "not_found"}
    conn = sqlite3.connect(path)
    stats: dict = {"db": str(path)}
    try:
        _set_pragmas(conn)
        conn.executescript(SCHEMA)
        _ensure_stale_column(conn)
        _ensure_instance_column(conn)
        if days is not None:
            cutoff = time.time() - days * 86400
            cur = conn.execute("DELETE FROM runs WHERE started < ?", (cutoff,))
            stats["runs_deleted"] = cur.rowcount
        if stale:
            # 先删观测再删函数（外键引用）
            conn.execute(
                "DELETE FROM arg_types WHERE fid IN (SELECT fid FROM functions WHERE stale=1)")
            conn.execute(
                "DELETE FROM ret_types WHERE fid IN (SELECT fid FROM functions WHERE stale=1)")
            conn.execute(
                "DELETE FROM exc_types WHERE fid IN (SELECT fid FROM functions WHERE stale=1)")
            cur = conn.execute("DELETE FROM functions WHERE stale=1")
            stats["functions_deleted"] = cur.rowcount
        if all_runs:
            cur = conn.execute("DELETE FROM runs")
            stats["runs_deleted"] = cur.rowcount
        conn.commit()
        stats["runs"] = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
        stats["functions"] = conn.execute("SELECT COUNT(*) FROM functions").fetchone()[0]
        stats["stale_functions"] = conn.execute(
            "SELECT COUNT(*) FROM functions WHERE stale=1").fetchone()[0]
    finally:
        conn.close()
    return stats


def load_summary(path: Path, pattern: str | None = None) -> list[dict]:
    """读取 trace 库，返回函数级汇总（show 命令用）。"""
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        rows = conn.execute(
            "SELECT f.fid, f.filename, f.qualname, f.lineno, f.hits, f.stale FROM functions f"
            " WHERE (? IS NULL OR f.qualname LIKE ?)"
            " ORDER BY f.hits DESC",
            (pattern, f"%{pattern}%" if pattern else None),
        ).fetchall()
        result = []
        for fid, filename, qualname, lineno, hits, stale in rows:
            # 用主查询已取的 fid 直接走主键索引，去掉 `fid IN (SELECT fid FROM functions ...)` 三级间接
            args = conn.execute(
                "SELECT arg, type_label, count FROM arg_types WHERE fid=?"
                " ORDER BY arg, count DESC", (fid,),
            ).fetchall()
            rets = conn.execute(
                "SELECT type_label, count FROM ret_types WHERE fid=? ORDER BY count DESC",
                (fid,),
            ).fetchall()
            excs = conn.execute(
                "SELECT exc_label, count FROM exc_types WHERE fid=? ORDER BY count DESC",
                (fid,),
            ).fetchall()
            result.append({
                "filename": filename, "qualname": qualname, "lineno": lineno,
                "hits": hits, "stale": bool(stale),
                "args": args, "rets": rets, "excs": excs,
            })
        return result
    finally:
        conn.close()


def load_summary_json(path: Path, pattern: str | None = None) -> str:
    """trace 库 → JSON（shell/Phase 3 消费的稳定接口）。"""
    rows = load_summary(path, pattern)
    return json.dumps(rows, ensure_ascii=False, indent=2)
