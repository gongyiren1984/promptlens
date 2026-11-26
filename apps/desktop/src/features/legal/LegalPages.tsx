import { useMemo, useState } from 'react';
import type { Capabilities } from '@promptlens/contracts';
import { qk, useApiQuery } from '../../api/hooks';
import { Badge, Card, Field, Input, Select } from '../../components/ui';
import { NOTICES, NOTICE_COUNT } from '../../generated/notices';
import { PRIVACY_SECTIONS, PRIVACY_VERSION, TERMS_SECTIONS, TERMS_VERSION } from '../../content/legal';
import { Link } from '../../app/router';
import { LegalSections } from './LegalSections';

export function AboutPage() {
  const capabilities = useApiQuery<Capabilities>(qk.capabilities(), (client) => client.get('/v1/capabilities'), { staleTime: 30_000 });
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>关于 PromptLens</h1>
          <div className="sub">本地优先的提示词实验与评估工具</div>
        </div>
      </div>

      <Card title="版本与运行环境">
        <div className="kv">
          <span>产品</span>
          <span>{capabilities.data?.product ?? 'PromptLens'}</span>
          <span>核心版本</span>
          <span>{capabilities.data?.serverVersion ?? '—'}</span>
          <span>API 版本</span>
          <span>{capabilities.data?.apiVersion ?? 'v1'}</span>
          <span>传输</span>
          <span className="mono">
            {capabilities.data ? `${capabilities.data.transport.type} ${capabilities.data.transport.host}:${capabilities.data.transport.port}` : '—'}
          </span>
          <span>工作区</span>
          <span className="mono">{capabilities.data?.workspace ?? '—'}</span>
        </div>
      </Card>

      <Card title="许可" subtitle="双许可模式">
        <div className="stack">
          <p>
            本软件以 <strong>AGPLv3</strong> 或 <strong>GPLv3</strong> 提供；如你需要在闭源或商业场景中使用，可与版权持有人另行签订商业授权协议。
          </p>
          <p className="small dim">
            AGPLv3 要求：若你把修改后的本软件作为网络服务提供给他人，需向用户提供对应的完整源代码。完整许可文本以仓库根目录的 LICENSE 文件为准。
          </p>
          <div className="row wrap">
            <Link className="btn" to="/legal/terms">
              许可与用户协议
            </Link>
            <Link className="btn" to="/legal/privacy">
              数据处理与隐私
            </Link>
            <Link className="btn" to="/legal/notices">
              第三方许可（{NOTICE_COUNT} 项）
            </Link>
          </div>
        </div>
      </Card>

      <Card title="第三方组件">
        <p className="small dim">
          本软件包含 Node.js、SQLite、React、Tauri、Rust crates 等第三方组件，其许可条款见
          <Link to="/legal/notices"> 第三方许可</Link>。清单由构建脚本从 package-lock.json 与 Cargo.lock 生成。
        </p>
      </Card>
    </div>
  );
}

export function PrivacyPage() {
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>数据处理与隐私说明</h1>
          <div className="sub">版本 {PRIVACY_VERSION}</div>
        </div>
      </div>
      <Card>
        <LegalSections sections={PRIVACY_SECTIONS} />
      </Card>
    </div>
  );
}

export function TermsPage() {
  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>许可与用户协议</h1>
          <div className="sub">版本 {TERMS_VERSION}</div>
        </div>
      </div>
      <Card>
        <LegalSections sections={TERMS_SECTIONS} />
      </Card>
    </div>
  );
}

export function NoticesPage() {
  const [query, setQuery] = useState('');
  const [ecosystem, setEcosystem] = useState('all');
  const ecosystems = useMemo(() => ['all', ...new Set(NOTICES.map((item) => item.ecosystem))], []);
  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return NOTICES.filter((item) => {
      if (ecosystem !== 'all' && item.ecosystem !== ecosystem) return false;
      if (!keyword) return true;
      return item.name.toLowerCase().includes(keyword) || item.license.toLowerCase().includes(keyword);
    });
  }, [query, ecosystem]);
  const unknown = NOTICES.filter((item) => item.license === 'UNKNOWN').length;

  return (
    <div className="page narrow">
      <div className="page-head">
        <div>
          <h1>第三方许可</h1>
          <div className="sub">共 {NOTICE_COUNT} 项；由 package-lock.json 与 Cargo.lock 生成</div>
        </div>
      </div>
      <Card>
        <div className="stack">
          <div className="row wrap">
            <Field label="搜索">
              <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="组件名或许可证" />
            </Field>
            <Field label="来源">
              <Select value={ecosystem} onChange={(event) => setEcosystem(event.target.value)}>
                {ecosystems.map((item) => (
                  <option key={item} value={item}>
                    {item === 'all' ? '全部' : item}
                  </option>
                ))}
              </Select>
            </Field>
            <div style={{ alignSelf: 'flex-end' }}>
              <Badge tone={unknown ? 'warn' : 'ok'}>
                {filtered.length} 项{unknown ? ` · ${unknown} 项未声明许可证` : ''}
              </Badge>
            </div>
          </div>
          <div className="notice-table" role="table" aria-label="第三方许可清单">
            {filtered.map((item) => (
              <div className="notice-row" role="row" key={`${item.ecosystem}:${item.name}@${item.version}`}>
                <span className="mono">{item.name}</span>
                <span className="mono dim">{item.version}</span>
                <span>{item.license}</span>
                <span className="dim">{item.ecosystem}</span>
              </div>
            ))}
            {!filtered.length ? <div className="empty">没有匹配的组件。</div> : null}
          </div>
        </div>
      </Card>
    </div>
  );
}
