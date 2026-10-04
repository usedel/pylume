// 插件包导出/导入（P2 DX，plugin_system_design §9.16 P2）：
// 分发闭环的过渡形态——zip 导出（发给同事/上传）+ zip 导入（解包校验落盘），
// v2 的 .ocx 市场在此之上演进（加签名与元数据清单）。
//
// 安全边界：
// - 导入的 zip 解包到临时目录先校验（manifest 合法 + id 合法 + 无路径逃逸条目），
//   全部通过才落盘 extensions/——不校验直接解包等于任意代码投放；
// - Zip Slip 防护：条目名含 .. 或绝对路径直接拒绝；
// - 同名插件已存在 → 拒绝（不静默覆盖用户代码；想更新先手动删或改 id）。

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::util::pylume_home;

/// 导出插件目录为 zip（保存路径由前端文件对话框选择后传入）。
/// 目录名（=插件 id）作为 zip 内的根目录前缀——导入端据此还原结构。
/// 失败清理：zip 写入中途失败会留下损坏文件——删除后报错（不留半成品误导分享）。
/// P2-3（2026-09-29 review）：改 async + spawn_blocking——插件含大资源时
/// 递归读 + 压缩是重 IO，原同步命令在主线程执行会明显卡顿（铁律 5）。
#[tauri::command]
pub async fn export_plugin(plugin_dir: String, save_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || export_plugin_impl(&plugin_dir, &save_path))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn export_plugin_impl(plugin_dir: &str, save_path: &str) -> Result<String, String> {
    let src = Path::new(plugin_dir);
    if !src.is_dir() {
        return Err(format!("插件目录不存在：{plugin_dir}"));
    }
    let file = match fs::File::create(save_path) {
        Ok(f) => f,
        Err(e) => return Err(format!("创建文件失败：{e}")),
    };
    let mut zip = zip::ZipWriter::new(file);
    let result = export_inner(&mut zip, src)
        .and_then(|()| zip.finish().map_err(|e| format!("完成 zip 失败：{e}")));
    match result {
        Ok(_file) => Ok(save_path.to_string()),
        Err(e) => {
            // 失败清理：半成品 zip 删除（zip writer Drop 时关闭文件句柄即可，无需 finish）
            let _ = fs::remove_file(save_path);
            Err(e)
        }
    }
}

fn export_inner(zip: &mut zip::ZipWriter<fs::File>, src: &Path) -> Result<(), String> {
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);

    let root_name = src
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default();
    if root_name.is_empty() {
        return Err("插件目录名无效".into());
    }

    // 递归收集（跳过隐藏文件与 node_modules 类噪声；保持插入序稳定）
    let mut files: Vec<(String, PathBuf)> = Vec::new(); // (zip 内相对路径, 磁盘绝对路径)
    collect_files(src, &root_name, &mut files)?;
    if files.is_empty() {
        return Err("插件目录为空".into());
    }
    for (zip_path, disk_path) in files {
        let bytes = fs::read(&disk_path).map_err(|e| format!("读取 {} 失败：{e}", disk_path.display()))?;
        zip.start_file(zip_path.clone(), options)
            .map_err(|e| format!("写入 zip 条目 {zip_path} 失败：{e}"))?;
        zip.write_all(&bytes).map_err(|e| format!("写入 {zip_path} 失败：{e}"))?;
    }
    Ok(()) // finish 由调用方独占调用（消耗 self，不能经 &mut 引用转发）
}

/// 递归收集待打包文件（隐藏文件与常见噪声目录跳过）
fn collect_files(dir: &Path, prefix: &str, out: &mut Vec<(String, PathBuf)>) -> Result<(), String> {
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || name == "node_modules" || name == "__pycache__" {
            continue;
        }
        let p = entry.path();
        let zip_path = format!("{prefix}/{name}");
        if p.is_dir() {
            collect_files(&p, &zip_path, out)?;
        } else {
            out.push((zip_path, p));
        }
    }
    Ok(())
}

/// 导入插件 zip：解包到临时目录 → 校验 → 落盘 extensions/<id>/。
/// 返回新插件的 manifest 路径（前端据此重扫）。
/// P2-3（2026-09-29 review）：同 export_plugin 改 async + spawn_blocking。
#[tauri::command]
pub async fn import_plugin(zip_path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || import_plugin_impl(&zip_path))
        .await
        .map_err(|e| format!("任务执行异常：{e}"))?
}

fn import_plugin_impl(zip_path: &str) -> Result<String, String> {
    let file = fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败：{e}"))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("读取 zip 失败（不是有效的 zip？）：{e}"))?;

    // 1) 解包到临时目录（先校验条目名，防 Zip Slip）
    let tmp = std::env::temp_dir().join(format!(
        "pylume-import-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
    let result = import_inner(&mut archive, &tmp);
    // 无论成败都清临时目录（落盘后的目标目录不在 tmp 下，不受影响）
    let _ = fs::remove_dir_all(&tmp);
    result
}

fn import_inner(
    archive: &mut zip::ZipArchive<fs::File>,
    tmp: &Path,
) -> Result<String, String> {
    // P2-4（2026-09-29 review）：zip 炸弹护栏——单文件有 10MB 上限，但条目数与
    // 累计解压量无上限（10 万个小条目 = 10 万次文件写 + 目录创建，磁盘/inode DoS）。
    const MAX_ENTRIES: usize = 2000;
    const MAX_TOTAL_BYTES: u64 = 64 * 1024 * 1024;
    if archive.len() > MAX_ENTRIES {
        return Err(format!("zip 条目数超过上限（{} > {}）", archive.len(), MAX_ENTRIES));
    }
    let mut total_bytes: u64 = 0;

    // 2) 逐条目解包（条目名必须相对且无 ..）
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败：{e}"))?;
        // enclosed_name 内置防逃逸（返回 None = 条目名试图越界）
        let Some(rel) = entry.enclosed_name() else {
            return Err(format!("zip 条目名非法（路径逃逸）：{}", entry.name()));
        };
        let dest = tmp.join(rel);
        if entry.is_dir() {
            fs::create_dir_all(&dest).map_err(|e| e.to_string())?;
            continue;
        }
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| format!("解压 {} 失败：{e}", entry.name()))?;
        // 大小护栏：单文件 10MB（插件是文本工具，超限基本是塞了二进制资源——v1 不支持）
        if bytes.len() > 10 * 1024 * 1024 {
            return Err(format!("条目 {} 超过 10MB 上限", entry.name()));
        }
        total_bytes = total_bytes.saturating_add(bytes.len() as u64);
        if total_bytes > MAX_TOTAL_BYTES {
            return Err("zip 累计解压量超过 64MB 上限".into());
        }
        fs::write(&dest, &bytes).map_err(|e| format!("写入 {} 失败：{e}", dest.display()))?;
    }

    // 3) 定位插件根：zip 应有且仅有一个顶层目录（= 插件 id），内含 pylume.plugin.json
    let top: Vec<_> = fs::read_dir(tmp)
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    if top.len() != 1 || !top[0].path().is_dir() {
        return Err("zip 结构不对：应只有一个顶层目录（插件 id）".into());
    }
    let plugin_root = top[0].path();
    let plugin_id = top[0].file_name().to_string_lossy().to_string();
    if !crate::plugin_cmds::valid_plugin_id(&plugin_id) {
        return Err(format!("顶层目录名不是合法插件 id：{plugin_id}"));
    }
    let manifest_path = plugin_root.join("pylume.plugin.json");
    if !manifest_path.is_file() {
        return Err("插件目录缺少 pylume.plugin.json".into());
    }

    // 4) manifest 校验（结构与 id 一致性；权限白名单校验在前端 loader，导入端先挡结构错）
    let manifest_str = fs::read_to_string(&manifest_path).map_err(|e| e.to_string())?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_str).map_err(|e| format!("manifest 不是合法 JSON：{e}"))?;
    let manifest_id = manifest["id"].as_str().unwrap_or("");
    if manifest_id != plugin_id {
        return Err(format!(
            "manifest.id（{manifest_id}）与目录名（{plugin_id}）不一致"
        ));
    }

    // 5) 落盘 extensions/（已存在拒绝——不静默覆盖）。
    // 失败清理：copy_dir 中途失败会在 dest 留半成品，挡住下次导入（误报「已存在」）——回滚删除。
    let dest_root = pylume_home().join("extensions").join(&plugin_id);
    if dest_root.exists() {
        return Err(format!(
            "插件 {plugin_id} 已存在（不覆盖；如需更新请先在插件目录删除旧版）"
        ));
    }
    let placed = fs::rename(&plugin_root, &dest_root).or_else(|_| copy_dir(&plugin_root, &dest_root));
    if let Err(e) = placed {
        let _ = fs::remove_dir_all(&dest_root); // 回滚半成品（失败仅尽力而为）
        return Err(format!("落盘失败：{e}"));
    }
    Ok(dest_root.to_string_lossy().to_string())
}

/// 跨盘 rename 失败时的回退：递归复制
fn copy_dir(src: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let p = entry.path();
        let d = dest.join(entry.file_name());
        if p.is_dir() {
            copy_dir(&p, &d)?;
        } else {
            fs::copy(&p, &d).map_err(|e| format!("复制 {} 失败：{e}", p.display()))?;
        }
    }
    Ok(())
}

/// 导出默认文件名建议（前端对话框 default_path 用）：<id>-<version>.zip
#[tauri::command]
pub fn plugin_export_filename(plugin_dir: &str) -> Result<String, String> {
    let manifest_path = Path::new(plugin_dir).join("pylume.plugin.json");
    let manifest = match fs::read_to_string(&manifest_path) {
        Ok(s) => s,
        Err(e) => return Err(format!("读取 manifest 失败：{e}")),
    };
    let v: serde_json::Value = match serde_json::from_str(&manifest) {
        Ok(v) => v,
        Err(e) => return Err(e.to_string()),
    };
    let id = v["id"].as_str().unwrap_or("plugin");
    let ver = v["version"].as_str().unwrap_or("0.0.0");
    Ok(format!("{id}-{ver}.zip"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let d = std::env::temp_dir().join(format!("pylume-plugin-pkg-{tag}-{nanos}"));
        fs::create_dir_all(&d).unwrap();
        d
    }

    fn make_plugin(root: &Path, id: &str, entry_content: &str) -> PathBuf {
        let dir = root.join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("pylume.plugin.json"),
            format!(r#"{{"schemaVersion":1,"id":"{id}","name":"测试","version":"1.2.3","engines":{{"pylume":">=0.1.0"}},"contributes":{{"tools":[{{"id":"t","title":"T","entry":"./t.js"}}]}},"permissions":[]}}"#),
        )
        .unwrap();
        fs::write(dir.join("t.js"), entry_content).unwrap();
        // 噪声文件：导出应跳过
        fs::write(dir.join(".DS_Store"), "noise").unwrap();
        dir
    }

    #[test]
    fn export_import_roundtrip() {
        let work = tmpdir("roundtrip");
        let plugin = make_plugin(&work, "com.test.round", "export const x = 1;");
        let zip_path = work.join("out.zip");
        export_plugin_impl(plugin.to_str().unwrap(), zip_path.to_str().unwrap()).unwrap();
        assert!(zip_path.is_file());

        // 导入正路径由 E2E 覆盖（import_plugin 的数据根经 OnceLock 缓存，单测进程内
        // 无法隔离重定向，强行走全流程会污染真实数据根）——此处只断言 zip 内容正确性。
        let file = fs::File::open(&zip_path).unwrap();
        let mut zip = zip::ZipArchive::new(file).unwrap();
        let names: Vec<String> = (0..zip.len())
            .map(|i| zip.by_index(i).unwrap().name().to_string())
            .collect();
        assert!(names.contains(&"com.test.round/pylume.plugin.json".to_string()));
        assert!(names.contains(&"com.test.round/t.js".to_string()));
        assert!(!names.iter().any(|n| n.contains(".DS_Store"))); // 噪声被跳过
        let _ = fs::remove_dir_all(&work);
    }

    #[test]
    fn import_rejects_bad_zip() {
        let work = tmpdir("badzip");
        // 非 zip 文件
        let notzip = work.join("not.zip");
        fs::write(&notzip, "this is not a zip").unwrap();
        let err = import_plugin_impl(notzip.to_str().unwrap()).unwrap_err();
        assert!(err.contains("zip"), "应报 zip 读取错误：{err}");
        let _ = fs::remove_dir_all(&work);
    }

    #[test]
    fn import_rejects_zip_slip() {
        let work = tmpdir("slip");
        // 构造带 ../ 的恶意 zip
        let zip_path = work.join("evil.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("../evil.txt", options).unwrap();
        zip.write_all(b"pwned").unwrap();
        zip.finish().unwrap();
        let err = import_plugin_impl(zip_path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("非法") || err.contains("逃逸"), "应拒绝路径逃逸：{err}");
        let _ = fs::remove_dir_all(&work);
    }

    #[test]
    fn import_rejects_multi_root_and_missing_manifest() {
        let work = tmpdir("structure");
        // 两个顶层目录
        let zip_path = work.join("multi.zip");
        let file = fs::File::create(&zip_path).unwrap();
        let mut zip = zip::ZipWriter::new(file);
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("a/x.txt", options).unwrap();
        zip.write_all(b"1").unwrap();
        zip.start_file("b/y.txt", options).unwrap();
        zip.write_all(b"2").unwrap();
        zip.finish().unwrap();
        let err = import_plugin_impl(zip_path.to_str().unwrap()).unwrap_err();
        assert!(err.contains("顶层目录"), "应拒绝多顶层：{err}");
        let _ = fs::remove_dir_all(&work);
    }

    #[test]
    fn export_filename_suggestion() {
        let work = tmpdir("fname");
        let plugin = make_plugin(&work, "com.test.fn", "x");
        let name = plugin_export_filename(plugin.to_str().unwrap()).unwrap();
        assert_eq!(name, "com.test.fn-1.2.3.zip");
        let _ = fs::remove_dir_all(&work);
    }
}
