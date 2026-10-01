// 已发布结果引用面板：查看引用的来源/版本/快照，添加新引用，断开引用
import { useMemo, useState } from "react";
import type { Formula } from "../engine/types";
import type { FormulaRuntime, RefState } from "../engine/graph";
import { formulaLabel } from "../engine/graph";
import Tex from "./Tex";

interface Props {
  formula: Formula;
  allFormulas: Formula[];
  runtime?: FormulaRuntime;
  /** 全笔记的解析结果（来源下拉直接使用，避免重复解析） */
  allRuntimes: Map<string, FormulaRuntime>;
  onAddRef: (sourceId: string, alias: string) => void;
  onRemoveRef: (alias: string) => void;
  /** 把别名以正确的 LaTeX 形态（如 L_{ref}）插入/追加到表达式 */
  onInsertAlias: (alias: string) => void;
}

function fmtNum(n: number | undefined): string {
  if (n === undefined) return "—";
  if (!Number.isFinite(n)) return String(n);
  return String(Number(n.toFixed(10)));
}

type NonnullSnapshot = NonNullable<RefState["snapshot"]>;

function unitTex(unit: string | undefined): string {
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

function SnapshotLine({ snap, title }: { snap: NonnullSnapshot; title: string }) {
  return (
    <div className="ref-snapshot" title={`${title}：来源版本 v${snap.sourceVersion}，抓取于 ${new Date(snap.capturedAt).toLocaleString()}`}>
      <span className="snap-tag">{title}</span>
      <Tex
        block={false}
        tex={`= ${fmtNum(snap.value)}${snap.unit ? `~${unitTex(snap.unit)}` : ""}`}
      />
      <span className="muted small">
        来源 v{snap.sourceVersion}{snap.sourceNote ? ` · ${snap.sourceNote}` : ""}
      </span>
    </div>
  );
}

export default function RefsPanel({ formula, allFormulas, runtime, allRuntimes, onAddRef, onRemoveRef, onInsertAlias }: Props) {
  const [sourceId, setSourceId] = useState("");
  const [alias, setAlias] = useState("");
  const [justAdded, setJustAdded] = useState<string | null>(null);

  // 可引用来源：其他公式中当前已验证、量纲明确者（含其自身引用链解析后的结果）
  const candidates = useMemo(
    () => allFormulas
      .filter((f) => f.id !== formula.id)
      .filter((f) => allRuntimes.get(f.id)?.published),
    [allFormulas, formula.id, allRuntimes],
  );

  const refs = Object.values(formula.refs ?? {});

  const submit = () => {
    if (!sourceId) return;
    const name = alias.trim();
    if (!name) return;
    onAddRef(sourceId, name);
    setJustAdded(name);
    setAlias("");
    setSourceId("");
  };

  /** 别名在 LaTeX 中的安全写法：含下划线时加花括号下标（L_{ref}） */
  const aliasLatex = (name: string) => {
    const i = name.indexOf("_");
    return i < 0 ? name : `${name.slice(0, i)}_{${name.slice(i + 1)}}`;
  };

  return (
    <div className="refs-panel">
      <div className="field-label">
        已发布结果引用（把其他公式<em>已验证</em>的数值与单位作为派生变量；绿色带下划线的符号即引用）
      </div>

      {refs.length === 0 ? (
        <p className="muted small">还没有引用。可在下方选择一条已验证公式，把它的结果作为变量引入本公式。</p>
      ) : (
        <ul className="ref-list">
          {refs.map((ref) => {
            const st = runtime?.refs[ref.alias];
            const source = allFormulas.find((f) => f.id === ref.sourceId);
            const cls = !st || st.status === "unused" ? "unused"
              : st.status === "ok" ? "ok" : "blocked";
            return (
              <li key={ref.alias} className={`ref-item ${cls}`} data-alias={ref.alias} data-status={cls}>
                <div className="ref-head">
                  <code className="ref-alias">{ref.alias}</code>
                  <span className="ref-arrow">←</span>
                  <span className="ref-source">{formulaLabel(allFormulas, ref.sourceId, source?.note ?? (ref.lastSnapshot?.sourceNote || ""))}</span>
                  <span className={`ref-badge ${cls}`}>
                    {cls === "ok" ? `已连接 · 来源 v${st?.sourceVersion ?? "?"}`
                      : cls === "blocked" ? "阻塞/过期"
                      : "未在表达式中使用"}
                  </span>
                  <button
                    type="button"
                    className="mini-btn"
                    onClick={() => onInsertAlias(ref.alias)}
                    title={`把 ${ref.alias} 以正确写法插入表达式末尾`}
                  >
                    插入到表达式
                  </button>
                  <button
                    type="button"
                    className="mini-btn danger"
                    onClick={() => onRemoveRef(ref.alias)}
                    title="断开此引用（不影响来源公式）"
                  >
                    断开
                  </button>
                </div>
                <div className="ref-meta muted small">
                  建立引用时来源版本：v{ref.pinnedSourceVersion}
                  {st?.status === "ok" && st.sourceVersion !== undefined && st.sourceVersion > ref.pinnedSourceVersion &&
                    ` · 上游已更新到 v${st.sourceVersion}，当前按最新版本重算`}
                </div>
                {st?.status === "ok" && (
                  <SnapshotLine snap={{
                    sourceVersion: st.sourceVersion!,
                    sourceNote: source?.note ?? "",
                    value: st.value!,
                    unit: st.unit ?? "",
                    capturedAt: ref.lastSnapshot?.capturedAt ?? Date.now(),
                  }} title="当前代入" />
                )}
                {st?.status === "blocked" && (
                  <>
                    <div className="ref-reason err-text small">{st.reason}</div>
                    {ref.lastSnapshot
                      ? <SnapshotLine snap={ref.lastSnapshot} title="最后有效快照（仅供历史查看，不参与计算）" />
                      : <div className="muted small">该引用从未成功代入过，没有历史快照。</div>}
                  </>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="ref-add">
        <select
          aria-label="选择引用来源公式"
          className="ref-source-select"
          value={sourceId}
          onChange={(e) => setSourceId(e.target.value)}
        >
          <option value="">— 选择已验证的来源公式 —</option>
          {candidates.map((f) => {
            const pub = allRuntimes.get(f.id)!.published!;
            return (
              <option key={f.id} value={f.id}>
                {formulaLabel(allFormulas, f.id)} = {fmtNum(pub.value)} {pub.unit || "（无量纲）"}（v{f.version}）
              </option>
            );
          })}
        </select>
        <input
          aria-label="引用变量名"
          className="ref-alias-input"
          placeholder="在本公式中的变量名，如 v_ref"
          value={alias}
          onChange={(e) => setAlias(e.target.value)}
        />
        <button
          type="button"
          className="mini-btn primary"
          disabled={!sourceId || !alias.trim()}
          onClick={submit}
        >
          建立引用
        </button>
        {candidates.length === 0 && (
          <span className="muted small">当前没有可引用的来源：其他公式需要先达到“已验证”。</span>
        )}
      </div>
      {justAdded && (
        <div className="muted small ref-added-hint">
          引用「{justAdded}」已建立。如需把它写入表达式，请点击该行的「插入到表达式」
          （系统会用 {aliasLatex(justAdded)} 这种正确写法，避免下标被拆成隐式乘法）。
          <button type="button" className="link-btn" onClick={() => { onInsertAlias(justAdded); setJustAdded(null); }}>
            立即插入
          </button>
          <button type="button" className="link-btn" onClick={() => setJustAdded(null)}>知道了</button>
        </div>
      )}
    </div>
  );
}
