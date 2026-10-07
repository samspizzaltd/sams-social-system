import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';

// ---------- shared bits ----------

export function Stat({ label, value, hint }) {
  return (
    <div className="cp-stat">
      <div className="cp-stat-value">{value === null || value === undefined ? '—' : value}</div>
      <div className="cp-stat-label">{label}</div>
      {hint ? <div className="cp-stat-hint">{hint}</div> : null}
    </div>
  );
}

export function ErrorBox({ error }) {
  if (!error) return null;
  return <div className="cp-error">{String(error)}</div>;
}

export function Loading() {
  return <div className="cp-loading">Loading…</div>;
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : n);
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—');

// ---------- Dashboard / Overview ----------

export function Overview({ goTo }) {
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      api.get('/api/overview'),
      api.get('/api/system')
    ])
      .then(([o, h]) => { setData(o.data); setHealth(h.data); })
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!data || !health) return <Loading />;

  const h = data.history;
  return (
    <div>
      <div className="cp-stat-row">
        <Stat label="Cycles completed" value={h ? fmt(h.cyclesCompleted) : '—'} />
        <Stat label="Posts published" value={h ? fmt(h.totalPostsPublished) : '—'} />
        <Stat label="Total engagement" value={h ? fmt(h.totalEngagement) : '—'} />
        <Stat label="Revenue recorded" value={data.revenueTotal !== null ? `₾ ${fmt(data.revenueTotal)}` : '—'} />
        <Stat label="Awaiting approval" value={data.pendingContent} />
      </div>

      <div className="cp-card-row">
        <div className="cp-card">
          <h3>System</h3>
          <table className="cp-kv">
            <tbody>
              <tr><td>API</td><td><span className="cp-pill ok">online</span></td></tr>
              <tr><td>Content generation</td><td>
                <span className={`cp-pill ${health.contentGeneration === 'claude' ? 'ok' : 'warn'}`}>
                  {health.contentGeneration}
                </span>
              </td></tr>
              <tr><td>Persistence</td><td>
                <span className={`cp-pill ${health.persistence === 'mysql' ? 'ok' : 'warn'}`}>
                  {health.persistence}
                </span>
              </td></tr>
              <tr><td>Claude calls (this process)</td><td>
                {health.claude ? `${health.claude.calls} calls, ${health.claude.failures} failures` : '—'}
              </td></tr>
            </tbody>
          </table>
        </div>

        <div className="cp-card">
          <h3>Recent cycles</h3>
          {data.recentCycles.length === 0 ? <p className="cp-muted">No cycles stored yet.</p> : (
            <table className="cp-table">
              <thead><tr><th>#</th><th>Status</th><th>Drafts</th><th>Published</th><th>Engagement</th><th>When</th></tr></thead>
              <tbody>
                {data.recentCycles.map((c) => (
                  <tr key={c.id}>
                    <td>{c.cycle_number}</td>
                    <td><span className={`cp-pill ${c.status === 'completed' ? 'ok' : 'err'}`}>{c.status}</span></td>
                    <td>{c.drafts_approved}/{c.drafts_created}</td>
                    <td>{c.posts_published}</td>
                    <td>{fmt(c.total_engagement)}</td>
                    <td>{fmtDate(c.started_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <button className="cp-btn" onClick={() => goTo('cycles', 'run')}>Run a new cycle →</button>
        </div>
      </div>
    </div>
  );
}

// ---------- Content Studio ----------

export function ContentSection({ status }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(0);

  const load = useCallback(() => {
    api.get(`/api/content?status=${status}`)
      .then((r) => setItems(r.data.content))
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const setStatus = async (id, next) => {
    setBusy(id);
    try {
      await api.post(`/api/content/${id}/status`, { status: next });
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(0);
    }
  };

  if (items === null) return error ? <ErrorBox error={error} /> : <Loading />;

  return (
    <div className="cp-content-list">
      <ErrorBox error={error} />
      {items.length === 0 && <p className="cp-muted">Nothing here yet. Content appears after a cycle runs.</p>}
      {items.map((c) => (
        <div className="cp-card cp-content-item" key={c.id}>
          <div className="cp-content-head">
            <strong>{c.title || 'Untitled'}</strong>
            <span className="cp-content-meta">
              score {c.quality_score ?? '—'} · <span className={`cp-pill ${/approved/.test(c.status) ? 'ok' : c.status === 'rejected' ? 'err' : 'warn'}`}>{c.status}</span>
            </span>
          </div>
          <p className="cp-caption">{c.caption}</p>
          <div className="cp-content-actions">
            <span className="cp-muted">{fmtDate(c.created_at)}</span>
            {!/approved/.test(c.status) && (
              <button className="cp-btn small" disabled={busy === c.id} onClick={() => setStatus(c.id, 'approved')}>Approve</button>
            )}
            {c.status !== 'rejected' && (
              <button className="cp-btn small ghost" disabled={busy === c.id} onClick={() => setStatus(c.id, 'rejected')}>Reject</button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

// ---------- Autonomous Cycles ----------

function PhaseBlock({ name, data }) {
  if (!data) return null;
  return (
    <div className="cp-phase">
      <div className="cp-phase-head">
        <strong>{name}</strong>
        <span className={`cp-pill ${data.status === 'completed' ? 'ok' : 'err'}`}>{data.status}</span>
      </div>
      <pre className="cp-json">{JSON.stringify(data, null, 2)}</pre>
    </div>
  );
}

export function CyclesSection({ mode }) {
  const [history, setHistory] = useState(null);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const pollRef = useRef(null);

  const loadHistory = useCallback(() => {
    api.get('/api/history?limit=25')
      .then((r) => setHistory(r.data))
      .catch((e) => {
        // Persistence down must not block running cycles (they work in-memory).
        setHistory({ summary: null, recent: [] });
        setError(e.response?.data?.error || e.message);
      });
  }, []);

  useEffect(() => {
    loadHistory();
    // If a cycle is already running (e.g. page reloaded mid-run), resume polling.
    api.get('/api/cycle/in-progress')
      .then((r) => { if (r.data.running) beginPolling(); })
      .catch(() => {});
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const beginPolling = () => {
    setRunning(true);
    setElapsed(0);
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      setElapsed((s) => s + 5);
      try {
        const r = await api.get('/api/cycle/in-progress');
        if (!r.data.running) {
          clearInterval(pollRef.current);
          setRunning(false);
          loadHistory();
        }
      } catch { /* transient; keep polling */ }
    }, 5000);
  };

  const runCycle = async () => {
    setError(null);
    try {
      // The proxy cuts long requests at ~60s; the cycle keeps running server-side,
      // so treat timeout as "started" and poll until the running flag clears.
      beginPolling();
      await api.post('/api/cycle/run', {}, { timeout: 55000 });
      clearInterval(pollRef.current);
      setRunning(false);
      loadHistory();
    } catch (e) {
      if (e.response && e.response.status === 409) {
        // already running - polling continues
      } else if (!e.response) {
        // timeout / proxy cut - polling continues
      } else {
        clearInterval(pollRef.current);
        setRunning(false);
        setError(e.response?.data?.error || e.message);
      }
    }
  };

  const openDetail = async (id) => {
    setDetail({ loading: true });
    try {
      const r = await api.get(`/api/cycle/${id}`);
      setDetail(r.data);
    } catch (e) {
      setDetail(null);
      setError(e.response?.data?.error || e.message);
    }
  };

  if (history === null) return <Loading />;

  const phases = detail && detail.phases && typeof detail.phases === 'object' ? detail.phases : null;

  return (
    <div>
      <ErrorBox error={error} />
      {mode === 'run' && (
        <div className="cp-card cp-run-card">
          <h3>Run an autonomous cycle</h3>
          <p className="cp-muted">
            Research → create → approve → publish → analyze → optimize → monetize.
            A full run makes ~10 Claude calls and takes 2–4 minutes.
          </p>
          <button className="cp-btn" disabled={running} onClick={runCycle}>
            {running ? `Running… ${elapsed}s` : 'Run cycle now'}
          </button>
        </div>
      )}

      <div className="cp-card">
        <h3>Cycle history</h3>
        {history.summary && (
          <p className="cp-muted">
            {history.summary.cyclesCompleted} completed · {fmt(history.summary.totalEngagement)} total engagement ·
            avg {fmt(history.summary.avgEngagementPerCycle)} per cycle
          </p>
        )}
        {(!history.recent || history.recent.length === 0) ? <p className="cp-muted">No cycles yet.</p> : (
          <table className="cp-table">
            <thead><tr><th>#</th><th>Status</th><th>Duration</th><th>Drafts</th><th>Published</th><th>Engagement</th><th>When</th><th></th></tr></thead>
            <tbody>
              {history.recent.map((c) => (
                <tr key={c.id}>
                  <td>{c.cycle_number}</td>
                  <td><span className={`cp-pill ${c.status === 'completed' ? 'ok' : 'err'}`}>{c.status}</span></td>
                  <td>{c.duration_ms ? `${Math.round(c.duration_ms / 1000)}s` : '—'}</td>
                  <td>{c.drafts_approved}/{c.drafts_created}</td>
                  <td>{c.posts_published}</td>
                  <td>{fmt(c.total_engagement)}</td>
                  <td>{fmtDate(c.started_at)}</td>
                  <td><button className="cp-btn small ghost" onClick={() => openDetail(c.id)}>Detail</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {detail && (
        <div className="cp-card">
          <div className="cp-content-head">
            <h3>Cycle detail {detail.cycle_number ? `#${detail.cycle_number}` : ''}</h3>
            <button className="cp-btn small ghost" onClick={() => setDetail(null)}>Close</button>
          </div>
          {detail.loading ? <Loading /> : phases ? (
            <div>
              <PhaseBlock name="Intelligence" data={phases.intelligence} />
              <PhaseBlock name="Production" data={phases.production} />
              <PhaseBlock name="Distribution" data={phases.distribution} />
              <PhaseBlock name="Analytics" data={phases.analytics} />
              <PhaseBlock name="Optimization" data={phases.optimization} />
              <PhaseBlock name="Monetization" data={phases.monetization} />
            </div>
          ) : <p className="cp-muted">No phase data stored for this cycle.</p>}
        </div>
      )}
    </div>
  );
}
