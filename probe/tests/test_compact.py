"""类型紧凑表示（P2-T03）单测。"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pylume_probe.compact import compact_type, shape_fingerprint, type_label  # noqa: E402

MOD = __name__  # pytest 导入名（test_compact，无包前缀）


class Widget:
    def __init__(self):
        self.a = 1
        self.b = "x"


class SubWidget(Widget):
    pass


def test_scalars():
    assert compact_type(1) == "int"
    assert compact_type(1.5) == "float"
    assert compact_type("s") == "str"
    assert compact_type(b"b") == "bytes"
    assert compact_type(None) == "None"
    assert compact_type(True) == "bool"  # bool 不落入 int


def test_type_label():
    assert type_label(dict) == "dict"
    assert type_label(Widget) == f"{MOD}.Widget"
    assert type_label(Path) == "pathlib.Path"


def test_instance():
    assert compact_type(Widget()) == f"{MOD}.Widget"
    # 子类化的 list 保留精确类名
    class MyList(list):
        pass
    assert compact_type(MyList()) == f"{MOD}.test_instance.<locals>.MyList"


def test_containers_flat():
    assert compact_type([1, 2]) == "list[int]"
    assert compact_type((1, "a")) == "tuple[int|str]"
    assert compact_type({1, 2}) == "set[int]"
    assert compact_type([]) == "list"
    assert compact_type({}) == "dict"


def test_dict_kv():
    assert compact_type({"k": 1}) == "dict[str, int]"
    assert compact_type({"k": 1, 2: "v"}) == "dict[str|int, int|str]"


def test_nested_depth_limit():
    # 深度 2：外层展开一层，内层到达深度上限 → [...]
    assert compact_type({"a": [1, 2]}) == "dict[str, list[int]]"
    assert compact_type([[[1]]]) == "list[list[list[...]]]"
    assert compact_type([[[[1]]]]) == "list[list[list[...]]]"  # 更深同样截断


def test_union_cap():
    # 超过 max_union 个不同类型 → 截断 |...
    v = [1, "a", 2.0, b"x", None, True]
    assert compact_type(v, max_depth=2, max_union=3, sample=8) == "list[int|str|float|...]"


def test_sample_cap():
    # 采样上限：前 8 个元素决定类型集合
    v = list(range(100)) + ["tail"]
    assert compact_type(v) == "list[int]"  # tail 未被采样


def test_functions_and_modules():
    assert compact_type(test_scalars) == "Callable"
    assert compact_type(print) == "Callable"
    assert compact_type(sys) == "module"
    assert compact_type(int) == "type[int]"


def test_shape_fingerprint_dict():
    assert shape_fingerprint({"title": 1, "links": 2}) == '{"links":"int","title":"int"}'
    assert shape_fingerprint({1: 2}) is None          # 非 str 键
    assert shape_fingerprint({}) is None              # 空
    assert shape_fingerprint({"k": 1}) == '{"k":"int"}'


def test_shape_fingerprint_nested_dict():
    # 值本身是 dict → 记值类型 + 子键集合（一层链式下标补全用）
    import json
    obj = json.loads(shape_fingerprint({"data": {"diff": [1, 2], "total": 3}}))
    assert set(obj["data"]["k"]) == {"diff", "total"}
    assert obj["data"]["t"].startswith("dict")


def test_shape_fingerprint_nested_list_of_dict():
    # 值是 list-of-dict → 记 list 类型 + 合并的元素 dict 键结构（{"e": {"t","k"}}）
    import json
    obj = json.loads(shape_fingerprint({"rows": [{"code": "1"}, {"code": "2", "name": "b"}]}))
    assert set(obj["rows"]["e"]["k"]) == {"code", "name"}
    assert obj["rows"]["t"].startswith("list")


def test_shape_fingerprint_top_list():
    # 顶层 list-of-dict → {"e": 元素结构}，供 list 元素索引补全
    import json
    obj = json.loads(shape_fingerprint([{"code": "1", "name": "a"}]))
    assert set(obj["e"]["k"]) == {"code", "name"}


def test_shape_fingerprint_deep_nested():
    # 多层嵌套：dict → dict → list → dict（验证递归深处）
    import json
    v = {"data": {"diff": [{"code": "1", "price": 1.0}]}}
    obj = json.loads(shape_fingerprint(v))
    assert obj["data"]["k"]["diff"]["e"]["k"]["code"]  # 深处可达
    assert set(obj["data"]["k"]["diff"]["e"]["k"]) == {"code", "price"}


def test_shape_fingerprint_instance():
    assert shape_fingerprint(Widget()) == '["a","b"]'
    assert shape_fingerprint(SubWidget()) == '["a","b"]'
    assert shape_fingerprint(1) is None               # 无 __dict__
    assert shape_fingerprint([1]) is None             # list 无 __dict__


def test_shape_fingerprint_large():
    big = {f"k{i}": i for i in range(20)}
    assert shape_fingerprint(big) is None  # 超过 max_keys


def test_shape_elem_sample_cap():
    """回归（P0）：_elem_shape 对超大 list-of-dict 有元素采样上限，不全量遍历。

    只出现在采样窗口之外的元素键会被省略（有意的精度换性能取舍）。
    """
    import json
    v = [{"x": 1} for _ in range(1000)] + [{"late_only": 1}]
    obj = json.loads(shape_fingerprint(v))
    assert set(obj["e"]["k"]) == {"x"}  # late_only 在采样上限之外，被省略


def test_set_union_order_stable():
    """回归（P1-15）：set/frozenset 的类型联合排序后拼接——迭代序受
    PYTHONHASHSEED 影响是进程级随机源，必须排序保证跨进程产出相同字符串。"""
    assert compact_type({1, "a", 2.0}) == "set[float|int|str]"
    assert compact_type(frozenset({1, "a", 2.0})) == "frozenset[float|int|str]"


def test_shape_list_of_dict_key_order_stable():
    """回归（P1-15）：同构 list-of-dict 因构造路径键序不同（先 {"b"} 后 {"a"} vs 反之）
    不得分裂出不同指纹——顶层 list 序列化补 sort_keys=True。"""
    a = shape_fingerprint([{"b": 1, "a": 2}, {"c": 3}])
    b = shape_fingerprint([{"c": 3}, {"a": 2, "b": 1}])
    assert a is not None and a == b
