import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-host-webserver';
import type {} from '@deepseek-ai/dsh-client-connection';
import type {} from '../../dsh/src/index.js';
import { readArcWebStatus } from './status.js';

export type { ArcWebStatus } from './types.js';
export { readArcWebStatus } from './status.js';

export const name = 'arc-web';
export const inject = ['arc', 'webServer', 'connection'];

/** Uses the official index transform seam; dynamic session titles belong to the client plugin. */
export function brandIndex(html: string): string {
  const branded = html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>/i, '<title>ARC</title>')
    .replace(/<link\b[^>]*\brel\s*=\s*["'](?:shortcut\s+)?icon["'][^>]*>/gi, '');
  return branded.replace(
    /<\/head>/i,
    '<link rel="icon" type="image/svg+xml" href="/arc/assets/icon.svg">\n</head>',
  );
}

function jsonResponse(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

/** Installs the authenticated, read-only ARC product surface inside the official Web host. */
export function apply(ctx: Context): void {
  const assets = new Map([
    ['/arc/assets/logo.svg', readFileSync(new URL('../../../assets/arc-logo.svg', import.meta.url))],
    ['/arc/assets/icon.svg', readFileSync(new URL('../../../assets/arc-icon.svg', import.meta.url))],
  ]);
  const authorized = (request: IncomingMessage, response: ServerResponse): boolean => {
    const rejection = ctx.connection.requestRejection(request);
    if (rejection === undefined) return true;
    jsonResponse(response, rejection, { error: rejection === 401 ? 'Authentication required' : 'Forbidden' });
    return false;
  };
  ctx.effect(() => ctx.webServer.tapIndex(brandIndex), 'ARC: product title and icon');
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/arc/api/status',
        handler(request, response) {
          if (!authorized(request, response)) return;
          if (request.method !== 'GET') {
            response.setHeader('allow', 'GET');
            jsonResponse(response, 405, { error: 'This endpoint is read-only; use GET' });
            return;
          }
          jsonResponse(response, 200, readArcWebStatus(ctx.arc));
        },
      }),
    'ARC: read-only status',
  );
  for (const [path, bytes] of assets)
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'exact',
          path,
          handler(request, response) {
            if (!authorized(request, response)) return;
            if (request.method !== 'GET' && request.method !== 'HEAD') {
              response.setHeader('allow', 'GET, HEAD');
              jsonResponse(response, 405, { error: 'Use GET or HEAD for this asset' });
              return;
            }
            response.writeHead(200, {
              'content-type': 'image/svg+xml',
              'content-length': bytes.length,
              'cache-control': 'no-cache',
              'x-content-type-options': 'nosniff',
            });
            response.end(request.method === 'HEAD' ? undefined : bytes);
          },
        }),
      `ARC: ${path}`,
    );
}
