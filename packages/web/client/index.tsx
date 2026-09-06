import { useEffect, useId, useRef, useState, type ComponentType, type ReactNode } from 'react';
import { refreshStatus, useChinese, useStatus } from './status.js';
import { Welcome, welcomeRegistration } from './Welcome.js';
import { ActionCard, actionCardRegistration } from './ActionCard.js';
import type { ArcWebStatus } from '../src/types.js';
import styles from './styles.css';

type Dispose = () => void;
interface ClientContext {
  effect(callback: () => Dispose): unknown;
  slots: {
    inject(name: string, register: () => Generator<Dispose>): unknown;
    register<Props extends object>(
      options: { name: string; id?: string; key?: string; label?: string; order?: number; priority?: number },
      component: ComponentType<Props>,
    ): Dispose;
  };
}

export const inject = ['slots'];

function Mark({ size = 32, className }: { size?: number; className?: string }) {
  return (
    <img
      className={className}
      src="/arc/assets/icon.svg"
      alt="ARC"
      width={size}
      height={size}
      draggable={false}
    />
  );
}

function BrandName() {
  return (
    <span className="arc-wordmark" aria-label="ARC Harness">
      ARC
    </span>
  );
}

function bytes(value: number): string {
  return value.toLocaleString();
}
function compactId(value: string): string {
  return value.slice(0, 8);
}

function Metric({ label, children, detail }: { label: string; children: ReactNode; detail: string }) {
  return (
    <div className="arc-metric">
      <span>{label}</span>
      <strong>{children}</strong>
      <small>{detail}</small>
    </div>
  );
}

function Contract({ data, zh }: { data: ArcWebStatus; zh: boolean }) {
  const contract = data.contract;
  const heading = useId();
  return (
    <section className="arc-section" aria-labelledby={heading}>
      <div className="arc-section-heading">
        <h3 id={heading}>{zh ? '当前契约' : 'Active contract'}</h3>
        <span className="arc-tag">v{contract.version}</span>
      </div>
      <p className="arc-muted">
        {zh
          ? '当前工作区共享这份有效规则。新任务继承它，模型提出的修改需要宿主审核。'
          : 'New tasks inherit this workspace contract. Model-proposed changes require host review.'}
      </p>
      <div className="arc-contract-name">
        <code>{contract.id}</code>
        <span className="arc-outline-tag">{zh ? '工作区级' : 'Workspace scope'}</span>
      </div>
      <div className="arc-facts">
        <div>
          <span>{zh ? '必需资源' : 'Required resources'}</span>
          <strong>{contract.requiredResources.length}</strong>
        </div>
        <div>
          <span>{zh ? '执行前置条件' : 'Action preconditions'}</span>
          <strong>{contract.preconditions.length}</strong>
        </div>
        <div>
          <span>{zh ? '模型记忆' : 'Model memory'}</span>
          <strong>{contract.allowModelMemory ? (zh ? '允许' : 'Allowed') : zh ? '关闭' : 'Disabled'}</strong>
        </div>
      </div>
      <p className="arc-label">{zh ? '允许的受管动作' : 'Allowed managed actions'}</p>
      <div className="arc-chips">
        {contract.allowedActions.length ? (
          contract.allowedActions.map((action) => <code key={action}>{action}</code>)
        ) : (
          <span className="arc-muted">{zh ? '没有允许的动作' : 'No actions allowed'}</span>
        )}
      </div>
      <details className="arc-details">
        <summary>{zh ? '查看完整规则' : 'View complete rules'}</summary>
        <pre>{JSON.stringify(contract, null, 2)}</pre>
      </details>
    </section>
  );
}

function Panel() {
  const zh = useChinese();
  const { data, error, refreshing } = useStatus();
  const latest = data?.recentInvocations[0];
  const progress = latest ? Math.min(100, (latest.viewBytes / latest.budgetBytes) * 100) : 0;
  return (
    <div className="arc-panel" data-testid="arc-panel">
      <header className="arc-panel-heading">
        <div>
          <p className="arc-eyebrow">ARC HARNESS</p>
          <h2>{zh ? '工作区概览' : 'Workspace overview'}</h2>
        </div>
        <button
          className="arc-icon-button"
          type="button"
          onClick={() => void refreshStatus()}
          disabled={refreshing}
          aria-label={zh ? '刷新 ARC 状态' : 'Refresh ARC status'}
          title={zh ? '刷新' : 'Refresh'}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            aria-hidden="true"
          >
            <path d="M20 7v5h-5M4 17v-5h5" />
            <path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 18 17" />
          </svg>
        </button>
      </header>
      {error && (
        <div className="arc-error" role="status">
          {error === 'unauthorized'
            ? zh
              ? '连接已失效，请重新打开 ARC 的登录链接。'
              : 'Your connection has expired. Reopen the ARC sign-in link.'
            : zh
              ? '暂时无法更新状态，请稍后重试。'
              : 'Status is unavailable. Try refreshing shortly.'}
          {data && <span>{zh ? '下方为上次读取的数据。' : 'Showing the last retrieved data below.'}</span>}
        </div>
      )}
      {!data && !error && (
        <div className="arc-loading" role="status">
          <span className="arc-loading-dot" />
          {zh ? '正在读取工作区…' : 'Loading your workspace…'}
        </div>
      )}
      {data && (
        <>
          <section className="arc-workspace-card">
            <div className="arc-workspace-top">
              <Mark size={38} />
              <div>
                <strong>
                  {data.workspaceRoot?.split(/[\\/]/).filter(Boolean).at(-1) ??
                    (zh ? '自定义工作区' : 'Custom workspace')}
                </strong>
                <p>{zh ? '为持续工作保留必要上下文' : 'Keep the context your work needs'}</p>
              </div>
              <span className="arc-mode">{data.mode === 'context' ? 'Context' : 'Governed'}</span>
            </div>
            {data.workspaceRoot && (
              <code className="arc-workspace-path" title={data.workspaceRoot}>
                {data.workspaceRoot}
              </code>
            )}
            <p className="arc-mode-description">
              {data.mode === 'context'
                ? zh
                  ? '原生工具已启用，执行遵循 DSH 工具策略。'
                  : 'Native tools enabled, using DSH execution policies.'
                : zh
                  ? '仅允许 ARC 受管动作，按当前契约提交。'
                  : 'ARC-managed actions only, under the active contract.'}
            </p>
          </section>
          <div className="arc-metrics">
            <Metric label={zh ? 'View 预算' : 'View budget'} detail={zh ? 'UTF-8 字节' : 'UTF-8 bytes'}>
              {bytes(data.runtime.viewBudgetBytes)}
            </Metric>
            <Metric
              label={zh ? '需求窗口' : 'Requirement window'}
              detail={zh ? '每次调用独立认证' : 'Fresh certificate per call'}
            >
              {data.runtime.horizon}
              <em>{zh ? '次调用' : 'calls'}</em>
            </Metric>
            <Metric
              label={zh ? '活跃任务' : 'Active tasks'}
              detail={
                zh ? `${data.counts.completedTasks} 个任务已完成` : `${data.counts.completedTasks} completed`
              }
            >
              {data.counts.activeTasks}
            </Metric>
          </div>
          <section className="arc-section">
            <div className="arc-section-heading">
              <h3>{zh ? '工作上下文' : 'Working context'}</h3>
              <span className="arc-outline-tag">{data.runtime.refreshPolicy}</span>
            </div>
            {latest ? (
              <>
                <div className="arc-usage">
                  <strong>
                    {bytes(latest.viewBytes)} <small>/ {bytes(latest.budgetBytes)} bytes</small>
                  </strong>
                  <span>{progress.toFixed(1)}%</span>
                </div>
                <div
                  className="arc-progress"
                  role="meter"
                  aria-label={zh ? '最近一次 View 用量' : 'Latest View usage'}
                  aria-valuemin={0}
                  aria-valuemax={latest.budgetBytes}
                  aria-valuenow={latest.viewBytes}
                >
                  <span style={{ width: `${progress}%` }} />
                </div>
                <div className="arc-invocation-meta">
                  <span>{zh ? `第 ${latest.step} 次调用` : `Call ${latest.step}`}</span>
                  <span title={latest.certificateId}>Certificate {compactId(latest.certificateId)}</span>
                  <span>
                    {zh ? `契约 v${latest.contractVersion}` : `Contract v${latest.contractVersion}`}
                  </span>
                </div>
                {latest.staleContract && (
                  <p className="arc-warning">
                    {zh
                      ? '这次调用使用的是旧版契约。后续调用将重新准入。'
                      : 'This call used an older contract. A new call requires fresh admission.'}
                  </p>
                )}
              </>
            ) : (
              <div className="arc-empty">
                <span className="arc-empty-symbol" aria-hidden="true">
                  ↗
                </span>
                <div>
                  <strong>{zh ? '等待下一次调用' : 'Ready for the next call'}</strong>
                  <p>
                    {zh
                      ? '开始或继续一个任务后，这里会显示 View 用量。'
                      : 'Start or continue a task to see its View usage here.'}
                  </p>
                </div>
              </div>
            )}
            <p className="arc-caption">
              {zh
                ? '显示本次运行观测到的最近调用；记录不代表证书此刻仍然有效。View 字节数与完整请求大小、token 数分别计算。'
                : 'Latest call observed during this run. A recorded certificate is not a live validity check. View bytes, full request size, and tokens are measured separately.'}
            </p>
            <div className="arc-policy-row">
              <span>
                {zh ? '活跃记忆上限' : 'Memory entry limit'}
                <b>{bytes(data.runtime.maxMemoryEntries)}</b>
              </span>
              <span>
                {zh ? '活跃需求上限' : 'Requirement limit'}
                <b>{bytes(data.runtime.maxActiveRequirements)}</b>
              </span>
            </div>
          </section>
          <Contract data={data} zh={zh} />
          <section className="arc-section">
            <div className="arc-section-heading">
              <h3>{zh ? '契约修改提案' : 'Contract proposals'}</h3>
              <span className="arc-outline-tag">{data.counts.pendingProposals}</span>
            </div>
            <p className="arc-muted">
              {zh
                ? '模型可以提出修改。提案只有经过宿主审核并应用后才生效。'
                : 'The model can propose changes. They take effect only after the host reviews and applies them.'}
            </p>
            {data.pendingProposals.length ? (
              <div className="arc-proposals">
                {data.pendingProposals.map((proposal) => (
                  <div className="arc-proposal" key={proposal.id}>
                    <span>
                      <code title={proposal.id}>{compactId(proposal.id)}</code>
                      <small>
                        v{proposal.baseVersion} → v{proposal.candidateVersion}
                      </small>
                    </span>
                    <span className={proposal.stale ? 'arc-stale' : 'arc-pending'}>
                      {proposal.stale
                        ? zh
                          ? '基于旧版本'
                          : 'Outdated base'
                        : zh
                          ? '待宿主审核'
                          : 'Awaiting host review'}
                    </span>
                  </div>
                ))}
                {data.pendingProposalsTruncated && (
                  <p className="arc-caption">
                    {zh ? '仅显示最近 50 条待审提案。' : 'Showing the latest 50 pending proposals.'}
                  </p>
                )}
              </div>
            ) : (
              <div className="arc-empty arc-empty-small">
                <span className="arc-empty-symbol" aria-hidden="true">
                  ✓
                </span>
                <div>
                  <strong>{zh ? '没有待审提案' : 'No pending proposals'}</strong>
                  <p>
                    {zh ? '模型提出契约修改后会显示在这里。' : 'Proposed contract changes will appear here.'}
                  </p>
                </div>
              </div>
            )}
          </section>
          <footer className="arc-panel-footer">
            <span>{zh ? 'ARC 工作区 · 只读概览' : 'ARC workspace · Read-only overview'}</span>
            <span>{zh ? '基于 DeepSeek Harness' : 'Built with DeepSeek Harness'}</span>
          </footer>
        </>
      )}
    </div>
  );
}

function OverviewDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const zh = useChinese();
  const dialog = useRef<HTMLDialogElement>(null);
  const heading = useId();
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="arc-dialog"
      aria-labelledby={heading}
      onClose={onClose}
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="arc-dialog-top">
        <span id={heading}>
          ARC <span>{zh ? '工作区' : 'WORKSPACE'}</span>
        </span>
        <button
          className="arc-icon-button"
          type="button"
          aria-label={zh ? '关闭 ARC 概览' : 'Close ARC overview'}
          onClick={onClose}
        >
          ×
        </button>
      </div>
      {open && <Panel />}
    </dialog>
  );
}

function Footer({ wide }: { wide: boolean }) {
  const zh = useChinese();
  const { data } = useStatus();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        className={`arc-footer-button${wide ? '' : ' arc-footer-rail'}`}
        type="button"
        title={zh ? 'ARC 工作区概览' : 'ARC workspace overview'}
        aria-label={zh ? '打开 ARC 工作区概览' : 'Open ARC workspace overview'}
        onClick={() => setOpen(true)}
      >
        <Mark size={24} />
        {wide && (
          <>
            <span>{zh ? 'ARC 工作区' : 'ARC workspace'}</span>
            <span className="arc-footer-mode">{data?.mode === 'governed' ? 'G' : data ? 'C' : '·'}</span>
          </>
        )}
      </button>
      <OverviewDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function SettingsSection({ close }: { close: () => void }) {
  const [narrow, setNarrow] = useState(() => window.matchMedia('(max-width: 640px)').matches);
  useEffect(() => {
    const query = window.matchMedia('(max-width: 640px)');
    const update = (): void => setNarrow(query.matches);
    query.addEventListener('change', update);
    update();
    return () => query.removeEventListener('change', update);
  }, []);
  // The pinned DSH settings shell has a fixed-width navigation rail. Use the
  // browser's modal top layer on narrow screens, with the official close prop.
  return narrow ? <OverviewDialog open onClose={close} /> : <Panel />;
}

/** DSH still owns navigation, chat, and settings; ARC occupies declared product slots. */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = '@dycalo/arc';
    style.textContent = styles;
    document.head.append(style);
    const title = document.querySelector('title');
    const brandTitle = (): void => {
      const current = document.title;
      if (current === 'DeepSeek Harness') document.title = 'ARC';
      else if (current.endsWith(' — DeepSeek Harness'))
        document.title = current.slice(0, -' — DeepSeek Harness'.length) + ' — ARC';
    };
    const observer = new MutationObserver(brandTitle);
    if (title) observer.observe(title, { childList: true, characterData: true, subtree: true });
    brandTitle();
    return () => {
      observer.disconnect();
      style.remove();
    };
  });
  ctx.slots.inject('sidebar.brand.mark', function* () {
    yield ctx.slots.register({ name: 'sidebar.brand.mark' }, Mark);
  });
  ctx.slots.inject('sidebar.brand.name', function* () {
    yield ctx.slots.register({ name: 'sidebar.brand.name' }, BrandName);
  });
  ctx.slots.inject('conversation.hero.brand.mark', function* () {
    yield ctx.slots.register({ name: 'conversation.hero.brand.mark' }, Mark);
  });
  ctx.slots.inject('sidebar.footer.action', function* () {
    yield ctx.slots.register({ name: 'sidebar.footer.action', id: 'arc', order: 0 }, Footer);
  });
  ctx.slots.inject('settings.section', function* () {
    yield ctx.slots.register(
      { name: 'settings.section', id: 'arc', label: 'ARC', order: 5 },
      SettingsSection,
    );
  });
  ctx.slots.inject('settings.onboarding', function* () {
    yield ctx.slots.register(welcomeRegistration, Welcome);
  });
  ctx.slots.inject('tool.call.toolview', function* () {
    yield ctx.slots.register(actionCardRegistration, ActionCard);
  });
}
