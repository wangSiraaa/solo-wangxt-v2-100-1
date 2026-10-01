// MathLive <math-field> 的 React 封装：受控的 LaTeX 输入
import { useEffect, useRef } from "react";
import type React from "react";
import "mathlive";

interface Props {
  value: string;
  onChange: (latex: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}

interface MathFieldElement extends HTMLElement {
  value: string;
  readOnly: boolean;
  placeholder: string;
  setValue: (v: string) => void;
  getValue: () => string;
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      "math-field": React.DetailedHTMLProps<
        React.HTMLAttributes<HTMLElement> & { placeholder?: string; readonly?: boolean },
        HTMLElement
      >;
    }
  }
}

export default function MathInput({ value, onChange, placeholder, readOnly }: Props) {
  const ref = useRef<MathFieldElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handler = (e: Event) => {
      onChangeRef.current((e.target as MathFieldElement).value);
    };
    el.addEventListener("input", handler);
    return () => el.removeEventListener("input", handler);
  }, []);

  // 外部值变化时同步（避免把正在输入的内容顶回去）
  useEffect(() => {
    const el = ref.current;
    if (el && el.getValue() !== value) el.setValue(value);
  }, [value]);

  useEffect(() => {
    if (ref.current) ref.current.readOnly = !!readOnly;
  }, [readOnly]);

  useEffect(() => {
    if (ref.current && placeholder !== undefined) ref.current.placeholder = placeholder;
  }, [placeholder]);

  return (
    <math-field
      ref={ref as unknown as React.Ref<HTMLElement>}
      style={{
        width: "100%",
        fontSize: "1.25rem",
        padding: "8px 10px",
        borderRadius: 8,
        border: "1px solid var(--border)",
        background: "var(--surface)",
        boxSizing: "border-box",
      }}
    />
  );
}
