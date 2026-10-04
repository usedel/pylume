"""
P1b 补测探针：P1 报告缺失的「无 .venv 冷启动」场景。

背景：lib-support-probe-p1.json 标注 venvExistedBefore=true，未覆盖
「工作区无 .venv、uv 首次需解析/创建环境」的冷启动耗时；文档
（python_library_support_research.md §5.2/§10.1）引用的 1017ms / 8s 超时档
需回填实测数字。另验证：uv python find 在 .venv 创建前返回的是系统解释器
还是项目解释器（决定解释器路径缓存的失效条件）。

用法：python bench\\lib-support-probe\\p1b_coldstart.py
输出：stdout 摘要 + bench/reports/lib-support-probe-p1b-coldstart.json

口径：
- ws-novenv 为全新目录 + 最小 pyproject.toml（零依赖），仅测 venv 创建开销，
  不含包下载（uv run 零依赖项目不会拉包）。
- 每个用例 3 次：首跑即 cold（venv 创建发生在第 1 次 uv run）。
"""

import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.join(HERE, "ws-novenv")  # 全新目录，保证无 .venv
REPORT = os.path.join(HERE, "..", "reports", "lib-support-probe-p1b-coldstart.json")

PYPROJECT = '[project]\nname = "coldstart-probe"\nversion = "0.0.0"\nrequires-python = ">=3.9"\n'

N = 3


def run_once(cmd, cwd):
    t0 = time.perf_counter()
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    dt = (time.perf_counter() - t0) * 1000.0
    return dt, p


def measure(label, cmd, cwd, note=""):
    times, errors = [], []
    for _ in range(N):
        dt, p = run_once(cmd, cwd)
        times.append(round(dt, 1))
        if p.returncode != 0:
            errors.append((p.stderr or p.stdout or "").strip()[:300])
    entry = {
        "label": label,
        "cmd": " ".join(cmd),
        "cold_ms": times[0],
        "warm_ms": times[1:],
        "warm_avg_ms": round(sum(times[1:]) / max(1, len(times) - 1), 1),
        "note": note,
    }
    if errors:
        entry["errors"] = errors[:3]
    print(f"[{label:34s}] cold={entry['cold_ms']:8.1f}ms  warm_avg={entry['warm_avg_ms']:8.1f}ms  {note}")
    return entry


def find_target(cwd):
    p = subprocess.run(["uv", "python", "find"], cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return (p.stdout or "").strip(), p.returncode


def main():
    if os.path.isdir(WS):
        shutil.rmtree(WS)  # 保证「无 .venv」前提
    os.makedirs(WS, exist_ok=True)
    with open(os.path.join(WS, "pyproject.toml"), "w", encoding="utf-8") as f:
        f.write(PYPROJECT)

    results = []

    # 1) venv 创建前：uv python find 返回什么？（决定缓存失效条件）
    before, rc_before = find_target(WS)
    is_venv_before = os.sep + ".venv" + os.sep in before or before.endswith(os.sep + ".venv" + os.sep + "python.exe") \
        or ".venv" in before.replace("/", os.sep)
    results.append({
        "label": "uv python find（.venv 创建前）",
        "output": before,
        "is_project_venv": bool(before) and is_venv_before,
        "returncode": rc_before,
        "note": "决定：解释器路径缓存的失效条件",
    })
    print(f"[uv python find（.venv 创建前）] → {before!r}  is_project_venv={is_venv_before}")

    # 2) uv run 冷启动（第 1 次需创建 .venv）+ 稳态
    results.append(measure("uv run python -c（无 .venv 冷启动）",
                           ["uv", "run", "python", "-c", "print(1)"], WS,
                           "首跑创建 .venv，零依赖项目"))

    # 3) venv 创建后：uv python find 是否切换为项目解释器
    after, rc_after = find_target(WS)
    is_venv_after = ".venv" in after.replace("/", os.sep)
    results.append({
        "label": "uv python find（.venv 创建后）",
        "output": after,
        "is_project_venv": bool(after) and is_venv_after,
        "returncode": rc_after,
        "note": "对比创建前输出，验证缓存失效必要性",
    })
    print(f"[uv python find（.venv 创建后）] → {after!r}  is_project_venv={is_venv_after}")

    report = {
        "probe": "P1b 无 .venv 冷启动补测（回填 P1 缺失场景）",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "pythonVersion": sys.version.split()[0],
        "uvVersion": (subprocess.run(["uv", "--version"], capture_output=True, text=True).stdout or "").strip(),
        "workspace": WS,
        "runsEach": N,
        "results": results,
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n报告已写入：{os.path.abspath(REPORT)}")

    cold = results[1]["cold_ms"]
    warm = results[1]["warm_avg_ms"]
    print(f"\n结论数据：uv run 冷启动（创建 .venv）={cold}ms · 稳态={warm}ms")
    print(f"→ 超时档位建议：uv 首次解析/创建环境取 max(3×cold, 3s) ≈ {max(cold * 3, 3000) / 1000:.0f}s")


if __name__ == "__main__":
    main()
