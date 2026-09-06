import type { DomainContract, RuntimeConfig } from '../../core/src/types.js';

export interface ArcWebPendingProposal {
  id: string;
  baseVersion: number;
  candidateVersion: number;
  createdAt: string;
  stale: boolean;
}

/** A recorded admission from this process; reading it does not revalidate a certificate. */
export interface ArcWebRecentInvocation {
  dshSessionId: string;
  taskId: string;
  step: number;
  viewBytes: number;
  budgetBytes: number;
  certificateId: string;
  contractVersion: number;
  staleContract: boolean;
}

/** Read-only, authenticated product information; never includes task or observation text. */
export interface ArcWebStatus {
  product: 'ARC';
  mode: 'context' | 'governed';
  workspaceRoot: string | null;
  runtime: RuntimeConfig;
  contract: DomainContract;
  pendingProposals: ArcWebPendingProposal[];
  pendingProposalsTruncated: boolean;
  counts: {
    tasks: number;
    activeTasks: number;
    completedTasks: number;
    pendingProposals: number;
  };
  invocationScope: 'current-process';
  recentInvocations: ArcWebRecentInvocation[];
}
