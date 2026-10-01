import { describe, it, expect } from "vitest";
import katex from "katex";
import { analyzeFormula } from "./math";

describe("引用标注 TeX 可被 KaTeX 渲染", () => {
  it("绿色下划线 + 引标注不产生渲染错误", () => {
    const r = analyzeFormula(
      "\\dfrac{L_{ref}}{T_{ref}}",
      {},
      "km/h",
      [
        { alias: "L_ref", status: "ok", value: 100, unit: "m" },
        { alias: "T_ref", status: "ok", value: 10, unit: "s" },
      ],
    );
    expect(r.status).toBe("ok");
    for (const tex of [r.originalTex!, r.substitutedTex!]) {
      const html = katex.renderToString(tex, { throwOnError: true, strict: false, trust: true });
      expect(html).toContain("underline");
      expect(html).toContain("1a7f37");
    }
  });

  it("阻塞引用的红色标注不产生渲染错误", () => {
    const r = analyzeFormula(
      "L_ref",
      {},
      "",
      [{ alias: "L_ref", status: "blocked", reason: "上游已删除" }],
    );
    expect(r.status).toBe("error");
    expect(() => katex.renderToString(r.originalTex!, { throwOnError: true, strict: false })).not.toThrow();
    expect(r.issues[0].message).toContain("上游已删除");
    expect(r.issues[0].message).toContain("不会用历史快照冒充");
  });
});
