// 变量赋值区：自动列出公式中出现的变量，填写数值与单位
import type { RefTraceEntry, VariableDef } from "../engine/types";

interface Props {
  /** 公式中识别到的变量名 */
  names: string[];
  value: Record<string, VariableDef>;
  onChange: (next: Record<string, VariableDef>) => void;
  /** 派生变量（来自其他公式的已发布结果）：只读展示来源，不允许手工抄数 */
  traces: RefTraceEntry[];
}

export default function VariableTable({ names, value, onChange, traces }: Props) {
  // 用户曾经定义、但当前公式里已不存在的变量也暂时保留（切换公式文本时不丢输入）
  const extra = Object.keys(value).filter((k) => !names.includes(k));
  const rows = [...names, ...extra];
  const traceByName = new Map(traces.map((t) => [t.name, t]));

  if (rows.length === 0) {
    return <p className="muted small">该公式中没有需要赋值的变量（只有数字和 π 等常量）。</p>;
  }

  const set = (name: string, patch: Partial<VariableDef>) => {
    const prev = value[name] ?? { value: "", unit: "" };
    onChange({ ...value, [name]: { ...prev, ...patch } });
  };

  return (
    <div className="var-table">
      <div className="var-row var-head">
        <span>变量</span><span>数值</span><span>单位（留空 = 纯数）</span><span />
      </div>
      {rows.map((name) => {
        const def = value[name] ?? { value: "", unit: "" };
        const ghost = extra.includes(name);
        const trace = traceByName.get(name);
        const derived = !!trace;
        return (
          <div className={`var-row ${ghost ? "ghost" : ""} ${derived ? "derived" : ""}`} key={name}>
            <span className="var-name" title={ghost ? "当前公式未引用该变量" : derived ? "派生变量：来自已发布结果引用" : undefined}>
              {name}{derived && <span className="ref-tag" title="已发布结果引用">引</span>}
            </span>
            {derived ? (
              <>
                <span className="derived-cell">
                  {trace.state === "live" && trace.value !== undefined ? (
                    <>
                      <strong>{trace.value}</strong> {trace.unit || "（无量纲）"}
                      <span className="muted small"> · {trace.sourceLabel} · v{trace.sourceRevision}</span>
                    </>
                  ) : trace.state === "blocked" ? (
                    <span className="err-text small">引用阻塞（见下方问题列表与溯源）</span>
                  ) : (
                    <span className="muted small">绑定了来源但当前表达式未使用</span>
                  )}
                </span>
                <span />
              </>
            ) : (
              <>
                <input
                  className="num-input"
                  inputMode="decimal"
                  placeholder="如 9.81"
                  value={def.value}
                  onChange={(e) => set(name, { value: e.target.value })}
                />
                <input
                  className="unit-input"
                  list="unit-suggestions"
                  placeholder="如 m/s^2"
                  value={def.unit}
                  onChange={(e) => set(name, { unit: e.target.value })}
                />
                {ghost ? (
                  <button
                    type="button"
                    className="mini-btn"
                    title="删除未引用的变量"
                    onClick={() => {
                      const next = { ...value };
                      delete next[name];
                      onChange(next);
                    }}
                  >
                    ×
                  </button>
                ) : <span />}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
