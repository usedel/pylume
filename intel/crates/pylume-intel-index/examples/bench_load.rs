//! P3-T02 性能验收：生成 10 万条 functions + 观测 → `TraceIndex::open` 计时。
//!
//! 运行：`cargo run --release --example bench_load`（release 下验收 < 2s，debug 仅自查功能）。

use std::path::PathBuf;
use std::time::Instant;

use pylume_intel_index::{TraceIndex, SCHEMA};
use rusqlite::Connection;

fn seed_db(path: &std::path::Path, n_functions: usize) {
    if path.exists() {
        std::fs::remove_file(path).unwrap();
    }
    let mut conn = Connection::open(path).unwrap();
    conn.execute_batch(SCHEMA).unwrap();

    let tx = conn.transaction().unwrap();
    {
        let mut stmt = tx
            .prepare("INSERT INTO functions(filename, qualname, lineno, hits, stale) VALUES(?1,?2,?3,?4,?5)")
            .unwrap();
        for i in 0..n_functions {
            let filename = format!("pkg/mod{}.py", i % 100);
            let qualname = format!("pkg{}.func_{}", i % 500, i);
            let lineno = (i % 2000) as i64 + 1;
            stmt.execute(rusqlite::params![filename, qualname, lineno, 5, 0])
                .unwrap();
        }
        let mut arg_stmt = tx
            .prepare("INSERT INTO arg_types(fid,arg,type_label,shape,count) VALUES(?1,?2,?3,'',?4)")
            .unwrap();
        let mut ret_stmt = tx
            .prepare("INSERT INTO ret_types(fid,type_label,shape,count) VALUES(?1,?2,'',?3)")
            .unwrap();
        for fid in 1..=n_functions as i64 {
            // 每函数 2 个参数观测 + 1 个返回观测，贴近真实分布
            if fid % 3 == 0 {
                arg_stmt
                    .execute(rusqlite::params![fid, "x", "int", 3])
                    .unwrap();
            }
            arg_stmt
                .execute(rusqlite::params![fid, "self", "pathlib.Path", 5])
                .unwrap();
            ret_stmt
                .execute(rusqlite::params![fid, "dict[str,int]", 4])
                .unwrap();
        }
    }
    tx.commit().unwrap();
}

fn main() {
    let n = 100_000;
    let path: PathBuf = std::env::temp_dir().join("pylume-intel-bench.db");

    println!("seeding {n} functions ...");
    let t0 = Instant::now();
    seed_db(&path, n);
    println!("  seed took {:?}", t0.elapsed());

    let t1 = Instant::now();
    let idx = TraceIndex::open(&path).unwrap();
    let elapsed = t1.elapsed();

    println!("loaded {} functions in {:?}", idx.len(), elapsed);
    println!("by_location('pkg/mod0.py', 1) -> {} funcs",
        idx.by_location("pkg/mod0.py", 1).count());

    let _ = std::fs::remove_file(&path);

    let ms = elapsed.as_secs_f64() * 1000.0;
    let pass = elapsed.as_secs() < 2;
    println!("result: {} ({:.1} ms vs 2000 ms budget)", if pass { "PASS" } else { "FAIL" }, ms);
    if !pass {
        std::process::exit(1);
    }
}