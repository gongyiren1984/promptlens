import { useEffect, useState } from 'react';
import type { AppConfig, AppConfigPatch, Capabilities } from '@promptlens/contracts';
import { getClient, pickDirectory } from '../../api/bridge';
import { isCredentialRef } from '../../lib/credential';
import { qk, useApiMutation, useApiQuery } from '../../api/hooks';
import { Button, Card, ErrorNotice, Field, Input, Modal, Select } from '../../components/ui';
import { PRIVACY_SECTIONS, PRIVACY_SUMMARY, PRIVACY_VERSION, TERMS_SECTIONS, TERMS_VERSION } from '../../content/legal';
import { LegalSections } from '../legal/LegalSections';
import { navigate, projectPath } from '../../app/router';
import { joinPath, safeName } from '../../lib/paths';

type ProjectResult = { projectId: string; name: string; root: string; created?: boolean };
type ModelChoice = 'skip' | 'mock' | 'openai';

export function OnboardingPage() {
  const config = useApiQuery<AppConfig>(qk.appConfig(), (client) => client.get('/v1/app/config'));
  const capabilities = useApiQuery<Capabilities>(qk.capabilities(), (client) => client.get('/v1/capabilities'));
  const saveConfig = useApiMutation(
    (client, patch: AppConfigPatch) => client.patch<AppConfig>('/v1/app/config', patch),
    { invalidate: () => [qk.appConfig()] },
  );
  const createProject = useApiMutation(
    (client, body: { path: string; name: string }) => client.post<ProjectResult>('/v1/projects', body),
    { invalidate: () => [qk.projects()] },
  );
  const addModel = useApiMutation(
    (client, body: Record<string, unknown> & { projectId: string }) => {
      const { projectId, ...payload } = body;
      return client.post(`/v1/projects/${projectId}/models`, payload);
    },
    { invalidate: () => [qk.projects()] },
  );

  const [step, setStep] = useState(0);
  const [consent, setConsent] = useState(false);
  const [legalOpen, setLegalOpen] = useState<'privacy' | 'terms' | null>(null);
  const [root, setRoot] = useState('');
  const [projectName, setProjectName] = useState('我的第一个项目');
  const [projectPathValue, setProjectPathValue] = useState('');
  const [pathTouched, setPathTouched] = useState(false);
  const [modelChoice, setModelChoice] = useState<ModelChoice>('skip');
  const [modelName, setModelName] = useState('mock-local');
  const [modelId, setModelId] = useState('mock-large');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [credentialRef, setCredentialRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [pickerHint, setPickerHint] = useState<string | null>(null);
  const canPickDirectory = Boolean(window.__TAURI_INTERNALS__);
  const [projectId, setProjectId] = useState<string | null>(null);

  useEffect(() => {
    if (root) return;
    const initial = config.data?.defaultProjectRoot ?? capabilities.data?.workspace ?? '';
    if (initial) setRoot(initial);
  }, [config.data, capabilities.data, root]);

  useEffect(() => {
    if (pathTouched || !root) return;
    setProjectPathValue(joinPath(root, safeName(projectName)));
  }, [root, projectName, pathTouched]);

  const steps = ['知情同意', '项目目录', '首个项目', '模型（可选）'];

  async function nextFromConsent() {
    if (!consent) {
      setError(new Error('请先阅读并同意数据处理说明。'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const now = new Date().toISOString();
      await saveConfig.mutateAsync({
        legal: {
          privacyVersion: PRIVACY_VERSION,
          privacyAcceptedAt: now,
          termsVersion: TERMS_VERSION,
          termsAcceptedAt: now,
        },
      });
      setStep(1);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function nextFromDirectory() {
    if (!root.trim().startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root.trim())) {
      setError(new Error('请输入绝对路径，例如 /Users/me/Documents/PromptLens。'));
      return;
    }
    setError(null);
    setStep(2);
  }

  async function nextFromProject() {
    if (!projectName.trim() || !projectPathValue.trim()) {
      setError(new Error('请填写项目名称与目录。'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createProject.mutateAsync({ path: projectPathValue.trim(), name: projectName.trim() });
      setProjectId(created.projectId);
      setStep(3);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function finish(skipModel: boolean) {
    if (!projectId) return;
    setBusy(true);
    setError(null);
    try {
      if (!skipModel && modelChoice !== 'skip') {
        if (modelChoice === 'mock') {
          await addModel.mutateAsync({ projectId, name: modelName.trim() || 'mock-local', providerType: 'mock', modelId: modelId.trim() || 'mock-large', params: {} });
        } else {
          if (!apiKey.trim() && credentialRef.trim() && !isCredentialRef(credentialRef)) {
            setError(new Error('凭据引用需形如 env:VARIABLE_NAME 或 keychain:service[:account]；可直接在上方填写 API Key。'));
            return;
          }
          let resolvedRef = credentialRef.trim();
          if (apiKey.trim()) {
            const client = await getClient();
            const stored = await client.post<{ credentialRef: string }>('/v1/credentials/keychain', {
              key: apiKey.trim(),
              account: modelName.trim() || 'openai-compatible',
            });
            resolvedRef = stored.credentialRef;
          }
          await addModel.mutateAsync({
            projectId,
            name: modelName.trim() || 'openai-compatible',
            providerType: 'openai_compatible',
            modelId: modelId.trim(),
            baseUrl: baseUrl.trim(),
            credentialRef: resolvedRef || undefined,
            params: {},
          });
        }
      }
      await saveConfig.mutateAsync({
        defaultProjectRoot: root.trim(),
        onboarding: { completedAt: new Date().toISOString(), version: 1, skipped: false },
      });
      localStorage.setItem('promptlens.lastProjectId', projectId);
      navigate(projectPath(projectId));
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function skipAll() {
    setBusy(true);
    setError(null);
    try {
      await saveConfig.mutateAsync({ onboarding: { skipped: true, version: 1 } });
      navigate('/');
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  }

  async function chooseDirectory() {
    setPickerHint(null);
    try {
      const picked = await pickDirectory();
      if (picked) setRoot(picked);
      else setPickerHint('未获取到目录（可能已取消），也可以直接输入绝对路径。');
    } catch (reason) {
      setPickerHint(`无法打开系统目录选择器：${(reason as Error)?.message ?? String(reason)}。请直接输入绝对路径。`);
    }
  }

  return (
    <div className="onboarding">
      <header className="onboarding-head">
        <div className="row" style={{ gap: 10 }}>
          <div className="brand-mark">PL</div>
          <div>
            <div style={{ fontWeight: 700 }}>PromptLens 初始设置</div>
            <div className="small dim">本地优先 · 数据默认不出机</div>
          </div>
        </div>
        <Button variant="ghost" size="small" onClick={skipAll} loading={busy}>
          跳过引导
        </Button>
      </header>

      <ol className="onboarding-steps" aria-label="设置步骤">
        {steps.map((label, index) => (
          <li key={label} className={index === step ? 'active' : index < step ? 'done' : ''}>
            <span>{index + 1}</span>
            {label}
          </li>
        ))}
      </ol>

      <main className="onboarding-body">
        {error ? <ErrorNotice error={error} /> : null}

        {step === 0 ? (
          <Card title="数据处理与隐私说明" subtitle={`版本 ${PRIVACY_VERSION}`}>
            <div className="stack">
              <ul className="plain-list">
                {PRIVACY_SUMMARY.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
              <div className="row wrap">
                <Button size="small" onClick={() => setLegalOpen('privacy')}>
                  阅读完整隐私说明
                </Button>
                <Button size="small" onClick={() => setLegalOpen('terms')}>
                  阅读许可与用户协议
                </Button>
              </div>
              <label className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                <span>
                  我已阅读并同意数据处理说明；我理解本软件以 AGPLv3/GPLv3 或商业授权提供，运行时会向我所配置的模型服务商发送必要内容。
                </span>
              </label>
              <div className="row">
                <Button variant="primary" loading={busy} disabled={!consent} onClick={nextFromConsent}>
                  继续
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        {step === 1 ? (
          <Card title="确认默认项目目录" subtitle="以后新建项目会默认放在这里">
            <div className="stack">
              <Field label="项目目录（绝对路径）" hint="目录不存在会自动创建；请确保当前用户有写权限。">
                <div className="row">
                  <Input className="mono" value={root} onChange={(event) => setRoot(event.target.value)} placeholder="/Users/me/Documents/PromptLens" />
                  <Button size="small" disabled={!canPickDirectory} onClick={chooseDirectory}>
                    选择目录
                  </Button>
                </div>
                {!canPickDirectory ? (
                  <div className="notice warn small" style={{ marginTop: 6 }}>
                    浏览器预览模式不支持系统目录选择，请直接输入绝对路径（桌面应用内可用「选择目录」）。
                  </div>
                ) : pickerHint ? (
                  <div className="notice warn small" style={{ marginTop: 6 }}>
                    {pickerHint}
                  </div>
                ) : null}
              </Field>
              <div className="row">
                <Button onClick={() => setStep(0)}>上一步</Button>
                <Button variant="primary" onClick={nextFromDirectory}>
                  继续
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        {step === 2 ? (
          <Card title="创建第一个项目" subtitle="项目保存提示词、用例、运行与报告">
            <div className="stack">
              <Field label="项目名称">
                <Input value={projectName} onChange={(event) => setProjectName(event.target.value)} placeholder="我的第一个项目" />
              </Field>
              <Field label="项目目录（绝对路径）" hint="默认由“目录 + 项目名”生成，可手动修改。">
                <Input
                  className="mono"
                  value={projectPathValue}
                  onChange={(event) => {
                    setPathTouched(true);
                    setProjectPathValue(event.target.value);
                  }}
                />
              </Field>
              <div className="row">
                <Button onClick={() => setStep(1)} disabled={busy}>
                  上一步
                </Button>
                <Button variant="primary" loading={busy} onClick={nextFromProject}>
                  创建并继续
                </Button>
              </div>
            </div>
          </Card>
        ) : null}

        {step === 3 ? (
          <Card title="配置模型（可选）" subtitle="模型属于当前项目；也可以稍后在模型中心添加">
            <div className="stack">
              <Field label="配置方式">
                <Select value={modelChoice} onChange={(event) => setModelChoice(event.target.value as ModelChoice)}>
                  <option value="skip">稍后配置</option>
                  <option value="mock">Mock 模型（完全本地，推荐先体验）</option>
                  <option value="openai">OpenAI 兼容接口</option>
                </Select>
              </Field>
              {modelChoice !== 'skip' ? (
                <>
                  <Field label="配置名称">
                    <Input value={modelName} onChange={(event) => setModelName(event.target.value)} />
                  </Field>
                  <Field label="模型 ID">
                    <Input value={modelId} onChange={(event) => setModelId(event.target.value)} placeholder={modelChoice === 'mock' ? 'mock-large' : 'gpt-4o-mini'} />
                  </Field>
                </>
              ) : null}
              {modelChoice === 'openai' ? (
                <>
                  <Field label="Base URL" hint="仅支持 https；本机回环地址可使用 http。">
                    <Input className="mono" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.openai.com/v1" />
                  </Field>
                  <Field label="API Key" hint="填写后自动写入 macOS 系统钥匙串，项目里只保存引用，不保存明文。">
                    <Input
                      className="mono"
                      type="password"
                      autoComplete="off"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder="sk-..."
                    />
                  </Field>
                  <Field
                    label="凭据引用（高级）"
                    hint="留空则使用上面的 API Key；也可填 env:VARIABLE 或 keychain:service:account（适合无需密钥的本机服务）。"
                  >
                    <Input className="mono" value={credentialRef} onChange={(event) => setCredentialRef(event.target.value)} placeholder="env:OPENAI_API_KEY" />
                  </Field>
                  {credentialRef.trim() && !isCredentialRef(credentialRef) ? (
                    <div className="notice warn small">凭据引用格式必须是 env:VARIABLE 或 keychain:service[:account]；也可以清空并直接填写 API Key。</div>
                  ) : null}
                </>
              ) : null}
              <div className="row">
                <Button onClick={() => setStep(2)} disabled={busy}>
                  上一步
                </Button>
                <Button variant="ghost" loading={busy} onClick={() => finish(true)}>
                  跳过模型配置
                </Button>
                <Button variant="primary" loading={busy} disabled={Boolean(!apiKey.trim() && credentialRef.trim() && !isCredentialRef(credentialRef))} onClick={() => finish(false)}>
                  完成设置
                </Button>
              </div>
            </div>
          </Card>
        ) : null}
      </main>

      <Modal open={legalOpen === 'privacy'} title={`数据处理与隐私说明（${PRIVACY_VERSION}）`} onClose={() => setLegalOpen(null)} wide>
        <LegalSections sections={PRIVACY_SECTIONS} />
      </Modal>
      <Modal open={legalOpen === 'terms'} title={`许可与用户协议（${TERMS_VERSION}）`} onClose={() => setLegalOpen(null)} wide>
        <LegalSections sections={TERMS_SECTIONS} />
      </Modal>
    </div>
  );
}

