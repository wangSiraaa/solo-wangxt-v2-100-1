import { describe, it, expect } from "vitest";
import { analyzeFormula, formatNumber } from "./math";
import type { VariableDef } from "./types";

const V = (value: string, unit = ""): VariableDef => ({ value, unit });

describe("四则运算与幂（基础）", () => {
  it("纯数四则与幂", () => {
    const r = analyzeFormula("2+3*4", {}, "");
    expect(r.status).toBe("ok");
    expect(r.value).toBe(14);
  });

  it("带单位乘除得到导出单位", () => {
    const r = analyzeFormula("x/t", { x: V("100", "m"), t: V("10", "s") }, "");
    expect(r.status).toBe("ok");
    expect(r.resultUnit).toBe("m / s");
    expect(r.value).toBeCloseTo(10, 10);
  });

  it("幂：(2 m)^2 得 m^2", () => {
    const r = analyzeFormula("a^2", { a: V("2", "m") }, "");
    expect(r.status).toBe("ok");
    expect(r.resultUnit).toBe("m^2");
    expect(r.value).toBe(4);
  });

  it("展示原式、替换式与结果单位", () => {
    const r = analyzeFormula("v*t+\\frac{1}{2}*a*t^2", {
      v: V("2", "m/s"), t: V("3", "s"), a: V("4", "m/s^2"),
    }, "");
    expect(r.status).toBe("ok");
    expect(r.originalTex).toContain("v");
    expect(r.substituted).toContain("m / s");
    expect(r.resultUnit).toBe("m");
    expect(r.value).toBeCloseTo(24, 10);
  });
});

describe("常用单位换算", () => {
  it("km/h → m/s", () => {
    const r = analyzeFormula("v", { v: V("100", "km/h") }, "m/s");
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(27.7778, 3);
    expect(r.targetUnit).toBe("m / s");
  });
});

describe("摄氏温标边界", () => {
  it("摄氏度 → 开尔文换算正确（25 °C = 298.15 K）", () => {
    const r = analyzeFormula("T", { T: V("25", "degC") }, "K");
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(298.15, 10);
    expect(r.targetUnit).toBe("K");
  });

  it("摄氏度 → 华氏度（25 °C = 77 °F）", () => {
    const r = analyzeFormula("T", { T: V("25", "degC") }, "degF");
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(77, 10);
  });

  it("华氏度 → 摄氏度（32 °F = 0 °C）", () => {
    const r = analyzeFormula("T", { T: V("32", "degF") }, "degC");
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(0, 10);
  });

  it("温差示例：摄氏度数值经 K 目标换算后相减", () => {
    // 正确做法：先换算到 K 再求差
    const a = analyzeFormula("T1", { T1: V("100", "degC") }, "K");
    const b = analyzeFormula("T2", { T2: V("20", "degC") }, "K");
    expect(a.status).toBe("ok");
    expect(b.status).toBe("ok");
    expect(a.targetValue! - b.targetValue!).toBeCloseTo(80, 10);
  });

  it("摄氏度直接相加标记为未验证（偏移温标运算歧义）", () => {
    const r = analyzeFormula("T_1+T_2", { T_1: V("10", "degC"), T_2: V("5", "degC") }, "");
    expect(r.status).toBe("unverified");
    expect(r.issues[0].kind).toBe("warning");
    expect(r.issues[0].message).toContain("偏移温标");
    expect(r.value).toBeUndefined();
  });

  it("摄氏度直接乘标量标记为未验证", () => {
    const r = analyzeFormula("T*2", { T: V("25", "degC") }, "");
    expect(r.status).toBe("unverified");
    expect(r.issues.some((i) => i.kind === "warning" && i.message.includes("乘除"))).toBe(true);
  });
});

describe("角度 / 弧度边界", () => {
  it("180 度 → 弧度 = π", () => {
    const r = analyzeFormula("\\theta", { theta: V("180", "deg") }, "rad");
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(Math.PI, 10);
    expect(r.targetUnit).toBe("rad");
  });

  it("π/2 弧度 → 度 = 90", () => {
    const r = analyzeFormula("pi/2", {}, "deg");
    expect(r.status).toBe("ok");
    expect(r.targetValue).toBeCloseTo(90, 10);
  });

  it("1 rad + 180 deg 量纲兼容并正确相加", () => {
    const r = analyzeFormula("a+b", { a: V("1", "rad"), b: V("180", "deg") }, "");
    expect(r.status).toBe("ok");
    expect(r.resultUnit).toBe("rad");
    expect(r.value).toBeCloseTo(1 + Math.PI, 10);
  });

  it("纯数与角度相加：量纲不兼容错误", () => {
    const r = analyzeFormula("a+b", { a: V("2", ""), b: V("1", "rad") }, "");
    expect(r.status).toBe("error");
    const iss = r.issues.find((i) => i.message.includes("量纲不兼容"))!;
    expect(iss).toBeDefined();
    expect(iss.path).toEqual([]);
  });
});

describe("除零边界（必须明确报错，不得自动取零或产生 Infinity）", () => {
  it("纯数除以零", () => {
    const r = analyzeFormula("a/b", { a: V("10"), b: V("0") }, "");
    expect(r.status).toBe("error");
    expect(r.issues.some((i) => i.message.includes("除数为零"))).toBe(true);
    expect(r.value).toBeUndefined();
  });

  it("带单位量除以 0 m/s（单位零）", () => {
    const r = analyzeFormula("a/b", { a: V("10", "m"), b: V("0", "m/s") }, "");
    expect(r.status).toBe("error");
    expect(r.issues.some((i) => i.message.includes("除数为零"))).toBe(true);
  });

  it("零的负幂报错", () => {
    const r = analyzeFormula("x^{-1}", { x: V("0", "m") }, "");
    expect(r.status).toBe("error");
    expect(r.issues.some((i) => i.message.includes("无定义"))).toBe(true);
  });
});

describe("未定义变量（不得自动取零）", () => {
  it("完全未定义的变量报错", () => {
    const r = analyzeFormula("a+b", {}, "");
    expect(r.status).toBe("error");
    expect(r.issues.filter((i) => i.message.includes("未赋值")).length).toBe(2);
    expect(r.value).toBeUndefined();
  });

  it("变量单位字段留空但数值存在 → 纯数", () => {
    const r = analyzeFormula("a+b", { a: V("2"), b: V("3") }, "");
    expect(r.status).toBe("ok");
    expect(r.value).toBe(5);
  });

  it("无法识别的单位报错", () => {
    const r = analyzeFormula("x", { x: V("3", "foobar") }, "");
    expect(r.status).toBe("error");
    expect(r.issues[0].message).toContain("无法识别");
  });
});

describe("量纲不兼容定位到表达式节点", () => {
  it("m + kg 在根节点报错并高亮片段", () => {
    const r = analyzeFormula("a+b", { a: V("1", "m"), b: V("1", "kg") }, "");
    expect(r.status).toBe("error");
    const iss = r.issues[0];
    expect(iss.path).toEqual([]);
    expect(iss.snippet).toContain("a");
    expect(r.originalTex).toContain("#d11f2d");
  });

  it("嵌套子表达式中不相容量纲定位到具体节点路径", () => {
    // (1 m + 2 kg) * 3 —— 问题节点路径为 [0]
    const r = analyzeFormula("(a+b)*c", {
      a: V("1", "m"), b: V("2", "kg"), c: V("3"),
    }, "");
    expect(r.status).toBe("error");
    const iss = r.issues.find((i) => i.message.includes("量纲不兼容"))!;
    expect(iss.path).toEqual([0]);
  });

  it("相减同样检查量纲", () => {
    const r = analyzeFormula("a-b", { a: V("1", "m/s"), b: V("2", "s") }, "");
    expect(r.status).toBe("error");
    expect(r.issues[0].message).toContain("相减");
  });

  it("量纲兼容的不同单位相加自动换算", () => {
    const r = analyzeFormula("a+b", { a: V("1", "km"), b: V("500", "m") }, "");
    expect(r.status).toBe("ok");
    // mathjs 保留左操作数单位：1 km + 500 m = 1.5 km；再经目标单位换算为米
    expect(r.resultUnit).toBe("km");
    expect(r.value).toBeCloseTo(1.5, 10);
    const r2 = analyzeFormula("a+b", { a: V("1", "km"), b: V("500", "m") }, "m");
    expect(r2.status).toBe("ok");
    expect(r2.targetValue).toBeCloseTo(1500, 10);
  });
});

describe("超出首版支持范围 → 未验证", () => {
  it("sqrt 函数标记未验证", () => {
    const r = analyzeFormula("\\sqrt{x}", { x: V("4", "m") }, "");
    expect(r.status).toBe("unverified");
    expect(r.issues.some((i) => i.message.includes("函数 sqrt"))).toBe(true);
  });

  it("sin 函数标记未验证", () => {
    const r = analyzeFormula("\\sin(x)", { x: V("1", "rad") }, "");
    expect(r.status).toBe("unverified");
  });

  it("± 运算符给出明确输入错误", () => {
    const r = analyzeFormula("a \\pm b", { a: V("1"), b: V("2") }, "");
    expect(r.status).toBe("error");
    expect(r.issues[0].message).toContain("±");
  });
});

describe("错误公式互不影响（隔离）", () => {
  it("同一笔记内多条公式独立分析", () => {
    const good = analyzeFormula("a+b", { a: V("1", "m"), b: V("2", "m") }, "");
    const badUnit = analyzeFormula("a+b", { a: V("1", "m"), b: V("2", "kg") }, "");
    const divZero = analyzeFormula("a/b", { a: V("1"), b: V("0") }, "");
    const undef = analyzeFormula("z+1", {}, "");
    const syntax = analyzeFormula("a+", {}, "");

    expect(good.status).toBe("ok");
    expect(badUnit.status).toBe("error");
    expect(divZero.status).toBe("error");
    expect(undef.status).toBe("error");
    expect(syntax.status).toBe("error");
    // 好公式结果不受任何坏公式影响
    expect(good.value).toBe(3);
  });
});

describe("导出保留可编辑表达式", () => {
  it("originalTex 与 substitutedTex 均为合法可渲染 TeX，且 source 可回溯", () => {
    const r = analyzeFormula("x_1+y_{out}", { x_1: V("1", "m"), y_out: V("2", "m") }, "");
    expect(r.status).toBe("ok");
    expect(r.source).toContain("x_1");
    expect(r.source).toContain("y_out");
    // KaTeX/mathjs 会把下划线转义为 \_
    expect(r.originalTex).toContain("x\\_1");
    expect(r.substitutedTex).toContain("mathrm{m}");
  });
});

describe("格式化", () => {
  it("formatNumber 去掉浮点尾零", () => {
    expect(formatNumber(3.14159265358979)).toBe("3.1415926536");
    expect(formatNumber(2)).toBe("2");
  });
});
