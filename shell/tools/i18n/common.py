# -*- coding: utf-8 -*-
"""i18n 抽取公共逻辑：解析 index.html，分配 i18n key。"""
import re
from html.parser import HTMLParser

CJK = re.compile(r"[\u4e00-\u9fff]")

CTX_MAP = [
    ("settings-section-appearance", "settings.appearance"),
    ("settings-section-editor", "settings.editor"),
    ("settings-section-keybindings", "settings.keybindings"),
    ("settings-section-save", "settings.save"),
    ("settings-section-python", "settings.python"),
    ("settings-section-templates", "settings.templates"),
    ("settings-section-terminal", "settings.terminal"),
    ("settings-section-logging", "settings.logging"),
    ("settings-section-storage", "settings.storage"),
    ("settings-section-plugins", "settings.plugins"),
    ("settings-modal", "settings"),
    ("new-project-modal", "newProject"),
    ("run-config-modal", "runConfig"),
    ("env-modal", "env"),
    ("confirm-modal", "dialog"),
    ("prompt-modal", "dialog"),
    ("palette-modal", "palette"),
    ("clipboard-diff-modal", "clipboardDiff"),
    ("history-modal", "history"),
    ("surround-modal", "surround"),
    ("resource-modal", "resource"),
    ("venv-version-modal", "env.venv"),
    ("storage-onboarding-modal", "storage"),
    ("activity-bar", "activity"),
    ("view-files", "tree"),
    ("view-search", "search"),
    ("view-git", "git"),
    ("git-detail-panel", "git.detail"),
    ("git-diff-panel", "git.diff"),
    ("menubar", "menubar"),
    ("run-group", "action"),
    ("win-controls", "window"),
    ("statusbar", "status"),
    ("output-header", "output"),
    ("terminal-panel", "terminal"),
    ("devtools-header", "devtools"),
    ("ew-get-started", "welcome"),
    ("center", "editor"),
]
STRIP = ["settings-", "btn-", "git-", "env-", "new-project-", "run-config-", "ew-", "lt-", "dep-", "storage-"]
SEMANTIC_ATTRS = ["data-menu", "data-view", "data-subtab", "data-scope", "data-action", "data-kind", "data-tab"]
TEXT_ATTRS = ("data-tip", "aria-label", "placeholder", "title", "alt")
ATTR_OF = {"text": "data-i18n", "data-tip": "data-i18n-tip", "aria-label": "data-i18n-aria",
           "placeholder": "data-i18n-ph", "title": "data-i18n-title", "alt": "data-i18n-alt"}


def camel(s):
    parts = [p for p in re.split(r"[-_\s]+", s) if p]
    if not parts: return "x"
    out = parts[0] + "".join(p.capitalize() for p in parts[1:])
    return re.sub(r"[^A-Za-z0-9]", "", out)


def norm(s):
    """规范化：去尾随省略号与括号补充，用于 tip/aria 同义合并。"""
    s = re.sub(r"[….]{1,3}$", "", s.strip())
    s = re.sub(r"[（(][^）)]*[）)]\s*$", "", s).strip()
    return s


def ctx_of(stack):
    for tag, eid, d in reversed(stack):
        for key, ns in CTX_MAP:
            if eid == key: return ns
        cls = d.get("class", "")
        for key, ns in CTX_MAP:
            if cls and key in cls: return ns
    return "common"


def local_of(item, stack):
    if item["tag"] == "option":
        for tag, sid, d in reversed(stack[:-1]):
            if tag == "select" and sid:
                base = sid
                for s in STRIP:
                    if base.startswith(s): base = base[len(s):]
                return f"{camel(base)}.{camel(item['attrs'].get('value', ''))}"
    if item["id"]:
        base = item["id"]
        for s in STRIP:
            if base.startswith(s): base = base[len(s):]
        return camel(base)
    d = item["attrs"]
    for a in SEMANTIC_ATTRS:
        if d.get(a): return camel(d[a])
    for tag, sid, dd in reversed(stack):
        if sid:
            base = sid
            for s in STRIP:
                if base.startswith(s): base = base[len(s):]
            return f"{camel(base)}{item['tag'].capitalize()}"
    return item["tag"]


class KeyAllocator:
    """按 (命名空间, 局部名, 规范化文本) 分配稳定 key；同义 tip/aria 合并。"""

    def __init__(self):
        self.by_norm = {}
        self.by_key = {}

    def alloc(self, ns, loc, text):
        nk = (ns, loc, norm(text))
        if nk in self.by_norm:
            return self.by_norm[nk]
        key = f"{ns}.{loc}"
        if key in self.by_key and self.by_key[key] != norm(text):
            n = 2
            while f"{ns}.{loc}{n}" in self.by_key: n += 1
            key = f"{ns}.{loc}{n}"
        self.by_key[key] = norm(text)
        self.by_norm[nk] = key
        return key


class Collector(HTMLParser):
    """收集所有含中文的标记点：属性与文本节点，带源码位置。"""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.stack = []
        self.hits = []
        self.skip = 0
        self.alloc = KeyAllocator()
        self.seen = set()

    def handle_starttag(self, tag, attrs):
        d = dict(attrs)
        pos = self.getpos()
        if tag in ("style", "script"): self.skip += 1
        self.stack.append((tag, d.get("id"), d, pos))
        if self.skip == 0:
            for a in TEXT_ATTRS:
                v = d.get(a)
                if v and CJK.search(v):
                    self.add(tag, pos, ATTR_OF[a], v, d, [(x[0], x[1], x[2]) for x in self.stack])

    def handle_startendtag(self, tag, attrs):
        self.handle_starttag(tag, attrs)
        self.handle_endtag(tag)

    def handle_endtag(self, tag):
        if tag in ("style", "script") and self.skip: self.skip -= 1
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def handle_data(self, data):
        if not data.strip() or not CJK.search(data) or self.skip or not self.stack: return
        tag, eid, d, pos = self.stack[-1]
        self.add(tag, pos, "data-i18n", data.strip(), d, [(x[0], x[1], x[2]) for x in self.stack])

    def add(self, tag, pos, attr, text, d, stack):
        sig = (pos[0], pos[1], attr)
        if sig in self.seen: return
        self.seen.add(sig)
        item = {"tag": tag, "id": d.get("id"), "attrs": d, "text": text}
        ns = ctx_of(stack)
        key = self.alloc.alloc(ns, local_of(item, stack), text)
        self.hits.append({"line": pos[0], "col": pos[1], "tag": tag,
                          "attr": attr, "key": key, "text": text.strip()})


def collect(src):
    c = Collector()
    c.feed(src)
    return c.hits
