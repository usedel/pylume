"""P2-T08 正确率抽检单测：check 命令闭环。"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

PROBE_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROBE_ROOT / "src"))

SCRIPT = '''
def add(a, b=10):
    return a + b

def parse(html):
    return {"title": html, "links": ["a", "b"]}

def boom():
    raise ValueError("boom")

def main():
    add(1, 2)
    add("x", "y")
    parse("<html>")
    try:
        boom()
    except ValueError:
        pass

main()
'''

EXPECT = {
    "functions": [
        {"qualname": "add", "args": {"a": ["int", "str"], "b": ["int", "str"]},
         "rets": ["int", "str"]},
        {"qualname": "parse", "args": {"html": ["str"]},
         "rets": ["dict[str, str|list[str]]"]},
        {"qualname": "boom", "rets": []},
    ]
}


def _env(tmp_path):
    env = os.environ.copy()
    env["PYLUME_PROBE_HOME"] = str(tmp_path / "home")
    env.pop("PYLUME_PROBE_CONFIG", None)
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def test_check_pass(tmp_path):
    script = tmp_path / "app.py"
    script.write_text(SCRIPT, encoding="utf-8")
    (tmp_path / "probe_expect.json").write_text(
        json.dumps(EXPECT), encoding="utf-8")
    (tmp_path / "home").mkdir()

    r = subprocess.run(
        [sys.executable, "-m", "pylume_probe.cli", "check", str(script)],
        capture_output=True, text=True, env=_env(tmp_path), cwd=str(PROBE_ROOT),
        encoding="utf-8", errors="replace",
    )
    assert r.returncode == 0, r.stdout + r.stderr
    assert "100.0%" in r.stdout


def test_check_miss_reported(tmp_path):
    """期望类型缺失 → miss 计数 + 非零退出码。"""
    script = tmp_path / "app.py"
    script.write_text(SCRIPT, encoding="utf-8")
    bad = json.loads(json.dumps(EXPECT))
    bad["functions"][0]["args"]["a"] = ["int", "str", "float"]  # float 不会被观测到
    (tmp_path / "probe_expect.json").write_text(json.dumps(bad), encoding="utf-8")
    (tmp_path / "home").mkdir()

    r = subprocess.run(
        [sys.executable, "-m", "pylume_probe.cli", "check", str(script),
         "--threshold", "99"],
        capture_output=True, text=True, env=_env(tmp_path), cwd=str(PROBE_ROOT),
        encoding="utf-8", errors="replace",
    )
    assert r.returncode == 1
    assert "float" in r.stdout  # miss 明细列出


def test_check_missing_expect_file(tmp_path):
    script = tmp_path / "app.py"
    script.write_text("print('x')\n", encoding="utf-8")
    (tmp_path / "home").mkdir()
    r = subprocess.run(
        [sys.executable, "-m", "pylume_probe.cli", "check", str(script)],
        capture_output=True, text=True, env=_env(tmp_path), cwd=str(PROBE_ROOT),
        encoding="utf-8", errors="replace",
    )
    assert r.returncode == 2
    assert "期望文件不存在" in r.stderr
