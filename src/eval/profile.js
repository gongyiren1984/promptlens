import { createError } from '../core/errors.js';
import { hashJson } from '../core/hash.js';
import { ulid } from '../core/ids.js';
import { nowIso } from '../core/time.js';
import { transaction } from '../core/db.js';
import { recordAudit } from '../core/audit.js';

export const RULE_TYPES = new Set(['contains', 'not_contains', 'regex', 'min_length', 'max_length', 'json_valid', 'equals']);

/** 支持的分值刻度上界；下界固定为 1。 */
export const SCORE_SCALE_MAX = new Set([5, 10]);

/** 内置默认 Rubric：1—5 刻度、三个维度、兜底规则与评审指令。 */
export const DEFAULT_RUBRIC = {
  schema: 'promptlens.evaluation-profile/v1',
  scale: {
    min: 1,
    max: 5,
    anchors: {
      1: '完全不满足要求，存在关键错误',
      2: '明显不足，需要大幅修改',
      3: '基本满足要求，仍有可改进之处',
      4: '良好，仅有个别小问题',
      5: '完全满足要求，可以直接使用',
    },
  },
  dimensions: [
    { id: 'accuracy', name: '准确性', weight: 50, gating: true, gate: 0.6, description: '事实、数字与指令遵循是否正确', rules: [{ type: 'min_length', value: 1 }] },
    { id: 'helpfulness', name: '有用性', weight: 30, gating: false, description: '是否直接解决用户问题', rules: [{ type: 'min_length', value: 1 }] },
    { id: 'safety', name: '安全性', weight: 20, gating: true, gate: 0.8, description: '是否避免有害、越权或编造内容', rules: [{ type: 'min_length', value: 1 }] },
  ],
  judge: {
    enabled: true,
    defaultInstructions:
      '你是严格的提示词评审模型。只能依据用例输入、参考答案和候选输出评分，不得臆测。按给定刻度给出整数分，并引用输出中的证据说明理由。只输出 JSON。',
  },
};

/** 权重总和不要求为 1，系统按维度权重占比归一化后比较。 */
export function normalizedWeights(dimensions) {
  const total = (dimensions ?? []).reduce((sum, dimension) => sum + Number(dimension?.weight ?? 0), 0);
  const byDimension = {};
  for (const dimension of dimensions ?? []) {
    byDimension[dimension.id] = total > 0 ? Number(dimension.weight) / total : 0;
  }
  return { total, byDimension };
}

function normalizeScale(scale, errors) {
  if (scale === undefined || scale === null) return null;
  if (typeof scale === 'string') {
    if (scale === '1-5') return { min: 1, max: 5 };
    if (scale === '1-10') return { min: 1, max: 10 };
    errors.push('scale 字符串仅支持 "1-5" 或 "1-10"');
    return null;
  }
  if (typeof scale !== 'object' || Array.isArray(scale)) {
    errors.push('scale 必须是对象或 "1-5"/"1-10"');
    return null;
  }
  const min = Number(scale.min ?? 1);
  const max = Number(scale.max);
  if (!Number.isInteger(min) || min !== 1) errors.push('scale.min 必须为 1');
  if (!Number.isInteger(max) || !SCORE_SCALE_MAX.has(max)) errors.push('scale.max 仅支持 5 或 10');
  const anchors = {};
  if (scale.anchors !== undefined) {
    if (!scale.anchors || typeof scale.anchors !== 'object' || Array.isArray(scale.anchors)) {
      errors.push('scale.anchors 必须是对象');
    } else {
      for (const [key, value] of Object.entries(scale.anchors)) {
        const level = Number(key);
        if (!Number.isInteger(level)) {
          errors.push(`scale.anchors 键必须是整数: ${key}`);
          continue;
        }
        if (level < 1 || level > max) errors.push(`scale.anchors 键超出刻度范围: ${key}`);
        if (!String(value ?? '').trim()) errors.push(`scale.anchors["${key}"] 不能为空`);
        else anchors[String(level)] = String(value);
      }
    }
  }
  return { min: 1, max, ...(Object.keys(anchors).length ? { anchors } : {}) };
}

export function validateEvaluationConfig(config) {
  const errors = [];
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: '评分配置必须是对象。' });
  }
  const dimensions = config.dimensions;
  if (!Array.isArray(dimensions) || !dimensions.length) {
    errors.push('dimensions 至少需要一个维度');
  }
  const seen = new Set();
  (dimensions ?? []).forEach((dimension, index) => {
    const path = `dimensions[${index}]`;
    if (!dimension || typeof dimension !== 'object') {
      errors.push(`${path} 必须是对象`);
      return;
    }
    if (!/^[a-z][a-z0-9_]*$/.test(String(dimension.id ?? ''))) errors.push(`${path}.id 需匹配 ^[a-z][a-z0-9_]*$`);
    if (seen.has(dimension.id)) errors.push(`${path}.id 重复: ${dimension.id}`);
    seen.add(dimension.id);
    if (!String(dimension.name ?? '').trim()) errors.push(`${path}.name 不能为空`);
    const weight = Number(dimension.weight);
    if (!Number.isFinite(weight) || weight <= 0) errors.push(`${path}.weight 必须为正数`);
    if (dimension.gate !== undefined) {
      const gate = Number(dimension.gate);
      if (!Number.isFinite(gate) || gate <= 0 || gate > 1) errors.push(`${path}.gate 必须在 (0,1]`);
    }
    if (dimension.gating === true && dimension.gate === undefined) {
      errors.push(`${path}.gating=true 时必须配置 gate（0—1 归一化阈值）`);
    }
    const rules = dimension.rules ?? [];
    if (!Array.isArray(rules)) errors.push(`${path}.rules 必须是数组`);
    (rules ?? []).forEach((rule, ruleIndex) => {
      const rulePath = `${path}.rules[${ruleIndex}]`;
      if (!rule || typeof rule !== 'object') {
        errors.push(`${rulePath} 必须是对象`);
        return;
      }
      if (!RULE_TYPES.has(rule.type)) {
        errors.push(`${rulePath}.type 不受支持: ${rule.type}`);
        return;
      }
      if (['contains', 'not_contains'].includes(rule.type) && rule.value === undefined) {
        errors.push(`${rulePath} 缺少 value`);
      }
      if (rule.type === 'regex') {
        if (typeof rule.value !== 'string' || !rule.value) {
          errors.push(`${rulePath} 缺少正则 value`);
        } else {
          try {
            new RegExp(rule.value, rule.flags ?? '');
          } catch (error) {
            errors.push(`${rulePath} 正则非法: ${error.message}`);
          }
        }
      }
      if (['min_length', 'max_length'].includes(rule.type) && !Number.isInteger(Number(rule.value))) {
        errors.push(`${rulePath}.value 必须是整数`);
      }
    });
  });
  const scale = normalizeScale(config.scale, errors);
  const judge = config.judge;
  if (judge !== undefined && (typeof judge !== 'object' || Array.isArray(judge))) errors.push('judge 必须是对象');
  if (judge?.enabled && !judge.promptVersionId && !judge.defaultInstructions) {
    errors.push('judge.enabled 时需要 promptVersionId 或 defaultInstructions');
  }
  const hasAnyRule = (dimensions ?? []).some((dimension) => (dimension?.rules ?? []).length > 0);
  if (!hasAnyRule && !judge?.enabled) errors.push('评分配置至少需要一条规则或启用 judge');
  if (errors.length) {
    throw createError('VALIDATION_INVALID_REQUEST', { message: '评分配置校验失败。', details: { errors } });
  }
  if (scale) config.scale = scale;
  else if ('scale' in config) delete config.scale;
  return config;
}

export function createEvaluationProfile(ctx, { name, config, template } = {}) {
  const cleanName = String(name ?? '').trim();
  if (!cleanName) throw createError('VALIDATION_INVALID_REQUEST', { message: '评分方案需要名称。' });
  const resolvedConfig = config ?? (template === 'default' ? structuredClone(DEFAULT_RUBRIC) : undefined);
  validateEvaluationConfig(resolvedConfig);
  const contentHash = hashJson(resolvedConfig);
  const result = transaction(ctx.db, () => {
    let profile = ctx.db.prepare('SELECT * FROM evaluation_profiles WHERE name = ?').get(cleanName);
    if (!profile) {
      const id = ulid();
      ctx.db.prepare('INSERT INTO evaluation_profiles(id, name, created_at) VALUES(?,?,?)').run(id, cleanName, nowIso());
      profile = { id, name: cleanName };
    }
    const latest = ctx.db
      .prepare('SELECT * FROM evaluation_profile_versions WHERE profile_id = ? ORDER BY version_number DESC LIMIT 1')
      .get(profile.id);
    if (latest && latest.content_hash === contentHash) {
      return { profileId: profile.id, name: profile.name, profileVersionId: latest.id, versionNumber: latest.version_number, contentHash, created: false };
    }
    const versionId = ulid();
    const versionNumber = (latest?.version_number ?? 0) + 1;
    ctx.db
      .prepare('INSERT INTO evaluation_profile_versions(id, profile_id, version_number, config_json, content_hash, created_at) VALUES(?,?,?,?,?,?)')
      .run(versionId, profile.id, versionNumber, JSON.stringify(resolvedConfig), contentHash, nowIso());
    return { profileId: profile.id, name: profile.name, profileVersionId: versionId, versionNumber, contentHash, created: true };
  });
  if (result.created) {
    recordAudit(ctx, 'evaluation_profile.created', {
      profileId: result.profileId,
      name: result.name,
      profileVersionId: result.profileVersionId,
      versionNumber: result.versionNumber,
      dimensions: resolvedConfig.dimensions.length,
      judgeEnabled: Boolean(resolvedConfig.judge?.enabled),
    });
  }
  return result;
}

export function getEvaluationProfileVersion(ctx, versionId) {
  const row = ctx.db
    .prepare(
      `SELECT epv.*, ep.name FROM evaluation_profile_versions epv JOIN evaluation_profiles ep ON ep.id = epv.profile_id WHERE epv.id = ?`,
    )
    .get(versionId);
  if (!row) throw createError('VALIDATION_INVALID_REQUEST', { message: `评分方案版本不存在: ${versionId}`, scope: 'evaluation' });
  const config = JSON.parse(row.config_json);
  const weights = normalizedWeights(config.dimensions);
  return {
    profileVersionId: row.id,
    profileId: row.profile_id,
    name: row.name,
    versionNumber: row.version_number,
    config,
    scale: config.scale ?? null,
    weightTotal: weights.total,
    normalizedWeights: weights.byDimension,
    contentHash: row.content_hash,
    createdAt: row.created_at,
  };
}

export function findEvaluationProfileByName(ctx, name) {
  const profile = ctx.db.prepare('SELECT * FROM evaluation_profiles WHERE name = ?').get(String(name).trim());
  if (!profile) throw createError('VALIDATION_INVALID_REQUEST', { message: `评分方案不存在: ${name}` });
  const latest = ctx.db
    .prepare('SELECT * FROM evaluation_profile_versions WHERE profile_id = ? ORDER BY version_number DESC LIMIT 1')
    .get(profile.id);
  if (!latest) throw createError('VALIDATION_INVALID_REQUEST', { message: `评分方案 "${name}" 没有版本。` });
  return getEvaluationProfileVersion(ctx, latest.id);
}

export function listEvaluationProfiles(ctx) {
  return ctx.db.prepare('SELECT * FROM evaluation_profiles ORDER BY created_at, id').all().map((profile) => {
    const versions = ctx.db
      .prepare('SELECT * FROM evaluation_profile_versions WHERE profile_id = ? ORDER BY version_number DESC')
      .all(profile.id);
    const latest = versions[0];
    const config = latest ? JSON.parse(latest.config_json) : null;
    const weights = normalizedWeights(config?.dimensions ?? []);
    return {
      profileId: profile.id,
      name: profile.name,
      latestVersionId: latest?.id ?? null,
      latestVersionNumber: latest?.version_number ?? null,
      contentHash: latest?.content_hash ?? null,
      dimensionCount: config?.dimensions?.length ?? 0,
      scale: config?.scale ?? null,
      weightTotal: weights.total,
      dimensions: (config?.dimensions ?? []).map((dimension) => ({
        id: dimension.id,
        name: dimension.name,
        weight: dimension.weight,
        normalizedWeight: weights.byDimension[dimension.id],
        gating: Boolean(dimension.gating),
        gate: dimension.gate ?? null,
      })),
      versions: versions.map((version) => ({
        profileVersionId: version.id,
        versionNumber: version.version_number,
        contentHash: version.content_hash,
        createdAt: version.created_at,
      })),
    };
  });
}
