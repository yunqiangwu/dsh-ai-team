import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchState, sendAction, type PluginSnapshot, type TeamSnapshotLite } from './api.js';

const POLL_MS = 2500;

const panel: React.CSSProperties = {
  position: 'fixed',
  right: 16,
  bottom: 16,
  width: 380,
  maxHeight: '80vh',
  display: 'flex',
  flexDirection: 'column',
  background: '#0f1729',
  color: '#e6edf3',
  border: '1px solid #243049',
  borderRadius: 12,
  boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
  fontFamily: 'ui-sans-serif, system-ui, sans-serif',
  fontSize: 13,
  zIndex: 9999,
  overflow: 'hidden',
};

const section: React.CSSProperties = { padding: 12, borderBottom: '1px solid #1c2740' };
const btn: React.CSSProperties = {
  background: '#1f6feb',
  color: 'white',
  border: 'none',
  borderRadius: 6,
  padding: '5px 10px',
  cursor: 'pointer',
  fontSize: 12,
};
const inputStyle: React.CSSProperties = {
  background: '#0b1120',
  color: '#e6edf3',
  border: '1px solid #2a3656',
  borderRadius: 6,
  padding: '5px 8px',
  fontSize: 12,
  width: '100%',
  boxSizing: 'border-box',
};

const STATUS_COLOR: Record<string, string> = {
  idle: '#8b949e',
  busy: '#d29922',
  reviewing: '#a371f7',
  done: '#3fb950',
};

export function TeamPanel() {
  const [data, setData] = useState<PluginSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const abort = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    try {
      const snap = await fetchState(ac.signal);
      setData(snap);
      setError(null);
      setSelected((cur) => cur ?? snap.teams[0]?.id ?? null);
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), POLL_MS);
    return () => {
      clearInterval(t);
      abort.current?.abort();
    };
  }, [refresh]);

  const team: TeamSnapshotLite | undefined = data?.teams.find((t) => t.id === selected);

  return (
    <div style={panel}>
      <div style={{ ...section, display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#111c33' }}>
        <strong style={{ fontSize: 13 }}>🤝 AI Team</strong>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={{ ...btn, background: '#21262d' }} onClick={() => void refresh()}>↻</button>
          <button style={{ ...btn, background: '#21262d' }} onClick={() => setCollapsed((c) => !c)}>{collapsed ? '▢' : '—'}</button>
        </div>
      </div>

      {error && <div style={{ ...section, color: '#f85149' }}>⚠ {error}</div>}

      {!collapsed && (
        <div style={{ overflowY: 'auto' }}>
          {!data || data.teams.length === 0 ? (
            <CreateTeamForm onCreated={() => void refresh()} />
          ) : (
            <>
              <div style={section}>
                <select
                  style={inputStyle}
                  value={selected ?? ''}
                  onChange={(e) => setSelected(e.target.value)}
                >
                  {data.teams.map((t) => (
                    <option key={t.id} value={t.id}>{t.name}</option>
                  ))}
                </select>
              </div>
              {team && <TeamDetail team={team} onChanged={() => void refresh()} />}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function CreateTeamForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState('Platform Squad');
  const [members, setMembers] = useState('leader, developer, developer, reviewer');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const list = members.split(',').map((s) => s.trim()).filter(Boolean);
      await sendAction('createTeam', {
        name,
        members: list.map((role) => ({ role })),
      });
      onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={section}>
      <div style={{ marginBottom: 6, opacity: 0.8 }}>No teams yet — create one</div>
      <input style={{ ...inputStyle, marginBottom: 6 }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Team name" />
      <input style={{ ...inputStyle, marginBottom: 6 }} value={members} onChange={(e) => setMembers(e.target.value)} placeholder="roles, comma separated" />
      <button style={{ ...btn, width: '100%' }} disabled={busy} onClick={() => void submit()}>
        {busy ? 'Creating…' : 'Create team'}
      </button>
    </div>
  );
}

function TeamDetail({ team, onChanged }: { team: TeamSnapshotLite; onChanged: () => void }) {
  const [role, setRole] = useState('developer');

  const addMember = async () => {
    await sendAction('addMember', { teamId: team.id, role });
    onChanged();
  };
  const assign = async () => {
    await sendAction('assignTask', {
      teamId: team.id,
      title: 'New task',
      description: 'Describe the work for a developer.',
      assigneeRole: 'developer',
      priority: 'medium',
    });
    onChanged();
  };

  const columns: Array<{ key: string; label: string }> = [
    { key: 'todo', label: 'To do' },
    { key: 'in_progress', label: 'In progress' },
    { key: 'in_review', label: 'In review' },
    { key: 'done', label: 'Done' },
    { key: 'blocked', label: 'Blocked' },
  ];

  return (
    <div>
      <div style={section}>
        <div style={{ opacity: 0.7, marginBottom: 6 }}>Members ({team.members.length})</div>
        {team.members.map((m) => (
          <div key={m.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0' }}>
            <span>{m.name} <span style={{ opacity: 0.6 }}>· {m.role}</span></span>
            <span style={{ color: STATUS_COLOR[m.status] ?? '#8b949e' }}>{m.branch}</span>
          </div>
        ))}
        <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
          <select style={inputStyle} value={role} onChange={(e) => setRole(e.target.value)}>
            <option value="developer">developer</option>
            <option value="reviewer">reviewer</option>
            <option value="leader">leader</option>
          </select>
          <button style={btn} onClick={() => void addMember()}>+ member</button>
        </div>
      </div>

      <div style={section}>
        <div style={{ opacity: 0.7, marginBottom: 6 }}>Active branches</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {team.branches.map((b) => (
            <span key={b} style={{ background: '#16223c', padding: '2px 6px', borderRadius: 4, fontFamily: 'monospace', fontSize: 11 }}>{b}</span>
          ))}
        </div>
        <button style={{ ...btn, width: '100%', marginTop: 8 }} onClick={() => void assign()}>+ assign task</button>
      </div>

      <div style={section}>
        <div style={{ opacity: 0.7, marginBottom: 6 }}>Task board ({team.tasks.length})</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {columns.map((col) => (
            <div key={col.key} style={{ background: '#0b1120', borderRadius: 6, padding: 6 }}>
              <div style={{ fontSize: 11, opacity: 0.7, marginBottom: 4 }}>{col.label}</div>
              {team.tasks.filter((t) => t.status === col.key).map((t) => (
                <div key={t.id} style={{ background: '#16223c', borderRadius: 4, padding: '4px 6px', marginBottom: 4 }}>
                  <div>{t.title}</div>
                  <div style={{ fontSize: 10, opacity: 0.6 }}>{t.priority}</div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
