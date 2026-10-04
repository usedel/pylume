# 大仓样例生成器（M4-6 性能红线验收，docs/dep_health_dev_plan.md §7 M4）
#
# 生成 80 个 .py 文件（4 层深目录 × 每层若干包 × 每包 5~8 模块），覆盖探针的全部
# 代码层形态：stdlib / 本地跨包 / 三方（已声明已装）/ 三方（未声明）/ missing /
# 惰性导入（函数体内）/ 多位点重复 import / 相对导入。
#
# 用法：python gen_large_repo.py <目标目录>
# 目标目录已存在时跳过生成（幂等）。

import sys
from pathlib import Path

# (顶层包名, 模块数) —— 4 层深目录由包名层级表达（pkg_a.sub.deep.core 等）
PACKAGES = [
    ("pkg_alpha", 16), ("pkg_beta", 12), ("pkg_gamma", 14),
    ("pkg_delta", 10), ("pkg_epsilon", 16), ("pkg_zeta", 12),
]

THIRD_PARTY_INSTALLED = ["requests", "pydantic", "uvicorn", "jmespath"]  # 已声明已装
THIRD_PARTY_UNDECLARED = ["sqlalchemy"]                                   # 已装未声明（E4）
MISSING = ["definitely_missing_a", "definitely_missing_b"]                # E1

TEMPLATE = '''"""{doc}"""


def public_fn() -> int:
    return {ret}


def lazy_imports() -> None:
    # 惰性导入（函数体内 → lazy=true）：一半进 MISSING（E1 lazy 形态）、一半进已装三方
    import {lazy_missing}
    from {lazy_installed} import exceptions

    try:
        import {try_import}
    except ImportError:
        pass


class Widget{idx}:
    def method(self) -> str:
        from {from_import_target} import helper  # 惰性 from-import

        return helper
'''


def main() -> None:
    target = Path(sys.argv[1] if len(sys.argv) > 1 else "large_repo")
    # 幂等判定：只认生成的样例产物（pkg_*/main.py），生成器自身与其他文件不算
    if (target / "main.py").exists() and any(target.glob("pkg_*")):
        print(f"已存在：{target}（跳过生成）")
        return
    target.mkdir(parents=True, exist_ok=True)

    n = 0
    for pkg, mods in PACKAGES:
        # 深目录：pkg/sub/deep/core/
        deep = target / pkg / "sub" / "deep" / "core"
        deep.mkdir(parents=True, exist_ok=True)
        (deep / "__init__.py").write_text("", encoding="utf-8")
        for i in range(mods):
            mod = deep / f"module_{i}.py"
            mod.write_text(
                TEMPLATE.format(
                    doc=f"{pkg} deep module {i}",
                    ret=i,
                    idx=i,
                    lazy_missing=MISSING[i % len(MISSING)],
                    lazy_installed=THIRD_PARTY_INSTALLED[i % len(THIRD_PARTY_INSTALLED)],
                    try_import=THIRD_PARTY_UNDECLARED[i % len(THIRD_PARTY_UNDECLARED)],
                    from_import_target=THIRD_PARTY_INSTALLED[(i + 1) % len(THIRD_PARTY_INSTALLED)],
                ),
                encoding="utf-8",
            )
            n += 1

    # 入口脚本：顶层 import 全形态 + 相对导入 + 重复位点
    entry = target / "main.py"
    entry.write_text(
        "import os\n"
        "import sys\n"
        "import json\n"
        "import requests\n"          # 三方已装已声明
        "import pydantic\n"
        "import pkg_alpha.sub.deep.core.module_0\n"   # 本地深包
        "import pkg_beta.sub.deep.core.module_1\n"
        "import definitely_missing_top\n"             # E1 顶层缺失
        "import requests\n"                            # 重复位点（同文件同模块聚合）
        "from uvicorn import Config\n"                 # from-import 三方
        "from pkg_gamma.sub.deep.core import module_2\n",  # from-import 本地
        encoding="utf-8",
    )
    n += 1

    # 相对导入样例（探针跳过：level>0 视为一方代码）
    rel = target / "pkg_alpha" / "relative_demo.py"
    rel.write_text("from .sub.deep.core import module_3\nfrom ..pkg_alpha import relative_demo\n", encoding="utf-8")
    n += 1

    print(f"已生成 {n} 个 .py 文件 → {target}")


if __name__ == "__main__":
    main()
