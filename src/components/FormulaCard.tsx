// 单条公式卡片：输入、变量赋值、原式/替换式/结果三段展示、问题定位、已发布结果引用
import { useMemo, useState } from "react";
import type { Formula, VariableDef } from "../engine/types";
import { analyzeFormula } from "../engine/math";
import type { FormulaRuntime } from "../engine/graph";
import MathInput from "./MathInput";
import Tex from "./Tex";
import VariableTable from "./VariableTable";
import RefsPanel from "./RefsPanel";

interface Props {
  formula: Formula;
  index: number;
  allFormulas: Formula[];
  runtime?: FormulaRuntime;
  allRuntimes: Map<string, FormulaRuntime>;
  onChange: (patch: Partial<Formula>) => void;
  onDelete: () => void;
  onAddRef: (sourceId: string, alias: string) => void;
  onRemoveRef: (alias: string) => void;
  onInsertAlias: (alias: string) => void;
}

const STATUS_META = {
  ok: { label: "已验证", cls: "ok" },
  unverified: { label: "未验证", cls: "warn" },
  error: { label: "有错误", cls: "err" },
  empty: { label: "空公式", cls: "empty" },
} as const;

export default function FormulaCard({
  formula, index, allFormulas, runtime, allRuntimes, onChange, onDelete, onAddRef, onRemoveRef, onInsertAlias,
}: Props) {
  const [collapsed, setCollapsed] = useState(false);
  // runtime 由依赖图统一给出（含引用绑定/阻塞）；App 总有 runtime，fallback 仅供组件单独使用
  const fallback = useMemo(
    () => analyzeFormula(formula.latex, formula.variables, formula.targetUnit),
    [formula.latex, formula.variables, formula.targetUnit],
  );
  const result = runtime?.analysis ?? fallback;
  const blockedRefs = runtime ? Object.values(runtime.blockers) : [];
  const connectedRefs = runtime
    ? Object.values(runtime.refs).filter((r) => r.status === "ok")
    : [];
  const hasBlocked = blockedRefs.length > 0;
  const meta = STATUS_META[result.status];

  const setVars = (variables: Record<string, VariableDef>) => onChange({ variables });

  return (
    <section className={`card status-${meta.cls}${hasBlocked ? " has-blocked" : ""}`} data-formula-id={formula.id}>
      <header className="card-head">
        <button type="button" className="collapse-btn" onClick={() => setCollapsed((c) => !c)}>
          {collapsed ? "▸" : "▾"}
        </button>
        <strong>公式 {index + 1}</strong>
        <span className="version-tag" title="内容版本：每次改变计算结果的编辑都会 +1，引用按版本追溯">v{formula.version}</span>
        <span className={`badge ${meta.cls}`}>
          {hasBlocked ? "引用阻塞" : meta.label}
        </span>
        <span className="summary">{result.summary}</span>
        <button type="button" className="mini-btn danger" onClick={onDelete} title="删除此公式（其下游引用将进入阻塞并保留快照）">
          删除
        </button>
      </header>

      {!collapsed && (
        <div className="card-body">
          <label className="field-label">
            输入表达式（支持 + − × ÷、幂、分数、括号；变量用字母或下标，如 <code>v</code>、<code>x_1</code>、<code>θ</code>）
            <MathInput
              value={formula.latex}
              onChange={(latex) => onChange({ latex })}
              placeholder="例如  v \\cdot t + \\frac{1}{2} a t^2"
            />
          </label>

          <RefsPanel
            formula={formula}
            allFormulas={allFormulas}
            runtime={runtime}
            allRuntimes={allRuntimes}
            onAddRef={onAddRef}
            onRemoveRef={onRemoveRef}
            onInsertAlias={onInsertAlias}
          />

          <div className="grid-2">
            <div>
              <div className="field-label">变量赋值（引用变量不在此列）</div>
              <VariableTable names={result.variables} value={formula.variables} onChange={setVars} />
            </div>
            <div>
              <label className="field-label">
                结果目标单位（可选；用于常用单位换算，如 K、degF、deg、rad、km/h）
                <input
                  className="unit-result-input"
                  list="unit-suggestions"
                  value={formula.targetUnit}
                  placeholder="自动（保留计算单位）"
                  onChange={(e) => onChange({ targetUnit: e.target.value })}
                />
              </label>
              <label className="field-label">
                备注
                <input
                  value={formula.note}
                  placeholder="例如：自由落体位移"
                  onChange={(e) => onChange({ note: e.target.value })}
                />
              </label>
            </div>
          </div>

          {hasBlocked && (
            <div className="blocked-banner" data-blocked-count={blockedRefs.length}>
              <strong>引用阻塞 / 结果过期：</strong>
              本公式不会使用历史快照冒充当前结果。
              <ul className="blocked-list">
                {blockedRefs.map((b) => (
                  <li key={b.alias}>
                    <code>{b.alias}</code>：{b.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {result.source !== undefined && (
            <div className="display-area">
              <div className="display-row">
                <span className="row-tag">原式</span>
                <div className="tex-box">{result.originalTex ? <Tex tex={result.originalTex} /> : <span className="muted">—</span>}</div>
              </div>
              <div className="display-row">
                <span className="row-tag">代入后计算式</span>
                <div className="tex-box">
                  {result.substitutedTex ? (
                    <>
                      <Tex tex={result.substitutedTex} />
                      {result.status !== "ok" && (
                        <span className="muted small">（未赋值、出错或被阻塞处保留符号）</span>
                      )}
                    </>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </div>
              </div>
              <div className="display-row result-row">
                <span className="row-tag">结果</span>
                <div className="tex-box">
                  {hasBlocked ? (
                    <div>
                      <span className="err-text">当前不可计算（引用阻塞），不显示结果数值。</span>
                      {blockedRefs.some((b) => b.snapshot) && (
                        <div className="snapshot-history">
                          <div className="muted small">最后有效快照（仅供历史查看）：</div>
                          {blockedRefs.filter((b) => b.snapshot).map((b) => (
                            <div key={b.alias} className="snap-line">
                              <code>{b.alias}</code>
                              <Tex
                                block={false}
                                tex={`= ${fmt(b.snapshot!.value)}${b.snapshot!.unit ? `~${toTexUnit(b.snapshot!.unit)}` : ""}`}
                              />
                              <span className="muted small">
                                来源 v{b.snapshot!.sourceVersion}
                                {b.snapshot!.sourceNote ? ` · ${b.snapshot!.sourceNote}` : ""}
                                {" · "}{new Date(b.snapshot!.capturedAt).toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ) : result.status === "ok" || result.status === "unverified" ? (
                    <div>
                      {result.value !== undefined && (
                        <div className="result-line">
                          <Tex tex={`= ${fmt(result.value)}${result.resultUnit ? `~${toTexUnit(result.resultUnit)}` : ""}`} />
                        </div>
                      )}
                      {result.targetValue !== undefined && (
                        <div className="result-line converted">
                          <Tex tex={`= ${fmt(result.targetValue)}~${toTexUnit(result.targetUnit ?? "")}`} />
                          <span className="muted small">（按目标单位换算）</span>
                        </div>
                      )}
                      {result.status === "unverified" && <div className="warn-text">{result.summary}</div>}
                    </div>
                  ) : (
                    <span className="err-text">{result.summary}</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {connectedRefs.length > 0 && (
            <div className="trace-line muted small">
              来源追溯：
              {connectedRefs.map((r, i) => {
                const src = allFormulas.find((f) => f.id === r.sourceId);
                return (
                  <span key={r.alias} className="trace-chip">
                    {i > 0 && "；"}
                    <code>{r.alias}</code> 来自 {src ? `公式 ${allFormulas.indexOf(src) + 1}` : "已删除的公式"}
                    {src?.note ? `（${src.note}）` : ""}
                    ，当前为来源 v{r.sourceVersion}（引用建立于 v{r.pinnedSourceVersion}）
                  </span>
                );
              })}
            </div>
          )}

          {result.issues.length > 0 && (
            <ul className="issue-list">
              {result.issues.map((iss, i) => (
                <li key={i} className={`issue ${iss.kind}`}>
                  <span className={`dot ${iss.kind}`} />
                  <span className="issue-kind">{iss.kind === "error" ? "错误" : "未验证"}</span>
                  <span className="issue-msg">{iss.message}</span>
                  <span className="issue-snippet">
                    定位：<Tex tex={iss.snippet || "·"} block={false} />
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function fmt(n: number | undefined): string {
  if (n === undefined) return "";
  if (!Number.isFinite(n)) return String(n);
  // 截断浮点尾零，科学计数法用 TeX 指数
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e7 || abs < 1e-4)) {
    const [m, e] = n.toExponential(6).split("e");
    return `${m.replace(/\.?0+$/, "")}\\times10^{${Number(e)}}`;
  }
  return String(Number(n.toFixed(10)));
}

// mathjs 单位文本（m / s^2）→ 简单 TeX（\mathrm{m}/\mathrm{s}^{2}）
function toTexUnit(unit: string): string {
  if (!unit) return "";
  const parts = unit.split(/\s*\/\s*/);
  const encode = (seg: string) =>
    seg.split(/\s+/).map((factor) => {
      const pow = factor.split("^");
      const base = `\\mathrm{${pow[0]}}`;
      return pow.length > 1 ? `${base}^{${pow[1]}}` : base;
    }).join("\\,");
  if (parts.length === 1) return encode(parts[0]);
  return `${encode(parts[0])}/${parts.slice(1).map(encode).join("/")}`;
}
