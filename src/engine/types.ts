// 量纲检查引擎的公共类型定义

/** 变量：数值文本 + 单位文本（单位留空表示纯数） */
export interface VariableDef {
  value: string;
  unit: string;
}

/** 引用来源版本的一次有效快照（仅供历史查看，不参与当前计算） */
export interface ResultSnapshot {
  /** 当时引用到的数值 */
  value: number;
  /** 当时的单位（mathjs 单位文本，无量纲为 ""） */
  unit: string;
  /** 快照对应的来源公式版本号 */
  sourceRevision: number;
  /** 抓取时间（epoch ms） */
  capturedAt: number;
}

/** 一条“已发布结果引用”：把另一公式的已验证结果绑定为本公式的派生变量 */
export interface RefBinding {
  /** 在本公式表达式中使用的派生变量名（如 u、v_in） */
  name: string;
  /** 来源公式的稳定标识 */
  sourceId: string;
  /** 最近一次成功对齐到的来源版本号 */
  sourceRevision: number;
  /** 最后一次有效结果快照：上游出错/删除/未解析时保留用于历史查看 */
  snapshot?: ResultSnapshot;
}

/** 一条公式 */
export interface Formula {
  id: string;
  /** MathLive 编辑产出的 LaTeX，导出后仍可重新编辑 */
  latex: string;
  /** 备注 */
  note: string;
  variables: Record<string, VariableDef>;
  /** 期望换算到的结果单位；留空表示使用计算得到的单位 */
  targetUnit: string;
  createdAt: number;
  /**
   * 内容版本号：任何影响计算结果的编辑（表达式 / 变量 / 目标单位 / 引用）都会 +1。
   * 下游引用据此显示“来源版本”，并判断自己手里的快照是否过期。
   */
  revision: number;
  /** 已发布结果引用列表（普通公式为空数组，二者互不影响） */
  refs: RefBinding[];
}

/** 问题严重级别：error = 明确错误（含引用阻塞）；warning = 超出首版支持范围，结果未验证 */
export type IssueKind = "error" | "warning";

export interface Issue {
  kind: IssueKind;
  /** 定位到的 AST 节点路径（根节点为 []，子节点为序号数组） */
  path: number[];
  /** 该节点对应的原式片段（LaTeX） */
  snippet: string;
  message: string;
}

/**
 * ok = 已验证；unverified = 结果未验证；error = 明确错误；
 * blocked = 引用的上游结果当前不可用（错误/未验证/删除/未解析/循环），下游不得拿旧值冒充；
 * empty = 空公式
 */
export type AnalysisStatus = "ok" | "unverified" | "error" | "blocked" | "empty";

/** 引用阻塞原因（供 UI 分类展示与测试断言） */
export type BlockReasonCode =
  | "missing"         // 来源已删除 / 导入后未解析
  | "upstream-status" // 来源存在但不是已验证状态
  | "circular"        // 处于循环引用环
  | "invalid";        // 来源结果本身无法重新解析（防御性）

export interface AnalysisResult {
  status: AnalysisStatus;
  /** 原式中识别出的变量名（不含 pi、e 等内置常量） */
  variables: string[];
  /** 所有问题（错误 + 未验证警告） */
  issues: Issue[];
  /** 原式对应的 mathjs 表达式 */
  source?: string;
  /** 替换变量后的计算式（mathjs 表达式） */
  substituted?: string;
  /** 原式的 TeX（带问题节点高亮） */
  originalTex?: string;
  /** 替换后计算式的 TeX（带问题节点高亮） */
  substitutedTex?: string;
  /** 结果数值（原始单位） */
  value?: number;
  /** 结果单位字符串，无量纲时为 "" */
  resultUnit?: string;
  /** 换算后的结果数值 */
  targetValue?: number;
  /** 换算后的结果单位 */
  targetUnit?: string;
  /** 给 UI 用的简短状态说明 */
  summary?: string;
  /** 派生变量名 → 其在原式 AST 中出现的节点路径（用于蓝色/紫色溯源高亮） */
  refPaths?: Record<string, number[][]>;
  /** 被实际使用（出现在表达式中）且当前被阻塞的派生变量名 */
  blockedRefs?: string[];
}

/** 引用在一次整笔记分析中的可追溯状态（UI 三段展示之外的溯源信息） */
export interface RefTraceEntry {
  /** 派生变量名 */
  name: string;
  sourceId: string;
  /** 来源公式的展示标签，如 “#2（速度）” */
  sourceLabel: string;
  /** live = 已对齐到来源当前已验证版本；blocked = 当前不可用；unused = 绑定了但表达式未使用 */
  state: "live" | "blocked" | "unused";
  /** 来源当前版本号（来源不存在时可能缺失） */
  sourceRevision?: number;
  /** live 时的当前数值 / 单位 */
  value?: number;
  unit?: string;
  /** blocked 时的原因码与完整说明 */
  reasonCode?: BlockReasonCode;
  reason?: string;
  /** 最后一次有效快照（live 与 blocked 都可能携带） */
  snapshot?: ResultSnapshot;
}
