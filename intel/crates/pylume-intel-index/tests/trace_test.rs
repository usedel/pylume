//! trace 索引层集成测试：造库 → 加载 → 查询。

use pylume_intel_index::{TraceIndex, SCHEMA};
use rusqlite::Connection;

fn seed(conn: &Connection) {
    conn.execute_batch(SCHEMA).unwrap();
    conn.execute(
        "INSERT INTO functions(filename, qualname, lineno, hits, stale) VALUES('a.py','A.foo',10,7,0)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO functions(filename, qualname, lineno, hits, stale) VALUES('b.py','B.bar',20,3,1)",
        [],
    )
    .unwrap();
    // A.foo (fid=1) 的观测：args + ret + exc
    conn.execute(
        "INSERT INTO arg_types(fid,arg,type_label,shape,count) VALUES(1,'x','int','',5)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO arg_types(fid,arg,type_label,shape,count) VALUES(1,'y','dict[str,int]','[\"a\",\"b\"]',2)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'str','',8)",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO exc_types(fid,exc_label,count) VALUES(1,'ValueError',1)",
        [],
    )
    .unwrap();
}

#[test]
fn loads_and_queries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("t.db");
    let conn = Connection::open(&path).unwrap();
    seed(&conn);
    drop(conn);

    let idx = TraceIndex::open(&path).unwrap();
    assert_eq!(idx.len(), 2);

    let foo: Vec<_> = idx.by_qualname("A.foo").collect();
    assert_eq!(foo.len(), 1);
    let f = foo[0];
    assert_eq!(f.filename, "a.py");
    assert_eq!(f.lineno, 10);
    assert_eq!(f.hits, 7);
    assert!(!f.stale);
    assert!(f.excs.is_empty() == false);
    assert_eq!(f.excs[0].exc_label, "ValueError");

    // shape 空串归一化为 None，非空保留
    assert_eq!(f.args.len(), 2);
    assert_eq!(f.args[0].shape, None);
    assert_eq!(f.args[1].shape.as_deref(), Some("[\"a\",\"b\"]"));
    assert_eq!(f.rets.len(), 1);
    assert_eq!(f.rets[0].type_label, "str");

    // 位置查询
    let loc: Vec<_> = idx.by_location("a.py", 10).collect();
    assert_eq!(loc.len(), 1);
    assert_eq!(loc[0].qualname, "A.foo");

    // 文件查询；stale 读取正确
    let b: Vec<_> = idx.by_file("b.py").collect();
    assert_eq!(b.len(), 1);
    assert!(b[0].stale);
    assert_eq!(b[0].hits, 3);

    // 未命中
    assert_eq!(idx.by_qualname("Nope.missing").count(), 0);
    assert_eq!(idx.by_location("a.py", 999).count(), 0);
}

#[test]
fn empty_db_loads() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("empty.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
    }
    let idx = TraceIndex::open(&path).unwrap();
    assert!(idx.is_empty());
}

#[test]
fn shape_empty_string_becomes_none_even_when_named_column_nullable() {
    // probe 端 shape 存空串；直接塞空串验证归一化（与上面用例交叉覆盖）。
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("s.db");
    {
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn.execute(
            "INSERT INTO functions(filename,qualname,lineno,hits,stale) VALUES('c.py','C.z',1,0,0)",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO ret_types(fid,type_label,shape,count) VALUES(1,'int','',1)",
            [],
        )
        .unwrap();
    }
    let idx = TraceIndex::open(&path).unwrap();
    let f: Vec<_> = idx.by_qualname("C.z").collect();
    assert_eq!(f[0].rets[0].shape, None);
}

/// CR-16：不存在的路径必须报错且**不得创建空 .db 文件**（原 Connection::open 会创建）。
#[test]
fn missing_db_errors_without_creating_file() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("never-exists.db");
    assert!(TraceIndex::open(&path).is_err());
    assert!(!path.exists(), "open 不得创建垃圾 .db 文件");
}

/// CR-17：最后段倒排查询（hover/definition/推断的查询路径）。
#[test]
fn by_last_segment_queries() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ls.db");
    {
        let conn = Connection::open(&path).unwrap();
        seed(&conn);
    }
    let idx = TraceIndex::open(&path).unwrap();
    // `A.foo` 的最后段 `foo`
    let foo: Vec<_> = idx.by_last_segment("foo").collect();
    assert_eq!(foo.len(), 1);
    assert_eq!(foo[0].qualname, "A.foo");
    // `B.bar` 的最后段 `bar`
    let bar: Vec<_> = idx.by_last_segment("bar").collect();
    assert_eq!(bar.len(), 1);
    assert!(bar[0].stale);
    // 未命中返回空
    assert_eq!(idx.by_last_segment("nope").count(), 0);
    // 倒数第二段：A.foo 的倒数第二段是 A
    let in_a: Vec<_> = idx.by_second_last_segment("A").collect();
    assert_eq!(in_a.len(), 1);
    // 前缀迭代：`f` 开头的最后段（foo）
    let pref: Vec<_> = idx.functions_by_last_segment_prefix("f").collect();
    assert_eq!(pref.len(), 1);
    assert_eq!(pref[0].qualname, "A.foo");
}

/// CR-17：type_label 倒排观测查询（members/chain/first_shape 的查询路径）。
#[test]
fn observations_of_type_merges_args_and_rets() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("ty.db");
    {
        let conn = Connection::open(&path).unwrap();
        seed(&conn);
    }
    let idx = TraceIndex::open(&path).unwrap();
    // int：args 里的 x（非 ret）；str：rets（is_ret = true）
    let ints: Vec<_> = idx.observations_of_type("int").collect();
    assert_eq!(ints.len(), 1);
    assert_eq!(ints[0].1.arg, "x");
    assert!(!ints[0].2);
    let strs: Vec<_> = idx.observations_of_type("str").collect();
    assert_eq!(strs.len(), 1);
    assert!(strs[0].2);
    // dict 类型带 shape
    let dicts: Vec<_> = idx.observations_of_type("dict[str,int]").collect();
    assert_eq!(dicts.len(), 1);
    assert_eq!(dicts[0].1.shape.as_deref(), Some("[\"a\",\"b\"]"));
    assert_eq!(idx.observations_of_type("nope").count(), 0);
}