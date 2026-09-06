import { useEffect } from 'react';
import { actionCardModel, type ActionToolBlock, type ActionCardState } from './action-card-model.js';
import { useChinese } from './status.js';
import styles from './ActionCard.css';

/** The official keyed atomic Tool slot, dispatched by the tool's wire name. */
export const actionCardRegistration = { name: 'tool.call.toolview', key: 'arc_act' } as const;

/** Only public ToolCallOwnerProps fields are consumed; DSH owns the call lifecycle. */
export interface ActionCardProps {
  callId: string;
  toolName: string;
  block: ActionToolBlock;
  inspect?: (() => void) | undefined;
}

const ACTIONS: Record<string, [string, string]> = {
  set: ['更新受管数据', 'Update managed data'],
  remember: ['保存记忆', 'Save memory'],
  forget: ['移除记忆', 'Retire memory'],
  recall: ['查找记忆', 'Find memory'],
  propose_contract: ['提交契约提案', 'Propose a contract change'],
  noop: ['更新后续需求', 'Update next requirements'],
  finish: ['完成任务', 'Finish task'],
};
const STATES: Record<ActionCardState, [string, string]> = {
  running: ['正在执行', 'In progress'],
  completed: ['已完成', 'Completed'],
  committed: ['已提交', 'Committed'],
  rejected: ['未提交', 'Rejected'],
  error: ['执行失败', 'Failed'],
  unknown: ['结果待确认', 'Unconfirmed result'],
};
let styleUsers = 0;
let stylesheet: HTMLStyleElement | undefined;

function mountStyles(): () => void {
  if (styleUsers++ === 0) {
    stylesheet = document.createElement('style');
    stylesheet.dataset.plugin = '@dycalo/arc/action-card';
    stylesheet.textContent = styles;
    document.head.append(stylesheet);
  }
  return () => {
    if (--styleUsers === 0) {
      stylesheet?.remove();
      stylesheet = undefined;
    }
  };
}

/** Pure transcript projection: never sends a prompt or writes a session event. */
export function ActionCard({ block, callId, inspect }: ActionCardProps) {
  const zh = useChinese();
  useEffect(mountStyles, []);
  const model = actionCardModel(block);
  const language = zh ? 0 : 1;
  const complete = model.state === 'completed';
  const title = complete
    ? zh
      ? '任务完成'
      : 'Task complete'
    : (ACTIONS[model.action ?? '']?.[language] ?? (zh ? 'ARC 动作' : 'ARC action'));
  const failed = model.state === 'error' || model.state === 'rejected';
  return (
    <section
      className={`arc-action-card${complete ? ' arc-action-complete' : ''}`}
      data-arc-action-state={model.state}
      data-arc-action-id={callId}
    >
      <div className="arc-action-heading">
        <span className="arc-action-icon" aria-hidden="true">
          {complete ? '✓' : failed ? '!' : '↗'}
        </span>
        <strong>{title}</strong>
        <span className={`arc-action-state${failed ? ' arc-action-failed' : ''}`}>
          {STATES[model.state][language]}
        </span>
      </div>
      {complete && (
        <p className="arc-action-summary" data-testid="arc-completion-summary">
          {model.summary}
        </p>
      )}
      {!complete && model.subject && <p className="arc-action-subject">{model.subject}</p>}
      {model.reason && <p className="arc-action-reason">{model.reason}</p>}
      {model.state === 'committed' && model.action === 'propose_contract' && (
        <p className="arc-action-subject">
          {zh
            ? '提案已保存，等待宿主审核。当前契约保持原版本。'
            : 'Proposal recorded for host review. The active contract has not changed.'}
        </p>
      )}
      <div className="arc-action-footer">
        <details className="arc-action-details">
          <summary>{zh ? '执行详情' : 'Execution details'}</summary>
          <p>{zh ? '工具调用' : 'Tool call'}</p>
          <pre>
            {model.callRaw ||
              (zh ? '调用记录不在当前窗口中。' : 'The call record is outside the current window.')}
          </pre>
          {model.resultRaw !== null && (
            <>
              <p>{zh ? '工具结果' : 'Tool result'}</p>
              <pre>{model.resultRaw}</pre>
            </>
          )}
        </details>
        {inspect && (
          <button type="button" className="arc-action-inspect" onClick={inspect}>
            {zh ? '查看轨迹' : 'Inspect trace'}
          </button>
        )}
      </div>
    </section>
  );
}
