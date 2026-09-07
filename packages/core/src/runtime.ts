import { randomUUID } from 'node:crypto';
import { mkdirSync, chmodSync, lstatSync, openSync, closeSync, fchmodSync, constants } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { ArcRuntimeInterface, Certificate, CommitResult, CommittedRecord, ContractProposal, DomainContract, EvidenceRecord, Json, PreparedInvocation, PrepareOptions, Proposal, ProposalInput, RecordCommitQuery, RecordInput, Requirement, Resource, RuntimeConfig, RuntimeOptions, SessionState, View } from './types.js';
import { ArcError, canonical, clone, DEFAULT_CONFIG, DEFAULT_CONTRACT, digest, fail, integer, json, keys, object, parseConfig, parseContract, parseProposalInput, refs, string } from './validation.js';
import { verifyAdmission, type AdmittedSource } from './admission.js';
import { materialize } from './materializer.js';
import { externalRequirements, parseExternalBinding, parseExternalCompletion, parseExternalPlanInput, parseExternalResult, type ExternalAction, type ExternalBinding, type ExternalCompletion, type ExternalPlan, type ExternalPlanInput, type ExternalResultInput } from './external.js';

interface SessionRow { id: string; task: string; step: number; status: 'active' | 'completed'; active_json: string; created_at: string; updated_at: string; latest_invocation: string | null; cache_json: string | null; summary: string | null }
interface RecordRow { seq: number; session_id: string; id: string; version: number; data_json: string; deps_json: string; retired: number }
interface InvocationRow { id: string; session_id: string; data_json: string; deps_json: string; config_digest: string; snapshot_json: string; proposal_id: string | null; status: string }
interface ProposalRow { id: string; session_id: string; invocation_id: string; data_json: string; status: Proposal['status']; reason: string | null; observation_json: string | null }
interface ActiveRequirement { requirement: Requirement; expiresAtStep: number | null }
interface Cache { ids: string[]; step: number; requirementDigest: string; contractVersion: number; dependencies: Record<string, number> }
interface Snapshot { resources: Record<string, number>; recordVersions: Record<string, number>; requirements: Requirement[] }
const rank = { metadata: 0, summary: 1, full: 2 };
const scopeRank = { step: 0, window: 1, session: 2 };
const now = (): string => new Date().toISOString();
const resourceDependency = (key: string): string => `resource:${key}`;
const recordDependency = (session: string, id: string): string => `record:${canonical([session, id])}`;

/** Durable ARC state. All mutating public methods serialize through SQLite BEGIN IMMEDIATE. */
export class ArcRuntime implements ArcRuntimeInterface {
  private readonly db: DatabaseSync;
  private closed = false;

  constructor(options: RuntimeOptions) {
    string(options.databasePath, 'databasePath', 4096);
    const path = options.databasePath === ':memory:' ? ':memory:' : resolve(options.databasePath);
    if (path !== ':memory:') {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      for (const candidate of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
        try {
          const entry = lstatSync(candidate);
          if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink > 1) fail('INVALID_INPUT', 'ARC database and sidecars must be regular files without links');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      const descriptor = openSync(path, constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0), 0o600);
      try { fchmodSync(descriptor, 0o600); } finally { closeSync(descriptor); }
    }
    this.db = new DatabaseSync(path);
    try {
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        const version = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version;
        if (version > 2) fail('CONFLICT', `Database schema ${version} is newer than this ARC release`);
        this.db.exec(`
        CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, data_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS clocks (key TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version > 0));
        CREATE TABLE IF NOT EXISTS resources (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, version INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task TEXT NOT NULL, step INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active', active_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL, latest_invocation TEXT, cache_json TEXT, summary TEXT);
        CREATE TABLE IF NOT EXISTS records (seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id), id TEXT NOT NULL, version INTEGER NOT NULL, data_json TEXT NOT NULL, deps_json TEXT NOT NULL, retired INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id,id,version));
        CREATE INDEX IF NOT EXISTS records_latest ON records(session_id,id,version DESC);
        CREATE TABLE IF NOT EXISTS invocations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), data_json TEXT NOT NULL, deps_json TEXT NOT NULL, config_digest TEXT NOT NULL, snapshot_json TEXT NOT NULL, proposal_id TEXT UNIQUE, status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS proposals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), invocation_id TEXT NOT NULL UNIQUE REFERENCES invocations(id), data_json TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, observation_json TEXT);
        CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, kind TEXT NOT NULL, session_id TEXT, data_json TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS contract_proposals (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), data_json TEXT NOT NULL, status TEXT NOT NULL, reason TEXT);
        CREATE TABLE IF NOT EXISTS external_plans (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), invocation_id TEXT NOT NULL UNIQUE REFERENCES invocations(id), data_json TEXT NOT NULL, status TEXT NOT NULL);
        CREATE INDEX IF NOT EXISTS external_plans_session ON external_plans(session_id,status);
        PRAGMA user_version=2;
      `);
        const storedContract = this.meta<DomainContract>('contract');
        const contract = parseContract(options.contract ?? storedContract ?? clone(DEFAULT_CONTRACT));
        if (storedContract && canonical(contract) !== canonical(storedContract)) fail('CONTRACT_MISMATCH', 'Stored contract differs; use updateContract with its expected version');
        if (!storedContract) this.setMeta('contract', contract);
        const oldConfig = this.meta<RuntimeConfig>('config');
        const config = parseConfig({ ...(oldConfig ?? DEFAULT_CONFIG), ...options.config });
        if (!oldConfig || canonical(config) !== canonical(oldConfig)) this.setMeta('config', config);
      });
      if (path !== ':memory:') chmodSync(path, 0o600);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  get config(): RuntimeConfig { return clone(this.meta<RuntimeConfig>('config')!); }
  get contract(): DomainContract { return clone(this.meta<DomainContract>('contract')!); }

  private one<T>(sql: string, ...values: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...values) as T | undefined; }
  private all<T>(sql: string, ...values: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...values) as T[]; }
  private run(sql: string, ...values: SQLInputValue[]): void { this.db.prepare(sql).run(...values); }
  private transaction<T>(body: () => T): T {
    if (this.closed) fail('CONFLICT', 'ARC runtime is closed');
    this.db.exec('BEGIN IMMEDIATE');
    try { const value = body(); this.db.exec('COMMIT'); return value; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private meta<T>(key: string): T | undefined {
    const row = this.one<{ data_json: string }>('SELECT data_json FROM meta WHERE key=?', key);
    return row ? JSON.parse(row.data_json) as T : undefined;
  }
  private setMeta(key: string, value: unknown): void { this.run('INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET data_json=excluded.data_json', key, canonical(value)); }
  private audit(kind: string, sessionId: string | null, value: unknown): void { this.run('INSERT INTO audit(timestamp,kind,session_id,data_json) VALUES(?,?,?,?)', now(), kind, sessionId, canonical(value)); }
  private clock(key: string): number { return this.one<{ version: number }>('SELECT version FROM clocks WHERE key=?', key)?.version ?? 0; }
  private advance(key: string): number {
    const version = this.clock(key) + 1;
    integer(version, 'resource version');
    this.run('INSERT INTO clocks VALUES(?,?) ON CONFLICT(key) DO UPDATE SET version=excluded.version', key, version);
    return version;
  }
  private fresh(dependencies: Record<string, number>): boolean { return Object.entries(dependencies).every(([key, version]) => this.clock(key) === version); }
  private sessionRow(id: string): SessionRow { return this.one<SessionRow>('SELECT * FROM sessions WHERE id=?', string(id, 'sessionId')) ?? fail('NOT_FOUND', `Unknown session ${id}`); }
  private state(row: SessionRow): SessionState {
    const active = JSON.parse(row.active_json) as ActiveRequirement[];
    return { id: row.id, task: row.task, step: row.step, status: row.status, requirements: active.filter(item => item.expiresAtStep === null || item.expiresAtStep >= row.step + 1).map(item => item.requirement), createdAt: row.created_at, updatedAt: row.updated_at, ...(row.summary === null ? {} : { summary: row.summary }) };
  }
  createSession(task: string, id: string = randomUUID()): SessionState {
    string(task, 'task', 1_000_000); string(id, 'sessionId');
    return this.transaction(() => {
      if (this.one('SELECT id FROM sessions WHERE id=?', id)) fail('CONFLICT', `Session ${id} already exists`);
      const time = now();
      this.run('INSERT INTO sessions(id,task,created_at,updated_at) VALUES(?,?,?,?)', id, task, time, time);
      this.audit('session-created', id, { task });
      return this.getSession(id);
    });
  }
  getSession(sessionId: string): SessionState { return this.state(this.sessionRow(sessionId)); }
  listSessions(): SessionState[] { return this.all<SessionRow>('SELECT * FROM sessions ORDER BY created_at,id').map(row => this.state(row)); }

  private latestRecord(sessionId: string, id: string): RecordRow | undefined { return this.one<RecordRow>('SELECT * FROM records WHERE session_id=? AND id=? ORDER BY version DESC LIMIT 1', sessionId, id); }
  private recordRows(sessionId: string): RecordRow[] {
    return this.all<RecordRow>('SELECT r.* FROM records r WHERE session_id=? AND version=(SELECT max(version) FROM records x WHERE x.session_id=r.session_id AND x.id=r.id) AND retired=0 ORDER BY seq DESC', sessionId);
  }
  listRecords(sessionId: string): EvidenceRecord[] {
    const session = this.sessionRow(sessionId);
    return this.recordRows(sessionId).map(row => JSON.parse(row.data_json) as EvidenceRecord).filter(record => record.expiresAtStep === undefined || record.expiresAtStep >= session.step + 1);
  }
  observe(sessionId: string, input: RecordInput): EvidenceRecord {
    return this.transaction(() => {
      const session = this.sessionRow(sessionId);
      if (session.status !== 'active') fail('CONFLICT', 'Cannot add evidence to a completed session');
      return this.writeRecord(session, input);
    });
  }
  private writeRecord(session: SessionRow, input: RecordInput, model = false, invocation?: PreparedInvocation): EvidenceRecord {
    const obj = object(input, 'record');
    keys(obj, ['id', 'content', 'source', 'kind', 'resourceVersions', 'summary', 'ttlSteps', 'derivedFrom'], 'record');
    const id = input.id === undefined ? `evidence:${randomUUID()}` : string(input.id, 'record.id');
    if (id === 'task' || id.startsWith('resource:')) fail('INVALID_INPUT', 'Record id uses a reserved task/resource namespace');
    const kind = input.kind ?? 'observation';
    if (kind !== 'observation' && kind !== 'memory') fail('INVALID_INPUT', 'Invalid record kind');
    const resourceVersions = refs(input.resourceVersions);
    const dependencies: Record<string, number> = Object.create(null) as Record<string, number>;
    let expiresAtStep = input.ttlSteps === undefined ? undefined : session.step + integer(input.ttlSteps, 'ttlSteps', 1, 100_000);
    for (const [key, version] of Object.entries(resourceVersions)) {
      if (this.clock(resourceDependency(key)) !== version) fail('STALE_EVIDENCE', `Resource ${key} no longer has version ${version}`);
      dependencies[resourceDependency(key)] = version;
    }
    if (input.derivedFrom !== undefined) {
      if (!Array.isArray(input.derivedFrom) || input.derivedFrom.length > 1024) fail('INVALID_INPUT', 'derivedFrom must be a bounded list of record ids');
      for (const sourceId of input.derivedFrom) {
        string(sourceId, 'source record id');
        if (sourceId === id) fail('INVALID_INPUT', 'A derived record needs a distinct id from its source');
        const viewRecord = invocation?.view.records.find(record => record.id === sourceId);
        if (invocation && !viewRecord) fail('MISSING_EVIDENCE', `Memory source ${sourceId} was not admitted in this invocation`);
        const source = viewRecord
          ? this.one<RecordRow>('SELECT * FROM records WHERE session_id=? AND id=? AND version=?', session.id, sourceId, viewRecord.version)
          : this.latestRecord(session.id, sourceId);
        if (!source || source.retired) fail('MISSING_EVIDENCE', `Unknown source record ${sourceId}`);
        const sourceRecord = JSON.parse(source.data_json) as EvidenceRecord;
        if (sourceRecord.expiresAtStep !== undefined) {
          if (sourceRecord.expiresAtStep < (invocation ? session.step : session.step + 1)) fail('STALE_EVIDENCE', `Source record ${sourceId} has expired`);
          expiresAtStep = Math.min(expiresAtStep ?? sourceRecord.expiresAtStep, sourceRecord.expiresAtStep);
        }
        const sourceDeps = JSON.parse(source.deps_json) as Record<string, number>;
        if (Object.hasOwn(sourceDeps, recordDependency(session.id, id))) fail('INVALID_INPUT', 'Derived evidence cannot rewrite a transitive ancestor');
        if (!this.fresh(sourceDeps)) fail('STALE_EVIDENCE', `Source record ${sourceId} is stale`);
        Object.assign(dependencies, sourceDeps);
        Object.assign(resourceVersions, sourceRecord.resourceVersions);
      }
    }
    const old = this.latestRecord(session.id, id);
    if (model && old && (JSON.parse(old.data_json) as EvidenceRecord).kind !== 'memory') fail('CONFLICT', 'Model memory cannot overwrite an observation');
    if (kind === 'memory') {
      const currentMemory = this.listRecords(session.id).filter(record => record.kind === 'memory');
      if (!currentMemory.some(record => record.id === id) && currentMemory.length >= this.config.maxMemoryEntries) fail('LIMIT_EXCEEDED', 'Active memory entry limit reached; retire a memory first');
    }
    const version = this.advance(recordDependency(session.id, id));
    dependencies[recordDependency(session.id, id)] = version;
    const record: EvidenceRecord = { id, version, content: string(input.content, 'record.content', 1_000_000), source: string(input.source, 'record.source', 4096), kind, resourceVersions, ...(input.summary === undefined ? {} : { summary: string(input.summary, 'record.summary', 1_000_000) }), ...(expiresAtStep === undefined ? {} : { expiresAtStep }) };
    this.run('INSERT INTO records(session_id,id,version,data_json,deps_json) VALUES(?,?,?,?,?)', session.id, id, version, canonical(record), canonical(dependencies));
    this.audit('record-written', session.id, { id, version, kind });
    return clone(record);
  }
  putResource(key: string, value: Json): Resource {
    string(key, 'resource key'); const copied = json(value);
    return this.transaction(() => this.writeResource(key, copied));
  }
  private writeResource(key: string, value: Json): Resource {
    const version = this.advance(resourceDependency(key));
    this.run('INSERT INTO resources VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,version=excluded.version', key, canonical(value), version);
    this.audit('resource-written', null, { key, version });
    return { key, value: clone(value), version };
  }
  getResource(key: string): Resource | undefined {
    const row = this.one<{ value_json: string; version: number }>('SELECT value_json,version FROM resources WHERE key=?', string(key, 'resource key'));
    return row ? { key, value: JSON.parse(row.value_json) as Json, version: row.version } : undefined;
  }

  private normalize(requirements: Requirement[]): Requirement[] {
    const map = new Map<string, Requirement>();
    for (const requirement of requirements) {
      const existing = map.get(requirement.resource);
      map.set(requirement.resource, existing ? { resource: requirement.resource, required: existing.required || requirement.required, representation: rank[existing.representation] >= rank[requirement.representation] ? existing.representation : requirement.representation, scope: scopeRank[existing.scope] >= scopeRank[requirement.scope] ? existing.scope : requirement.scope } : clone(requirement));
    }
    return [...map.values()].sort((a, b) => a.resource.localeCompare(b.resource, 'en'));
  }
  private requirements(session: SessionRow, step: number): Requirement[] {
    const active = (JSON.parse(session.active_json) as ActiveRequirement[]).filter(item => item.expiresAtStep === null || item.expiresAtStep >= step).map(item => item.requirement);
    return this.normalize([...active, ...this.contract.requiredResources.map(key => ({ resource: `resource:${key}`, required: true, representation: 'full' as const, scope: 'session' as const }))]);
  }
  private compile(session: SessionRow, step: number, requiredRecords: string[], hostRequirements: Requirement[] = [], recovery = false): { view: View; dependencies: Record<string, number>; cache: Cache; refresh: PreparedInvocation['refresh'] } {
    const config = this.config;
    const requirements = this.normalize([...this.requirements(session, step), ...hostRequirements, ...requiredRecords.map(resource => ({ resource, required: true, representation: 'full' as const, scope: 'step' as const }))]);
    const records = this.recordRows(session.id);
    const available = new Map<string, AdmittedSource>();
    available.set('task', { record: { id: 'task', version: 1, content: session.task, source: 'user', kind: 'task', resourceVersions: {} }, dependencies: {} });
    for (const row of records) {
      const record = JSON.parse(row.data_json) as EvidenceRecord;
      available.set(record.id, { record, dependencies: JSON.parse(row.deps_json) as Record<string, number>, sequence: row.seq });
    }
    for (const row of this.all<{ key: string; value_json: string; version: number }>('SELECT * FROM resources ORDER BY key')) {
      available.set(`resource:${row.key}`, { record: { id: `resource:${row.key}`, version: row.version, kind: 'resource', content: row.value_json, source: 'managed-store', resourceVersions: { [row.key]: row.version } }, dependencies: { [resourceDependency(row.key)]: row.version } });
    }
    const prior = session.cache_json ? JSON.parse(session.cache_json) as Cache : undefined;
    let reason = 'reuse';
    if (recovery) reason = 'recovery';
    else if (!prior) reason = 'initial';
    else if (config.refreshPolicy === 'always') reason = 'policy';
    else if (prior.contractVersion !== this.contract.version) reason = 'contract-changed';
    else if (prior.requirementDigest !== digest(requirements)) reason = 'requirements-changed';
    else if (!this.fresh(prior.dependencies)) reason = 'stale-dependency';
    else if (step - prior.step >= config.horizon) reason = 'horizon';
    const rebuilt = reason !== 'reuse';
    const candidates = rebuilt ? [...available.keys()].filter(id => id !== 'task') : [...new Set([...records.slice(0, 8).map(row => row.id), ...prior!.ids])];
    const eligible = (entry: { record: EvidenceRecord; dependencies: Record<string, number> }): boolean => (entry.record.expiresAtStep === undefined || entry.record.expiresAtStep >= step) && this.fresh(entry.dependencies);
    const { view, dependencies } = materialize({ available: new Map([...available].map(([id, entry]) => [id, { ...entry, eligible: eligible(entry) }])), candidates, requirements, budgetBytes: config.viewBudgetBytes, optionalEvidence: config.optionalEvidence });
    return { view, dependencies, refresh: { rebuilt, reason }, cache: { ids: candidates, step: rebuilt ? step : prior!.step, requirementDigest: digest(requirements), contractVersion: this.contract.version, dependencies } };
  }
  private sourceAt(session: SessionRow, id: string, version: number): AdmittedSource | undefined {
    if (id === 'task') return version === 1 ? { record: { id: 'task', version: 1, content: session.task, source: 'user', kind: 'task', resourceVersions: {} }, dependencies: {} } : undefined;
    if (id.startsWith('resource:')) {
      const key = id.slice('resource:'.length);
      const resource = this.getResource(key);
      if (!resource || resource.version !== version) return undefined;
      return { record: { id, version, kind: 'resource', content: canonical(resource.value), source: 'managed-store', resourceVersions: { [key]: version } }, dependencies: { [resourceDependency(key)]: version } };
    }
    const row = this.one<RecordRow>('SELECT * FROM records WHERE session_id=? AND id=? AND version=?', session.id, id, version);
    if (!row || row.retired) return undefined;
    return { record: JSON.parse(row.data_json) as EvidenceRecord, dependencies: JSON.parse(row.deps_json) as Record<string, number>, sequence: row.seq };
  }
  private certifyView(session: SessionRow, step: number, view: View, requirements: Requirement[]): Record<string, number> {
    return verifyAdmission({ view, requirements, step, budgetBytes: this.config.viewBudgetBytes, optionalEvidence: this.config.optionalEvidence, source: (id, version) => this.sourceAt(session, id, version), currentVersion: key => this.clock(key) });
  }
  prepare(sessionId: string, options: PrepareOptions = {}): PreparedInvocation {
    const parsedOptions = object(options, 'prepare options');
    keys(parsedOptions, ['requiredRecords', 'observedRequirements', 'inferredRequirements'], 'prepare options');
    if (options.requiredRecords !== undefined && (!Array.isArray(options.requiredRecords) || options.requiredRecords.length > 1024)) fail('INVALID_INPUT', 'requiredRecords must be a bounded list');
    const requiredRecords = [...new Set((options.requiredRecords ?? []).map(id => string(id, 'required record id')))];
    const hostRequirements = [...externalRequirements(options.observedRequirements ?? [], 'observedRequirements'), ...externalRequirements(options.inferredRequirements ?? [], 'inferredRequirements')];
    return this.transaction(() => {
      const session = this.sessionRow(sessionId);
      if (session.status !== 'active') fail('CONFLICT', 'Session is completed');
      if (this.one("SELECT id FROM external_plans WHERE session_id=? AND status IN ('pending','unknown') LIMIT 1", sessionId)) fail('EXTERNAL_PENDING', 'Reconcile the outstanding external execution before preparing another invocation');
      const step = session.step + 1;
      const normalizedPlan = this.normalize([...this.requirements(session, step), ...hostRequirements, ...requiredRecords.map(resource => ({ resource, required: true, representation: 'full' as const, scope: 'step' as const }))]);
      let compiled: ReturnType<ArcRuntime['compile']> | undefined;
      let dependencies: Record<string, number> | undefined;
      const limit = this.config.materializationAttempts;
      for (let attempt = 0; attempt < limit; attempt++) {
        try {
          compiled = this.compile(session, step, requiredRecords, hostRequirements, attempt > 0);
          dependencies = this.certifyView(session, step, compiled.view, normalizedPlan);
          if (canonical(compiled.dependencies) !== canonical(dependencies)) fail('CERTIFICATE_INVALID', 'Compiler omitted or altered witness dependencies');
          break;
        } catch (error) {
          // Repair only candidate generation before any actor call, under this
          // unchanged SQLite snapshot. Never repair a rejected actor output.
          if (!(error instanceof ArcError) || !['CERTIFICATE_INVALID', 'MISSING_EVIDENCE', 'STALE_EVIDENCE', 'BUDGET_EXCEEDED'].includes(error.code) || attempt + 1 === limit) throw error;
          compiled = undefined;
          dependencies = undefined;
        }
      }
      if (!compiled || !dependencies) fail('CERTIFICATE_INVALID', 'No candidate passed independent admission');
      const { view, cache, refresh } = compiled;
      const id = randomUUID();
      const certificate: Certificate = { id: randomUUID(), sessionId, invocationId: id, contractVersion: this.contract.version, viewDigest: digest(view.rendered), dependencies: clone(dependencies) };
      const invocation: PreparedInvocation = { id, sessionId, step, view, certificate, refresh };
      const snapshot: Snapshot = {
        resources: Object.fromEntries(this.all<{ key: string; version: number }>('SELECT key,version FROM resources').map(row => [row.key, row.version])),
        recordVersions: Object.fromEntries(this.all<{ id: string }>('SELECT DISTINCT id FROM records WHERE session_id=?', sessionId).map(row => [row.id, this.clock(recordDependency(sessionId, row.id))])),
        requirements: normalizedPlan,
      };
      this.run("UPDATE proposals SET status='rejected',reason='superseded by a fresh invocation' WHERE session_id=? AND status='pending'", sessionId);
      this.run("UPDATE invocations SET status='superseded' WHERE session_id=? AND status='active'", sessionId);
      this.run('INSERT INTO invocations VALUES(?,?,?,?,?,?,NULL,?)', id, sessionId, canonical(invocation), canonical(dependencies), digest(this.config), canonical(snapshot), 'active');
      this.run('UPDATE sessions SET step=?,latest_invocation=?,cache_json=?,updated_at=? WHERE id=?', step, id, canonical(cache), now(), sessionId);
      this.audit('invocation-prepared', sessionId, { id, certificateId: certificate.id, costBytes: view.costBytes, refresh });
      return clone(invocation);
    });
  }
  private invocationRow(id: string): InvocationRow { return this.one<InvocationRow>('SELECT * FROM invocations WHERE id=?', string(id, 'invocationId')) ?? fail('NOT_FOUND', 'Unknown invocation'); }
  private checkInvocation(row: InvocationRow): PreparedInvocation {
    const invocation = JSON.parse(row.data_json) as PreparedInvocation;
    if (row.status !== 'active' || this.sessionRow(row.session_id).latest_invocation !== row.id) fail('CERTIFICATE_INVALID', 'Invocation has been superseded');
    if (invocation.certificate.contractVersion !== this.contract.version) fail('CONTRACT_MISMATCH', 'Contract changed after this invocation');
    if (row.config_digest !== digest(this.config)) fail('CERTIFICATE_INVALID', 'Runtime configuration changed after this invocation');
    if (!this.fresh(JSON.parse(row.deps_json) as Record<string, number>)) fail('STALE_EVIDENCE', 'An admitted evidence dependency changed');
    const expected = this.certifyView(this.sessionRow(row.session_id), invocation.step, invocation.view, (JSON.parse(row.snapshot_json) as Snapshot).requirements);
    if (canonical(expected) !== canonical(invocation.certificate.dependencies) || canonical(expected) !== row.deps_json) fail('CERTIFICATE_INVALID', 'Certificate dependencies do not match the admitted sources');
    if (Buffer.byteLength(invocation.view.rendered) > this.config.viewBudgetBytes || invocation.certificate.viewDigest !== digest(invocation.view.rendered)) fail('CERTIFICATE_INVALID', 'Stored view is invalid');
    return invocation;
  }
  verify(invocation: PreparedInvocation): void {
    const row = this.invocationRow(invocation.id);
    if (digest(invocation) !== digest(JSON.parse(row.data_json))) fail('CERTIFICATE_INVALID', 'Invocation, view or certificate was modified');
    this.checkInvocation(row);
  }
  propose(invocationId: string, raw: ProposalInput): Proposal {
    const input = parseProposalInput(raw);
    return this.transaction(() => {
      const row = this.invocationRow(invocationId);
      const invocation = this.checkInvocation(row);
      if (row.proposal_id) fail('CONFLICT', 'An invocation may seal only one proposal');
      if (!this.contract.allowedActions.includes(input.action.type)) fail('INVALID_INPUT', `Action ${input.action.type} is not allowed by this contract`);
      if (['remember', 'forget'].includes(input.action.type) && !this.contract.allowModelMemory) fail('INVALID_INPUT', 'Model memory updates are disabled');
      if (input.requirements.length > this.config.maxActiveRequirements) fail('LIMIT_EXCEEDED', 'Too many declared requirements');
      const dependencies = JSON.parse(row.deps_json) as Record<string, number>;
      const snapshot = JSON.parse(row.snapshot_json) as Snapshot;
      const resourceVersion = (key: string): number => Object.hasOwn(snapshot.resources, key) ? snapshot.resources[key]! : 0;
      for (const key of input.additionalResources ?? []) {
        if (!Object.hasOwn(snapshot.resources, key)) fail('MISSING_EVIDENCE', `Additional resource ${key} did not exist at the reasoning snapshot`);
        dependencies[resourceDependency(key)] = resourceVersion(key);
      }
      if (input.action.type === 'set') dependencies[resourceDependency(input.action.key)] = resourceVersion(input.action.key);
      for (const predicate of this.contract.preconditions) dependencies[resourceDependency(predicate.key)] = resourceVersion(predicate.key);
      if (input.action.type === 'remember') {
        input.action.id ??= `memory:${randomUUID()}`;
        dependencies[recordDependency(row.session_id, input.action.id)] = Object.hasOwn(snapshot.recordVersions, input.action.id) ? snapshot.recordVersions[input.action.id]! : 0;
        for (const [key, version] of Object.entries(input.action.resourceVersions ?? {})) {
          if (resourceVersion(key) !== version) fail('STALE_EVIDENCE', `Memory source ${key} does not match the reasoning snapshot`);
          dependencies[resourceDependency(key)] = version;
        }
        for (const id of input.action.derivedFrom ?? []) {
          const record = invocation.view.records.find(record => record.id === id);
          if (!record) fail('MISSING_EVIDENCE', `Memory source ${id} was not admitted`);
          const source = this.one<RecordRow>('SELECT * FROM records WHERE session_id=? AND id=? AND version=?', row.session_id, id, record.version);
          if (!source) fail('MISSING_EVIDENCE', `Memory source ${id} is not a stored evidence record`);
          Object.assign(dependencies, JSON.parse(source.deps_json) as Record<string, number>);
        }
      }
      if (input.action.type === 'forget') {
        const id = input.action.id;
        const record = invocation.view.records.find(record => record.id === id && record.kind === 'memory');
        if (!record) fail('MISSING_EVIDENCE', 'Only admitted model memory can be forgotten');
        dependencies[recordDependency(row.session_id, id)] = record.version;
      }
      const created = input.action.type === 'set' ? [`resource:${input.action.key}`]
        : input.action.type === 'remember' ? [input.action.id!] : [];
      this.checkRequirementReferences(row.session_id, input.requirements, created,
        input.action.type === 'forget' ? [input.action.id] : []);
      const proposal: Proposal = { id: randomUUID(), sessionId: row.session_id, invocationId, status: 'pending', action: input.action, requirements: input.requirements, dependencies };
      this.run('INSERT INTO proposals(id,session_id,invocation_id,data_json,status) VALUES(?,?,?,?,?)', proposal.id, row.session_id, invocationId, canonical(proposal), 'pending');
      this.run('UPDATE invocations SET proposal_id=? WHERE id=?', proposal.id, invocationId);
      this.audit('proposal-sealed', row.session_id, { id: proposal.id, invocationId });
      return clone(proposal);
    });
  }
  private proposalRow(id: string): ProposalRow { return this.one<ProposalRow>('SELECT * FROM proposals WHERE id=?', string(id, 'proposalId')) ?? fail('NOT_FOUND', 'Unknown proposal'); }
  getProposal(proposalId: string): Proposal {
    const row = this.proposalRow(proposalId);
    return { ...(JSON.parse(row.data_json) as Proposal), status: row.status };
  }
  getRecordCommit(sessionId: string, query: RecordCommitQuery): CommittedRecord | undefined {
    this.sessionRow(sessionId);
    const input = object(query, 'record commit query');
    keys(input, ['id', 'version', 'source'], 'record commit query');
    if (input.id === undefined && input.source === undefined) fail('INVALID_INPUT', 'Record commit query requires id or source');
    if (input.version !== undefined && input.id === undefined) fail('INVALID_INPUT', 'Record version requires id');
    const conditions = ["p.session_id=?", "p.status='committed'", "json_extract(p.data_json,'$.action.type')='remember'"];
    const values: SQLInputValue[] = [sessionId];
    for (const field of ['id', 'source'] as const) {
      if (input[field] !== undefined) {
        conditions.push(`json_extract(p.observation_json,'$.${field}')=?`);
        values.push(string(input[field], `record commit ${field}`, field === 'source' ? 4096 : 512));
      }
    }
    if (input.version !== undefined) {
      conditions.push("json_extract(p.observation_json,'$.version')=?");
      values.push(integer(input.version, 'record commit version', 1));
    }
    const row = this.one<{ proposal_json: string; invocation_json: string; observation_json: string }>(
      `SELECT p.data_json AS proposal_json,i.data_json AS invocation_json,p.observation_json
       FROM proposals p JOIN invocations i ON i.id=p.invocation_id
       WHERE ${conditions.join(' AND ')} ORDER BY json_extract(i.data_json,'$.step') DESC LIMIT 1`, ...values);
    if (!row) return undefined;
    return {
      proposal: { ...(JSON.parse(row.proposal_json) as Proposal), status: 'committed' },
      invocation: JSON.parse(row.invocation_json) as PreparedInvocation,
      record: JSON.parse(row.observation_json) as EvidenceRecord,
    };
  }
  planExternal(invocationId: string, raw: ExternalPlanInput, rawBinding: ExternalBinding): ExternalPlan {
    const input = parseExternalPlanInput(raw);
    const binding = parseExternalBinding(rawBinding);
    return this.transaction(() => {
      const row = this.invocationRow(invocationId);
      this.checkInvocation(row);
      if (row.proposal_id) fail('CONFLICT', 'An invocation may seal only one managed proposal or external plan');
      if (input.requirements.length > this.config.maxActiveRequirements) fail('LIMIT_EXCEEDED', 'Too many declared requirements');
      const snapshot = JSON.parse(row.snapshot_json) as Snapshot;
      const dependencies = JSON.parse(row.deps_json) as Record<string, number>;
      for (const key of input.additionalResources ?? []) {
        if (!Object.hasOwn(snapshot.resources, key)) fail('MISSING_EVIDENCE', `Additional resource ${key} did not exist at the reasoning snapshot`);
        dependencies[resourceDependency(key)] = snapshot.resources[key]!;
      }
      const id = randomUUID();
      const actions = input.actions.map(action => ({ ...action, recordId: `external-result:${id}:${action.id}`, status: 'pending' as const }));
      const requirements = input.requirements.map(requirement => ({ ...requirement, resource: requirement.resource.startsWith('result:')
        ? actions.find(action => action.id === requirement.resource.slice(7))!.recordId : requirement.resource }));
      this.checkRequirementReferences(row.session_id, requirements, actions.map(action => action.recordId));
      const plan: ExternalPlan = { id, sessionId: row.session_id, invocationId, binding, actions, requirements, dependencies, status: 'pending', createdAt: now() };
      this.run('INSERT INTO external_plans VALUES(?,?,?,?,?)', id, row.session_id, invocationId, canonical(plan), 'pending');
      this.run('UPDATE invocations SET proposal_id=? WHERE id=?', id, invocationId);
      this.audit('external-plan-sealed', row.session_id, { id, invocationId, binding });
      return clone(plan);
    });
  }
  getExternalPlan(planId: string): ExternalPlan {
    const row = this.one<{ data_json: string }>('SELECT data_json FROM external_plans WHERE id=?', string(planId, 'external plan id'));
    if (!row) fail('NOT_FOUND', 'Unknown external plan');
    return JSON.parse(row.data_json) as ExternalPlan;
  }
  listExternalPlans(sessionId: string): ExternalPlan[] {
    this.sessionRow(sessionId);
    return this.all<{ data_json: string }>('SELECT data_json FROM external_plans WHERE session_id=? ORDER BY rowid', sessionId).map(row => JSON.parse(row.data_json) as ExternalPlan);
  }
  private saveExternal(plan: ExternalPlan): ExternalPlan {
    this.run('UPDATE external_plans SET data_json=?,status=? WHERE id=?', canonical(plan), plan.status, plan.id);
    return clone(plan);
  }
  private checkExternal(plan: ExternalPlan): void {
    const row = this.invocationRow(plan.invocationId);
    this.checkInvocation(row);
    if (row.proposal_id !== plan.id || !this.fresh(plan.dependencies)) fail('STALE_EVIDENCE', 'External execution binding or guarded dependencies changed');
  }
  startExternalAction(planId: string, actionId: string): ExternalAction {
    string(actionId, 'external action id', 64);
    return this.transaction(() => {
      const plan = this.getExternalPlan(planId);
      if (plan.status !== 'pending') fail('CONFLICT', 'External plan is not pending');
      this.checkExternal(plan);
      const index = plan.actions.findIndex(action => action.id === actionId);
      const action = plan.actions[index];
      if (!action || action.status !== 'pending' || plan.actions.slice(0, index).some(prior => prior.status !== 'succeeded')) fail('CONFLICT', 'External actions must start once, in order, after successful preceding results');
      action.status = 'running';
      this.saveExternal(plan);
      this.audit('external-action-started', plan.sessionId, { planId, actionId });
      return clone({ id: action.id, operation: action.operation, arguments: action.arguments });
    });
  }
  recordExternalResult(planId: string, actionId: string, raw: ExternalResultInput): ExternalPlan {
    string(actionId, 'external action id', 64);
    const result = parseExternalResult(raw);
    return this.transaction(() => {
      const plan = this.getExternalPlan(planId);
      const action = plan.actions.find(action => action.id === actionId);
      if (!action) fail('NOT_FOUND', 'Unknown external action');
      if (action.result && canonical(action.result) === canonical(result)) return plan;
      if (plan.status !== 'pending' || action.status !== 'running') fail('CONFLICT', 'Only a running external action can acquire a result; recorded results cannot be replaced');
      if (this.latestRecord(plan.sessionId, action.recordId)) fail('CONFLICT', 'External result identifier already has evidence');
      // Record real outcomes even when the reasoning snapshot has since become
      // stale. Freshness is checked at dispatch and declaration settlement.
      action.observation = this.writeRecord(this.sessionRow(plan.sessionId), {
        id: action.recordId, source: `runtime:external:${plan.binding.adapter}`,
        content: result.content, ...(result.summary === undefined ? {} : { summary: result.summary }),
      });
      action.result = result;
      action.status = result.status;
      this.audit('external-action-recorded', plan.sessionId, { planId, actionId, status: result.status, recordId: action.recordId });
      return this.saveExternal(plan);
    });
  }
  completeExternal(planId: string, raw: ExternalCompletion): ExternalPlan {
    const completion = parseExternalCompletion(raw);
    return this.transaction(() => {
      const plan = this.getExternalPlan(planId);
      if (plan.status === 'committed' || plan.status === 'rejected') {
        if (completion.receiptDigest !== undefined && plan.completion?.receiptDigest !== completion.receiptDigest) fail('CONFLICT', 'The completed external receipt cannot be replaced');
        return plan;
      }
      if (plan.status === 'unknown') fail('EXTERNAL_PENDING', 'Unknown external effects require explicit host reconciliation');
      if (completion.status === 'unknown' || plan.actions.some(action => action.status === 'running' || action.status === 'unknown')) {
        plan.status = 'unknown';
        plan.reason = completion.reason ?? 'External execution has an uncertain outcome';
      } else if (completion.status === 'failed') {
        plan.status = 'rejected';
        plan.reason = completion.reason ?? 'External execution failed; its pending declaration was discarded';
      } else {
        if (plan.actions.some(action => action.status !== 'succeeded')) fail('CONFLICT', 'A successful completion requires every external result');
        this.db.exec('SAVEPOINT external_completion');
        try {
          this.checkExternal(plan);
          const session = this.sessionRow(plan.sessionId);
          for (const action of plan.actions) {
            const source = action.observation && this.sourceAt(session, action.recordId, action.observation.version);
            if (!source || !this.fresh(source.dependencies) || canonical(source.record) !== canonical(action.observation)) fail('STALE_EVIDENCE', 'An external result changed before declaration settlement');
          }
          const requirements = this.normalize([...plan.requirements, ...(completion.inferredRequirements ?? []), ...(completion.observedRequirements ?? [])]);
          // This transaction covers only ARC state. External effects occurred
          // earlier and are neither applied nor rolled back by this transition.
          this.activate(session, requirements);
          plan.status = 'committed';
          this.db.exec('RELEASE external_completion');
        } catch (error) {
          this.db.exec('ROLLBACK TO external_completion; RELEASE external_completion');
          if (!(error instanceof ArcError)) throw error;
          plan.status = 'rejected';
          plan.reason = `${error.code}: ${error.message}`;
        }
      }
      plan.completion = completion;
      this.audit('external-plan-completed', plan.sessionId, { planId, status: plan.status, reason: plan.reason ?? null });
      return this.saveExternal(plan);
    });
  }
  reconcileExternal(planId: string, reason: string): ExternalPlan {
    string(reason, 'host reconciliation reason', 16_384);
    return this.transaction(() => {
      const plan = this.getExternalPlan(planId);
      if (plan.status === 'committed' || plan.status === 'rejected') return plan;
      // The host must first stop/reconcile the external executor. Never replay
      // it, manufacture an outcome, or revive its prospective declaration.
      plan.status = 'rejected';
      plan.reason = `Host reconciliation: ${reason}`;
      this.audit('external-plan-reconciled', plan.sessionId, { planId, reason });
      return this.saveExternal(plan);
    });
  }
  private checkRequirementReferences(sessionId: string, declaration: Requirement[], created: string[] = [], removed: string[] = []): void {
    for (const { resource, required } of declaration) {
      if (!required) continue;
      const row = this.latestRecord(sessionId, resource);
      const exists = !removed.includes(resource) && (created.includes(resource) || resource === 'task'
        || (resource.startsWith('resource:') ? this.getResource(resource.slice(9)) !== undefined : row !== undefined && !row.retired));
      if (!exists) fail('MISSING_EVIDENCE', `Required reference ${resource} cannot be resolved. Use a registered evidence id, resource:<existing key>, or a result created by this operation. File paths and result aliases from earlier operations are not evidence ids. No declaration was activated.`);
    }
  }
  private activate(session: SessionRow, declaration: Requirement[]): void {
    // Recheck after the action, inside the same settlement transaction. This
    // also covers plans sealed by an older runtime and intervening retirement.
    this.checkRequirementReferences(session.id, declaration);
    const existing = (JSON.parse(session.active_json) as ActiveRequirement[]).filter(item => item.expiresAtStep === null || item.expiresAtStep > session.step);
    const active = new Map(existing.map(item => [item.requirement.resource, item]));
    for (const requirement of declaration) {
      const expiresAtStep = requirement.scope === 'session' ? null : session.step + (requirement.scope === 'step' ? 1 : this.config.horizon);
      const old = active.get(requirement.resource);
      if (old) {
        const merged = this.normalize([old.requirement, requirement])[0]!;
        active.set(requirement.resource, { requirement: merged, expiresAtStep: old.expiresAtStep === null || expiresAtStep === null ? null : Math.max(old.expiresAtStep, expiresAtStep) });
      } else active.set(requirement.resource, { requirement, expiresAtStep });
    }
    if (active.size > this.config.maxActiveRequirements) fail('LIMIT_EXCEEDED', 'Active requirements would exceed their limit; explicitly retire an obsolete requirement');
    this.run('UPDATE sessions SET active_json=?,updated_at=? WHERE id=?', canonical([...active.values()]), now(), session.id);
  }
  private apply(session: SessionRow, proposal: Proposal, invocation: PreparedInvocation): Json {
    const action = proposal.action;
    switch (action.type) {
      case 'set': {
        if (action.expectedVersion !== undefined && (this.getResource(action.key)?.version ?? 0) !== action.expectedVersion) fail('CONFLICT', 'Action expectedVersion does not match');
        return json(this.writeResource(action.key, action.value));
      }
      case 'remember': {
        const { type: _type, ...input } = action;
        return json(this.writeRecord(session, { ...input, kind: 'memory' }, true, invocation));
      }
      case 'forget': {
        const row = this.latestRecord(session.id, action.id);
        if (!row || row.retired || (JSON.parse(row.data_json) as EvidenceRecord).kind !== 'memory') fail('MISSING_EVIDENCE', 'Memory is missing or retired');
        if (this.requirements(session, session.step + 1).some(item => item.resource === action.id && item.required)) fail('CONFLICT', 'Cannot forget required evidence; retire its requirement first');
        this.advance(recordDependency(session.id, action.id));
        this.run('UPDATE records SET retired=1 WHERE seq=?', row.seq);
        return { forgotten: action.id };
      }
      case 'finish':
        this.run("UPDATE sessions SET status='completed',summary=? WHERE id=?", action.summary, session.id);
        return { summary: action.summary };
      case 'propose_contract': {
        const current = this.contract;
        if (action.contract.id !== current.id || action.contract.version !== current.version + 1) fail('INVALID_INPUT', 'A proposed contract must retain its id and advance the current version by one');
        const candidate: ContractProposal = { id: randomUUID(), sessionId: session.id, invocationId: invocation.id, baseVersion: current.version, contract: action.contract, rationale: action.rationale, status: 'pending', createdAt: now() };
        this.run('INSERT INTO contract_proposals(id,session_id,data_json,status) VALUES(?,?,?,?)', candidate.id, session.id, canonical(candidate), 'pending');
        this.audit('contract-proposed', session.id, { id: candidate.id, baseVersion: current.version });
        return { contractProposalId: candidate.id, status: 'pending', baseVersion: current.version, message: 'Candidate stored; the active contract has not changed. A host must review and apply it.' };
      }
      case 'recall': {
        const terms = action.query.toLocaleLowerCase('en').split(/\s+/).filter(Boolean);
        const matches = this.recordRows(session.id).map(row => ({ row, record: JSON.parse(row.data_json) as EvidenceRecord }))
          .filter(({ row, record }) => record.source !== 'runtime:recall' && (record.expiresAtStep === undefined || record.expiresAtStep >= session.step + 1) && this.fresh(JSON.parse(row.deps_json) as Record<string, number>))
          .map(({ record }) => ({ record, score: terms.filter(term => `${record.id} ${record.source} ${record.content}`.toLocaleLowerCase('en').includes(term)).length }))
          .filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id, 'en')).slice(0, action.limit ?? 5).map(item => item.record);
        const result = { query: action.query, matches: matches.map(record => ({ id: record.id, version: record.version, kind: record.kind, source: record.source, excerpt: record.content.slice(0, 256) })) };
        const record = this.writeRecord(session, { id: `recall:${randomUUID()}`, content: canonical(result), source: 'runtime:recall', derivedFrom: matches.map(record => record.id), ttlSteps: 1 });
        return { ...result, resultRecordId: record.id };
      }
      case 'noop': return { reason: action.reason ?? 'No managed state change' };
    }
  }
  private rejected(row: ProposalRow, reason: string): CommitResult {
    this.run("UPDATE proposals SET status='rejected',reason=? WHERE id=? AND status='pending'", reason, row.id);
    this.audit('proposal-rejected', row.session_id, { id: row.id, reason });
    return { proposalId: row.id, status: 'rejected', reason };
  }
  commit(proposalId: string): CommitResult {
    return this.transaction(() => {
      const row = this.proposalRow(proposalId);
      if (row.status !== 'pending') return { proposalId, status: 'rejected', reason: `Proposal already ${row.status}; it cannot be applied again` };
      this.db.exec('SAVEPOINT application');
      try {
        const proposal = JSON.parse(row.data_json) as Proposal;
        const invocation = this.checkInvocation(this.invocationRow(row.invocation_id));
        const session = this.sessionRow(row.session_id);
        if (session.status !== 'active') fail('CONFLICT', 'Session is completed');
        if (!this.fresh(proposal.dependencies)) fail('STALE_EVIDENCE', 'Sealed action dependencies changed');
        const contract = this.contract;
        if (!contract.allowedActions.includes(proposal.action.type)) fail('CONTRACT_MISMATCH', 'Action is no longer allowed');
        for (const predicate of contract.preconditions) {
          const resource = this.getResource(predicate.key);
          const valid = predicate.op === 'exists' ? resource !== undefined : predicate.op === 'equals' ? resource !== undefined && canonical(resource.value) === canonical(predicate.value) : resource !== undefined && canonical(resource.value) !== canonical(predicate.value);
          if (!valid) fail('CONFLICT', `Live precondition failed for ${predicate.key}`);
        }
        const observation = this.apply(session, proposal, invocation);
        const inferred = proposal.action.type === 'recall' ? [{ resource: (observation as { resultRecordId: string }).resultRecordId, required: true, representation: 'full' as const, scope: 'step' as const }] : [];
        this.activate(session, [...proposal.requirements, ...inferred]);
        this.run("UPDATE proposals SET status='committed',observation_json=? WHERE id=?", canonical(observation), row.id);
        this.audit('proposal-committed', row.session_id, { id: row.id, action: proposal.action.type });
        this.db.exec('RELEASE application');
        return { proposalId, status: 'committed', observation };
      } catch (error) {
        this.db.exec('ROLLBACK TO application; RELEASE application');
        if (!(error instanceof ArcError)) throw error;
        return this.rejected(row, `${error.code}: ${error.message}`);
      }
    });
  }
  reject(proposalId: string, reason: string): CommitResult {
    string(reason, 'rejection reason', 16_384);
    return this.transaction(() => {
      const row = this.proposalRow(proposalId);
      if (row.status !== 'pending') return { proposalId, status: 'rejected', reason: `Proposal already ${row.status}` };
      return this.rejected(row, reason);
    });
  }
  updateContract(raw: DomainContract, expectedVersion: number): void {
    const contract = parseContract(raw); integer(expectedVersion, 'expectedVersion');
    this.transaction(() => {
      const previous = this.contract;
      if (previous.version !== expectedVersion) fail('CONFLICT', 'Contract version changed');
      if (contract.id !== previous.id || contract.version !== expectedVersion + 1) fail('INVALID_INPUT', 'Contract id must remain stable and its version must advance by one');
      this.setMeta('contract', contract);
      this.audit('contract-updated', null, { id: contract.id, from: expectedVersion, to: contract.version });
    });
  }
  listContractProposals(sessionId?: string): ContractProposal[] {
    if (sessionId !== undefined) this.sessionRow(sessionId);
    const rows = sessionId === undefined
      ? this.all<{ data_json: string; status: ContractProposal['status']; reason: string | null }>('SELECT data_json,status,reason FROM contract_proposals ORDER BY rowid')
      : this.all<{ data_json: string; status: ContractProposal['status']; reason: string | null }>('SELECT data_json,status,reason FROM contract_proposals WHERE session_id=? ORDER BY rowid', sessionId);
    return rows.map(row => ({ ...(JSON.parse(row.data_json) as ContractProposal), status: row.status, ...(row.reason === null ? {} : { reason: row.reason }) }));
  }
  private contractCandidate(id: string): ContractProposal {
    string(id, 'contract proposal id');
    return this.listContractProposals().find(candidate => candidate.id === id) ?? fail('NOT_FOUND', 'Unknown contract proposal');
  }
  applyContractProposal(id: string, expectedVersion: number): ContractProposal {
    integer(expectedVersion, 'expected contract version');
    return this.transaction(() => {
      const candidate = this.contractCandidate(id);
      if (candidate.status !== 'pending') fail('CONFLICT', `Contract proposal is already ${candidate.status}`);
      const current = this.contract;
      if (current.version !== expectedVersion || candidate.baseVersion !== expectedVersion) fail('CONFLICT', 'The contract proposal is based on a different active version');
      const contract = parseContract(candidate.contract);
      if (contract.id !== current.id || contract.version !== expectedVersion + 1) fail('INVALID_INPUT', 'Invalid proposed contract version');
      this.setMeta('contract', contract);
      this.run("UPDATE contract_proposals SET status='applied' WHERE id=?", id);
      this.audit('contract-applied', candidate.sessionId, { id, from: expectedVersion, to: contract.version });
      return { ...candidate, status: 'applied' };
    });
  }
  rejectContractProposal(id: string, reason: string): ContractProposal {
    string(reason, 'rejection reason', 16_384);
    return this.transaction(() => {
      const candidate = this.contractCandidate(id);
      if (candidate.status !== 'pending') fail('CONFLICT', `Contract proposal is already ${candidate.status}`);
      this.run("UPDATE contract_proposals SET status='rejected',reason=? WHERE id=?", reason, id);
      this.audit('contract-proposal-rejected', candidate.sessionId, { id, reason });
      return { ...candidate, status: 'rejected', reason };
    });
  }
  retireRequirement(sessionId: string, resource: string): void {
    string(resource, 'requirement resource');
    this.transaction(() => {
      const session = this.sessionRow(sessionId);
      if (this.contract.requiredResources.some(key => `resource:${key}` === resource) || resource === 'task') fail('CONFLICT', 'A domain obligation cannot be retired as a task requirement');
      const active = (JSON.parse(session.active_json) as ActiveRequirement[]).filter(item => item.requirement.resource !== resource);
      this.run('UPDATE sessions SET active_json=?,cache_json=NULL,updated_at=? WHERE id=?', canonical(active), now(), sessionId);
      this.run("UPDATE invocations SET status='superseded' WHERE session_id=? AND status='active'", sessionId);
      this.audit('requirement-retired', sessionId, { resource });
    });
  }
  close(): void { if (!this.closed) { this.db.close(); this.closed = true; } }
}
