// 引用溯源面板：列出每条引用的来源、版本、当前状态与历史快照
import type { RefTraceEntry } from "../engine/types";

export default function RefTracePanel({ traces }: { traces: RefTraceEntry[] }) {
  if (traces.length === 0) return null;
  return (
    <div className="trace-panel">
      <div className="trace-title">引用来源（可追溯）</div>
      <ul className="trace-list">
        {traces.map((t, i) => (
          <li key={i} className={`trace-item ${t.state}`}>
            <span className={`trace-dot ${t.state}`} />
            <span className="trace-var">{t.name}</span>
            <span className="muted small">← {t.sourceLabel}</span>
            <span className={`trace-state ${t.state}`}>
              {t.state === "live" ? `已对齐 v${t.sourceRevision}` : t.state === "blocked" ? "阻塞/过期" : "未使用"}
            </span>
            {t.state === "live" && t.value !== undefined && (
              <span className="trace-val">{t.value} {t.unit || "（无量纲）"}</span>
            )}
            {t.reason && t.state === "live" && <span className="muted small">{t.reason}</span>}
            {t.state === "blocked" && <span className="trace-reason">{t.reason}</span>}
            {t.snapshot && (
              <details className="snapshot">
                <summary className="muted small">最后一次有效快照（历史）</summary>
                <span className="muted small">
                  {t.snapshot.value} {t.snapshot.unit || "（无量纲）"} · 来源版本 v{t.snapshot.sourceRevision}
                  {t.snapshot.capturedAt ? ` · ${new Date(t.snapshot.capturedAt).toLocaleString()}` : ""}
                </span>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
