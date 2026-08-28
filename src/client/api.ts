// Client-side bridge to the host HTTP API. Mirrors the host `apiBase`
// (default /api/ai-team). Keep this in sync with src/api.ts if you change paths.

const BASE = '/api/ai-team';

export interface TeamSnapshotLite {
  id: string;
  name: string;
  leaderId?: string;
  members: Array<{ id: string; name: string; role: string; branch: string; status: string; workspacePath: string }>;
  tasks: Array<{
    id: string;
    title: string;
    description: string;
    assigneeId?: string;
    status: string;
    priority: string;
    branch?: string;
    dependsOn: string[];
    createdAt: number;
    updatedAt: number;
  }>;
  branches: string[];
  repositoryPath: string;
  updatedAt: number;
}

export interface PluginSnapshot {
  teams: TeamSnapshotLite[];
  updatedAt: number;
}

export async function fetchState(signal?: AbortSignal): Promise<PluginSnapshot> {
  const res = await fetch(`${BASE}/state`, { signal });
  if (!res.ok) throw new Error(`state request failed: ${res.status}`);
  return res.json();
}

export async function sendAction(type: string, payload: unknown): Promise<unknown> {
  const res = await fetch(`${BASE}/action`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type, payload }),
  });
  if (!res.ok) throw new Error(`action ${type} failed: ${res.status}`);
  return res.json();
}
