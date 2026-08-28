// Host-side HTTP API that bridges the browser panel to TeamService.
//
// Conforms to the documented `ctx.webServer.register({ method, path, handler })`
// contract: each register call returns a disposer which we chain through
// ctx.effect so it is removed automatically on plugin unload. If your DSH
// revision exposes a different signature, adjust `registerApi` only — the
// service layer is untouched.

import type { TeamService } from './service.js';

interface Route {
  method: 'GET' | 'POST';
  path: string;
  handler: (req: any, res: any) => void | Promise<void>;
}

function sendJson(res: any, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function readBody(req: any): Promise<any> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
  });
}

export function buildRoutes(service: TeamService, base: string): Route[] {
  return [
    {
      method: 'GET',
      path: `${base}/state`,
      handler: (_req, res) => sendJson(res, 200, service.snapshot()),
    },
    {
      method: 'POST',
      path: `${base}/action`,
      handler: async (req, res) => {
        const { type, payload } = await readBody(req);
        try {
          switch (type) {
            case 'createTeam':
              return sendJson(res, 200, await service.createTeam(payload));
            case 'addMember':
              return sendJson(res, 200, await service.addMember(payload.teamId, payload));
            case 'assignTask':
              return sendJson(res, 200, await service.assignTask(payload.teamId, payload));
            case 'updateTaskStatus':
              return sendJson(res, 200, await service.updateTaskStatus(payload.teamId, payload.taskId, payload.status));
            case 'createBranch':
              await service.createBranch(payload.teamId, payload.memberId, payload.branch);
              return sendJson(res, 200, { ok: true });
            case 'switchBranch':
              await service.switchBranch(payload.teamId, payload.memberId, payload.branch);
              return sendJson(res, 200, { ok: true });
            case 'mergeBranch':
              return sendJson(res, 200, await service.mergeBranch(payload.teamId, payload.memberId, payload.source));
            case 'reviewCode':
              return sendJson(res, 200, await service.reviewCode(payload.teamId, payload));
            default:
              return sendJson(res, 400, { error: `unknown action: ${type}` });
          }
        } catch (err) {
          return sendJson(res, 500, { error: (err as Error).message });
        }
      },
    },
  ];
}

/**
 * Register all routes. Returns a single disposer that tears every route down.
 * Wrap the result in `ctx.effect(...)` from the plugin entry.
 */
export function registerApi(webServer: { register(route: Route): unknown }, service: TeamService, base: string): () => void {
  const disposers = buildRoutes(service, base).map((route) => webServer.register(route));
  return () => {
    for (const d of disposers) {
      try {
        (d as (() => void) | undefined)?.();
      } catch {
        /* ignore teardown errors */
      }
    }
  };
}
