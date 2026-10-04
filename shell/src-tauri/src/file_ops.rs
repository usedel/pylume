// 文件管理写操作（P25-T01）：增/删/改名/复制粘贴/回收站/资源管理器/剪贴板。
// 设计要点：
// - 删除走系统回收站（trash crate，Windows SHFileOperation），绝不 std::fs::remove_dir_all；
// - 粘贴同名自动加「 - 副本」后缀；
// - 重命名联动逻辑（标签/LSP/诊断/树）在 T03 由前端负责，这里只做磁盘层面 rename 并返回结果。

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::util::{no_window, pylume_home};

/// 新建空文件（父目录不存在时自动创建）；已存在则报错。
#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("文件已存在：{path}"));
    }
    if let Some(parent) = p.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::File::create(p).map(|_| ()).map_err(|e| e.to_string())
}

/// 新建文件夹（支持嵌套路径）；已存在则报错。
#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("路径已存在：{path}"));
    }
    fs::create_dir_all(p).map_err(|e| e.to_string())
}

/// 新建 Python 包：建目录 + 写一个空的 `__init__.py`（单命令原子完成，避免「目录已建、__init__.py 缺失」半成品）。
/// path 为包目录绝对路径；已存在则报错。
#[tauri::command]
pub fn create_py_package(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.exists() {
        return Err(format!("路径已存在：{path}"));
    }
    fs::create_dir_all(p).map_err(|e| e.to_string())?;
    fs::File::create(p.join("__init__.py")).map(|_| ()).map_err(|e| e.to_string())
}

/// 文件/目录重命名（磁盘层面，跨目录移动也支持）。
#[tauri::command]
pub fn rename_path(old_path: String, new_path: String) -> Result<(), String> {
    let old = Path::new(&old_path);
    if !old.exists() {
        return Err(format!("源路径不存在：{old_path}"));
    }
    let new = Path::new(&new_path);
    if new.exists() {
        return Err(format!("目标路径已存在：{new_path}"));
    }
    if let Some(parent) = new.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }
    fs::rename(old, new).map_err(|e| e.to_string())
}

/// 删除到系统回收站（可恢复）；trash crate 跨平台。
/// async + spawn_blocking：大目录移回收站可能耗时，同步 command 会卡死主线程 UI。
#[tauri::command]
pub async fn trash_path(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        trash::delete(Path::new(&path)).map_err(|e| format!("移入回收站失败：{e}"))
    })
    .await
    .map_err(|e| format!("任务执行异常：{e}"))?
}

/// 精确复制：src（文件或目录）→ dst 完整目标路径。
#[tauri::command]
pub async fn copy_path(src: String, dst: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || copy_path_impl(src, dst))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn copy_path_impl(src: String, dst: String) -> Result<(), String> {
    copy_recursive(Path::new(&src), Path::new(&dst)).map_err(|e| e.to_string())
}

/// 粘贴：src → dst_dir/同名（同名自动加「 - 副本」），返回最终新路径。
#[tauri::command]
pub async fn paste_path(src: String, dst_dir: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || paste_path_impl(src, dst_dir))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn paste_path_impl(src: String, dst_dir: String) -> Result<String, String> {
    let src = PathBuf::from(&src);
    let file_name = src
        .file_name()
        .ok_or_else(|| format!("源路径无效：{}", src.display()))?
        .to_os_string();
    let dst = unique_target(&Path::new(&dst_dir).join(&file_name));
    copy_recursive(&src, &dst).map_err(|e| e.to_string())?;
    Ok(dst.to_string_lossy().to_string())
}

/// 在系统资源管理器中显示并选中该文件/目录（Windows explorer /select）。
#[tauri::command]
pub fn reveal_in_explorer(path: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // /select,<path>：逗号紧跟 select，整个参数一体（逗号后不能有空格）
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(format!("/select,{path}"));
        no_window(&mut cmd)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开资源管理器：{e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        let p = Path::new(&path);
        let dir = if p.is_dir() { p } else { p.parent().unwrap_or(p) };
        std::process::Command::new("xdg-open")
            .arg(dir)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = path;
        Err("当前平台不支持的资源管理器操作".into())
    }
}

/// 用系统默认浏览器打开 URL（Markdown 预览点击外部链接用）。
/// 仅放行 http/https，杜绝 `javascript:`、`file:` 等协议从预览注入。
/// 与 reveal_in_explorer 同款的跨平台 spawn + no_window，零新依赖。
#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err(format!("仅允许 http/https 链接：{u}"));
    }
    #[cfg(windows)]
    {
        // explorer 直接接受 URL 参数（不经过 shell 解析，避免 & / ^ 等 cmd 元字符被误解释），
        // 会把 http(s) 交给系统默认浏览器。
        let mut cmd = std::process::Command::new("explorer");
        cmd.arg(u);
        no_window(&mut cmd)
            .spawn()
            .map(|_| ())
            .map_err(|e| format!("无法打开浏览器：{e}"))
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(u)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(u)
            .spawn()
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = u;
        Err("当前平台不支持打开外部链接".into())
    }
}

/// 文本写入系统剪贴板（tauri clipboard-manager 插件）。
#[tauri::command]
pub fn copy_to_clipboard(app: tauri::AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
        .map_err(|e| format!("写入剪贴板失败：{e}"))
}

// ---------- 内部实现 ----------

/// 递归复制：目录递归建结构，文件走 fs::copy。不依赖第三方 crate。
fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    let meta = fs::metadata(src)?;
    if meta.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            copy_recursive(&entry.path(), &dst.join(entry.file_name()))?;
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        let n = fs::copy(src, dst)?;
        let _ = n;
        Ok(())
    }
}

/// 目标已存在时追加「 - 副本」（可叠加 - 副本 2 / - 副本 3 …）。
fn unique_target(dst: &Path) -> PathBuf {
    if !dst.exists() {
        return dst.to_path_buf();
    }
    let parent = dst.parent().unwrap_or_else(|| Path::new(""));
    let stem = dst
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = dst.extension().map(|s| s.to_string_lossy().to_string());
    let mut n = 1;
    loop {
        let suffix = if n == 1 { String::new() } else { format!(" {n}") };
        let name = if let Some(e) = &ext {
            format!("{stem} - 副本{suffix}.{e}")
        } else {
            format!("{stem} - 副本{suffix}")
        };
        let cand = parent.join(name);
        if !cand.exists() {
            return cand;
        }
        n += 1;
    }
}

/// 工作区哈希（复用 probe 的算法：realpath 归一化后 sha1 前 12 位 hex）。
/// 见 probe/src/pylume_probe/store.py::project_hash。
pub fn project_hash(root: &str) -> String {
    use sha1::{Digest, Sha1};
    let canonical = fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root));
    // Windows 上 fs::canonicalize 返回 verbatim 路径（\\?\F:\... / \\?\UNC\...），
    // 与 Python os.path.realpath（F:\... / \\server\...）不一致——去前缀对齐，
    // 否则 shell 与 probe 的 trace 库 hash 错位（P3-T06' 根因）。
    let norm = canonical.to_string_lossy().replace('/', "\\");
    let norm = strip_verbatim_prefix(&norm);
    // tech-debt #4：Windows 路径不区分大小写，与 probe 的 os.path.normcase（.lower()）对齐——
    // 否则同一目录大小写不同会各产一个 trace 库，intel 读不到 probe 写的数据。
    #[cfg(windows)]
    let norm = norm.to_lowercase();
    let mut hasher = Sha1::new();
    hasher.update(norm.as_bytes());
    let digest = hasher.finalize();
    digest.iter().take(6).map(|b| format!("{b:02x}")).collect()
}

/// 去掉 Windows verbatim 路径前缀（\\?\ 与 \\?\UNC\）。
fn strip_verbatim_prefix(path: &str) -> String {
    if let Some(rest) = path.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{rest}")
    } else if let Some(rest) = path.strip_prefix("\\\\?\\") {
        rest.to_string()
    } else {
        path.to_string()
    }
}

// ---------- 最近打开文件（P25-T09，工作区级，存 <data_root>/recent/<hash>.json） ----------

fn recent_path(root: &str) -> PathBuf {
    pylume_home().join("recent").join(format!("{}.json", project_hash(root)))
}

#[tauri::command]
pub fn get_recent(workspace_root: String) -> Result<Vec<String>, String> {
    let p = recent_path(&workspace_root);
    if !p.is_file() {
        return Ok(Vec::new());
    }
    let s = fs::read_to_string(p).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&s).unwrap_or_default())
}

/// 记录最近打开（去重 + 过滤已删除 + 置顶 + 上限 10），返回更新后的列表
#[tauri::command]
pub fn add_recent(workspace_root: String, file: String) -> Result<Vec<String>, String> {
    let mut list: Vec<String> = get_recent(workspace_root.clone()).unwrap_or_default();
    list.retain(|x| x != &file && Path::new(x).is_file());
    list.insert(0, file);
    list.truncate(10);
    let p = recent_path(&workspace_root);
    fs::create_dir_all(p.parent().unwrap_or(Path::new(""))).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&list).map_err(|e| format!("序列化最近文件列表失败：{e}"))?;
    fs::write(p, json).map_err(|e| e.to_string())?;
    Ok(list)
}

// ---------- 书签（P2：行级书签，工作区级，存 <data_root>/bookmarks/<hash>.json） ----------

/// 一个书签：文件 + 行号 + 建书签时那一行的文本（列表里直接能看懂，不必再读盘）
#[derive(Serialize, Deserialize, Clone)]
pub struct Bookmark {
    pub path: String,
    pub line: u32,
    pub text: String,
}

fn bookmarks_path(root: &str) -> PathBuf {
    pylume_home().join("bookmarks").join(format!("{}.json", project_hash(root)))
}

/// 全部书签（按添加顺序）
#[tauri::command]
pub fn get_bookmarks(workspace_root: String) -> Result<Vec<Bookmark>, String> {
    let p = bookmarks_path(&workspace_root);
    if !p.is_file() {
        return Ok(Vec::new());
    }
    let s = fs::read_to_string(p).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&s).unwrap_or_default())
}

fn write_bookmarks(workspace_root: &str, list: &[Bookmark]) -> Result<(), String> {
    let p = bookmarks_path(workspace_root);
    fs::create_dir_all(p.parent().unwrap_or(Path::new(""))).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(list).map_err(|e| format!("序列化书签失败：{e}"))?;
    fs::write(p, json).map_err(|e| e.to_string())
}

/// 切换书签：同文件同行已存在则移除，否则追加（返回更新后的列表）
#[tauri::command]
pub fn toggle_bookmark(
    workspace_root: String,
    path: String,
    line: u32,
    text: String,
) -> Result<Vec<Bookmark>, String> {
    let mut list = get_bookmarks(workspace_root.clone())?;
    let hit = list.iter().position(|b| b.path == path && b.line == line);
    match hit {
        Some(i) => {
            list.remove(i);
        }
        None => list.push(Bookmark { path, line, text }),
    }
    write_bookmarks(&workspace_root, &list)?;
    Ok(list)
}

/// 清空工作区全部书签
#[tauri::command]
pub fn clear_bookmarks(workspace_root: String) -> Result<Vec<Bookmark>, String> {
    write_bookmarks(&workspace_root, &[])?;
    Ok(Vec::new())
}

// ---------- 断点持久化（P2-11 UX 审查：断点随工作区落盘，与书签同模式） ----------
//
// 此前端内只在内存保留断点表（跨调试会话、不跨应用重启），而书签却持久化——行为不一致。
// 存 <data_root>/breakpoints/<hash>.json；wire 格式用 camelCase 直接对齐 TS 的 BreakpointSpec，
// 空串表示无该高级属性（TS 侧加载时归一为 undefined，保持「空 spec 即普通断点」语义）。

/// 一条持久化断点：文件路径 + 行号 + DAP 高级属性（空串 = 无）
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistedBreakpoint {
    pub path: String,
    pub line: u32,
    #[serde(default)]
    pub condition: String,
    #[serde(default)]
    pub hit_condition: String,
    #[serde(default)]
    pub log_message: String,
    /// 启用状态（B-6；缺省 = 启用——旧快照无此字段时不改变行为）
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

fn breakpoints_path(root: &str) -> PathBuf {
    pylume_home().join("breakpoints").join(format!("{}.json", project_hash(root)))
}

/// 全部持久化断点（文件不存在返回空表）
#[tauri::command]
pub fn get_breakpoints(workspace_root: String) -> Result<Vec<PersistedBreakpoint>, String> {
    let p = breakpoints_path(&workspace_root);
    if !p.is_file() {
        return Ok(Vec::new());
    }
    let s = fs::read_to_string(p).map_err(|e| e.to_string())?;
    Ok(serde_json::from_str(&s).unwrap_or_default())
}

/// 全量覆盖写入断点表（前端每次断点表变更后整体落盘，量级小、语义最简）
#[tauri::command]
pub fn set_breakpoints(workspace_root: String, breakpoints: Vec<PersistedBreakpoint>) -> Result<(), String> {
    let p = breakpoints_path(&workspace_root);
    fs::create_dir_all(p.parent().unwrap_or(Path::new(""))).map_err(|e| e.to_string())?;
    let json = serde_json::to_string(&breakpoints).map_err(|e| format!("序列化断点失败：{e}"))?;
    fs::write(p, json).map_err(|e| e.to_string())
}

// ---------- 单元测试 ----------

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn tmpdir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("pylume-test-{tag}-{nanos}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn test_unique_target_no_conflict() {
        let base = tmpdir("unique");
        let dst = base.join("a.py");
        fs::write(&dst, "").unwrap();
        // a.py 已存在 → a - 副本.py
        let got = unique_target(&dst);
        assert_eq!(got.file_name().unwrap().to_string_lossy(), "a - 副本.py");
        assert!(!got.exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn test_unique_target_no_ext() {
        let base = tmpdir("unique2");
        let dst = base.join("hello");
        fs::create_dir_all(&dst).unwrap();
        let got = unique_target(&dst);
        assert_eq!(got.file_name().unwrap().to_string_lossy(), "hello - 副本");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn test_unique_target_when_free() {
        let base = tmpdir("unique3");
        let dst = base.join("free.py");
        let got = unique_target(&dst);
        assert_eq!(got, dst);
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn test_create_file_and_dir() {
        let base = tmpdir("create");
        let nested = base.join("pkg").join("mod.py");
        create_file(nested.to_string_lossy().to_string()).unwrap();
        assert!(nested.is_file());
        // 已存在报错
        assert!(create_file(nested.to_string_lossy().to_string()).is_err());
        // 新建目录
        let d = base.join("a").join("b");
        create_dir(d.to_string_lossy().to_string()).unwrap();
        assert!(d.is_dir());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn test_create_py_package() {
        let base = tmpdir("pkg");
        // 嵌套包路径一次建全，且生成空 __init__.py
        let pkg = base.join("a").join("b");
        create_py_package(pkg.to_string_lossy().to_string()).unwrap();
        assert!(pkg.is_dir());
        let init = pkg.join("__init__.py");
        assert!(init.is_file());
        assert_eq!(fs::read_to_string(&init).unwrap(), "");
        // 已存在报错
        assert!(create_py_package(pkg.to_string_lossy().to_string()).is_err());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn test_rename_path() {
        let base = tmpdir("rename");
        let a = base.join("a.py");
        fs::write(&a, "x=1").unwrap();
        let b = base.join("sub").join("b.py");
        rename_path(a.to_string_lossy().to_string(), b.to_string_lossy().to_string()).unwrap();
        assert!(!a.exists());
        assert!(b.is_file());
        assert_eq!(fs::read_to_string(&b).unwrap(), "x=1");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn test_copy_recursive_and_paste() {
        let base = tmpdir("copy");
        let src_dir = base.join("src");
        fs::create_dir_all(src_dir.join("sub")).unwrap();
        fs::write(src_dir.join("a.txt"), "hello").unwrap();
        fs::write(src_dir.join("sub").join("b.txt"), "world").unwrap();

        // copy_path 目录 → 精确目标
        let dst_dir = base.join("dst");
        copy_path_impl(src_dir.to_string_lossy().to_string(), dst_dir.to_string_lossy().to_string())
            .unwrap();
        assert!(dst_dir.join("a.txt").is_file());
        assert!(dst_dir.join("sub").join("b.txt").is_file());

        // paste_path 到已含同名目录 → 自动加副本
        let new_path = paste_path_impl(src_dir.to_string_lossy().to_string(), base.to_string_lossy().to_string())
            .unwrap();
        assert!(Path::new(&new_path).exists());
        assert!(new_path.contains("副本"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn test_project_hash_deterministic() {
        let h1 = project_hash(".");
        let h2 = project_hash(".");
        assert_eq!(h1, h2);
        assert_eq!(h1.len(), 12);
        assert!(h1.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn test_strip_verbatim_prefix() {
        assert_eq!(strip_verbatim_prefix("\\\\?\\F:\\ai-pro\\x"), "F:\\ai-pro\\x");
        assert_eq!(strip_verbatim_prefix("\\\\?\\UNC\\server\\share"), "\\\\server\\share");
        assert_eq!(strip_verbatim_prefix("F:\\plain\\path"), "F:\\plain\\path");
    }

    /// 与 probe 的口径对齐验证（**不依赖任何具体机器路径**）。
    ///
    /// probe（`probe/src/pylume_probe/store.py::project_hash`）的哈希输入是
    /// `sha1(normcase(normpath(realpath(root))))[:12]`：realpath 解析真实路径并去掉尾部分隔符，
    /// normpath 统一为反斜杠、normcase 统一大小写（Windows）。因此「同一目录的不同书写形式」
    /// （含大小写变体）在两端必须落到同一个 trace 库文件名上——这里用运行期真实存在的
    /// 临时目录断言这些不变式。
    ///
    /// （原实现写死本机 hash `dc7d8df083c6`，换机器/换盘符必然误报，故改为不变式断言。）
    #[test]
    fn project_hash_aligns_with_probe_normalization() {
        let dir = tmpdir("projhash");
        let plain = dir.to_string_lossy().to_string();

        // 1. 确定性 + 形态：12 位小写 hex
        let h = project_hash(&plain);
        assert_eq!(h, project_hash(&plain));
        assert_eq!(h.len(), 12);
        assert!(h.chars().all(|c| c.is_ascii_hexdigit()));

        // 2. 正/反斜杠混写（对应 Python normpath 的分隔符归一）
        assert_eq!(project_hash(&plain.replace('\\', "/")), h);

        // 3. 尾部分隔符（对应 realpath 归一：带与不带必须同键）
        assert_eq!(project_hash(&format!("{plain}/")), h);
        #[cfg(windows)]
        assert_eq!(project_hash(&format!("{plain}\\")), h);

        // 4. Windows verbatim 前缀：fs::canonicalize 会带 `\\?\`，而 Python realpath 不会
        //    —— strip_verbatim_prefix 正是两端对齐点（仅 Windows 有意义）。
        #[cfg(windows)]
        assert_eq!(project_hash(&format!("\\\\?\\{plain}")), h);

        // 5. Windows 大小写变体 → 同键（对应 probe 的 os.path.normcase / to_lowercase，tech-debt #4）
        #[cfg(windows)]
        assert_eq!(project_hash(&plain.to_uppercase()), h);
        #[cfg(windows)]
        assert_eq!(project_hash(&plain.to_lowercase()), h);

        // 6. 不同目录 → 不同键（trace 库文件名隔离）
        let other = dir.join("other");
        fs::create_dir_all(&other).unwrap();
        assert_ne!(project_hash(&other.to_string_lossy()), h);

        fs::remove_dir_all(dir).unwrap();
    }
}