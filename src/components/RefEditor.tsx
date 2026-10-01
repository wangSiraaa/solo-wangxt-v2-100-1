// “已发布结果引用”编辑器：在当前公式中把别的已验证公式的结果绑定为派生变量
import { useState } from "react";
import type { Formula, RefBinding } from "../engine/types";

interface Props {
  formula: Formula;
  /** 可作为来源的公式（已验证、量纲明确），id → 展示标签与当前结果文本 */
  sources: { id: string; label: string; resultText: string }[];
  /** 保存前的整体校验（名称/来源/循环）；返回错误信息列表，空数组表示通过 */
  validate: (nextRefs: RefBinding[]) => string[];
  onChange: (refs: RefBinding[]) => void;
}

export default function RefEditor({ formula, sources, validate, onChange }: Props) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [sourceId, setSourceId] = useState("");
  const [err, setErr] = useState("");

  const commitAdd = () => {
    const n = name.trim();
    if (!n || !sourceId) { setErr("请填写派生变量名并选择来源公式"); return; }
    const binding: RefBinding = { name: n, sourceId, sourceRevision: 0 };
    const errors = validate([...formula.refs, binding]);
    if (errors.length) { setErr(errors[0]); return; }
    onChange([...formula.refs, binding]);
    setName(""); setSourceId(""); setErr(""); setAdding(false);
  };

  const commitChange = (idx: number, patch: Partial<RefBinding>) => {
    const next = formula.refs.map((r, i) => (i === idx ? { ...r, ...patch } : r));
    const errors = validate(next);
    if (errors.length) { setErr(errors[0]); return; }
    setErr("");
    onChange(next);
  };

  const remove = (idx: number) => {
    setErr("");
    onChange(formula.refs.filter((_, i) => i !== idx));
  };

  return (
    <div className="ref-editor">
      <div className="field-label" style={{ marginBottom: 6 }}>
        已发布结果引用（把另一条“已验证”公式的数值+单位+来源版本绑定为派生变量）
      </div>

      {formula.refs.length === 0 && !adding && (
        <p className="muted small" style={{ margin: "0 0 6px" }}>
          尚无引用。派生变量会作为本公式表达式中的变量参与计算（如 <code>v_kmh</code>），上游变动后沿链路自动重算。
        </p>
      )}

      {formula.refs.map((r, i) => (
        <div className="ref-row" key={i}>
          <code className="ref-name">{r.name}</code>
          <span className="muted small">←</span>
          <select
            className="ref-source-select"
            value={sources.some((s) => s.id === r.sourceId) ? r.sourceId : ""}
            onChange={(e) => {
              if (e.target.value) commitChange(i, { sourceId: e.target.value, sourceRevision: 0, snapshot: undefined });
            }}
          >
            {!sources.some((s) => s.id === r.sourceId) && (
              <option value="">来源当前不可用 / 未解析（{r.sourceId.slice(0, 10)}…）</option>
            )}
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.label}（{s.resultText}）</option>
            ))}
          </select>
          <span className="muted small ref-ver">
            {r.snapshot ? `对齐来源 v${r.sourceRevision} · 快照 ${r.snapshot.capturedAt ? new Date(r.snapshot.capturedAt).toLocaleString() : "—"}` : "尚未取得有效值"}
          </span>
          <button type="button" className="mini-btn danger" onClick={() => remove(i)} title="删除此引用">×</button>
        </div>
      ))}

      {adding ? (
        <div className="ref-row ref-add">
          <input
            className="ref-name-input"
            placeholder="派生变量名，如 v_in"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <span className="muted small">←</span>
          <select className="ref-source-select" value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
            <option value="">选择已验证的来源公式…</option>
            {sources.map((s) => (
              <option key={s.id} value={s.id}>{s.label}（{s.resultText}）</option>
            ))}
          </select>
          <button type="button" className="mini-btn" onClick={commitAdd}>绑定</button>
          <button type="button" className="mini-btn" onClick={() => { setAdding(false); setErr(""); }}>取消</button>
        </div>
      ) : (
        <button type="button" className="mini-btn" onClick={() => setAdding(true)} disabled={sources.length === 0}>
          ＋ 引用已验证结果
        </button>
      )}
      {sources.length === 0 && !adding && (
        <span className="muted small"> （当前没有“已验证”的其他公式可引用）</span>
      )}
      {err && <div className="ref-err">{err}</div>}
    </div>
  );
}
