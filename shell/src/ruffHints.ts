// PR-L（dx_features_backlog §6.6）：ruff 规则中文速释表。
// 落点：ruffLint.ts 构造 marker 时，对命中速释表的规则码在消息末尾追加一句人话解释
//（Monaco 诊断 hover 原生渲染 marker.message 的多行文本，无需自建 hover provider）。
//
// 维护纪律：
//   · 键为**精确规则码**（如 "E501"），不支持通配——宁可缺条目，不可写错解释；
//   · 解释须「可执行」（说清怎么改），不翻译规则名；新增条目按类别分组并保持字母序；
//   · 首发 30~50 条常见规则（调研结论：量在内容，无技术风险），后续按用户反馈增量补。

/** 规则码 → 中文速释（命中即追加到诊断消息） */
export const RUFF_HINTS: Readonly<Record<string, string>> = {
  // ---------- E（pycodestyle 错误） ----------
  E101: "缩进混用了制表符——统一改用空格。",
  E401: "一行写了多个 import——拆成多行。",
  E402: "import 不在文件顶部（前面有可执行代码）——把 import 上移，确有必要的用注释说明。",
  E501: "行超过最大长度（默认 88 字符）——换行或拆分表达式。",
  E711: "与 None 比较应使用 is / is not，而不是 ==。",
  E712: "与 True/False 比较应使用 is，或直接把条件本身写进 if。",
  E713: "不要写 not x in y——应写成 x not in y。",
  E714: "不要写 not x is y——应写成 x is not y。",
  E721: "类型比较不要用 ==——应使用 isinstance()。",
  E722: "裸 except 会吞掉所有异常（包括 Ctrl+C）——至少写成 except Exception。",
  E731: "不要把 lambda 赋给变量——改用 def 定义具名函数。",
  E741: "变量名 l/I/O 与数字难以区分——换成有意义的名字。",
  E742: "类名不符合大驼峰（PascalCase）规范。",
  E743: "函数名不符合小写蛇形（snake_case）规范。",
  // ---------- W（pycodestyle 警告） ----------
  W191: "缩进使用了制表符——PEP 8 要求统一用空格。",
  W291: "行尾有多余空白。",
  W292: "文件末尾缺少换行符。",
  W293: "空行上含有空白字符。",
  W605: "无效的转义序列——在字符串前加 r 写成原始字符串。",
  // ---------- F（pyflakes） ----------
  F401: "导入的模块/符号未被使用——删除，或确需保留时行尾加 # noqa: <code>。",
  F403: "使用了 from x import *——命名空间不可控，改为显式导入。",
  F405: "该名称可能来自 import *，来源不明确——改为显式导入。",
  F541: "f-string 没有任何占位符——去掉 f 前缀。",
  F632: "用 is/is not 比较字符串或数字字面量恒为 False——应使用 ==/!=。",
  F702: "continue 不在循环内。",
  F706: "return 不在函数/方法内。",
  F707: "默认 except（裸捕获）应放在 except 链的最后。",
  F811: "同名函数/导入重复定义，后者遮蔽前者。",
  F821: "使用了未定义的名称——检查拼写或补 import。",
  F822: "__all__ 里引用了本模块未定义的名字。",
  F823: "局部变量在被赋值前被引用（函数内有赋值语句，Python 视其为局部变量）。",
  F841: "局部变量赋值后从未使用——删除，或改用 _ 占位。",
  // ---------- I（isort） ----------
  I001: "import 块未按规范排序——按 Ctrl+Alt+O（整理 imports）一键修复。",
  // ---------- N（pep8-naming） ----------
  N801: "类名应使用大驼峰（PascalCase）。",
  N802: "函数名应使用小写蛇形（snake_case）。",
  N803: "参数名应使用小写蛇形（snake_case）。",
  N806: "非函数局部的变量名应使用小写蛇形（snake_case）。",
  // ---------- UP（pyupgrade） ----------
  UP008: "super() 无需传类与 self——Python 3 直接写 super().__init__()。",
  UP015: "open() 的模式参数冗余（如 \"r\"）——省略即可。",
  // ---------- B（flake8-bugbear） ----------
  B006: "默认值用了可变对象（list/dict/set）——改用 None 哨兵，在函数体内创建。",
  B007: "循环变量未被使用——改名 _ 或 _name。",
  B008: "函数调用被用作默认参数（只在定义时求值一次）——改用 None 哨兵。",
  B011: "assert False 会被 python -O 优化剔除——改抛异常。",
  B015: "该语句没有任何效果（如裸的 x == 1）——可能漏了断言或调用。",
  B023: "循环内定义的函数/lambda 绑定了循环变量——闭包在循环结束后取到的是最后一个值。",
  // ---------- C4（comprehensions） ----------
  C408: "不必要的 dict() 调用——用 {} 字面量更直观。",
  // ---------- SIM（flake8-simplify） ----------
  SIM101: "重复的 isinstance 判断可合并为一次调用。",
  SIM108: "if/else 双分支赋值可改写成三元表达式。",
  SIM115: "打开文件未用 with 上下文管理器——资源可能不会关闭。",
  SIM117: "嵌套的 with 可合并为一条语句（逗号分隔）。",
  SIM118: "用 key in dict.keys() 判断——去掉 .keys() 直接 in。",
  // ---------- RET（flake8-return） ----------
  RET504: "变量赋值后立即 return——直接返回该表达式。",
  RET505: "if/else 分支都在 return——省略 else，减少嵌套层级。",
  // ---------- ARG（flake8-unused-arguments） ----------
  ARG001: "函数参数未被使用——确需保留（如回调签名）改名 _ 前缀。",
  ARG002: "方法参数未被使用——确需保留（如回调签名）改名 _ 前缀。",
  // ---------- 其他常见类别 ----------
  A002: "参数名遮蔽了 Python 内置名（如 list/str/id）——换名避免踩坑。",
  DTZ005: "datetime.now() 未指定时区——传 tz 参数避免「天真」的本地时间。",
  ERA001: "被注释掉的代码块——直接删除，需要时找版本管理。",
  S101: "生产代码用 assert 做校验（-O 下会被剔除）——改抛显式异常。",
  T201: "使用了 print()——库代码建议改用 logging。",
  RUF012: "可变的类属性需要 ClassVar 注解，否则会被误认为实例字段。",
  RUF013: "默认值为 None 但类型未标 Optional——补全类型注解。",
  RUF100: "无效的 # noqa（该规则本就不会触发）——删除这行 noqa。",
};

/** 速释前缀（全角括号 + 空行分隔，hover 中与原文视觉区隔） */
const HINT_PREFIX = "\n\n〔速释〕";

/**
 * 构造最终诊断消息：`<code> <message>` + 命中速释表时追加 `\n\n〔速释〕<解释>`。
 * 纯函数（单测）；code 为 null 时返回原始 message（无规则码无从查表）。
 */
export function withRuffHint(code: string | null | undefined, message: string): string {
  const base = code ? `${code} ${message}` : message;
  const hint = code ? RUFF_HINTS[code] : undefined;
  return hint ? `${base}${HINT_PREFIX}${hint}` : base;
}
