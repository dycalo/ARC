// Keyless HTTP relay over docker exec stdio. The container has no network route
// to the provider or host; only the coordinator can forward to its budget gate.
import { createServer } from 'node:http';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const MAX_FRAME = 2 * 1024 * 1024;
const send = (stream, frame) => stream.write(JSON.stringify(frame) + '\n');

export async function serveContainerRelay() {
  const pending = new Map();
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
      response.writeHead(404).end(); return;
    }
    if (pending.size >= 4) { response.writeHead(429).end(); return; }
    const id = randomUUID();
    try {
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > 524288) throw new Error('request-too-large');
        chunks.push(chunk);
      }
      pending.set(id, response);
      response.on('close', () => { if (pending.delete(id)) send(process.stdout, { type: 'cancel', id }); });
      send(process.stdout, { type: 'request', id, authorization: request.headers.authorization ?? '', body: Buffer.concat(chunks).toString('base64') });
    } catch { response.destroy(); }
  });
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    try {
      if (line.length > MAX_FRAME) throw new Error('frame-too-large');
      const frame = JSON.parse(line);
      const response = pending.get(frame.id);
      if (!response) return;
      if (frame.type === 'headers') response.writeHead(frame.status, { 'content-type': frame.contentType, 'cache-control': 'no-store' });
      else if (frame.type === 'chunk') {
        response.write(Buffer.from(frame.body, 'base64'));
        if (response.writableLength > 8 * 1024 * 1024) response.destroy();
      } else if (frame.type === 'end') { pending.delete(frame.id); response.end(); }
      else if (frame.type === 'error') { pending.delete(frame.id); response.destroy(); }
    } catch { server.closeAllConnections(); server.close(); process.exitCode = 1; lines.close(); }
  });
  lines.on('close', () => { server.closeAllConnections(); server.close(); });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  send(process.stdout, { type: 'ready', port: server.address().port });
}

export async function attachHostRelay(child, proxyBaseUrl) {
  const endpoint = new URL(proxyBaseUrl + '/chat/completions');
  if (endpoint.hostname !== '127.0.0.1' || endpoint.protocol !== 'http:') throw new Error('Host relay requires the local budget proxy');
  const lines = createInterface({ input: child.stdout });
  const pending = new Map();
  let readyResolve, readyReject;
  const ready = new Promise((resolveReady, reject) => { readyResolve = resolveReady; readyReject = reject; });
  const timer = setTimeout(() => readyReject(new Error('Container relay did not start')), 30000);
  const stopped = () => {
    clearTimeout(timer);
    readyReject(new Error('Container relay exited'));
    for (const abort of pending.values()) abort.abort();
  };
  child.once('exit', stopped);
  child.once('error', stopped);
  child.stdin.on('error', stopped);
  lines.on('line', line => {
    let frame;
    try { if (line.length > MAX_FRAME) throw new Error(); frame = JSON.parse(line); }
    catch { child.kill(); return; }
    if (frame.type === 'ready' && Number.isSafeInteger(frame.port) && frame.port > 0 && frame.port < 65536) {
      clearTimeout(timer); readyResolve(`http://127.0.0.1:${frame.port}/v1`); return;
    }
    if (frame.type === 'cancel') { pending.get(frame.id)?.abort(); return; }
    if (frame.type !== 'request' || typeof frame.id !== 'string' || typeof frame.body !== 'string' || typeof frame.authorization !== 'string' || pending.has(frame.id)) return;
    if (pending.size >= 4) { send(child.stdin, { type: 'error', id: frame.id }); return; }
    const abort = new AbortController();
    pending.set(frame.id, abort);
    void (async () => {
      try {
        const response = await fetch(endpoint, { method: 'POST', headers: { authorization: frame.authorization, 'content-type': 'application/json' }, body: Buffer.from(frame.body, 'base64'), signal: abort.signal, redirect: 'error' });
        send(child.stdin, { type: 'headers', id: frame.id, status: response.status, contentType: response.headers.get('content-type') ?? 'application/json' });
        for await (const chunk of response.body ?? []) {
          if (!send(child.stdin, { type: 'chunk', id: frame.id, body: Buffer.from(chunk).toString('base64') })) {
            await new Promise((done, reject) => {
              const clean = () => { child.stdin.off('drain', drain); child.stdin.off('error', error); abort.signal.removeEventListener('abort', error); };
              const drain = () => { clean(); done(); };
              const error = () => { clean(); reject(new Error('relay-closed')); };
              child.stdin.once('drain', drain); child.stdin.once('error', error); abort.signal.addEventListener('abort', error, { once: true });
              if (abort.signal.aborted) error();
            });
          }
        }
        send(child.stdin, { type: 'end', id: frame.id });
      } catch { if (!child.stdin.destroyed) send(child.stdin, { type: 'error', id: frame.id }); }
      finally { pending.delete(frame.id); }
    })();
  });
  return { baseUrl: await ready, close() { stopped(); lines.close(); child.stdin.end(); child.kill(); } };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await serveContainerRelay();
