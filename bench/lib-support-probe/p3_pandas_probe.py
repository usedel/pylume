"""
P3 探针：intel 对 pandas / NumPy 运行时变量实际能提供什么？（research §4.6 / §10.2）

背景：裁决「pandas / NumPy 运行时对象洞察」走 P2 探针先行——intel hover 对
`df = pd.read_csv(...)` 这类变量能否给出「类型 + 列集合」？能给 → 做轻量
「运行时对象卡」（§11.8：变量行 chip + 列 chips）；给不到 → 登记放弃。

口径：intel hover 的 shape 字段直接来自 probe 的
`pylume_probe.compact.shape_fingerprint`（compact.py）——probe 侧产出的
结构指纹就是 intel `render_variable` 展示的「字段（shape）」的唯一来源。
因此本探针直接在真实 pandas / NumPy 对象上运行 shape_fingerprint + compact_type，
其输出即为 intel hover 将呈现的内容（不需要起完整外壳做端到端验证）。

用法：uv run --with pandas --with numpy python bench\\lib-support-probe\\p3_pandas_probe.py
输出：stdout 摘要 + bench/reports/lib-support-probe-p3-pandas.json
"""

import io
import json
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PROBE_SRC = os.path.join(HERE, "..", "..", "probe", "src")
REPORT = os.path.join(HERE, "..", "reports", "lib-support-probe-p3-pandas.json")

sys.path.insert(0, PROBE_SRC)

from pylume_probe.compact import compact_type, shape_fingerprint  # noqa: E402

import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402


def main():
    csv = "name,age,city\nalice,30,nyc\nbob,25,la\ncarol,41,sf\n"
    df = pd.read_csv(io.StringIO(csv))
    arr = np.zeros((2, 3))
    series = df["age"]

    subjects = [
        ("df = pd.read_csv(...)", df),
        ("series = df[\"age\"]", series),
        ("arr = np.zeros((2,3))", arr),
        ("对照组：dict（既有能力基线）", {"name": "alice", "age": 30}),
    ]
    results = []
    for label, value in subjects:
        type_label = compact_type(value, max_depth=1)
        shape = shape_fingerprint(value)
        # intel hover.rs render_variable 对非 dict 类型：shape 数组元素原样展示（实例属性名）
        members = json.loads(shape) if shape else []
        entry = {
            "label": label,
            "type_label": type_label,
            "shape_fingerprint": shape,
            "intel_hover_members": members if isinstance(members, list) else "（dict 键结构）",
            "has_columns": "columns" in (members if isinstance(members, list) else []),
        }
        results.append(entry)
        print(f"[{label}]")
        print(f"  type_label = {type_label}")
        print(f"  shape      = {(shape or 'None')[:200]}")
        print(f"  列信息可得  = {entry['has_columns']}")

    df_shape = results[0]
    verdict = {
        "type_label_ok": df_shape["type_label"] == "pandas.DataFrame",
        "columns_available": bool(df_shape["has_columns"]),
    }
    print(
        "\n结论："
        f"type_label={'[OK] pandas.DataFrame' if verdict['type_label_ok'] else '[FAIL]'}"
        f" · 列集合={'可得 -> 可做轻量对象卡' if verdict['columns_available'] else '不可得 -> 按裁决登记放弃'}"
    )

    report = {
        "probe": "P3 intel 对 pandas / NumPy 运行时变量的实际输出（shape_fingerprint = intel hover shape 唯一来源）",
        "generatedAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "pythonVersion": sys.version.split()[0],
        "pandasVersion": pd.__version__,
        "numpyVersion": np.__version__,
        "results": results,
        "verdict": verdict,
        "note": "列在 DataFrame 内部 _mgr.blocks 结构中，非对象属性；shape_fingerprint 的实例分支只采 __dict__ 属性名",
    }
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(f"\n报告已写入：{os.path.abspath(REPORT)}")


if __name__ == "__main__":
    main()
