/** Structural subset of DSH's public ToolCallBlock; no browser runtime is imported. */
export type ActionToolBlock =
  | {
      name: string;
      argsRaw: string;
    }
  | {
      kind: 'tool-result';
      call: { name: string; argsRaw: string } | null;
      content: readonly { type: string; text?: string }[];
      isError: boolean;
    };

export type ActionCardState = 'running' | 'completed' | 'committed' | 'rejected' | 'error' | 'unknown';
export interface ActionCardModel {
  state: ActionCardState;
  action: string | null;
  subject?: string;
  summary?: string;
  reason?: string;
  callRaw: string;
  resultRaw: string | null;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function json(text: string): Record<string, unknown> | undefined {
  try {
    return object(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' && !value.includes('\0') ? value : undefined;
}

/** Display only the settled receipt already recorded by DSH, without executing or admitting anything. */
export function actionCardModel(block: ActionToolBlock): ActionCardModel {
  const settled = 'kind' in block;
  const call = settled ? block.call : block;
  const callRaw = call?.argsRaw ?? '';
  const args = json(callRaw);
  const action = call?.name === 'arc_act' ? object(args?.action) : undefined;
  const actionType = text(action?.type) ?? null;
  const subject = text(action?.key) ?? text(action?.id) ?? text(action?.query);
  const model: ActionCardModel = {
    state: 'running',
    action: actionType,
    callRaw,
    resultRaw: null,
    ...(subject ? { subject } : {}),
  };
  if (!settled) return model;

  const resultText =
    block.content.length === 1 && block.content[0]?.type === 'text' ? block.content[0].text : undefined;
  model.resultRaw = resultText ?? JSON.stringify(block.content, null, 2);
  const receipt = resultText === undefined ? undefined : json(resultText);
  if (block.isError !== false) {
    model.state = 'error';
    model.reason = text(receipt?.reason) ?? text(resultText);
    return model;
  }
  model.reason = text(receipt?.reason);
  if (receipt?.status === 'rejected') {
    model.state = 'rejected';
    return model;
  }
  if (call?.name !== 'arc_act' || receipt?.status !== 'committed' || !text(receipt.proposalId)) {
    model.state = 'unknown';
    return model;
  }
  const summary = text(action?.summary);
  if (actionType === 'finish') {
    // A valid call or a success-looking result alone never constitutes completion.
    const finishShape = action && Object.keys(action).every((key) => key === 'type' || key === 'summary');
    if (finishShape && summary && receipt.sessionStatus === 'completed') {
      model.state = 'completed';
      model.summary = summary;
    } else model.state = 'unknown';
    return model;
  }
  model.state = 'committed';
  return model;
}
