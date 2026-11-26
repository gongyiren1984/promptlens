import { useEffect, useMemo, useState } from 'react';
import type {
  EvaluationProfileSummary,
  ExperimentDraft,
  ModelProfile,
  PreflightResult,
  Prompt,
  RunCreateResult,
  TestSet,
} from '@promptlens/contracts';
import { getClient } from '../../api/bridge';
import { qk, useApiMutation, useApiQuery, useQueryInvalidator } from '../../api/hooks';
import { Badge, Button, Card, ErrorNotice, Field, Input, Select, Stat, formatDateTime, useToast } from '../../components/ui';
import { navigate, projectPath } from '../../app/router';

interface BranchOption {
  versionId: string;
  label: string;
  promptName: string;
  versionNumber: number;
  contentHash: string;
  variables: string[];
}

interface ModelOption {
  versionId: string;
  profileId: string;
  name: string;
  providerType: string;
  modelId: string;
  contentHash: string;
  pricing: Record<string, unknown> | null;
}

const STEPS = ['分支与用例', '模型矩阵', '执行策略', '评估与预算', '冻结摘要'];

export function WizardPage({ projectId }: { projectId: string }) {
  const { push } = useToast();
  const invalidate = useQueryInvalidator();

  const prompts = useApiQuery<{ prompts: Prompt[] }>(qk.prompts(projectId), (client) => client.get(`/v1/projects/${projectId}/prompts`));
  const testSets = useApiQuery<{ testSets: TestSet[] }>(qk.testSets(projectId), (client) => client.get(`/v1/projects/${projectId}/testsets`));
  const models = useApiQuery<{ models: ModelProfile[] }>(qk.models(projectId), (client) => client.get(`/v1/projects/${projectId}/models`));
  const profiles = useApiQuery<{ profiles: EvaluationProfileSummary[] }>(qk.evalProfiles(projectId), (client) => client.get(`/v1/projects/${projectId}/eval-profiles`));
  const drafts = useApiQuery<{ drafts: ExperimentDraft[] }>(qk.drafts(projectId), (client) => client.get(`/v1/projects/${projectId}/drafts`));

  const [step, setStep] = useState(1);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [branchIds, setBranchIds] = useState<string[]>([]);
  const [testSetVersionId, setTestSetVersionId] = useState('');
  const [sampleSize, setSampleSize] = useState('');
  const [modelIds, setModelIds] = useState<string[]>([]);
  const [fallbacks, setFallbacks] = useState<Record<string, string>>({});
  const [repetitions, setRepetitions] = useState(1);
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [maxConcurrency, setMaxConcurrency] = useState(4);
  const [order, setOrder] = useState<'sequential' | 'seeded_random'>('sequential');
  const [dialogueEnabled, setDialogueEnabled] = useState(false);
  const [dialogue, setDialogue] = useState({
    maxRounds: 5,
    generatorModelVersionId: '',
    generatorPromptVersionId: '',
    initialInputPolicy: 'case_first' as 'case_first' | 'generator_first',
    maxOutputTokensPerTurn: '',
  });
  const [termination, setTermination] = useState<Array<{ type: 'literal' | 'regex' | 'json_condition'; value: string }>>([
    { type: 'literal', value: '<END>' },
  ]);
  const [evalProfileVersionId, setEvalProfileVersionId] = useState('');
  const [budget, setBudget] = useState({ maxRequests: '200', maxTotalTokens: '', maxDurationSeconds: '900', amount: '', currency: 'USD' });
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [preflightError, setPreflightError] = useState<unknown>(null);
  const [preflighting, setPreflighting] = useState(false);
  const [starting, setStarting] = useState(false);

  const branchOptions = useMemo<BranchOption[]>(() => {
    const list: BranchOption[] = [];
    for (const prompt of prompts.data?.prompts ?? []) {
      for (const variant of prompt.variants) {
        const latest = variant.versions.find((version) => version.versionId === variant.latestVersionId);
        if (!latest) continue;
        list.push({
          versionId: latest.versionId,
          label: variant.label,
          promptName: prompt.name,
          versionNumber: latest.versionNumber,
          contentHash: latest.contentHash,
          variables: latest.variables,
        });
      }
    }
    return list;
  }, [prompts.data]);

  const modelOptions = useMemo<ModelOption[]>(() => {
    return (models.data?.models ?? [])
      .filter((model) => model.latest)
      .map((model) => ({
        versionId: model.latest!.modelConfigVersionId,
        profileId: model.latest!.profileId,
        name: model.name,
        providerType: model.latest!.providerType,
        modelId: model.latest!.modelId,
        contentHash: model.latest!.contentHash,
        pricing: model.latest!.pricing as unknown as Record<string, unknown> | null,
      }));
  }, [models.data]);

  const profileOptions = useMemo(() => {
    return (profiles.data?.profiles ?? []).flatMap((profile) =>
      profile.versions.map((version) => ({
        profileVersionId: version.profileVersionId,
        name: profile.name,
        versionNumber: version.versionNumber,
        contentHash: version.contentHash,
        dimensionCount: profile.dimensionCount,
        scale: profile.scale ?? null,
        weightTotal: profile.weightTotal ?? null,
        dimensions: profile.dimensions ?? [],
      })),
    );
  }, [profiles.data]);

  const selectedEvalProfile = useMemo(
    () => profileOptions.find((profile) => profile.profileVersionId === evalProfileVersionId) ?? null,
    [profileOptions, evalProfileVersionId],
  );

  const testSetOptions = useMemo(() => {
    return (testSets.data?.testSets ?? []).flatMap((set) =>
      set.versions.map((version) => ({
        versionId: version.testSetVersionId,
        label: `${set.name} · v${version.versionNumber}（${version.caseCount} 条）`,
        caseCount: version.caseCount,
        hash: version.contentHash,
      })),
    );
  }, [testSets.data]);

  useEffect(() => {
    if (!testSetVersionId && testSetOptions.length) setTestSetVersionId(testSetOptions[0].versionId);
  }, [testSetOptions, testSetVersionId]);

  useEffect(() => {
    if (!evalProfileVersionId && profileOptions.length) setEvalProfileVersionId(profileOptions[0].profileVersionId);
  }, [profileOptions, evalProfileVersionId]);

  useEffect(() => {
    if (!dialogue.generatorModelVersionId && modelOptions.length) {
      setDialogue((current) => ({ ...current, generatorModelVersionId: modelOptions[0].versionId }));
    }
  }, [modelOptions, dialogue.generatorModelVersionId]);

  const labels = useMemo(() => {
    const counts = new Map<string, number>();
    for (const option of branchOptions) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
    return new Map(
      branchOptions.map((option) => [
        option.versionId,
        (counts.get(option.label) ?? 0) > 1 ? `${option.promptName}·${option.label}` : option.label,
      ]),
    );
  }, [branchOptions]);

  function buildSpec() {
    const variants = branchIds.map((versionId) => {
      const option = branchOptions.find((item) => item.versionId === versionId)!;
      return { label: labels.get(versionId) ?? option.label, promptVersionId: option.versionId, contentHash: option.contentHash };
    });
    const testSet = testSetOptions.find((item) => item.versionId === testSetVersionId);
    const specModels = modelIds.map((versionId) => {
      const option = modelOptions.find((item) => item.versionId === versionId)!;
      const fallbackId = fallbacks[versionId];
      return {
        modelConfigVersionId: option.versionId,
        modelProfileId: option.profileId,
        contentHash: option.contentHash,
        ...(fallbackId ? { fallbackModelConfigVersionIds: [fallbackId] } : {}),
      };
    });
    const profile = profileOptions.find((item) => item.profileVersionId === evalProfileVersionId);
    const budgetSpec: Record<string, unknown> = {};
    if (budget.maxRequests) budgetSpec.maxRequests = Number(budget.maxRequests);
    if (budget.maxTotalTokens) budgetSpec.maxTotalTokens = Number(budget.maxTotalTokens);
    if (budget.maxDurationSeconds) budgetSpec.maxDurationSeconds = Number(budget.maxDurationSeconds);
    if (budget.amount) budgetSpec.maxAmount = { amount: budget.amount, currency: budget.currency };
    return {
      schema: 'promptlens.experiment/v1',
      projectId,
      name: name.trim() || '未命名实验',
      variants,
      testSet: {
        testSetVersionId: testSet?.versionId ?? '',
        contentHash: testSet?.hash ?? '',
        ...(sampleSize ? { sampleSize: Number(sampleSize) || undefined } : {}),
      },
      models: specModels,
      repetitions,
      execution: {
        order,
        maxAttempts,
        maxConcurrency,
        ...(dialogueEnabled
          ? {
              dialogue: {
                maxRounds: dialogue.maxRounds,
                generatorModelConfigVersionId: dialogue.generatorModelVersionId,
                ...(dialogue.generatorPromptVersionId ? { generatorPromptVersionId: dialogue.generatorPromptVersionId } : {}),
                initialInputPolicy: dialogue.initialInputPolicy,
                ...(dialogue.maxOutputTokensPerTurn ? { maxOutputTokensPerTurn: Number(dialogue.maxOutputTokensPerTurn) } : {}),
                termination,
              },
            }
          : {}),
      },
      evaluation: {
        profileVersionId: profile?.profileVersionId ?? '',
        contentHash: profile?.contentHash ?? '',
      },
      budget: budgetSpec,
    };
  }

  function payload() {
    return {
      name,
      branchVersionIds: branchIds,
      testSetVersionId,
      sampleSize: sampleSize ? Number(sampleSize) : null,
      modelVersionIds: modelIds,
      fallbacks,
      repetitions,
      maxAttempts,
      maxConcurrency,
      order,
      dialogue: dialogueEnabled
        ? {
            maxRounds: dialogue.maxRounds,
            generatorModelVersionId: dialogue.generatorModelVersionId,
            generatorPromptVersionId: dialogue.generatorPromptVersionId || null,
            initialInputPolicy: dialogue.initialInputPolicy,
            maxOutputTokensPerTurn: dialogue.maxOutputTokensPerTurn ? Number(dialogue.maxOutputTokensPerTurn) : null,
            termination,
          }
        : null,
      evalProfileVersionId,
      budget: {
        maxRequests: budget.maxRequests ? Number(budget.maxRequests) : undefined,
        maxTotalTokens: budget.maxTotalTokens ? Number(budget.maxTotalTokens) : undefined,
        maxDurationSeconds: budget.maxDurationSeconds ? Number(budget.maxDurationSeconds) : undefined,
        ...(budget.amount ? { maxAmount: { amount: budget.amount, currency: budget.currency } } : {}),
      },
    };
  }

  function restore(draft: ExperimentDraft) {
    const data = draft.payload ?? {};
    setDraftId(draft.draftId);
    setName(draft.name ?? data.name ?? '');
    setBranchIds(data.branchVersionIds ?? []);
    setTestSetVersionId(data.testSetVersionId ?? '');
    setSampleSize(data.sampleSize ? String(data.sampleSize) : '');
    setModelIds(data.modelVersionIds ?? []);
    setFallbacks((data.fallbacks as Record<string, string>) ?? {});
    setRepetitions(data.repetitions ?? 1);
    setMaxAttempts(data.maxAttempts ?? 3);
    setMaxConcurrency(data.maxConcurrency ?? 4);
    setOrder((data.order as 'sequential' | 'seeded_random') ?? 'sequential');
    const savedDialogue = data.dialogue as
      | {
          maxRounds?: number;
          generatorModelVersionId?: string;
          generatorPromptVersionId?: string | null;
          initialInputPolicy?: 'case_first' | 'generator_first';
          maxOutputTokensPerTurn?: number | null;
          termination?: Array<{ type: 'literal' | 'regex' | 'json_condition'; value: string }>;
        }
      | null
      | undefined;
    setDialogueEnabled(Boolean(savedDialogue));
    if (savedDialogue) {
      setDialogue({
        maxRounds: savedDialogue.maxRounds ?? 5,
        generatorModelVersionId: savedDialogue.generatorModelVersionId ?? '',
        generatorPromptVersionId: savedDialogue.generatorPromptVersionId ?? '',
        initialInputPolicy: savedDialogue.initialInputPolicy ?? 'case_first',
        maxOutputTokensPerTurn: savedDialogue.maxOutputTokensPerTurn ? String(savedDialogue.maxOutputTokensPerTurn) : '',
      });
      setTermination(savedDialogue.termination?.length ? savedDialogue.termination : [{ type: 'literal', value: '<END>' }]);
    }
    setEvalProfileVersionId(data.evalProfileVersionId ?? '');
    const saved = data.budget ?? {};
    setBudget({
      maxRequests: saved.maxRequests ? String(saved.maxRequests) : '',
      maxTotalTokens: saved.maxTotalTokens ? String(saved.maxTotalTokens) : '',
      maxDurationSeconds: saved.maxDurationSeconds ? String(saved.maxDurationSeconds) : '',
      amount: (saved.maxAmount as { amount: string } | undefined)?.amount ?? '',
      currency: (saved.maxAmount as { currency: string } | undefined)?.currency ?? 'USD',
    });
    setStep(Math.min(5, Math.max(1, draft.step)));
    push('草稿已恢复', 'info');
  }

  const saveDraft = useApiMutation(
    async (client, value: { draftId: string | null; name: string; step: number; payload: Record<string, unknown> }) => {
      if (value.draftId) {
        return client.patch<ExperimentDraft>(`/v1/projects/${projectId}/drafts/${value.draftId}`, { name: value.name, step: value.step, payload: value.payload });
      }
      return client.post<ExperimentDraft>(`/v1/projects/${projectId}/drafts`, { name: value.name, step: value.step, payload: value.payload });
    },
    {
      invalidate: () => [qk.drafts(projectId)],
      onSuccess: (draft) => {
        setDraftId(draft.draftId);
        push('草稿已保存', 'success');
      },
      onError: (error) => push((error as Error).message, 'error'),
    },
  );

  async function runPreflight() {
    setPreflighting(true);
    setPreflightError(null);
    try {
      const client = await getClient();
      const result = await client.post<PreflightResult>(`/v1/projects/${projectId}/runs/preflight`, { spec: buildSpec(), includeSnapshot: true });
      setPreflight(result);
    } catch (error) {
      setPreflight(null);
      setPreflightError(error);
    } finally {
      setPreflighting(false);
    }
  }

  async function startRun() {
    setStarting(true);
    try {
      const client = await getClient();
      const result = await client.post<RunCreateResult>(`/v1/projects/${projectId}/runs`, {
        spec: buildSpec(),
        idempotencyKey: crypto.randomUUID(),
      });
      await invalidate(qk.runs(projectId, '', 0));
      push(result.reused ? '复用了已存在运行' : `运行已启动：${result.trialCount} 个 Trial`, 'success');
      navigate(projectPath(projectId, `/runs/${result.runId}`));
    } catch (error) {
      push((error as Error).message, 'error');
    } finally {
      setStarting(false);
    }
  }

  const step1Valid = name.trim().length > 0 && branchIds.length >= 2 && Boolean(testSetVersionId);
  const step2Valid = modelIds.length >= 1;
  const dialogueValid =
    !dialogueEnabled ||
    (dialogue.maxRounds >= 1 &&
      dialogue.maxRounds <= 20 &&
      Boolean(dialogue.generatorModelVersionId) &&
      termination.every(isTerminationValid));
  const step3Valid =
    repetitions >= 1 && repetitions <= 20 && maxAttempts >= 1 && maxConcurrency >= 1 && dialogueValid;
  const step4Valid = Boolean(evalProfileVersionId) && (budget.maxRequests || budget.maxTotalTokens || budget.maxDurationSeconds || budget.amount);
  const canAdvance = step === 1 ? step1Valid : step === 2 ? step2Valid : step === 3 ? step3Valid : step === 4 ? step4Valid : true;

  const selectedTestSet = testSetOptions.find((option) => option.versionId === testSetVersionId);
  const trialEstimate = branchIds.length * (selectedTestSet?.caseCount ?? 0) * modelIds.length * repetitions;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>新建实验</h1>
          <div className="sub">冻结分支、测试集、模型、评分与预算后生成不可变快照。</div>
        </div>
        <span className="spacer" />
        <div className="sticky-actions">
          <Button
            onClick={() => saveDraft.mutate({ draftId, name, step, payload: payload() as Record<string, unknown> })}
            loading={saveDraft.isPending}
          >
            保存草稿
          </Button>
        </div>
      </header>

      {(drafts.data?.drafts.length ?? 0) > 0 && !draftId ? (
        <div className="notice info">
          <span>发现 {drafts.data!.drafts.length} 个未完成草稿：</span>
          <span className="row">
            {drafts.data!.drafts.slice(0, 3).map((draft) => (
              <Button key={draft.draftId} size="small" onClick={() => restore(draft)}>
                {draft.name || '未命名'} · 第 {draft.step} 步 · {formatDateTime(draft.updatedAt)}
              </Button>
            ))}
          </span>
        </div>
      ) : null}

      <Card>
        <div className="steps">
          {STEPS.map((title, index) => {
            const number = index + 1;
            const state = number < step ? 'done' : number === step ? 'active' : '';
            return (
              <button key={title} className={`step ${state}`} onClick={() => setStep(number)}>
                <span className="idx">{number < step ? '✓' : number}</span>
                {title}
              </button>
            );
          })}
        </div>
      </Card>

      {step === 1 ? (
        <div className="stack">
          <Card title="实验名称与分支">
            <Field label="实验名称">
              <Input value={name} onChange={(event) => setName(event.target.value)} placeholder="客服提示词 A/B 实验" />
            </Field>
          </Card>

          <Card title="选择分支（至少 2 个）" subtitle="每个分支指向一个不可变提示词版本" flush>
            <div className="list" style={{ padding: 10 }}>
              {branchOptions.length ? (
                branchOptions.map((option) => (
                  <label key={option.versionId} className="checkline">
                    <input
                      type="checkbox"
                      checked={branchIds.includes(option.versionId)}
                      onChange={(event) =>
                        setBranchIds((current) =>
                          event.target.checked ? [...current, option.versionId] : current.filter((id) => id !== option.versionId),
                        )
                      }
                    />
                    <span style={{ flex: 1 }}>
                      <strong>{labels.get(option.versionId) ?? option.label}</strong>
                      <span className="small dim"> · {option.promptName} · v{option.versionNumber}</span>
                      {option.variables.length ? <span className="small dim"> · 变量 {option.variables.join(', ')}</span> : null}
                    </span>
                    <span className="mono small dim">{option.contentHash.slice(0, 14)}…</span>
                  </label>
                ))
              ) : (
                <div className="table-empty">还没有可用分支；请先在提示词实验室保存版本。</div>
              )}
            </div>
          </Card>

          <Card title="测试集">
            <div className="row">
              <Field label="测试集版本">
                <Select value={testSetVersionId} onChange={(event) => setTestSetVersionId(event.target.value)}>
                  {testSetOptions.map((option) => (
                    <option key={option.versionId} value={option.versionId}>
                      {option.label}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="抽样条数（可选）" hint="留空使用完整测试集">
                <Input value={sampleSize} onChange={(event) => setSampleSize(event.target.value.replace(/\D/g, ''))} placeholder="如 20" style={{ width: 140 }} />
              </Field>
              <div className="spacer" />
              <div className="small dim">
                预计 Trial：{branchIds.length} × {selectedTestSet?.caseCount ?? 0} × {modelIds.length} × {repetitions} ={' '}
                <strong>{trialEstimate}</strong>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {step === 2 ? (
        <div className="stack">
          <Card title="模型矩阵" subtitle="至少选择一个模型；可为每个模型指定一个故障转移模型" flush>
            <div className="list" style={{ padding: 10 }}>
              {modelOptions.length ? (
                modelOptions.map((option) => (
                  <div key={option.versionId} className="checkline" style={{ alignItems: 'flex-start' }}>
                    <input
                      type="checkbox"
                      checked={modelIds.includes(option.versionId)}
                      onChange={(event) =>
                        setModelIds((current) =>
                          event.target.checked ? [...current, option.versionId] : current.filter((id) => id !== option.versionId),
                        )
                      }
                      style={{ marginTop: 4 }}
                    />
                    <div style={{ flex: 1 }}>
                      <div>
                        <strong>{option.name}</strong>{' '}
                        <Badge tone={option.providerType === 'mock' ? 'warn' : 'info'}>{option.providerType}</Badge>{' '}
                        <span className="small dim mono">{option.modelId}</span>
                      </div>
                      <div className="small dim">
                        {option.pricing ? `价格：${String((option.pricing as { unit?: string }).unit ?? '')}` : '价格未知（成本按未知呈现）'}
                      </div>
                    </div>
                    {modelIds.includes(option.versionId) ? (
                      <Field label="故障转移">
                        <Select
                          value={fallbacks[option.versionId] ?? ''}
                          onChange={(event) => setFallbacks({ ...fallbacks, [option.versionId]: event.target.value })}
                          style={{ minWidth: 160 }}
                        >
                          <option value="">不配置</option>
                          {modelOptions
                            .filter((item) => item.versionId !== option.versionId)
                            .map((item) => (
                              <option key={item.versionId} value={item.versionId}>
                                {item.name}
                              </option>
                            ))}
                        </Select>
                      </Field>
                    ) : null}
                  </div>
                ))
              ) : (
                <div className="table-empty">还没有模型；请到模型中心添加。</div>
              )}
            </div>
          </Card>
          <div className="notice warn">配置故障转移后，回退结果会记录实际模型并排除出对照均值。</div>
        </div>
      ) : null}

      {step === 3 ? (
        <div className="stack">
          <Card title="执行策略">
            <div className="grid cols-4">
              <Field label="重复次数" hint="1—20">
                <Input value={String(repetitions)} onChange={(event) => setRepetitions(clampNumber(event.target.value, 1, 20, 1))} />
              </Field>
              <Field label="最大尝试次数" hint="1—10">
                <Input value={String(maxAttempts)} onChange={(event) => setMaxAttempts(clampNumber(event.target.value, 1, 10, 3))} />
              </Field>
              <Field label="并发度" hint="1—256">
                <Input value={String(maxConcurrency)} onChange={(event) => setMaxConcurrency(clampNumber(event.target.value, 1, 256, 4))} />
              </Field>
              <Field label="执行顺序">
                <Select value={order} onChange={(event) => setOrder(event.target.value as typeof order)}>
                  <option value="sequential">顺序</option>
                  <option value="seeded_random">种子随机</option>
                </Select>
              </Field>
            </div>
            <div className="small dim" style={{ marginTop: 10 }}>
              重试采用指数退避；取消只停止后续请求，已完成 Trial 不会被回滚。
            </div>
          </Card>

          <Card title="双模型多轮对话" subtitle="模型 B 生成初始输入或追问，模型 A 作为被测对象回答；每个 Trial 独立上下文">
            <label className="checkline">
              <input type="checkbox" checked={dialogueEnabled} onChange={(event) => setDialogueEnabled(event.target.checked)} />
              <span>启用对话模式（沿用例预算执行，达到轮数/终止条件/预算即停止）</span>
            </label>
            {dialogueEnabled ? (
              <div className="stack" style={{ marginTop: 12 }}>
                <div className="grid cols-4">
                  <Field label="最大轮数" hint="1—20">
                    <Input
                      value={String(dialogue.maxRounds)}
                      onChange={(event) => setDialogue({ ...dialogue, maxRounds: clampNumber(event.target.value, 1, 20, 5) })}
                    />
                  </Field>
                  <Field label="生成模型 B">
                    <Select
                      value={dialogue.generatorModelVersionId}
                      onChange={(event) => setDialogue({ ...dialogue, generatorModelVersionId: event.target.value })}
                    >
                      <option value="">请选择</option>
                      {modelOptions.map((option) => (
                        <option key={option.versionId} value={option.versionId}>
                          {option.name}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="生成提示词（可选）" hint="留空使用内置生成提示词">
                    <Select
                      value={dialogue.generatorPromptVersionId}
                      onChange={(event) => setDialogue({ ...dialogue, generatorPromptVersionId: event.target.value })}
                    >
                      <option value="">内置提示词</option>
                      {branchOptions.map((option) => (
                        <option key={option.versionId} value={option.versionId}>
                          {option.promptName} · {option.label} · v{option.versionNumber}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="首轮输入">
                    <Select
                      value={dialogue.initialInputPolicy}
                      onChange={(event) =>
                        setDialogue({ ...dialogue, initialInputPolicy: event.target.value as 'case_first' | 'generator_first' })
                      }
                    >
                      <option value="case_first">用例输入</option>
                      <option value="generator_first">模型 B 生成</option>
                    </Select>
                  </Field>
                  <Field label="每轮输出上限" hint="最大 Token，留空不限制">
                    <Input
                      value={dialogue.maxOutputTokensPerTurn}
                      onChange={(event) =>
                        setDialogue({ ...dialogue, maxOutputTokensPerTurn: event.target.value.replace(/\D/g, '') })
                      }
                      placeholder="如 512"
                    />
                  </Field>
                </div>

                <div className="stack" style={{ gap: 8 }}>
                  <div className="row small dim">
                    <span>终止条件</span>
                    <span className="spacer" />
                    <Button
                      size="small"
                      onClick={() => setTermination((current) => [...current, { type: 'literal', value: '' }])}
                      disabled={termination.length >= 10}
                    >
                      添加条件
                    </Button>
                  </div>
                  {termination.map((item, index) => (
                    <div className="row" key={`${item.type}-${index}`} style={{ gap: 8 }}>
                      <Select
                        value={item.type}
                        onChange={(event) =>
                          setTermination((current) =>
                            current.map((entry, i) =>
                              i === index ? { ...entry, type: event.target.value as typeof entry.type } : entry,
                            ),
                          )
                        }
                        style={{ width: 150 }}
                      >
                        <option value="literal">文本包含</option>
                        <option value="regex">正则匹配</option>
                        <option value="json_condition">JSON 条件</option>
                      </Select>
                      <Input
                        value={item.value}
                        onChange={(event) =>
                          setTermination((current) =>
                            current.map((entry, i) => (i === index ? { ...entry, value: event.target.value } : entry)),
                          )
                        }
                        placeholder={item.type === 'json_condition' ? '{"path":"status","equals":"done"}' : '如 <END>'}
                      />
                      <Button
                        size="small"
                        variant="ghost"
                        onClick={() => setTermination((current) => current.filter((_, i) => i !== index))}
                        disabled={termination.length <= 1}
                      >
                        删除
                      </Button>
                    </div>
                  ))}
                  <div className="small dim">
                    B 输出 <code>&lt;END&gt;</code> 或满足任一条件时停止；达到最大轮数或预算同样停止。
                  </div>
                </div>
              </div>
            ) : null}
          </Card>
        </div>
      ) : null}

      {step === 4 ? (
        <div className="stack">
          <Card
            title="评估方案"
            actions={
              <Button size="small" onClick={() => navigate(projectPath(projectId, '/eval-profiles'))}>
                管理评分方案
              </Button>
            }
          >
            <Field label="评分方案版本">
              <Select value={evalProfileVersionId} onChange={(event) => setEvalProfileVersionId(event.target.value)}>
                {profileOptions.map((profile) => (
                  <option key={profile.profileVersionId} value={profile.profileVersionId}>
                    {profile.name} · v{profile.versionNumber}（{profile.dimensionCount} 个维度 · {profile.scale ? `${profile.scale.min}—${profile.scale.max} 刻度` : '0—1'}）
                  </option>
                ))}
              </Select>
            </Field>
            {selectedEvalProfile ? (
              <div className="stack" style={{ gap: 6, marginTop: 10 }}>
                <div className="row small" style={{ flexWrap: 'wrap', gap: 6 }}>
                  <span className="dim">权重总和 {selectedEvalProfile.weightTotal ?? '—'}（自动归一化）</span>
                  {selectedEvalProfile.dimensions.map((dimension) => (
                    <span key={dimension.id} className="badge muted">
                      {dimension.name} {((dimension.normalizedWeight ?? 0) * 100).toFixed(0)}%
                      {dimension.gating ? ` · 门槛 ${formatEvalGate(dimension.gate, selectedEvalProfile.scale)}` : ''}
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </Card>

          <Card title="预算" subtitle="至少设置一个硬性限制；金额上限要求全部模型价格已知">
            <div className="grid cols-4">
              <Field label="最大请求数">
                <Input value={budget.maxRequests} onChange={(event) => setBudget({ ...budget, maxRequests: event.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label="最大 Token 数">
                <Input value={budget.maxTotalTokens} onChange={(event) => setBudget({ ...budget, maxTotalTokens: event.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label="最大时长（秒）">
                <Input value={budget.maxDurationSeconds} onChange={(event) => setBudget({ ...budget, maxDurationSeconds: event.target.value.replace(/\D/g, '') })} />
              </Field>
              <Field label="金额上限（可选）">
                <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  <Input value={budget.amount} onChange={(event) => setBudget({ ...budget, amount: event.target.value.replace(/[^\d.]/g, '') })} placeholder="0.50" />
                  <Select value={budget.currency} onChange={(event) => setBudget({ ...budget, currency: event.target.value })} style={{ width: 86 }}>
                    <option value="USD">USD</option>
                    <option value="CNY">CNY</option>
                    <option value="EUR">EUR</option>
                  </Select>
                </div>
              </Field>
            </div>
          </Card>
        </div>
      ) : null}

      {step === 5 ? (
        <div className="stack">
          <Card
            title="冻结摘要"
            subtitle="预检会解析全部引用并校验内容哈希，任何漂移都会阻断运行"
            actions={
              <Button size="small" onClick={runPreflight} loading={preflighting}>
                {preflight ? '重新预检' : '执行预检'}
              </Button>
            }
          >
            <div className="grid cols-4">
              <Stat label="分支" value={branchIds.length} />
              <Stat label="用例" value={selectedTestSet?.caseCount ?? 0} hint={sampleSize ? `抽样 ${sampleSize}` : '全量'} />
              <Stat label="模型" value={modelIds.length} />
              <Stat label="Trial 合计" value={preflight?.trialCount ?? trialEstimate} hint={`重复 ${repetitions} 次`} />
            </div>

            {preflight ? (
              <div className="stack" style={{ marginTop: 14 }}>
                <dl className="kv">
                  <dt>快照哈希</dt>
                  <dd className="mono">{preflight.snapshotHash}</dd>
                  <dt>分支</dt>
                  <dd>{preflight.plan.variants.join(' / ')}</dd>
                  <dt>模型</dt>
                  <dd>{preflight.plan.models.join(' / ')}</dd>
                  {preflight.plan.worstCaseRequests ? (
                    <>
                      <dt>最坏模型调用</dt>
                      <dd>
                        {preflight.plan.worstCaseRequests}
                        {preflight.plan.dialogue ? (
                          <span className="dim small">
                            {' '}
                            （对话 {preflight.plan.dialogue.callsPerTrial} 次/Trial，{preflight.plan.dialogue.maxRounds} 轮）
                          </span>
                        ) : null}
                      </dd>
                    </>
                  ) : null}
                  <dt>预估成本</dt>
                  <dd>
                    {preflight.estimate.amount == null
                      ? '未知（价格不完整）'
                      : `${preflight.estimate.amount} ${preflight.estimate.currency ?? ''}`}{' '}
                    <span className="dim small">（{preflight.estimate.completeness}）</span>
                  </dd>
                </dl>
                {preflight.warnings.length ? (
                  <div className="stack" style={{ gap: 6 }}>
                    {preflight.warnings.map((warning) => (
                      <div className="notice warn" key={warning.code}>
                        <span className="mono small">[{warning.code}]</span> {warning.message}
                      </div>
                    ))}
                  </div>
                ) : null}
                {preflight.risks.length ? (
                  <div className="notice error">
                    <div>
                      {preflight.risks.map((risk) => (
                        <div key={risk}>· {risk}</div>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="row">
                  <Button variant="primary" onClick={startRun} loading={starting}>
                    启动运行
                  </Button>
                  <Button onClick={() => saveDraft.mutate({ draftId, name, step, payload: payload() as Record<string, unknown> })} loading={saveDraft.isPending}>
                    保存草稿
                  </Button>
                </div>
              </div>
            ) : preflightError ? (
              <div style={{ marginTop: 12 }}>
                <ErrorNotice error={preflightError} onRetry={runPreflight} />
              </div>
            ) : (
              <div className="notice info" style={{ marginTop: 12 }}>
                点击“执行预检”生成冻结摘要；只有预检通过才能启动运行。
              </div>
            )}
          </Card>
        </div>
      ) : null}

      <div className="row">
        <Button disabled={step === 1} onClick={() => setStep((value) => Math.max(1, value - 1))}>
          上一步
        </Button>
        <span className="spacer" />
        {!canAdvance ? <span className="small dim">请完成当前步骤的必要字段</span> : null}
        {step < 5 ? (
          <Button variant="primary" disabled={!canAdvance} onClick={() => setStep((value) => Math.min(5, value + 1))}>
            下一步
          </Button>
        ) : (
          <Button variant="primary" disabled={!preflight || starting} onClick={startRun} loading={starting}>
            启动运行
          </Button>
        )}
      </div>
    </div>
  );
}

function formatEvalGate(gate: number | null | undefined, scale: { min: number; max: number } | null) {
  if (gate == null) return '—';
  if (!scale) return gate.toFixed(2);
  return (scale.min + Number(gate) * (scale.max - scale.min)).toFixed(1);
}

function isTerminationValid(item: { type: 'literal' | 'regex' | 'json_condition'; value: string }) {
  if (!item.value.trim()) return false;
  if (item.type === 'regex') {
    try {
      new RegExp(item.value);
      return true;
    } catch {
      return false;
    }
  }
  if (item.type === 'json_condition') {
    try {
      const parsed = JSON.parse(item.value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed);
    } catch {
      return false;
    }
  }
  return true;
}

function clampNumber(value: string, min: number, max: number, fallback: number) {
  const number = Number(value.replace(/\D/g, ''));
  if (!Number.isFinite(number) || value === '') return fallback;
  return Math.min(max, Math.max(min, number));
}
