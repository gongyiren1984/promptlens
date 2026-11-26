export * from './types';
export * from './generated/error-catalog';

export const INELIGIBILITY_LABELS: Record<string, string> = {
  pending_execution: '等待执行',
  canceled: '已取消',
  invalid_output: '输出无效',
  cross_model_fallback: '跨模型回退',
  unknown_state: '状态未知',
  missing_required_dimension: '缺少必需维度',
  budget_exhausted: '预算耗尽',
};

export const OUTPUT_VALIDITY_LABELS: Record<string, string> = {
  valid: '有效',
  invalid_empty: '空输出',
  invalid_truncated: '被截断',
  invalid_format: '格式不符',
  policy_blocked: '策略拦截',
  not_available: '不可用',
};

export const TRIAL_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  retrying: '重试中',
  completed: '已完成',
  failed: '失败',
  canceled: '已取消',
  aborted_unknown: '中断未知',
};

export const EVALUATION_STATUS_LABELS: Record<string, string> = {
  not_requested: '未请求',
  pending: '待评估',
  completed: '已评估',
  incomplete: '评估不完整',
  failed: '评估失败',
};

export const RUN_STATUS_LABELS: Record<string, string> = {
  queued: '排队中',
  running: '执行中',
  cancel_requested: '取消中',
  completed: '已完成',
  completed_with_errors: '完成但有错误',
  canceled: '已取消',
  failed: '失败',
};
