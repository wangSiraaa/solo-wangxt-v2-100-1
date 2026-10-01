// LaTeX（MathLive 输出）→ mathjs 可解析的中缀表达式
// 首版明确支持：+ - × ÷、隐式乘法、幂、括号、分数、下标变量、希腊字母、十进制数/科学计数法。
// 函数（sin/cos/sqrt 等）、±、关系符等超出范围：可解析但在分析阶段标记为“未验证”。

export interface ConvertResult {
  source: string;
  /** 转换阶段发现的、超出首版支持范围的用法 */
  notices: string[];
}

export class LatexConvertError extends Error {}

type Tok =
  | { t: "num"; v: string }
  | { t: "word"; v: string }
  | { t: "op"; v: string }
  | { t: "lp" }
  | { t: "rp" }
  | { t: "lb" }
  | { t: "rb" }
  | { t: "caret" }
  | { t: "under" }
  | { t: "frac" }
  | { t: "func"; v: string }
  | { t: "mathrm" };

// 希腊字母 → mathjs 符号名
const GREEK: Record<string, string> = {
  alpha: "alpha", beta: "beta", gamma: "gamma", delta: "delta",
  epsilon: "epsilon", varepsilon: "varepsilon", zeta: "zeta", eta: "eta",
  theta: "theta", vartheta: "vartheta", iota: "iota", kappa: "kappa",
  lambda: "lambda", mu: "mu", nu: "nu", xi: "xi", omicron: "omicron",
  pi: "pi", varpi: "varpi", rho: "rho", varrho: "varrho", sigma: "sigma",
  varsigma: "varsigma", tau: "tau", upsilon: "upsilon", phi: "phi",
  varphi: "varphi", chi: "chi", psi: "psi", omega: "omega",
  Gamma: "Gamma", Delta: "Delta", Theta: "Theta", Lambda: "Lambda",
  Xi: "Xi", Pi: "Pi", Sigma: "Sigma", Upsilon: "Upsilon", Phi: "Phi",
  Psi: "Psi", Omega: "Omega",
};

// 支持的函数仅做“可解析”处理，分析阶段会把函数调用标记为未验证
const FUNCS = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc",
  "sinh", "cosh", "tanh", "arcsin", "arccos", "arctan",
  "sqrt", "cbrt", "exp", "log", "log2", "log10", "ln", "abs", "nthRoot",
]);

// 直接出现在输入里的 Unicode 符号
const UNICODE_OPS: Record<string, string> = {
  "×": "*", "⋅": "*", "·": "*", "∗": "*",
  "÷": "/", "−": "-", "–": "-", "—": "-",
  "＋": "+", "－": "-",
};

const UNICODE_GREEK: Record<string, string> = {
  α: "alpha", β: "beta", γ: "gamma", δ: "delta", ε: "epsilon", ζ: "zeta",
  η: "eta", θ: "theta", ι: "iota", κ: "kappa", λ: "lambda", μ: "mu",
  ν: "nu", ξ: "xi", π: "pi", ρ: "rho", σ: "sigma", τ: "tau", υ: "upsilon",
  φ: "phi", χ: "chi", ψ: "psi", ω: "omega",
};

const SPACING_CMDS = new Set([",", ";", ":", "!", " ", "~", "quad", "qquad", "ensk", "enspace", "thinspace", "medspace", "thickspace", "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits"]);

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const pushOp = (ch: string) => toks.push({ t: "op", v: ch });

  while (i < input.length) {
    const ch = input[i];

    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || ch === " ") { i++; continue; }

    if (ch === "{") { toks.push({ t: "lb" }); i++; continue; }
    if (ch === "}") { toks.push({ t: "rb" }); i++; continue; }
    if (ch === "(" || ch === "[") { toks.push({ t: "lp" }); i++; continue; }
    if (ch === ")" || ch === "]") { toks.push({ t: "rp" }); i++; continue; }
    if (ch === "^") { toks.push({ t: "caret" }); i++; continue; }
    if (ch === "_") { toks.push({ t: "under" }); i++; continue; }

    if (UNICODE_OPS[ch]) { pushOp(UNICODE_OPS[ch]); i++; continue; }
    if (UNICODE_GREEK[ch]) { toks.push({ t: "word", v: UNICODE_GREEK[ch] }); i++; continue; }
    if ("+-*/".includes(ch)) { pushOp(ch); i++; continue; }

    if (/[0-9.]/.test(ch)) {
      const m = /^[0-9]+(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?|^\.[0-9]+/.exec(input.slice(i));
      toks.push({ t: "num", v: m![0] });
      i += m![0].length;
      continue;
    }

    if (/[a-zA-Z]/.test(ch)) {
      // 内置常量 pi 作为一个单词
      const piWord = /^pi(?![a-zA-Z0-9])/.exec(input.slice(i));
      if (piWord) {
        toks.push({ t: "word", v: "pi" });
        i += 2;
        continue;
      }
      // 单字母后紧跟数字：视为带下标数字的变量名（T1、x2 等，与 T_{1} 等价）；
      // 多个字母相邻仍按隐式乘法（如 m g）
      const indexed = /^([a-zA-Z])([0-9]+)(?![a-zA-Z])/.exec(input.slice(i));
      if (indexed) {
        toks.push({ t: "word", v: `${indexed[1]}_${indexed[2]}` });
        i += indexed[0].length;
        continue;
      }
      toks.push({ t: "word", v: ch });
      i++;
      continue;
    }

    if (ch === "\\") {
      const m = /^\\([a-zA-Z]+)/.exec(input.slice(i));
      if (m) {
        const name = m[1];
        i += m[0].length;
        if (SPACING_CMDS.has(name)) continue;
        if (name === "frac" || name === "dfrac" || name === "tfrac") { toks.push({ t: "frac" }); continue; }
        if (name === "text" || name === "mbox" || name === "textbf" || name === "textit") { toks.push({ t: "mathrm" }); continue; }
        if (name === "mathrm" || name === "mathit" || name === "mathbf" || name === "operatorname" || name === "mathsf" || name === "mathtt") { toks.push({ t: "mathrm" }); continue; }
        if (FUNCS.has(name)) { toks.push({ t: "func", v: name === "ln" ? "log" : name }); continue; }
        if (GREEK[name] !== undefined) { toks.push({ t: "word", v: GREEK[name] }); continue; }
        if (name === "left" || name === "right") {
          const n = input[i];
          if (n === "(" || n === "[") toks.push({ t: "lp" });
          else if (n === ")" || n === "]") toks.push({ t: "rp" });
          else if (n === ".") { /* 不可见分隔符，忽略 */ }
          else throw new LatexConvertError(`不支持的 LaTeX 定界符：\\${name}${n ?? ""}`);
          i++;
          continue;
        }
        if (name === "cdot" || name === "ast" || name === "star") { pushOp("*"); continue; }
        if (name === "times" || name === "divide") { pushOp(name === "times" ? "*" : "/"); continue; }
        if (name === "pm" || name === "mp") {
          throw new LatexConvertError(`不支持的运算符：\\${name}（±），首版仅支持 +、-、×、÷ 和幂`);
        }
        if (name === "le" || name === "leq" || name === "ge" || name === "geq" || name === "ne" || name === "neq" || name === "approx" || name === "equiv") {
          throw new LatexConvertError(`不支持的关系/比较运算符：\\${name}，首版仅支持 +、-、×、÷ 和幂`);
        }
        throw new LatexConvertError(`不支持的 LaTeX 命令：\\${name}`);
      }
      // \, \; \: \! 或 \<空格>
      const one = input[i + 1];
      if (one === "," || one === ";" || one === ":" || one === "!" || one === " ") { i += 2; continue; }
      throw new LatexConvertError(`无法识别的 LaTeX 命令：${input.slice(i, i + 2)}`);
    }

    throw new LatexConvertError(`无法识别的字符：“${ch}”`);
  }
  return toks;
}

interface Parser {
  toks: Tok[];
  pos: number;
  notices: string[];
}

const peek = (p: Parser): Tok | undefined => p.toks[p.pos];

function startsAtom(p: Parser): boolean {
  const t = peek(p);
  return t !== undefined && (t.t === "num" || t.t === "word" || t.t === "lp" || t.t === "lb" || t.t === "frac" || t.t === "func" || t.t === "mathrm");
}

function startsFactor(p: Parser): boolean {
  const t = peek(p);
  return (t !== undefined && t.t === "op" && (t.v === "-" || t.v === "+")) || startsAtom(p);
}

// 下标内容：单词不拆分（y_{out} → y_out），数字直接用
function parseSubscript(p: Parser): string {
  const t = p.toks[p.pos];
  if (!t) throw new LatexConvertError("下标内容为空");
  if (t.t === "lb") {
    p.pos++;
    const parts: string[] = [];
    while (p.pos < p.toks.length && p.toks[p.pos].t !== "rb") {
      const tk = p.toks[p.pos];
      if (tk.t === "word" || tk.t === "num") { parts.push(tk.v); p.pos++; }
      else if (tk.t === "op" && (tk.v === "-" || tk.v === "+")) { parts.push(tk.v); p.pos++; }
      else throw new LatexConvertError("下标花括号内只支持字母、数字与正负号");
    }
    if (p.toks[p.pos]?.t !== "rb") throw new LatexConvertError("下标缺少右花括号 }");
    p.pos++;
    return parts.join("");
  }
  if (t.t === "num" || t.t === "word") { p.pos++; return t.v; }
  throw new LatexConvertError("下标必须是数字、字母或 {…} 形式");
}

// 原子（可能带下标和上标）
function parseAtom(p: Parser): string {
  const t = p.toks[p.pos];
  if (!t) throw new LatexConvertError("表达式不完整");

  if (t.t === "lp") {
    p.pos++;
    const inner = parseExpr(p);
    const close = p.toks[p.pos];
    if (!close || close.t !== "rp") throw new LatexConvertError("缺少右括号 )");
    p.pos++;
    return `(${inner})`;
  }

  if (t.t === "lb") {
    p.pos++;
    const inner = parseExpr(p);
    const close = p.toks[p.pos];
    if (!close || close.t !== "rb") throw new LatexConvertError("缺少右花括号 }");
    p.pos++;
    return `(${inner})`;
  }

  if (t.t === "num") { p.pos++; return t.v; }

  if (t.t === "word") {
    p.pos++;
    let name = t.v;
    // 下标：x_1、x_{out}、\alpha_0
    const nxt = peek(p);
    if (nxt && nxt.t === "under") {
      p.pos++;
      if (!startsAtom(p)) throw new LatexConvertError(`下标符号 “_” 后缺少下标内容（变量 ${name}）`);
      const sub = parseSubscript(p);
      name = sub === "" ? name : `${name}_${sub}`;
    }
    return name;
  }

  if (t.t === "frac") {
    p.pos++;
    if (!startsAtom(p)) throw new LatexConvertError("\\frac 后缺少分子");
    const num = parseAtom(p);
    if (!startsAtom(p)) throw new LatexConvertError("\\frac 后缺少分母");
    const den = parseAtom(p);
    return `((${num})/(${den}))`;
  }

  if (t.t === "func") {
    p.pos++;
    if (!startsAtom(p)) throw new LatexConvertError(`函数 ${t.v} 后缺少参数`);
    const arg = parseAtom(p);
    p.notices.push(`函数 ${t.v}() 超出首版支持范围（仅支持四则运算和幂），结果将标记为未验证`);
    return `${t.v}(${arg})`;
  }

  if (t.t === "mathrm") {
    p.pos++;
    const grp = p.toks[p.pos];
    if (!grp || grp.t !== "lb") throw new LatexConvertError(`\\${"mathrm"} 后需要花括号内容`);
    // 原样提取花括号内的文本，整体作为一个标识符
    let depth = 1;
    let j = p.pos + 1;
    let raw = "";
    while (j < p.toks.length && depth > 0) {
      const tk = p.toks[j];
      if (tk.t === "lb") depth++;
      else if (tk.t === "rb") { depth--; if (depth === 0) break; }
      raw += tk.t === "num" || tk.t === "word" ? tk.v
        : tk.t === "op" ? tk.v
        : tk.t === "caret" ? "^" : "";
      j++;
    }
    if (depth !== 0) throw new LatexConvertError("缺少右花括号 }");
    p.pos = j + 1;
    const id = raw.replace(/\s+/g, "");
    if (!id) throw new LatexConvertError("\\mathrm{} 中的标识符为空");
    return id;
  }

  throw new LatexConvertError("表达式不完整或存在多余的运算符");
}

// 一元符号 + 幂（右结合）
function parseFactor(p: Parser): string {
  const t = peek(p);
  if (t && t.t === "op" && (t.v === "-" || t.v === "+")) {
    p.pos++;
    const v = parseFactor(p);
    return t.v === "-" ? `(-(${v}))` : `(${v})`;
  }
  let base = parseAtom(p);
  const nxt = peek(p);
  if (nxt && nxt.t === "caret") {
    p.pos++;
    if (!startsFactor(p)) throw new LatexConvertError("幂符号 ^ 后缺少指数");
    const exp = parseFactor(p);
    base = `(${base})^(${exp})`;
  }
  return base;
}

// 乘除（含隐式乘法）
function parseTerm(p: Parser): string {
  if (!startsFactor(p)) {
    const t = peek(p);
    if (t && t.t === "op") throw new LatexConvertError(`运算符 ${t.v} 前缺少操作数`);
    throw new LatexConvertError("表达式不完整");
  }
  let left = parseFactor(p);
  for (;;) {
    const t = peek(p);
    if (t && t.t === "op" && (t.v === "*" || t.v === "/")) {
      p.pos++;
      if (!startsFactor(p)) throw new LatexConvertError(`运算符 ${t.v} 后缺少操作数`);
      const right = parseFactor(p);
      left = t.v === "*" ? `(${left})*(${right})` : `(${left})/(${right})`;
    } else if (startsFactor(p) && !(peek(p)!.t === "op")) {
      // 隐式乘法：两个因子相邻，如 2 x、a b、3(1+2)
      const right = parseFactor(p);
      left = `(${left})*(${right})`;
    } else {
      break;
    }
  }
  return left;
}

function parseExpr(p: Parser): string {
  let left = parseTerm(p);
  for (;;) {
    const t = peek(p);
    if (t && t.t === "op" && (t.v === "+" || t.v === "-")) {
      p.pos++;
      if (!startsFactor(p)) throw new LatexConvertError(`运算符 ${t.v} 后缺少操作数`);
      const right = parseTerm(p);
      left = t.v === "+" ? `(${left})+(${right})` : `(${left})-(${right})`;
    } else {
      break;
    }
  }
  return left;
}

export function latexToSource(latex: string): ConvertResult {
  const trimmed = latex.trim();
  if (!trimmed) return { source: "", notices: [] };
  const toks = tokenize(trimmed);
  const p: Parser = { toks, pos: 0, notices: [] };
  const source = parseExpr(p);
  if (p.pos !== toks.length) {
    const extra = toks[p.pos];
    throw new LatexConvertError(
      extra.t === "rb" ? "存在多余的右花括号 }" :
      extra.t === "rp" ? "存在多余的右括号 )" :
      "表达式存在无法解析的多余内容",
    );
  }
  return { source, notices: p.notices };
}
