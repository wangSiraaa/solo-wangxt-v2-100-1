// KaTeX 渲染组件：展示原式 / 替换后的计算式（含颜色高亮）
import { useEffect, useRef } from "react";
import katex from "katex";

interface Props {
  tex: string;
  block?: boolean;
  className?: string;
}

export default function Tex({ tex, block = true, className }: Props) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !tex) return;
    try {
      katex.render(tex, el, {
        displayMode: block,
        throwOnError: false,
        strict: false,
        trust: true,
      });
    } catch {
      el.textContent = tex;
    }
  }, [tex, block]);

  return <span ref={ref} className={className} />;
}
