# -*- coding: utf-8 -*-
"""漂移锁：扫描 src-tauri 里会冒到前端的错误文案，与 data/backend_err.json 的映射表比对。

定位：后端错误不走语言包（含 Rust 格式占位 `{xx}` / `{:.1}`，塞进扁平词条会让 t() 的 key 空间
爆炸，且英文的参数顺序常与中文不同），改为「中文模板 → 英文模板」的翻译层
（src/i18n/backendError.ts）。Rust 侧不改一字，靠本脚本兜住同步：后端新增/改动错误文案而
data/backend_err.json 没跟上 → 本脚本报出，避免英文界面里冒出中文错误。

用法（在 shell/ 下）：python3 tools/i18n/scan_rust.py     退出码 1 = 有未登记/已失效条目
建议在 CI 与「改完 Rust 错误文案」后各跑一次。
"""
import glob, json, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUST_DIR = os.path.join(HERE, "..", "..", "src-tauri", "src")
MAP_JSON = os.path.join(HERE, "data", "backend_err.json")

# Err( 之后（允许换行 / format! 包裹）的中文字符串字面量
PAT = re.compile(r'Err\(\s*(?:format!\s*\(\s*)?"((?:[^"\\]|\\.)*[\u4e00-\u9fff](?:[^"\\]|\\.)*)"', re.S)
ESCAPES = {"n": "\n", "t": "\t", "r": "\r", "\\": "\\", '"': '"', "'": "'", "0": "\0"}


def unescape(s):
    """还原 Rust 字符串字面量的转义（源码里写作 `\\` 与 `\\n`，运行时值才是 \\ 与换行）。"""
    out, i = [], 0
    while i < len(s):
        if s[i] == "\\" and i + 1 < len(s):
            out.append(ESCAPES.get(s[i + 1], s[i + 1]))
            i += 2
        else:
            out.append(s[i])
            i += 1
    return "".join(out)


def scan():
    found = {}
    for f in sorted(glob.glob(os.path.join(RUST_DIR, "*.rs"))) + sorted(glob.glob(os.path.join(RUST_DIR, "*", "*.rs"))):
        src = open(f, encoding="utf-8").read()
        for m in PAT.finditer(src):
            text = unescape(m.group(1))
            line = src[: m.start()].count("\n") + 1
            found.setdefault(text, []).append(os.path.relpath(f, RUST_DIR) + f":{line}")
    return found


def main():
    found = scan()
    mapping = json.load(open(MAP_JSON, encoding="utf-8"))
    missing = sorted(t for t in found if t not in mapping)
    stale = sorted(t for t in mapping if t not in found)
    # 参数个数必须一致（否则英文模板填不出正确参数）
    bad = [(z, e) for z, e in mapping.items() if z.count("{") != e.count("{")]
    print(f"Rust 错误文案 {len(found)} 条 / 已登记映射 {len(mapping)} 条")
    if missing:
        print(f"\n!! 未登记（英文界面会露出中文）{len(missing)} 条：")
        for t in missing[:30]:
            print(f"   - {t[:78]}   [{found[t][0]}]")
    if stale:
        print(f"\n!! 已失效映射（Rust 侧已无此文案）{len(stale)} 条：")
        for t in stale[:30]:
            print(f"   + {t[:78]}")
    if bad:
        print(f"\n!! 占位个数不一致 {len(bad)} 条：")
        for z, e in bad[:10]:
            print(f"   ! {z[:60]} || {e[:60]}")
    if missing or stale or bad:
        sys.exit(1)
    print("映射表与 Rust 侧一致 ✓")


if __name__ == "__main__":
    main()
