//! pylume-intel-index：trace 索引层（P3-T02）。
//!
//! 独立库 crate，只读消费 pylume-probe 写入的 SQLite trace 库
//! （`~/.pylume/traces/<project-hash>.db`），在内存中构建查询索引。
//! 不依赖外壳内部 API（架构第一原则）。
//!
//! 性能目标：10 万条 functions 记录加载 < 2s（release 下验收，见 `examples/bench_load.rs`）。

pub mod trace;
pub mod type_label;

pub use trace::{ExcObs, Function, TraceError, TraceIndex, TypeObs, SCHEMA};
pub use type_label::{parse, TypeLabel};