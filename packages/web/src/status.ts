import type { ArcDshController } from '../../dsh/src/index.js';
import type { ArcWebStatus } from './types.js';

/** Reads current host-owned state without preparing, verifying or committing an invocation. */
export function readArcWebStatus(controller: ArcDshController): ArcWebStatus {
  const runtime = controller.runtime;
  const contract = runtime.contract;
  const tasks = runtime.listSessions();
  const pending = runtime.listContractProposals().filter((proposal) => proposal.status === 'pending');
  return {
    product: 'ARC',
    mode: controller.mode,
    workspaceRoot: controller.workspaceRoot ?? null,
    runtime: structuredClone(runtime.config),
    contract: structuredClone(contract),
    pendingProposals: pending
      .slice(-50)
      .reverse()
      .map((proposal) => ({
        id: proposal.id,
        baseVersion: proposal.baseVersion,
        candidateVersion: proposal.contract.version,
        createdAt: proposal.createdAt,
        stale: proposal.baseVersion !== contract.version,
      })),
    pendingProposalsTruncated: pending.length > 50,
    counts: {
      tasks: tasks.length,
      activeTasks: tasks.filter((task) => task.status === 'active').length,
      completedTasks: tasks.filter((task) => task.status === 'completed').length,
      pendingProposals: pending.length,
    },
    invocationScope: 'current-process',
    recentInvocations: controller.recentInvocations().map((invocation) => ({
      ...invocation,
      staleContract: invocation.contractVersion !== contract.version,
    })),
  };
}
