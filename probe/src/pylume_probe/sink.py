"""观测聚合器：monitor 回调的最小出口，运行期零 I/O（采集无感的关键）。"""
from __future__ import annotations

import threading


class ObservationSink:
    """内存聚合观测数据；finalize 时由 store 批量写入 SQLite。

    聚合粒度（Phase 3 intel 消费的就是这些类型集合 + 频次）：
    - functions: (filename, qualname, lineno) -> fid
    - hits:      fid -> 调用次数
    - args:      (fid, 参数名, 类型标签, 结构指纹) -> 次数
    - rets:      (fid, 类型标签, 结构指纹) -> 次数
    - excs:      (fid, 异常类型标签) -> 次数
    """

    __slots__ = ("funcs", "_next_fid", "_fid_lock", "hits", "args", "rets", "excs",
                 "arg_seen", "ret_seen")

    def __init__(self) -> None:
        self.funcs: dict[tuple[str, str, int], int] = {}
        self._next_fid = 0
        # P1-14（2026-09-29 review）：func_id 的 get+赋值非原子——多线程首次并发调用
        # 同一函数时两人拿到相同 _next_fid，后写者覆盖 funcs[key]，先返回的 fid 成孤儿，
        # 落库时 fid_map[mf] KeyError → save 抛异常 → 整次观测丢失。冷路径（新函数首见）
        # 加双重检查锁；热路径（get 命中）无锁，开销红线不受影响。
        self._fid_lock = threading.Lock()
        self.hits: dict[int, int] = {}
        self.args: dict[tuple[int, str, str, str | None], int] = {}
        self.rets: dict[tuple[int, str, str | None], int] = {}
        self.excs: dict[tuple[int, str], int] = {}
        # 类型观测降采样计数（每参数位/返回位）
        self.arg_seen: dict[tuple[int, str], int] = {}
        self.ret_seen: dict[int, int] = {}

    def func_id(self, filename: str, qualname: str, lineno: int) -> int:
        key = (filename, qualname, lineno)
        fid = self.funcs.get(key)
        if fid is None:
            with self._fid_lock:
                fid = self.funcs.get(key)
                if fid is None:
                    fid = self._next_fid
                    self._next_fid += 1
                    self.funcs[key] = fid
        return fid

    def add_hit(self, fid: int) -> None:
        self.hits[fid] = self.hits.get(fid, 0) + 1

    def over_limit(self, fid: int, limit: int) -> bool:
        return self.hits.get(fid, 0) >= limit

    def arg_over(self, fid: int, name: str, limit: int) -> bool:
        """该参数位类型观测是否已达上限（降采样检查）。"""
        return self.arg_seen.get((fid, name), 0) >= limit

    def ret_over(self, fid: int, limit: int) -> bool:
        """该函数返回值类型观测是否已达上限（降采样检查）。"""
        return self.ret_seen.get(fid, 0) >= limit

    def add_arg(self, fid: int, name: str, type_label: str, shape: str | None) -> None:
        key = (fid, name, type_label, shape)
        self.args[key] = self.args.get(key, 0) + 1
        skey = (fid, name)
        self.arg_seen[skey] = self.arg_seen.get(skey, 0) + 1

    def add_ret(self, fid: int, type_label: str, shape: str | None) -> None:
        key = (fid, type_label, shape)
        self.rets[key] = self.rets.get(key, 0) + 1
        self.ret_seen[fid] = self.ret_seen.get(fid, 0) + 1

    def add_exc(self, fid: int, exc_label: str) -> None:
        key = (fid, exc_label)
        self.excs[key] = self.excs.get(key, 0) + 1

    @property
    def func_count(self) -> int:
        return len(self.funcs)

    @property
    def observation_count(self) -> int:
        return len(self.args) + len(self.rets) + len(self.excs)
