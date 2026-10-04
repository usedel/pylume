// Python 标准库顶层模块名集合（供「缺失包安装提示」排除使用）。
// 用途：`import os.bacarat` 这类「标准库子模块不存在」的诊断会被识别为 missing-import，
// 若直接按顶层名提示「安装 os」会误报——用本集合把标准库顶层名排除掉。
// 清单对齐 CPython 3.11+ sys.stdlib_module_names 的公开顶层模块（不含下划线开头的内部模块）。

export const STDLIB_MODULES: ReadonlySet<string> = new Set([
  "abc", "aifc", "argparse", "array", "ast", "asynchat", "asyncio", "asyncore",
  "atexit", "audioop", "base64", "bdb", "binascii", "binhex", "bisect", "builtins",
  "bz2", "cProfile", "calendar", "cgi", "cgitb", "chunk", "cmath", "cmd", "code",
  "codecs", "codeop", "collections", "colorsys", "compileall", "concurrent",
  "configparser", "contextlib", "contextvars", "copy", "copyreg", "crypt", "csv",
  "ctypes", "curses", "dataclasses", "datetime", "dbm", "decimal", "difflib", "dis",
  "distutils", "doctest", "email", "encodings", "ensurepip", "enum", "errno",
  "faulthandler", "fcntl", "filecmp", "fileinput", "fnmatch", "fractions",
  "ftplib", "functools", "gc", "getopt", "getpass", "gettext", "glob", "graphlib",
  "grp", "gzip", "hashlib", "heapq", "hmac", "html", "http", "idlelib", "imaplib",
  "imghdr", "imp", "importlib", "inspect", "io", "ipaddress", "itertools", "json",
  "keyword", "linecache", "locale", "logging", "lzma", "mailbox", "mailcap",
  "marshal", "math", "mimetypes", "mmap", "modulefinder", "msilib", "msvcrt",
  "multiprocessing", "netrc", "nis", "nntplib", "nt", "ntpath", "nturl2path",
  "numbers", "opcode", "operator", "optparse", "os", "ossaudiodev", "pathlib",
  "pdb", "pickle", "pickletools", "pipes", "pkgutil", "platform", "plistlib",
  "poplib", "posix", "posixpath", "pprint", "profile", "pstats", "pty", "pwd",
  "py_compile", "pyclbr", "pydoc", "queue", "quopri", "random", "re", "readline",
  "reprlib", "resource", "rlcompleter", "runpy", "sched", "secrets", "select",
  "selectors", "shelve", "shlex", "shutil", "signal", "site", "smtpd", "smtplib",
  "sndhdr", "socket", "socketserver", "spwd", "sqlite3", "ssl", "stat",
  "statistics", "string", "stringprep", "struct", "subprocess", "sunau",
  "symtable", "sys", "sysconfig", "syslog", "tabnanny", "tarfile", "telnetlib",
  "tempfile", "termios", "test", "textwrap", "threading", "time", "timeit",
  "tkinter", "token", "tokenize", "trace", "traceback", "tracemalloc", "tty",
  "turtle", "turtledemo", "types", "typing", "unicodedata", "unittest", "urllib",
  "uuid", "uu", "venv", "warnings", "wave", "weakref", "webbrowser", "winreg",
  "winsound", "wsgiref", "xdrlib", "xml", "xmlrpc", "zipapp", "zipfile",
  "zipimport", "zlib", "zoneinfo",
]);