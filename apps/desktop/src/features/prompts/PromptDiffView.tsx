import type { PromptDiff } from '@promptlens/contracts';
import { Badge } from '../../components/ui';

export function PromptDiffView({ diff }: { diff: PromptDiff }) {
  return (
    <div className="stack">
      <div className="row small">
        <Badge tone="accent">左 {diff.left.label} v{diff.left.versionNumber}</Badge>
        <span className="mono dim">{diff.left.contentHash.slice(0, 18)}…</span>
        <span className="spacer">⇄</span>
        <Badge tone="info">右 {diff.right.label} v{diff.right.versionNumber}</Badge>
        <span className="mono dim">{diff.right.contentHash.slice(0, 18)}…</span>
        {diff.identical ? <Badge tone="ok">内容一致</Badge> : <Badge tone="warn">内容不同</Badge>}
      </div>
      <div className="diff">
        {diff.lines.map((line, index) => (
          <div key={index} className={`diff-line ${line.type}`}>
            <span className="ln">{line.leftLine ?? ''}</span>
            <span className="ln">{line.rightLine ?? ''}</span>
            <span>{line.type === 'add' ? '+' : line.type === 'remove' ? '−' : ' '}</span>
            <span>{line.line || ' '}</span>
          </div>
        ))}
      </div>
      <div className="small dim">
        对比基于行级 LCS；空行也会逐行对齐。内容哈希一致时不会产生新版本。
      </div>
    </div>
  );
}
