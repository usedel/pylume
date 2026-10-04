"""注入模式（sitecustomize + atexit）端到端：子进程采集闭环。"""
from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from pathlib import Path

PROBE_ROOT = Path(__file__).resolve().parent.parent
SRC = PROBE_ROOT / "src"

SCRIPT = '''
def add(a, b=10):
    return a + b

def parse(html):
    return {"title": html, "links": ["a", "b"]}

add(1, 2)
parse("<html>")
print("done")
'''


def _env(tmp_path):
    env = os.environ.copy()
    env["PYLUME_PROBE_HOME"] = str(tmp_path / "home")
    env["PYLUME_PROBE_AUTOSTART"] = "1"
    env["PYLUME_PROBE_SCRIPT"] = str(tmp_path / "app.py")
    env["PYTHONPATH"] = str(SRC)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def test_inject_subprocess(tmp_path):
    script = tmp_path / "app.py"
    script.write_text(SCRIPT, encoding="utf-8")
    (tmp_path / "home").mkdir()

    r = subprocess.run(
        [sys.executable, str(script)],
        capture_output=True, text=True, env=_env(tmp_path),
        encoding="utf-8", errors="replace",
    )
    assert r.returncode == 0, r.stderr
    assert "done" in r.stdout
    assert "✓" in r.stderr  # 探针摘要输出到 stderr

    dbs = list((tmp_path / "home" / "traces").glob("*.db"))
    assert len(dbs) == 1
    conn = sqlite3.connect(dbs[0])
    try:
        fns = dict(conn.execute("SELECT qualname, hits FROM functions").fetchall())
        assert fns["add"] == 1
        assert fns["parse"] == 1
        args = dict(
            (a, t)
            for a, t in conn.execute(
                "SELECT arg, type_label FROM arg_types").fetchall()
        )
        assert args["a"] == "int"
        assert args["html"] == "str"
        rets = dict(conn.execute("SELECT type_label, count FROM ret_types").fetchall())
        assert rets["dict[str, str|list[str]]"] == 1
    finally:
        conn.close()


def test_inject_crash_still_saves(tmp_path):
    """未捕获异常：atexit 仍落库。"""
    script = tmp_path / "app.py"
    script.write_text("def boom():\n    raise ValueError('x')\nboom()\n",
                      encoding="utf-8")
    (tmp_path / "home").mkdir()

    r = subprocess.run(
        [sys.executable, str(script)],
        capture_output=True, text=True, env=_env(tmp_path),
        encoding="utf-8", errors="replace",
    )
    assert r.returncode == 1
    assert "ValueError" in r.stderr
    assert "✓" in r.stderr  # 落库成功
    dbs = list((tmp_path / "home" / "traces").glob("*.db"))
    assert len(dbs) == 1


def test_inject_argv_guard(tmp_path):
    """argv[0] 守卫：环境变量存在但 argv[0] 不是目标脚本 → 不采集。"""
    script = tmp_path / "app.py"
    script.write_text("print('plain')\n", encoding="utf-8")
    (tmp_path / "home").mkdir()
    env = _env(tmp_path)
    # PYLUME_PROBE_SCRIPT 指向 app.py，但实际运行另一个脚本
    other = tmp_path / "other.py"
    other.write_text("print('other')\n", encoding="utf-8")
    r = subprocess.run(
        [sys.executable, str(other)],
        capture_output=True, text=True, env=env,
        encoding="utf-8", errors="replace",
    )
    assert r.returncode == 0
    assert "pylume-probe" not in r.stderr  # 未激活


def test_no_autostart_noop(tmp_path):
    """未设置 AUTOSTART：探针完全不介入（不侵入原则）。"""
    script = tmp_path / "app.py"
    script.write_text("print('plain')\n", encoding="utf-8")
    env = os.environ.copy()
    env.pop("PYLUME_PROBE_AUTOSTART", None)
    env["PYTHONPATH"] = str(SRC)
    env["PYTHONIOENCODING"] = "utf-8"
    r = subprocess.run(
        [sys.executable, str(script)],
        capture_output=True, text=True, env=env,
        encoding="utf-8", errors="replace",
    )
    assert r.returncode == 0
    assert r.stdout.strip() == "plain"
    assert "pylume-probe" not in r.stderr


def test_inject_old_python_skips_gracefully(tmp_path, monkeypatch):
    """Python < 3.12：明确提示后跳过采集，脚本正常运行（P1-BUG-003）。

    用 monkeypatch 把 version_info 伪装成 3.11，验证 bootstrap 的版本守卫
    （真实 3.11 解释器不在 CI 矩阵里，守卫逻辑本身可单测）。
    """
    import contextlib
    import io

    import pylume_probe.autostart as autostart

    script = tmp_path / "app.py"
    script.write_text("print('ok')\n", encoding="utf-8")
    (tmp_path / "home").mkdir()

    # 激活注入路径（目标脚本存在 + argv[0] 守卫通过）
    monkeypatch.setenv("PYLUME_PROBE_SCRIPT", str(script))
    monkeypatch.setattr(sys, "argv", [str(script)])
    monkeypatch.setenv("PYLUME_PROBE_HOME", str(tmp_path / "home"))
    # 伪装低版本（真元组：比较语义与 sys.version_info 一致）
    monkeypatch.setattr(autostart.sys, "version_info", (3, 11, 9, "final", 0))
    monkeypatch.setattr(autostart.sys, "version", "3.11.9 (fake)")

    err = io.StringIO()
    with contextlib.redirect_stderr(err):
        autostart.bootstrap()

    assert "3.12" in err.getvalue()
    assert "sys.monitoring" in err.getvalue()
    # 未落库（无 trace db 生成）
    dbs = list((tmp_path / "home" / "traces").glob("*.db"))
    assert dbs == []


def test_inject_run_id_dedups_duplicate_summary(tmp_path):
    """TD-020：同一 run_id 的父子进程（相同 argv[0]）各自触发 atexit._finalize 时，
    只落库一次 + 只打印一次摘要（消除重复摘要与观测翻倍）。"""
    script = tmp_path / "app.py"
    script.write_text(
        "import os, subprocess, sys\n"
        "def work():\n"
        "    return list(range(3))\n"
        "work()\n"
        "if os.environ.get('OC_NO_RECURSE') != '1':\n"
        "    subprocess.run([sys.executable, os.path.abspath(sys.argv[0])],\n"
        "                   env={**os.environ, 'OC_NO_RECURSE': '1'})\n"
        "print('done')\n",
        encoding="utf-8",
    )
    env = _env(tmp_path)
    env["PYLUME_PROBE_RUN_ID"] = "run-dedup-1"

    r = subprocess.run(
        [sys.executable, "-u", str(script)],
        capture_output=True, text=True, env=env,
        encoding="utf-8", errors="replace",
    )
    assert r.returncode == 0, r.stderr
    assert r.stderr.count("✓") == 1, f"摘要应只打印一次，实际 stderr:\n{r.stderr}"

    dbs = list((tmp_path / "home" / "traces").glob("*.db"))
    assert len(dbs) == 1
    conn = sqlite3.connect(dbs[0])
    try:
        rows = conn.execute("SELECT COUNT(*) FROM runs").fetchone()[0]
        assert rows == 1, conn.execute("SELECT id, script FROM runs").fetchall()
        # work() 只被采集一次（同 run_id 的子进程被去重，不再重复累加 hits）
        work_hits = conn.execute(
            "SELECT hits FROM functions WHERE qualname='work'").fetchone()
        assert work_hits is not None and work_hits[0] == 1, \
            f"work hits 应为 1，实际 {work_hits}"
    finally:
        conn.close()
