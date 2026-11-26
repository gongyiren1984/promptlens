/** 规则评估：纯函数、无网络，便于单测与复现。 */
export function evaluateRules(rules, { content, expected, caseMeta }) {
  const results = (rules ?? []).map((rule) => evaluateRule(rule, content, expected, caseMeta));
  const passed = results.filter((item) => item.passed).length;
  return {
    results,
    passed,
    total: results.length,
    score: results.length ? passed / results.length : null,
  };
}

function evaluateRule(rule, content, expected, caseMeta) {
  const text = String(content ?? '');
  const caseSensitive = rule.caseSensitive !== false;
  const haystack = caseSensitive ? text : text.toLowerCase();
  const needle = (value) => (caseSensitive ? String(value) : String(value).toLowerCase());
  try {
    switch (rule.type) {
      case 'contains':
        return { type: rule.type, value: rule.value, passed: haystack.includes(needle(rule.value)) };
      case 'not_contains':
        return { type: rule.type, value: rule.value, passed: !haystack.includes(needle(rule.value)) };
      case 'regex': {
        const regex = new RegExp(rule.value, rule.flags ?? '');
        return { type: rule.type, value: rule.value, passed: regex.test(text) };
      }
      case 'min_length':
        return { type: rule.type, value: rule.value, passed: text.length >= Number(rule.value), actual: text.length };
      case 'max_length':
        return { type: rule.type, value: rule.value, passed: text.length <= Number(rule.value), actual: text.length };
      case 'json_valid': {
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          return { type: rule.type, passed: false, actual: '不是合法 JSON' };
        }
        const required = rule.required ?? [];
        const missing = required.filter((field) => parsed == null || typeof parsed !== 'object' || !(field in parsed));
        return { type: rule.type, passed: missing.length === 0, actual: missing.length ? `缺少字段: ${missing.join(',')}` : 'ok' };
      }
      case 'equals': {
        const target = rule.expected ? expected : rule.value;
        if (target === undefined || target === null) return { type: rule.type, passed: false, actual: '缺少比较目标' };
        const normalized = typeof target === 'object' ? JSON.stringify(target) : String(target);
        return { type: rule.type, passed: text.trim() === normalized.trim() };
      }
      default:
        return { type: rule.type, passed: false, actual: '未知规则' };
    }
  } catch (error) {
    return { type: rule.type, passed: false, actual: `规则执行失败: ${error.message}` };
  }
}

export function combineDimensionScore(ruleScore, judgeScore) {
  if (ruleScore == null && judgeScore == null) return null;
  if (ruleScore == null) return judgeScore;
  if (judgeScore == null) return ruleScore;
  return (ruleScore + judgeScore) / 2;
}

export function weightedOverall(dimensionScores, dimensions) {
  let weighted = 0;
  let totalWeight = 0;
  for (const dimension of dimensions) {
    const score = dimensionScores[dimension.id];
    if (score == null) continue;
    weighted += score * Number(dimension.weight);
    totalWeight += Number(dimension.weight);
  }
  return totalWeight ? weighted / totalWeight : null;
}

/** 把内部 0—1 分数换算为配置刻度的展示值；无刻度时原样返回。 */
export function toScaleScore(score, scale) {
  if (score == null || !scale) return score;
  const min = Number(scale.min ?? 1);
  const max = Number(scale.max ?? 1);
  return min + Number(score) * (max - min);
}
