"""traceback 点击跳转验收材料（S1-T05）。

5 类错误 + 语法错误，对应 Gate B 验收标准第 3 条：
运行时 / 语法 / 导入 / 断言 / 嵌套调用，全部可点击跳转到出错行。

用法（在 IDE 内打开本目录后逐条运行，或在终端）：
    uv run main.py -- --case runtime
    uv run main.py -- --case attribute
    uv run main.py -- --case import
    uv run main.py -- --case assert
    uv run main.py -- --case nested
    uv run syntax_error.py

（uv run 需用 `--` 分隔自身参数与脚本参数）
"""
import sys

def coral(n:int, m:int):
    return n+m
    

def case_runtime() -> None:
    # 1. 运行时错误：除零（ZeroDivisionError）
    total = 100
    count = 0
    print("result =", total / count)  # ← 出错行：line 23


def case_attribute() -> None:
    # 2. 属性错误：None 上取属性（AttributeError）
    data = None
    print(data.items())  # ← 出错行：line 29


def case_import() -> None:
    # 3. 导入错误：不存在的模块（ModuleNotFoundError）
    import nonexistent_module_xyz  # ← 出错行：line 34


def case_assert() -> None:
    # 4. 断言失败（AssertionError）
    value = 41
    assert value == 42, f"expected 42, got {value}"  # ← 出错行：line 40


def inner_helper() -> None:
    # 嵌套调用最内层：真正抛错的位置
    config = {}
    print(config["missing_key"])  # ← 出错行：line 46（KeyError）


def middle_caller() -> None:
    inner_helper()  # ← 嵌套中间帧：line 50


def case_nested() -> None:
    # 5. 嵌套调用（KeyError，多帧 traceback）
    middle_caller()  # ← 嵌套最外帧：line 54


CASES = {
    "runtime": case_runtime,
    "attribute": case_attribute,
    "import": case_import,
    "assert": case_assert,
    "nested": case_nested,
}


def main() -> None:
    if len(sys.argv) < 2 or sys.argv[1] not in CASES:
        print(__doc__)
        sys.exit(2)
    CASES[sys.argv[1]]()

if __name__ == "__main__":
    main()