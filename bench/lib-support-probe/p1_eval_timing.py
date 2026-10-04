"""
P1 探针：求值桥（py_eval）的耗时基线。

问题：工作区解释器为 null（uv run 兜底）时，`uv run python -c ...` 到底多慢？
决定：求值桥的超时档位、是否需要进度提示、是否可用 `--no-project` 提速。

用法：D:\\py\\python.exe bench\\lib-support-probe\\p1_eval_timing.py
输出：stdout 摘要 + bench/reports/lib-support-probe-p1.json

口径：
- 直连解释器 = 已配置 workspace interpreter（env_cmds::get_interpreter 返回 Some）
- uv run      = interpreter=null 的兜底路径（dap.rs:356 uv_fallback 同策略）
- 每个用例跑 N 次，首跑单独记为 cold（uv 首次可能要解析/创建环境）
"""

import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
WS = os.path.join(HERE, "ws")  # 模拟工作区（含 pyproject.toml）
REPORT = os.path.join(HERE, "..", "reports", "lib-support-probe-p1.json")

# 受控脚本：贴近真实 kind（re/format/ast 都要 import 这几个模块）
BRIDGE_SCRIPT = (
    "import json,sys,re,datetime,ast;"
    "a=json.loads(sys.argv[1]);"
    "m=re.findall(a['p'],a['s'],a['f']);"
    "print(json.dumps({'ok':True,'n':len(m)}))"
)
ARGS = json.dumps({"p": r"\b(\w+)@(\w+)\.com", "s": "a@corp.com b@corp.com", "f": 0})

N = 5


def run_once(cmd, cwd):
    t0 = time.perf_counter()
    p = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    dt = (time.perf_counter() - t0) * 1000.0
    return dt, p


def measure(label, cmd, cwd, note=""):
    times = []
    errors = []
    for _ in range(N):
        dt, p = run_once(cmd, cwd)
        times.append(round(dt, 1))
        if p.returncode != 0:
            errors.append((p.stderr or p.stdout or "").strip()[:300])
    entry = {
        "label": label,
        "cmd": " ".join(cmd),
        "cwd": cwd,
        "cold_ms": times[0],
        "warm_ms": times[1:],
        "warm_avg_ms": round(sum(times[1:]) / max(1, len(times) - 1), 1),
        "warm_min_ms": min(times[1:]) if len(times) > 1 else None,
        "note": note,
    }
    if errors:
        entry["errors"] = errors[:3]
    print(f"[{label:28s}] cold={entry['cold_ms']:8.1f}ms  warm_avg={entry['warm_avg_ms']:8.1f}ms  {note}")
    return entry


def main():
    os.makedirs(WS, exist_ok=True)
    py = sys.executable
    results = []
    report_cached = {}

    # 1) 直连解释器（interpreter 已配置）
    results.append(measure("direct: python -c", [py, "-c", BRIDGE_SCRIPT, ARGS], WS, "基线"))
    # 2) 直连 + isolated（-I：忽略用户 site 与 PYTHON* 环境变量，更安全）
    results.append(measure("direct: python -I -c", [py, "-I", "-c", BRIDGE_SCRIPT, ARGS], WS, "安全模式开销"))
    # 3) 只 import 内置（无第三方 import）的最小脚本，作下界参考
    results.append(measure("direct: 最小脚本", [py, "-c", "print(1)"], WS, "进程启动下界"))

    # 4) uv run（项目模式，冷启动可能创建 .venv）
    venv_exists = os.path.isdir(os.path.join(WS, ".venv"))
    uv_cold = measure("uv run python -c", ["uv", "run", "python", "-c", BRIDGE_SCRIPT, ARGS], WS,
                      f"{'已存在 .venv' if venv_exists else '首次：需解析/创建环境'}")
    results.append(uv_cold)

    # 5) uv run --no-project（求值桥只需一个能跑的 Python，不需要项目环境）
    results.append(measure("uv run --no-project", ["uv", "run", "--no-project", "python", "-c", BRIDGE_SCRIPT, ARGS], WS,
                           "跳过项目解析"))

    # 6) uv run 再来一轮（.venv 已建好后的稳态）
    results.append(measure("uv run python -c (二次)", ["uv", "run", "python", "-c", BRIDGE_SCRIPT, ARGS], WS, "稳态"))

    # 7) uv python find（若要缓存解释器路径，这条命令的耗时决定是否值得）
    results.append(measure("uv python find", ["uv", "python", "find"], WS, "能否落地为解释器缓存"))

    # 8) 缓存策略：先 uv python find 拿到项目解释器，之后直连它（绕过 uv run 的每次解析开销）
    found = subprocess.run(["uv", "python", "find"], cwd=WS, capture_output=True, text=True).stdout.strip()
    cached = {
        "found": found,
        "is_project_venv": os.path.abspath(found).startswith(os.path.abspath(WS)) if found else False,
    }
    if found and os.path.exists(found):
        results.append(measure("cached: uv python find 结果直连", [found, "-I", "-c", BRIDGE_SCRIPT, ARGS], WS,
                               "缓存一次后续直连"))
    report_cached = cached

    report = {
        "probe": "P1 py_eval 耗时基线",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "cachedInterpreter": report_cached,
        "python": py,
        "pythonVersion": sys.version.split()[0],
        "uvVersion": (subprocess.run(["uv", "--version"], capture_output=True, text=True).stdout or "").strip(),
        "workspace": WS,
        "venvExistedBefore": venv_exists,
        "runsEach": N,
        "results": results,
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n报告已写入：{os.path.abspath(REPORT)}")

    direct = results[0]["warm_avg_ms"]
    uv = results[5]["warm_avg_ms"]
    noproj = results[4]["warm_avg_ms"]
    print(f"\n结论数据：直连 warm_avg={direct}ms · uv run 稳态={uv}ms · uv --no-project={noproj}ms")
    print(f"→ 超时档位建议：直连 3s 充足；uv 兜底需 ≥{max(uv, noproj) * 3:.0f}ms（3 倍余量）")


if __name__ == "__main__":
    main()
