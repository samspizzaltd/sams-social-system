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

// Two-tap confirmation that lives IN the page - never window.confirm().
// Browser dialogs can be suppressed ("don't show again" checkbox), after
// which confirm() silently answers No forever and buttons look dead
// (exactly what happened to the owner on 2026-10-13).
// First tap arms the button and shows confirmLabel; second tap within 5s
// fires onConfirm; doing nothing disarms it.
export function ConfirmButton({ label, confirmLabel, onConfirm, className = 'cp-btn small', disabled }) {
  const [armed, setArmed] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const click = () => {
    if (!armed) {
      setArmed(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setArmed(false), 5000);
      return;
    }
    clearTimeout(timerRef.current);
    setArmed(false);
    onConfirm();
  };
  return (
    <button
      type="button"
      className={className + (armed ? ' cp-armed' : '')}
      disabled={disabled}
      onClick={click}
    >
      {armed ? (confirmLabel || 'Tap again to confirm') : label}
    </button>
  );
}

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : n);
const fmtDate = (d) => {
  if (!d) return '—';
  const t = new Date(String(d).replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleString();
};

// ---------- Autopilot master switch ----------

export const PLATFORM_NAME = { instagram: 'Instagram', facebook_page: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube' };

// Epoch ms -> "Fri 19:00" in the viewer's clock (the owner is in Tbilisi).
export const fmtSlot = (ms) => {
  if (!ms) return 'as soon as possible';
  const d = new Date(Number(ms));
  return d.toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

const ago = (s) => (s === null || s === undefined ? null
  : s < 90 ? 'just now' : s < 3600 ? Math.round(s / 60) + ' min ago' : Math.round(s / 3600) + ' h ago');

// Small always-visible indicator for the top bar.
export function AutopilotPill({ onClick }) {
  const [on, setOn] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api.get('/api/autopilot')
      .then((r) => { if (alive) setOn(!!r.data.enabled); })
      .catch(() => { if (alive) setOn(null); });
    load();
    const t = setInterval(load, 30000);
    window.addEventListener('autopilot-changed', load);
    return () => { alive = false; clearInterval(t); window.removeEventListener('autopilot-changed', load); };
  }, []);
  return (
    <button type="button" className={'cp-ap-pill ' + (on ? 'on' : 'off')} onClick={onClick}
      title="Open the Dashboard to switch the system on or off">
      <span className="dot" />
      {on === null ? 'System: unknown' : on ? 'System ON · publishing' : 'System OFF'}
    </button>
  );
}

function ApStep({ n, label, onClick }) {
  const body = (<><b>{n === null || n === undefined ? '—' : n}</b><span>{label}</span></>);
  return onClick
    ? <button type="button" className="cp-ap-step link" onClick={onClick}>{body}</button>
    : <div className="cp-ap-step">{body}</div>;
}

// The big ON/OFF switch on the Dashboard, with what the system is doing.
export function AutopilotCard({ goTo }) {
  const [ap, setAp] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get('/api/autopilot')
      .then((r) => { setAp(r.data); setError(null); })
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 20000);
    return () => clearInterval(t);
  }, [load]);

  const toggle = async () => {
    if (!ap) return;
    setBusy(true); setError(null);
    try {
      const r = await api.put('/api/autopilot', { enabled: !ap.enabled });
      setAp(r.data);
      window.dispatchEvent(new Event('autopilot-changed'));
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!ap) {
    return (
      <div className="cp-card cp-ap-card off">
        {error ? <ErrorBox error={'Could not read the system switch: ' + error} /> : <Loading />}
      </div>
    );
  }

  const c = ap.counts || {};
  const on = !!ap.enabled;
  const slots = (ap.settings && ap.settings.publish_slots ? ap.settings.publish_slots : []).join(' and ');
  const publisherOk = ap.publisher_last_tick_s !== null && ap.publisher_last_tick_s < 120;
  const workerSeen = ago(ap.worker_last_seen_s);
  const workerOk = ap.worker_last_seen_s !== null && ap.worker_last_seen_s < 180;
  const preparing = (c.preparing || 0) + (c.analysed_waiting || 0);
  // Connected platforms that do not show this system's posts publicly yet
  // (TikTok / YouTube before their app reviews) - their posts wait.
  const waitingNames = (ap.waiting_platforms || []).map((p) => PLATFORM_NAME[p] || p);
  const waitingPosts = Object.entries(c.waiting_route || {}).filter(([, n]) => n > 0);
  const publicNames = (ap.connected || []).filter((p) => !(ap.waiting_platforms || []).includes(p))
    .map((p) => (PLATFORM_NAME[p] || p) + (ap.routes && ap.routes[p] === 'drafts' ? ' (via your drafts)' : ''));

  return (
    <div className={'cp-card cp-ap-card ' + (on ? 'on' : 'off')}>
      <div className="cp-ap-head">
        <button type="button" className={'cp-switch' + (on ? ' on' : '')} onClick={toggle} disabled={busy}
          aria-pressed={on} aria-label="Switch the system on or off">
          <span className="cp-switch-label">{on ? 'ON' : 'OFF'}</span>
        </button>
        <div>
          <div className="cp-ap-state">
            {on ? 'System is ON - active and publishing' : 'System is OFF - nothing is being published'}
          </div>
          <div className="cp-ap-sub">
            {on
              ? 'Your library videos are being prepared (captions written from the video, branded edit, sounds circulated) and land in the Publish Queue for your approval. Approved posts go out at ' + (slots || 'the posting slots') + ' Tbilisi time.'
              : 'Nothing new is prepared and nothing goes out. Posts you approve wait in the queue until you switch it on. (An upload that already started finishes - TikTok and YouTube cannot call one back.)'}
          </div>
        </div>
      </div>
      <ErrorBox error={error} />

      <div className="cp-ap-steps">
        <ApStep n={c.library_waiting} label="new videos in the library" onClick={() => goTo('media', 'library')} />
        <ApStep n={preparing} label="being prepared" onClick={() => goTo('media', 'library')} />
        <ApStep n={c.awaiting_review} label="waiting for your approval" onClick={() => goTo('media', 'publish')} />
        <ApStep n={c.scheduled} label={ap.next_up ? 'scheduled - next ' + fmtSlot(ap.next_up.scheduled_at) : 'scheduled to publish'} onClick={() => goTo('media', 'publish')} />
        <ApStep n={c.published_24h} label="published in the last 24 h" />
      </div>

      <div className="cp-ap-health">
        <span className={'cp-pill ' + (publisherOk ? 'ok' : 'err')}>
          Publisher {publisherOk ? 'running' : 'not running'}
        </span>
        <span className={'cp-pill ' + (workerOk ? 'ok' : 'warn')}>
          Video worker on your PC: {workerSeen ? 'seen ' + workerSeen : 'not seen since the server restarted'}
        </span>
        <span className={'cp-pill ' + (ap.claude ? 'ok' : 'warn')}>
          Captions: {ap.claude ? 'written by Claude' : 'templates (Claude offline)'}
        </span>
        <span className={'cp-pill ' + (publicNames.length ? 'ok' : 'err')}>
          Posting publicly to: {publicNames.length ? publicNames.join(', ') : 'nothing yet'}
        </span>
        {waitingNames.length > 0 && (
          <span className="cp-pill warn">Waiting for public posting: {waitingNames.join(', ')}</span>
        )}
        <span className="cp-pill ok">Sounds in circulation: {c.sounds_circulating === null ? '—' : c.sounds_circulating}</span>
      </div>

      {on && !workerOk && (c.library_waiting > 0 || preparing > 0) && (
        <p className="cp-muted" style={{ marginTop: 10 }}>
          New videos are prepared by the video worker on your PC - start it to let them through:
          <code> cd D:\Projects\sams-social-system\video &amp;&amp; node render-worker.mjs --watch</code>
        </p>
      )}
      {waitingNames.length > 0 && (
        <p className="cp-muted" style={{ marginTop: 10 }}>
          {waitingNames.join(' and ')} {waitingNames.length > 1 ? 'do' : 'does'} not allow public posts from this system yet
          (each platform has to approve the posting app first).
          {waitingPosts.length > 0 && (
            <> Approved posts waiting here: {waitingPosts.map(([p, n]) => n + ' ' + (PLATFORM_NAME[p] || p)).join(', ')} - nothing is lost; they go out as soon as {waitingNames.length > 1 ? 'those platforms allow it' : 'it allows it'}.</>
          )}
        </p>
      )}
      {c.in_drafts > 0 && (
        <p className="cp-muted" style={{ marginTop: 8 }}>
          <button type="button" className="cp-btn small" onClick={() => goTo('media', 'publish')}>
            {c.in_drafts} in your TikTok drafts
          </button>{' '}
          Open TikTok, paste the caption (Publish Queue → Needs you → Copy caption) and post {c.in_drafts === 1 ? 'it' : 'them'}.
        </p>
      )}
      {ap.activity && (
        <p className="cp-muted" style={{ marginTop: 8 }}>Latest: {ap.activity.text} ({fmtDate(ap.activity.at)})</p>
      )}
      {c.failed > 0 && (
        <p className="cp-muted" style={{ marginTop: 4 }}>
          {c.failed} video{c.failed === 1 ? '' : 's'} could not be prepared - see Media Library for the reason and "Prepare again".
        </p>
      )}
    </div>
  );
}

// ---------- Dashboard / Overview ----------

export function Overview({ goTo }) {
  const [data, setData] = useState(null);
  const [health, setHealth] = useState(null);
  const [realPublished, setRealPublished] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      api.get('/api/overview'),
      api.get('/api/system')
    ])
      .then(([o, h]) => { setData(o.data); setHealth(h.data); })
      .catch((e) => setError(e.response?.data?.error || e.message));
    // The only numbers that reflect the real accounts come from the publish
    // queue - the cycle aggregates are the sandbox simulation.
    api.get('/api/publish-queue')
      .then((r) => setRealPublished(r.data.queue.filter((q) => q.status === 'published').length))
      .catch(() => setRealPublished(null));
  }, []);

  if (error) return <div><AutopilotCard goTo={goTo} /><ErrorBox error={error} /></div>;
  if (!data || !health) return <div><AutopilotCard goTo={goTo} /><Loading /></div>;

  const h = data.history;
  return (
    <div>
      <AutopilotCard goTo={goTo} />
      <div className="cp-stat-row">
        <Stat label="Cycles completed" value={h ? fmt(h.cyclesCompleted) : '—'} />
        <Stat label="REAL posts published" value={realPublished === null ? '—' : fmt(realPublished)}
          hint="via the publish queue, with your approval" />
        <Stat label="Simulated posts" value={h ? fmt(h.totalPostsPublished) : '—'}
          hint="demo numbers from cycle sandbox runs - nothing was posted" />
        <Stat label="Simulated engagement" value={h ? fmt(h.totalEngagement) : '—'}
          hint="demo numbers, not from your real accounts" />
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
          <p className="cp-muted">
            "Published" and "Engagement" here are the cycle sandbox simulation, not your
            real accounts. Real posting happens only in Media &amp; Publishing → Publish Queue.
          </p>
          {data.recentCycles.length === 0 ? <p className="cp-muted">No cycles stored yet.</p> : (
            <table className="cp-table">
              <thead><tr><th>#</th><th>Status</th><th>Drafts</th><th>Published (sim.)</th><th>Engagement (sim.)</th><th>When</th></tr></thead>
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

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';
const BEAT_LABEL = { hook: 'Hook', body: 'Scene', cta: 'Call to action' };

// Everything about one draft, so the owner judges the real thing before
// approving: the shooting script beat by beat, and any video rendered from it
// (or a button to render one from library footage via the PC render worker).
function ContentReview({ id }) {
  const [item, setItem] = useState(null);
  const [error, setError] = useState(null);
  const [footage, setFootage] = useState([]);
  const [pick, setPick] = useState('');
  const [notice, setNotice] = useState(null);
  const pollRef = useRef(null);
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    api.get(`/api/content/${id}`)
      .then((r) => {
        if (!aliveRef.current) return;
        setItem(r.data);
        const busyRender = (r.data.renders || []).some((x) => x.status === 'queued' || x.status === 'rendering');
        clearTimeout(pollRef.current);
        if (busyRender) pollRef.current = setTimeout(load, 15000);
      })
      .catch((e) => { if (aliveRef.current) setError(e.response?.data?.error || e.message); });
  }, [id]);

  useEffect(() => {
    aliveRef.current = true;
    load();
    api.get('/api/media?kind=video')
      .then((r) => { if (aliveRef.current) setFootage(r.data.media || []); })
      .catch(() => {});
    return () => { aliveRef.current = false; clearTimeout(pollRef.current); };
  }, [load]);

  const render = async () => {
    setError(null); setNotice(null);
    try {
      await api.post('/api/render-jobs', { template: 'ScriptPromo', content_id: id, media_ids: [Number(pick)] });
      setNotice('Render queued. The render worker on your PC turns the script and this clip into a video - it appears here when done (keep the worker running).');
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  if (!item) return error ? <ErrorBox error={error} /> : <Loading />;

  let script = null;
  try { script = item.script ? JSON.parse(item.script) : null; } catch { script = null; }
  const beats = (script && script.beats) || [];
  const renders = item.renders || [];
  const done = renders.filter((r) => r.status === 'done' && r.url_path);

  return (
    <div className="cp-card" style={{ marginTop: 10, background: 'var(--cp-bg, #faf7f4)' }}>
      <ErrorBox error={error} />
      {notice && <div className="cp-success">{notice}</div>}

      <strong>Video</strong>
      {done.length ? done.map((r) => (
        <video key={r.id} controls preload="metadata" className="cp-review-video" src={API_BASE + r.url_path} />
      )) : (
        <p className="cp-muted">
          No video yet - a cycle writes the idea, caption and shooting script; the video gets rendered or filmed afterwards.
          {renders.some((r) => r.status === 'queued' || r.status === 'rendering') ? ' A render is in progress…' : ''}
          {renders.some((r) => r.status === 'failed') ? ' Last render failed: ' + String((renders.find((r) => r.status === 'failed') || {}).error || '').slice(0, 140) : ''}
        </p>
      )}

      <div className="cp-form" style={{ marginTop: 8 }}>
        <label className="cp-form-wide">Render a preview video from this script using footage
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">— pick a clip from the library —</option>
            {footage.map((m) => <option key={m.id} value={m.id}>#{m.id} {m.title || 'video'}</option>)}
          </select>
        </label>
        <button className="cp-btn small" disabled={!pick} onClick={render}>Render preview video</button>
      </div>

      <strong style={{ display: 'block', marginTop: 12 }}>Shooting script{script && script.duration ? ` (${script.duration} s)` : ''}</strong>
      {beats.length ? (
        <table className="cp-table">
          <thead><tr><th>When</th><th>Part</th><th>On screen / spoken</th></tr></thead>
          <tbody>
            {beats.map((b, i) => (
              <tr key={i}><td>{b.at}</td><td>{BEAT_LABEL[b.type] || b.type}</td><td>{b.text}</td></tr>
            ))}
          </tbody>
        </table>
      ) : <p className="cp-muted">{item.script ? String(item.script).slice(0, 600) : 'No script stored for this draft.'}</p>}

      <strong style={{ display: 'block', marginTop: 12 }}>Caption</strong>
      <p className="cp-caption">{item.caption}</p>
    </div>
  );
}

export function ContentSection({ status }) {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(0);
  const [openId, setOpenId] = useState(null);

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
          {openId === c.id && <ContentReview id={c.id} />}
          <div className="cp-content-actions">
            <span className="cp-muted">{fmtDate(c.created_at)}</span>
            <button className="cp-btn small ghost" onClick={() => setOpenId(openId === c.id ? null : c.id)}>
              {openId === c.id ? 'Close review' : 'Review'}
            </button>
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
