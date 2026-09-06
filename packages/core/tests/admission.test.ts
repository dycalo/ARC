import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, digest } from '../src/index.js';
import type { View } from '../src/types.js';
import { contract, fixture } from './helpers.js';

interface CompilerOutput {
  view: View;
  dependencies: Record<string, number>;
  cache: unknown;
  refresh: unknown;
}

type FaultyCompiler = {
  compile: (...args: unknown[]) => CompilerOutput;
};

const compilerFaults: [string, (output: CompilerOutput) => void][] = [
  ['omitted mandatory witness', (output) => {
    output.view.records = output.view.records.filter((record) => record.id !== 'resource:guard');
  }],
  ['weakened mandatory requirement plan', (output) => {
    output.view.requirements = [];
    output.view.records = output.view.records.filter((record) => record.id !== 'resource:guard');
  }],
  ['invented resource content', (output) => {
    output.view.records.find((record) => record.id === 'resource:guard')!.content = '{"authorized":false}';
  }],
  ['downgraded full evidence to metadata', (output) => {
    output.view.records.find((record) => record.id === 'resource:guard')!.content = '';
  }],
  ['false provenance authority', (output) => {
    output.view.records.find((record) => record.id === 'source-note')!.source = 'user';
  }],
  ['removed transitive dependency scope', (output) => {
    output.dependencies = {};
  }],
  ['omitted mandatory task', (output) => {
    output.view.records = output.view.records.filter((record) => record.id !== 'task');
  }],
  ['duplicated witness', (output) => {
    output.view.records.push(structuredClone(output.view.records[0]!));
  }],
  ['inflated declared byte budget', (output) => {
    output.view.budgetBytes += 1024;
  }],
];

for (const [label, introduceFault] of compilerFaults) {
  test(`independent admission rejects hash-consistent compiler output with ${label}`, (t) => {
    const { runtime } = fixture(t, { contract: contract({ requiredResources: ['guard'] }) });
    const session = runtime.createSession('Certify evidence independently of compilation');
    const guard = runtime.putResource('guard', { authorized: true });
    runtime.observe(session.id, {
      id: 'source-note', content: 'A tool observation', source: 'tool:read', resourceVersions: { guard: guard.version },
    });
    // Fault injection deliberately changes the untrusted compiler boundary, not
    // the trusted record store, normalizer, sealer, or admission verifier.
    const internal = runtime as unknown as FaultyCompiler;
    const original = internal.compile;
    let forgedDigest: string | undefined;
    internal.compile = function (...args: unknown[]): CompilerOutput {
      const output = original.apply(this, args);
      introduceFault(output);
      output.view.rendered = canonical({ format: 'arc-view-v1', records: output.view.records, requirements: output.view.requirements });
      output.view.costBytes = Buffer.byteLength(output.view.rendered, 'utf8');
      forgedDigest = digest(output.view.rendered);
      return output;
    };

    assert.throws(() => runtime.prepare(session.id));
    assert.match(forgedDigest!, /^[a-f0-9]{64}$/);
    assert.equal(runtime.getSession(session.id).step, 0);
    assert.deepEqual(runtime.getSession(session.id).requirements, []);
    assert.deepEqual(runtime.getResource('guard'), guard);

    internal.compile = original;
    const valid = runtime.prepare(session.id);
    runtime.verify(valid);
    assert.equal(valid.step, 1);
  });
}
