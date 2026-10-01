// 量纲检查引擎的公共类型定义

/** 变量：数值文本 + 单位文本（单位留空表示纯数） */
export interface VariableDef {
  value: string;
  unit: string;
}

/**
 * 已发布结果引用：把另一条公式某个已验证结果当作本公式的派生变量。
 * 引用一旦建立即不可变（pinnedSourceVersion 固定当时的来源版本）：
 * 上游每次重新验证都会沿链路产生新版本，下游跟随最新有效结果重算；
 * 上游错误/未验证/被删除时不得用旧值冒充当前结果（进入 blocked），
 * 最后一次有效快照保留在 lastSnapshot 中供历史查看。
 */
export interface ResultRef {
  /** 本公式内使用的变量名（LaTeX/mathjs 符号），如 v_ref */
  alias: string;
  /** 来源公式 id */
  sourceId: string;
  /** 建立引用时来源公式的版本，用于展示“最初引用”的版本 */
  pinnedSourceVersion: number;
  /** 最后一次成功代入的有效结果快照；从未成功过时为 null */
  lastSnapshot: PublishedSnapshot | null;
}

/** 引用成功代入时保存的来源结果快照（历史可查，永不作为当前结果冒充） */
export interface PublishedSnapshot {
  /** 产生该快照时来源公式的版本 */
  sourceVersion: number;
  /** 来源公式当时的备注/说明（便于在来源被删除后仍能看懂快照） */
  sourceNote: string;
  value: number;
  /** 结果单位字符串，无量纲时为 ""（仍属量纲明确，可被引用） */
  unit: string;
  /** 快照产生时间（ms） */
  capturedAt: number;
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
  /** 已发布结果引用（别名 → 引用定义） */
  refs?: Record<string, ResultRef>;
  /**
   * 内容版本：任何会改变计算结果的编辑（LaTeX/变量/目标单位/引用集合）都会 +1。
   * 下游据此识别“来源版本”并展示追溯信息；备注修改不升版。
   */
  version: number;
  createdAt: number;
}

/** 问题严重级别：error = 明确错误；warning = 超出首版支持范围，结果未验证 */
export type IssueKind = "error" | "warning";

export interface Issue {
  kind: IssueKind;
  /** 定位到的 AST 节点路径（根节点为 []，子节点为序号数组） */
  path: number[];
  /** 该节点对应的原式片段（LaTeX） */
  snippet: string;
  message: string;
}

export type AnalysisStatus = "ok" | "unverified" | "error" | "empty";

/** 外部（引用）绑定的解析状态 */
export type ExternalStatus = "ok" | "blocked";

export interface ExternalBinding {
  /** 变量别名 */
  alias: string;
  status: ExternalStatus;
  /** 可代入时的数值与单位（单位 "" 为无量纲纯数） */
  value?: number;
  unit?: string;
  /** 阻塞原因（status=blocked 时） */
  reason?: string;
  /** 可代入时：来源公式 id / 当前版本 / 建立时版本，供原式追溯标注 */
  sourceId?: string;
  sourceVersion?: number;
  pinnedSourceVersion?: number;
  /** 阻塞时若有历史快照，带回给 UI 展示 */
  snapshot?: PublishedSnapshot | null;
}

export interface AnalysisResult {
  status: AnalysisStatus;
  /** 原式中识别出的变量名（不含 pi、e 等内置常量、不含引用别名） */
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
  /** 引用别名（绑定的外部变量），UI 不把它们放进手工变量表 */
  externalAliases?: string[];
}
