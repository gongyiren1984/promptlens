import { useState } from 'react';
import { Button, Modal } from '../../components/ui';

export const TOUR_VERSION = 1;

const STEPS: Array<{ title: string; body: string }> = [
  {
    title: '工作区',
    body: '工作区是所有项目的容器。项目会写入工作区目录并自动出现在列表中；你可以在「设置 → 全局工作区」随时切换，切换后立即生效并在下次启动时沿用。',
  },
  {
    title: '项目与提示词',
    body: '进入项目后，先在「提示词」中导入或新建提示词。每次修改都会生成不可变版本，支持变体、版本差异对比与恢复旧版本。',
  },
  {
    title: '用例与评分',
    body: '「用例」支持 CSV/JSONL 导入、AI 生成与用例库复用；「评分方案」定义维度与规则，可设置门禁与通过线，用于随后实验的自动评审。',
  },
  {
    title: '实验与运行',
    body: '在「新建实验」中配置提示词、用例集与模型组合。预检会给出试次数量与成本估算；运行页可以实时查看进度、失败原因，并对失败试次一键重试。',
  },
  {
    title: '报告与模型中心',
    body: '运行结束后会生成版本化报告，可导出 Markdown。模型配置按项目保存，凭据只用 env:/keychain: 引用；常用配置可「保存到模型库」跨项目复用。',
  },
];

export function TourOverlay({ open, onComplete }: { open: boolean; onComplete: () => void }) {
  const [index, setIndex] = useState(0);
  const step = STEPS[index];
  const last = index === STEPS.length - 1;

  return (
    <Modal
      open={open}
      title={`快速上手 ${index + 1}/${STEPS.length} · ${step.title}`}
      onClose={onComplete}
      footer={
        <>
          <Button variant="ghost" onClick={onComplete}>
            跳过引导
          </Button>
          {index > 0 ? <Button onClick={() => setIndex(index - 1)}>上一步</Button> : null}
          <Button
            variant="primary"
            onClick={() => {
              if (last) onComplete();
              else setIndex(index + 1);
            }}
          >
            {last ? '开始使用' : '下一步'}
          </Button>
        </>
      }
    >
      <div className="stack">
        <p style={{ margin: 0, lineHeight: 1.7 }}>{step.body}</p>
        <div className="row" style={{ gap: 6 }}>
          {STEPS.map((item, position) => (
            <span key={item.title} className="tour-dot" data-active={position === index ? 'true' : undefined} />
          ))}
        </div>
      </div>
    </Modal>
  );
}
