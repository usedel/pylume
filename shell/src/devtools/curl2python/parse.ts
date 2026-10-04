// cURL 命令解析：自研简化 shell 词法 + flag 扫描，覆盖爬虫高频 flag。
// 完整 curl 语法极复杂，此处聚焦 -X/-H/-d/-u/-b/-A/-F/-G/-I/-k/--compressed 等常见项；
// 未识别的 flag 一律跳过（不消费后续 token），保证不误吞 URL。

export interface CurlCommand {
  method: string;
  url: string;
  headers: Array<[string, string]>;
  /** body 原始文本（-d / --data-raw / --data-binary / --data-urlencode 合并） */
  data: string | null;
  /** body 是否为 JSON（由 Content-Type 推导） */
  dataAsJson: boolean;
  /** -u / --user 的 "user:pass" */
  user: string | null;
  /** -b / --cookie */
  cookies: string | null;
  /** -A / --user-agent */
  userAgent: string | null;
  /** -F / --form 的 key=value / key=@file */
  form: Array<[string, string]>;
  insecure: boolean;
  headOnly: boolean;
  /** -G：把 -d 当查询串 */
  useGetQuery: boolean;
}

function emptyCurl(): CurlCommand {
  return {
    method: "GET",
    url: "",
    headers: [],
    data: null,
    dataAsJson: false,
    user: null,
    cookies: null,
    userAgent: null,
    form: [],
    insecure: false,
    headOnly: false,
    useGetQuery: false,
  };
}

/** 需要跟一个「值」的参数（-X url、-H header、-d body …） */
const FLAG_TAKES_VALUE = new Set([
  "-X", "--request",
  "-H", "--header",
  "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode",
  "-u", "--user",
  "-b", "--cookie",
  "-A", "--user-agent",
  "-F", "--form",
  "--url",
]);

/** 无值布尔 flag（出现即生效） */
const FLAG_BOOLEAN = new Set([
  "-k", "--insecure",
  "-I", "--head",
  "-G", "--get",
  "--compressed",
  "-s", "--silent",
  "-S", "--show-error",
  "-L", "--location",
  "-g", "--globoff",
  "-v", "--verbose",
  "-i", "--include",
  "--globoff",
]);

/** shell 风格词法：分割空白，支持单引号 / 双引号 / 反斜杠转义（返回展开后的 token） */
export function tokenizeShell(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let hasCur = false;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const c = input[i];
    if (c === "'") {
      hasCur = true;
      i++;
      while (i < n && input[i] !== "'") {
        cur += input[i];
        i++;
      }
      i++; // 跳过右引号
    } else if (c === '"') {
      hasCur = true;
      i++;
      while (i < n && input[i] !== '"') {
        if (input[i] === "\\" && i + 1 < n) {
          const next = input[i + 1];
          if (next === '"' || next === "\\" || next === "\n" || next === "$" || next === "`") {
            cur += next;
            i += 2;
            continue;
          }
        }
        cur += input[i];
        i++;
      }
      i++; // 跳过右引号
    } else if (c === "\\" && i + 1 < n) {
      hasCur = true;
      cur += input[i + 1];
      i += 2;
    } else if (/\s/.test(c)) {
      if (hasCur) {
        tokens.push(cur);
        cur = "";
        hasCur = false;
      }
      i++;
    } else {
      cur += c;
      hasCur = true;
      i++;
    }
  }
  if (hasCur) tokens.push(cur);
  return tokens;
}

/** 把一个 header 值拆成 [名, 值]（无冒号时值为空串） */
function splitHeader(v: string): [string, string] {
  const idx = v.indexOf(":");
  if (idx === -1) return [v.trim(), ""];
  return [v.slice(0, idx).trim(), v.slice(idx + 1).trim()];
}

/** 拆 key=value（无等号时值为空串） */
function splitPair(v: string): [string, string] {
  const idx = v.indexOf("=");
  if (idx === -1) return [v.trim(), ""];
  return [v.slice(0, idx).trim(), v.slice(idx + 1).trim()];
}

export function parseCurl(input: string): CurlCommand {
  const tokens = tokenizeShell(input);
  const cmd = emptyCurl();
  let gotMethod = false;
  // 可选 "curl" 前缀
  let i = tokens[0] === "curl" ? 1 : 0;

  for (; i < tokens.length; i++) {
    let tok = tokens[i];
    // 处理 --flag=value 内联形式
    let inline: string | undefined;
    if (tok.startsWith("--") && tok.includes("=")) {
      const eq = tok.indexOf("=");
      inline = tok.slice(eq + 1);
      tok = tok.slice(0, eq);
    }

    if (tok === "--") {
      // 之后的都当位置参数
      for (let j = i + 1; j < tokens.length; j++) {
        if (!cmd.url) cmd.url = tokens[j];
      }
      break;
    }

    const nextValue = (): string => {
      const v = inline ?? tokens[++i];
      return v ?? "";
    };

    if (FLAG_TAKES_VALUE.has(tok)) {
      switch (tok) {
        case "-X":
        case "--request":
          cmd.method = nextValue();
          gotMethod = true;
          break;
        case "-H":
        case "--header":
          cmd.headers.push(splitHeader(nextValue()));
          break;
        case "-d":
        case "--data":
        case "--data-raw":
        case "--data-binary":
        case "--data-urlencode":
          // 多次 -d 时用 & 拼接（与 curl 语义一致）
          cmd.data = cmd.data === null ? nextValue() : `${cmd.data}&${nextValue()}`;
          break;
        case "-u":
        case "--user":
          cmd.user = nextValue();
          break;
        case "-b":
        case "--cookie":
          cmd.cookies = nextValue();
          break;
        case "-A":
        case "--user-agent":
          cmd.userAgent = nextValue();
          break;
        case "-F":
        case "--form":
          cmd.form.push(splitPair(nextValue()));
          break;
        case "--url":
          cmd.url = nextValue();
          break;
      }
      continue;
    }

    if (FLAG_BOOLEAN.has(tok)) {
      if (tok === "-k" || tok === "--insecure") cmd.insecure = true;
      else if (tok === "-I" || tok === "--head") cmd.headOnly = true;
      else if (tok === "-G" || tok === "--get") cmd.useGetQuery = true;
      // 其余布尔项（-s/-L/--compressed…）对产物无影响，忽略
      continue;
    }

    // 位置参数 → URL（取第一个未赋值处）
    if (!cmd.url && !tok.startsWith("-")) {
      cmd.url = tok;
    }
  }

  // 由 Content-Type 推导 JSON body
  cmd.dataAsJson = cmd.headers.some(
    ([k, v]) => k.toLowerCase() === "content-type" && v.toLowerCase().includes("json"),
  );

  // 未显式指定 method 时按语义推断
  if (!gotMethod) {
    if (cmd.headOnly) cmd.method = "HEAD";
    else if (cmd.useGetQuery) cmd.method = "GET";
    else if (cmd.data !== null || cmd.form.length > 0) cmd.method = "POST";
    else cmd.method = "GET";
  } else {
    cmd.method = cmd.method.toUpperCase();
  }

  return cmd;
}