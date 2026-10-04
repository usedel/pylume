//! 按窗口隔离的进程内状态容器（阶段 1 核心抽象）。
//!
//! `WindowKey = window label`（多窗口计划 `docs/multi_window_dev_plan.md` §2.1）。
//! 单窗口下等价于原单例（仅一个 wid）；多窗口下各窗口独立。
//!
//! 设计取舍：不提供 `with/entry` 这类「闭包内操作」的便捷封装——各调用点的控制流
//! 差异很大（尤其线程循环里的条件 `return`），闭包模式会迫使这些控制流改写为返回值
//! 模式、引入无谓的 `Result`。统一暴露 `lock()` 借出整张表，调用方按 `wid` 做两级
//! 查找即可，改动最直白、与现有 `unpoison(LSP.lock())` 风格一致。

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use crate::util::unpoison;

pub struct PerWindow<T>(Mutex<HashMap<String, T>>);

impl<T> Default for PerWindow<T> {
    fn default() -> Self {
        Self(Mutex::new(HashMap::new()))
    }
}

impl<T> PerWindow<T> {
    pub fn new() -> Self {
        Self::default()
    }

    /// 借用整张「窗口 → 值」表。调用方按 `wid` 做二级操作。
    pub fn lock(&self) -> MutexGuard<'_, HashMap<String, T>> {
        unpoison(self.0.lock())
    }

    /// 该窗口是否有值。
    pub fn contains(&self, wid: &str) -> bool {
        self.lock().contains_key(wid)
    }

    /// 写入（覆盖）某窗口的值，返回旧值。
    pub fn insert(&self, wid: &str, v: T) -> Option<T> {
        self.lock().insert(wid.to_string(), v)
    }

    /// 取出某窗口的值（窗口关闭清理用）。
    pub fn remove(&self, wid: &str) -> Option<T> {
        self.lock().remove(wid)
    }

    /// 清空全部窗口（应用退出 `RunEvent::Exit` 清理用）。
    pub fn drain_all(&self) -> Vec<T> {
        self.lock().drain().map(|(_, v)| v).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn per_window_isolates_windows() {
        let pw = PerWindow::<i32>::new();
        pw.insert("a", 1);
        pw.insert("b", 2);
        assert_eq!(pw.contains("a"), true);
        assert_eq!(pw.contains("b"), true);
        assert_eq!(pw.lock().get("a").copied(), Some(1));
        assert_eq!(pw.lock().get("b").copied(), Some(2));
    }

    #[test]
    fn per_window_remove_only_target() {
        let pw = PerWindow::<i32>::new();
        pw.insert("a", 1);
        pw.insert("b", 2);
        assert_eq!(pw.remove("a"), Some(1));
        assert_eq!(pw.contains("a"), false);
        assert_eq!(pw.contains("b"), true);
    }

    #[test]
    fn per_window_insert_replaces() {
        let pw = PerWindow::<i32>::new();
        pw.insert("a", 1);
        assert_eq!(pw.insert("a", 2), Some(1));
        assert_eq!(pw.lock().get("a").copied(), Some(2));
    }

    #[test]
    fn per_window_drain_all_empties() {
        let pw = PerWindow::<i32>::new();
        pw.insert("a", 1);
        pw.insert("b", 2);
        let drained: Vec<i32> = pw.drain_all();
        assert_eq!(drained.len(), 2);
        assert_eq!(pw.lock().len(), 0);
    }
}