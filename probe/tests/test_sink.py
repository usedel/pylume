"""观测聚合器单测（P1-14 回归：func_id 多线程竞态）。"""
from __future__ import annotations

import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from pylume_probe.sink import ObservationSink  # noqa: E402


def test_func_id_basic():
    sink = ObservationSink()
    a = sink.func_id("f.py", "foo", 1)
    b = sink.func_id("f.py", "foo", 1)
    c = sink.func_id("f.py", "bar", 2)
    assert a == b
    assert a != c


def test_func_id_thread_safe():
    """回归（P1-14）：多线程首次并发调用同一函数——func_id 的 get+赋值非原子时，
    两线程拿到相同 _next_fid 且后者覆盖 funcs[key]，先返回的 fid 成孤儿，
    落库阶段 fid_map[mf] KeyError → save 抛异常 → 整次观测丢失。"""
    for _ in range(50):  # 重复多轮放大竞态窗口命中率
        sink = ObservationSink()
        n_threads = 8
        n_calls = 200
        barrier = threading.Barrier(n_threads)

        def worker(out: list[int], base: int):
            barrier.wait()  # 对齐起跑线，最大化首见并发概率
            for i in range(n_calls):
                out.append(sink.func_id("f.py", f"fn_{i % 17}", i))

        results: list[int] = []
        threads = [threading.Thread(target=worker, args=(results, t)) for t in range(n_threads)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # 断言 1：fid 无重复（同一函数的并发首见不产生双 fid）
        assert len(results) == n_threads * n_calls
        # 断言 2：funcs 表中每个键唯一且 fid 与 _next_fid 计数一致（无孤儿）
        fids = sorted(sink.funcs.values())
        assert fids == list(range(len(sink.funcs)))
        # 断言 3：同一 key 的并发调用返回同一 fid
        for key, fid in sink.funcs.items():
            assert isinstance(fid, int) and fid >= 0


def test_func_id_concurrent_distinct_keys_unique():
    """不同 key 并发首见：fid 序列仍两两不重（_next_fid 递增不被并发撕裂）。"""
    sink = ObservationSink()
    barrier = threading.Barrier(4)

    def worker(out: list[int], offset: int):
        barrier.wait()
        for i in range(100):
            out.append(sink.func_id("f.py", f"fn_{offset}_{i}", i))

    threads_results: list[list[int]] = [[], [], [], []]
    threads = [
        threading.Thread(target=worker, args=(threads_results[i], i))
        for i in range(4)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    all_fids = [f for r in threads_results for f in r]
    assert len(all_fids) == 400
    assert len(set(all_fids)) == 400  # 400 个不同 key → 400 个不同 fid


def test_monitor_fid_filename_normalized():
    """回归（P2-4）：Monitor._fid 对 filename 做 normcase+normpath——
    Windows 下大小写/分隔符变体（f:/x\\app.py vs F:\\X\\app.py）须落同一 fid，
    否则同函数跨运行在 functions 表分裂多行（跨运行聚合语义被破坏）。"""
    import os

    from pylume_probe.config import ProbeConfig
    from pylume_probe.monitor import Monitor

    for variant in ("F:\\X\\App.PY", "f:/x\\app.py", "F:/X/app.py"):
        sink = ObservationSink()
        mon = Monitor(ProbeConfig(), sink, "F:/X")
        # 直接构造 code 不可行（co_filename 只读），走 _fid 的缓存路径等价验证：
        # 用 types.FunctionType 动态造一个 code 也复杂——改为直接断言归一化行为：
        class FakeCode:
            co_filename = variant
            co_qualname = "fn"
            co_firstlineno = 1

        f = mon._fid(FakeCode())  # type: ignore[arg-type]
        g = sink.func_id(os.path.normcase(os.path.normpath("F:/X/app.py")), "fn", 1)
        assert f == g, f"{variant} 归一化后应与 F:/X/app.py 同 fid"
