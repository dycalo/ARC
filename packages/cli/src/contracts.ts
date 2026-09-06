import { stat } from 'node:fs/promises';
import { ArcRuntime, canonical } from '../../core/src/index.js';
import { loadConfiguration, loadWorkspace, saveContractMirror } from './config.js';

export interface ContractCommand {
  workspace: string;
  operation: 'list' | 'apply' | 'reject' | 'sync';
  id?: string;
  expectedVersion?: number;
  reason?: string;
}

/** Copies a stable active contract to disk without making the mirror authoritative. */
export async function syncActiveContract(runtime: ArcRuntime, workspace: string): Promise<number> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const contract = runtime.contract;
    try {
      await saveContractMirror(workspace, contract);
    } catch (error) {
      throw new Error(`Database contract version ${runtime.contract.version} remains active, but contract.json could not be synchronized: ${error instanceof Error ? error.message : String(error)}. Repair the file or directory problem, then run arc contract sync. Do not reapply an already applied proposal.`);
    }
    if (canonical(runtime.contract) === canonical(contract)) return contract.version;
  }
  throw new Error('The active database contract kept changing during synchronization. Run arc contract sync after concurrent updates finish.');
}

/** Operator commands open existing database authority even when its disk mirror is stale. */
export async function contractCommand(options: ContractCommand): Promise<Record<string, unknown>> {
  const configuration = await loadConfiguration(options.workspace);
  let suppliedContract;
  try { await stat(configuration.databasePath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    suppliedContract = (await loadWorkspace(options.workspace)).contract;
  }
  const runtime = new ArcRuntime({ databasePath: configuration.databasePath, config: configuration.config.runtime, ...(suppliedContract === undefined ? {} : { contract: suppliedContract }) });
  try {
    if (options.operation === 'list') return { activeContract: runtime.contract, proposals: runtime.listContractProposals() };
    if (options.operation === 'sync') return { syncedVersion: await syncActiveContract(runtime, options.workspace) };
    if (!options.id) throw new Error(`arc contract ${options.operation} requires a proposal id.`);
    if (options.operation === 'reject') return { proposal: runtime.rejectContractProposal(options.id, options.reason ?? 'Rejected by the CLI operator.') };
    const candidate = runtime.listContractProposals().find(proposal => proposal.id === options.id);
    if (!candidate) throw new Error('Unknown contract proposal. Use arc contract list to inspect candidates.');
    const proposal = runtime.applyContractProposal(candidate.id, options.expectedVersion ?? candidate.baseVersion);
    return { proposal, syncedVersion: await syncActiveContract(runtime, options.workspace) };
  } finally { runtime.close(); }
}
