import { useMemo, useState } from 'react';
import type { EvaluationProfileSummary, EvaluationScale } from '@promptlens/contracts';
import { qk, useApiMutation, useApiQuery } from '../../api/hooks';
import { Badge, Button, Card, EmptyState, ErrorNotice, Field, Input, Modal, Select, Textarea, Toggle, useToast } from '../../components/ui';

type ScaleOption = '1-5' | '1-10' | 'none';

interface DimensionDraft {
  id: string;
  name: string;
  weight: string;
  gating: boolean;
  gate: string;
  rules: string;
}

const TEMPLATE_DIMENSIONS: DimensionDraft[] = [
  { id: 'accuracy', name: '准确性', weight: '50', gating: true, gate: '0.6', rules: '[{"type":"min_length","value":1}]' },
  { id: 'helpfulness', name: '有用性', weight: '30', gating: false, gate: '', rules: '[{"type":"min_length","value":1}]' },
  { id: 'safety', name: '安全性', weight: '20', gating: true, gate: '0.8', rules: '[{"type":"min_length","value":1}]' },
];

const TEMPLATE_ANCHORS = [
  '1=完全不满足要求，存在关键错误',
  '2=明显不足，需要大幅修改',
  '3=基本满足要求，仍有可改进之处',
  '4=良好，仅有个别小问题',
  '5=完全满足要求，可以直接使用',
].join('\n');

const EMPTY_DIMENSION: DimensionDraft = { id: '', name: '', weight: '1', gating: false, gate: '', rules: '' };

export function EvalProfilesPage({ projectId }: { projectId: string }) {
  const { push } = useToast();
  const [open, setOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [scale, setScale] = useState<ScaleOption>('1-5');
  const [anchors, setAnchors] = useState(TEMPLATE_ANCHORS);
  const [judgeEnabled, setJudgeEnabled] = useState(true);
  const [judgeInstructions, setJudgeInstructions] = useState(
    '你是严格的提示词评审模型。只能依据用例输入、参考答案和候选输出评分，不得臆测。按给定刻度给出整数分，并引用输出中的证据说明理由。只输出 JSON。',
  );
  const [dimensions, setDimensions] = useState<DimensionDraft[]>(TEMPLATE_DIMENSIONS);

  const profiles = useApiQuery<{ profiles: EvaluationProfileSummary[] }>(qk.evalProfiles(projectId), (client) =>
    client.get(`/v1/projects/${projectId}/eval-profiles`),
  );

  const createProfile = useApiMutation(
    async (client, variables: { config: Record<string, unknown>; name: string }) =>
      client.post(`/v1/projects/${projectId}/eval-profiles`, variables),
    {
      invalidate: () => [qk.evalProfiles(projectId)],
      onSuccess: (data) => {
        const result = data as unknown as { versionNumber: number; created: boolean };
        push(result.created ? `已创建 v${result.versionNumber}` : '内容未变化，复用现有版本', 'success');
        setOpen(false);
      },
    },
  );

  const weightTotal = useMemo(() => dimensions.reduce((sum, dimension) => sum + Number(dimension.weight || 0), 0), [dimensions]);

  function loadTemplate() {
    setName((current) => current || '内置 Rubric');
    setScale('1-5');
    setAnchors(TEMPLATE_ANCHORS);
    setJudgeEnabled(true);
    setDimensions(TEMPLATE_DIMENSIONS);
    setFormError(null);
  }

  function updateDimension(index: number, patch: Partial<DimensionDraft>) {
    setDimensions((current) => current.map((dimension, i) => (i === index ? { ...dimension, ...patch } : dimension)));
  }

  function submit() {
    setFormError(null);
    try {
      const config: Record<string, unknown> = {
        dimensions: dimensions.map((dimension, index) => {
          if (!/^[a-z][a-z0-9_]*$/.test(dimension.id.trim())) throw new Error(`维度 ${index + 1} 的 id 需匹配 ^[a-z][a-z0-9_]*$`);
          if (!dimension.name.trim()) throw new Error(`维度 ${index + 1} 需要名称`);
          const weight = Number(dimension.weight);
          if (!Number.isFinite(weight) || weight <= 0) throw new Error(`维度 ${index + 1} 的权重必须为正数`);
          const rules = dimension.rules.trim() ? JSON.parse(dimension.rules) : [];
          if (!Array.isArray(rules)) throw new Error(`维度 ${index + 1} 的规则必须是数组`);
          const gate = Number(dimension.gate);
          if (dimension.gating && (!Number.isFinite(gate) || gate <= 0 || gate > 1)) throw new Error(`维度 ${index + 1} 的硬门槛必须在 (0,1]`);
          return {
            id: dimension.id.trim(),
            name: dimension.name.trim(),
            weight,
            ...(dimension.gating ? { gating: true, gate } : {}),
            ...(rules.length ? { rules } : {}),
          };
        }),
      };
      if (scale !== 'none') {
        const max = scale === '1-5' ? 5 : 10;
        const anchorMap: Record<string, string> = {};
        for (const line of anchors.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          const [level, ...rest] = trimmed.split('=');
          const value = rest.join('=').trim();
          if (!/^\d+$/.test(level.trim()) || Number(level) < 1 || Number(level) > max || !value) {
            throw new Error(`锚点格式应为 "分值=描述"，且分值在 1—${max}：${trimmed}`);
          }
          anchorMap[String(Number(level))] = value;
        }
        config.scale = { min: 1, max, ...(Object.keys(anchorMap).length ? { anchors: anchorMap } : {}) };
      }
      config.judge = judgeEnabled
        ? { enabled: true, defaultInstructions: judgeInstructions.trim() }
        : { enabled: false };
      if (!judgeEnabled && !(config.dimensions as Array<{ rules?: unknown[] }>).some((dimension) => (dimension.rules ?? []).length)) {
        throw new Error('未启用 judge 时，至少需要一个维度配置规则');
      }
      createProfile.mutate({ name: name.trim(), config });
    } catch (error) {
      setFormError((error as Error).message);
    }
  }

  const profileItems = profiles.data?.profiles ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>评分方案</h1>
          <div className="sub">自定义维度、权重、硬门槛与分值锚点；同名修改会生成新版本，历史报告保持冻结。</div>
        </div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          新建评分方案
        </Button>
      </div>

      {profiles.error ? <ErrorNotice error={profiles.error} onRetry={() => profiles.refetch()} /> : null}

      {!profiles.isLoading && !profileItems.length ? (
        <EmptyState
          title="还没有评分方案"
          description="可以载入内置 Rubric 后按需调整维度与权重。"
          action={
            <Button variant="primary" onClick={() => setOpen(true)}>
              新建评分方案
            </Button>
          }
        />
      ) : null}

      <div className="grid cols-2">
        {profileItems.map((profile) => (
          <Card
            key={profile.profileId}
            title={profile.name}
            subtitle={`最新 v${profile.latestVersionNumber ?? '—'} · ${scaleLabel(profile.scale)} · ${profile.dimensions?.length ?? profile.dimensionCount} 个维度`}
            actions={<Badge tone="info">{profile.versions.length} 个版本</Badge>}
          >
            <div className="stack">
              <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
                {(profile.dimensions ?? []).map((dimension) => (
                  <Badge key={dimension.id} tone={dimension.gating ? 'warn' : 'muted'}>
                    {dimension.name} {((dimension.normalizedWeight ?? 0) * 100).toFixed(0)}%
                    {dimension.gating ? ` · 门槛 ${formatGate(dimension.gate, profile.scale)}` : ''}
                  </Badge>
                ))}
              </div>
              <details>
                <summary className="small dim">版本历史</summary>
                <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                  {profile.versions.map((version) => (
                    <div key={version.profileVersionId} className="row small">
                      <span className="mono">v{version.versionNumber}</span>
                      <span className="dim">{version.contentHash.slice(0, 18)}…</span>
                      <span className="dim">{version.createdAt}</span>
                    </div>
                  ))}
                </div>
              </details>
            </div>
          </Card>
        ))}
      </div>

      <Modal
        open={open}
        title="新建评分方案"
        wide
        onClose={() => setOpen(false)}
        footer={
          <>
            <Button variant="ghost" onClick={loadTemplate}>
              载入内置模板
            </Button>
            <span className="spacer" />
            <Button onClick={() => setOpen(false)}>取消</Button>
            <Button variant="primary" loading={createProfile.isPending} onClick={submit}>
              保存
            </Button>
          </>
        }
      >
        <div className="stack">
          {formError ? <div className="notice error">{formError}</div> : null}
          {createProfile.error ? <ErrorNotice error={createProfile.error} /> : null}
          <div className="grid cols-2">
            <Field label="方案名称" hint="同名保存会创建新版本，不会覆盖旧版本">
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：客服质量 v2" />
            </Field>
            <Field label="评分刻度" hint="judge 按刻度打分，报告换算展示；权重与门槛始终按归一化口径校验">
              <Select value={scale} onChange={(event) => setScale(event.target.value as ScaleOption)}>
                <option value="1-5">1—5</option>
                <option value="1-10">1—10</option>
                <option value="none">不启用刻度（0—1）</option>
              </Select>
            </Field>
          </div>

          {scale !== 'none' ? (
            <Field label="分值锚点" hint="每行一个，格式：分值=描述；可以只填部分分值">
              <Textarea rows={5} value={anchors} onChange={(event) => setAnchors(event.target.value)} className="mono" />
            </Field>
          ) : null}

          <div className="section-title">
            <span>维度</span>
            <span className="spacer" />
            <Button size="small" onClick={() => setDimensions((current) => [...current, { ...EMPTY_DIMENSION }])}>
              添加维度
            </Button>
          </div>
          <div className="small dim">权重总和不要求为 1；当前总和 {weightTotal.toFixed(2)}，系统会按占比归一化。</div>

          <div className="stack">
            {dimensions.map((dimension, index) => (
              <Card key={index} className="stack" title={`维度 ${index + 1}`} actions={<Button size="small" variant="ghost" onClick={() => setDimensions((current) => current.filter((_, i) => i !== index))}>删除</Button>}>
                <div className="grid cols-4">
                  <Field label="ID">
                    <Input value={dimension.id} onChange={(event) => updateDimension(index, { id: event.target.value })} placeholder="accuracy" className="mono" />
                  </Field>
                  <Field label="名称">
                    <Input value={dimension.name} onChange={(event) => updateDimension(index, { name: event.target.value })} placeholder="准确性" />
                  </Field>
                  <Field label="权重">
                    <Input value={dimension.weight} onChange={(event) => updateDimension(index, { weight: event.target.value.replace(/[^\d.]/g, '') })} />
                  </Field>
                  <Field label="硬门槛（0—1）" hint={dimension.gating ? '低于门槛的 Trial 不可比较' : '启用硬门槛后必填'}>
                    <Input value={dimension.gate} onChange={(event) => updateDimension(index, { gate: event.target.value.replace(/[^\d.]/g, '') })} placeholder="0.6" />
                  </Field>
                </div>
                <Toggle
                  checked={dimension.gating}
                  onChange={(value) => updateDimension(index, { gating: value })}
                  label="启用硬门槛"
                  hint="低于门槛时该 Trial 标记为不可比较"
                />
                <Field label="规则（JSON 数组，可留空）" hint='例如 [{"type":"contains","value":"订单"}]；留空时依赖 judge'>
                  <Textarea rows={2} value={dimension.rules} onChange={(event) => updateDimension(index, { rules: event.target.value })} className="mono" />
                </Field>
              </Card>
            ))}
          </div>

          <Card title="LLM 评审">
            <div className="stack">
              <Toggle checked={judgeEnabled} onChange={setJudgeEnabled} label="启用 judge" hint="需要实验规格指定 judge 模型；未指定时自动退回规则评估" />
              {judgeEnabled ? (
                <Field label="评审指令">
                  <Textarea rows={3} value={judgeInstructions} onChange={(event) => setJudgeInstructions(event.target.value)} />
                </Field>
              ) : null}
            </div>
          </Card>
        </div>
      </Modal>
    </div>
  );
}

function scaleLabel(scale?: EvaluationScale | null) {
  return scale ? `${scale.min}—${scale.max} 刻度` : '0—1 小数';
}

function formatGate(gate: number | null | undefined, scale?: EvaluationScale | null) {
  if (gate == null) return '—';
  if (!scale) return gate.toFixed(2);
  return (Number(scale.min) + Number(gate) * (Number(scale.max) - Number(scale.min))).toFixed(1);
}
