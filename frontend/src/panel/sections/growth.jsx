import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { Stat, ErrorBox, Loading } from './core';

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : n);
const fmtDate = (d) => (d ? new Date(d).toLocaleString() : '—');

// Pull the latest completed cycle's phases out of history + detail.
function useLatestCycle() {
  const [cycle, setCycle] = useState(null);
  const [error, setError] = useState(null);
  const [empty, setEmpty] = useState(false);

  useEffect(() => {
    api.get('/api/history?limit=10')
      .then((r) => {
        const latest = (r.data.recent || []).find((c) => c.status === 'completed');
        if (!latest) { setEmpty(true); return null; }
        return api.get(`/api/cycle/${latest.id}`).then((d) => setCycle(d.data));
      })
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, []);

  return { cycle, error, empty };
}

// ---------- Analytics ----------

export function AnalyticsSection() {
  const { cycle, error, empty } = useLatestCycle();
  const [history, setHistory] = useState(null);

  useEffect(() => {
    api.get('/api/history?limit=25').then((r) => setHistory(r.data)).catch(() => {});
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (empty) return <p className="cp-muted">Run a cycle first - analytics appear once posts are tracked.</p>;
  if (!cycle) return <Loading />;

  const analytics = cycle.phases && cycle.phases.analytics;
  const breakdown = analytics && analytics.platformBreakdown ? analytics.platformBreakdown : {};

  return (
    <div>
      <div className="cp-stat-row">
        <Stat label="Posts tracked (latest cycle)" value={analytics ? analytics.postsTracked : null} />
        <Stat label="Engagement (latest cycle)" value={analytics ? fmt(analytics.totalEngagement) : null} />
        <Stat label="Avg per post" value={analytics ? fmt(analytics.averageEngagementRate) : null} />
      </div>

      <div className="cp-card">
        <h3>Platform breakdown — latest cycle</h3>
        <table className="cp-table">
          <thead><tr><th>Platform</th><th>Posts</th><th>Engagement</th><th>Reach</th></tr></thead>
          <tbody>
            {Object.entries(breakdown).map(([platform, d]) => (
              <tr key={platform}>
                <td>{platform}</td><td>{d.posts}</td><td>{fmt(d.engagement)}</td><td>{fmt(d.reach)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="cp-muted">
          Numbers are sandbox estimates until the platform APIs (TikTok / Instagram / Facebook / YouTube) are connected.
        </p>
      </div>

      {history && history.recent && history.recent.length > 1 && (
        <div className="cp-card">
          <h3>Engagement across cycles</h3>
          <div className="cp-bars">
            {[...history.recent].reverse().map((c) => {
              const max = Math.max(...history.recent.map((x) => x.total_engagement || 0), 1);
              const h = Math.max(4, Math.round(((c.total_engagement || 0) / max) * 120));
              return (
                <div className="cp-bar-wrap" key={c.id} title={`#${c.cycle_number}: ${fmt(c.total_engagement)}`}>
                  <div className="cp-bar" style={{ height: `${h}px` }} />
                  <div className="cp-bar-label">#{c.cycle_number}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------- Growth Intelligence ----------

export function GrowthSection({ view }) {
  const { cycle, error, empty } = useLatestCycle();

  if (error) return <ErrorBox error={error} />;
  if (empty) return <p className="cp-muted">Run a cycle first - growth intelligence comes from the research agents.</p>;
  if (!cycle) return <Loading />;

  const intel = cycle.phases && cycle.phases.intelligence;
  const opt = cycle.phases && cycle.phases.optimization;
  if (!intel) return <p className="cp-muted">No intelligence data in the latest cycle.</p>;

  if (view === 'schedule') {
    return (
      <div className="cp-card">
        <h3>Best posting times (latest research)</h3>
        <ul className="cp-list">
          {(intel.bestTimes || []).map((t, i) => <li key={i}>{t}</li>)}
        </ul>
        {opt && opt.optimalPostingTimes && (
          <>
            <h3>Optimizer confirmation</h3>
            <ul className="cp-list">
              {opt.optimalPostingTimes.map((t, i) => <li key={i}>{t}</li>)}
            </ul>
          </>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className="cp-card">
        <h3>Recommended hashtags</h3>
        <div className="cp-tags">
          {(intel.hashtags || []).map((h, i) => <span className="cp-tag" key={i}>{h}</span>)}
        </div>
      </div>
      <div className="cp-card">
        <h3>Content gaps — what nobody in Tbilisi is doing</h3>
        <ul className="cp-list">
          {(intel.contentGaps || []).map((g, i) => <li key={i}>{g}</li>)}
        </ul>
      </div>
      {opt && opt.trendingTopics && (
        <div className="cp-card">
          <h3>Trending topics</h3>
          <div className="cp-tags">
            {opt.trendingTopics.map((t, i) => <span className="cp-tag" key={i}>{t}</span>)}
          </div>
        </div>
      )}
      {opt && opt.recommendations && (
        <div className="cp-card">
          <h3>Strategy recommendations</h3>
          <ul className="cp-list">
            {opt.recommendations.map((r, i) => (
              <li key={i}><strong>{r.area}:</strong> {r.proposed} <em>({r.impact})</em></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------- Monetization ----------

export function MonetizationSection({ view }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ platform: 'tiktok', source: 'creator_fund', amount: '', currency: 'GEL', note: '' });
  const [saved, setSaved] = useState(false);
  const { cycle } = useLatestCycle();

  const load = useCallback(() => {
    api.get('/api/revenue')
      .then((r) => setData(r.data))
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setSaved(false);
    try {
      await api.post('/api/revenue', { ...form, amount: Number(form.amount) });
      setForm({ ...form, amount: '', note: '' });
      setSaved(true);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Delete this revenue entry? This cannot be undone.')) return;
    try { await api.delete(`/api/revenue/${id}`); load(); }
    catch (err) { setError(err.response?.data?.error || err.message); }
  };

  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  if (view === 'record') {
    return (
      <div className="cp-card cp-form-card">
        <h3>Record income</h3>
        <p className="cp-muted">Log money the social channels produce - creator funds, sponsorships, affiliate payouts, orders attributed to social.</p>
        <ErrorBox error={error} />
        {saved && <div className="cp-success">Recorded.</div>}
        <form onSubmit={submit} className="cp-form">
          <label>Platform
            <select value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })}>
              <option value="tiktok">TikTok</option>
              <option value="instagram">Instagram</option>
              <option value="facebook">Facebook</option>
              <option value="youtube">YouTube</option>
              <option value="direct">Direct / in-store</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>Source
            <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>
              <option value="creator_fund">Creator fund / bonus</option>
              <option value="sponsorship">Sponsorship</option>
              <option value="affiliate">Affiliate</option>
              <option value="ads">Ad revenue</option>
              <option value="orders">Attributed orders</option>
              <option value="other">Other</option>
            </select>
          </label>
          <label>Amount
            <input type="number" step="0.01" required value={form.amount}
              onChange={(e) => setForm({ ...form, amount: e.target.value })} placeholder="0.00" />
          </label>
          <label>Currency
            <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
              <option>GEL</option><option>USD</option><option>EUR</option>
            </select>
          </label>
          <label className="cp-form-wide">Note
            <input type="text" value={form.note} maxLength={500}
              onChange={(e) => setForm({ ...form, note: e.target.value })} placeholder="optional" />
          </label>
          <button className="cp-btn" type="submit">Record</button>
        </form>
      </div>
    );
  }

  if (view === 'opportunities') {
    const mon = cycle && cycle.phases && cycle.phases.monetization;
    return (
      <div>
        {!mon ? <p className="cp-muted">Run a cycle to refresh eligibility and opportunities.</p> : (
          <>
            <div className="cp-card">
              <h3>Program eligibility</h3>
              <table className="cp-kv"><tbody>
                {Object.entries(mon.eligibility || {}).map(([k, v]) => (
                  <tr key={k}><td>{k}</td><td><span className={`cp-pill ${v ? 'ok' : 'warn'}`}>{v ? 'eligible' : 'not yet'}</span></td></tr>
                ))}
              </tbody></table>
              {mon.estimatedMonthly && <p className="cp-muted">Estimated potential: {mon.estimatedMonthly}/month</p>}
            </div>
            <div className="cp-card">
              <h3>Opportunities</h3>
              <table className="cp-table">
                <thead><tr><th>Opportunity</th><th>Potential</th><th>Priority</th></tr></thead>
                <tbody>
                  {(mon.opportunities || []).map((o, i) => (
                    <tr key={i}><td>{o.name}</td><td>{o.potential}</td><td><span className={`cp-pill ${o.priority === 'high' ? 'ok' : 'warn'}`}>{o.priority}</span></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    );
  }

  // ledger (default)
  const s = data.summary;
  return (
    <div>
      <div className="cp-stat-row">
        <Stat label="Total recorded" value={`₾ ${fmt(s.total)}`} hint="all entries, mixed currencies shown at face value" />
        <Stat label="Entries" value={data.entries.length} />
        <Stat label="Platforms earning" value={Object.keys(s.byPlatform).length} />
      </div>
      <div className="cp-card-row">
        <div className="cp-card">
          <h3>By platform</h3>
          <table className="cp-kv"><tbody>
            {Object.entries(s.byPlatform).map(([k, v]) => <tr key={k}><td>{k}</td><td>{fmt(v)}</td></tr>)}
          </tbody></table>
        </div>
        <div className="cp-card">
          <h3>By source</h3>
          <table className="cp-kv"><tbody>
            {Object.entries(s.bySource).map(([k, v]) => <tr key={k}><td>{k}</td><td>{fmt(v)}</td></tr>)}
          </tbody></table>
        </div>
        <div className="cp-card">
          <h3>By month</h3>
          <table className="cp-kv"><tbody>
            {Object.entries(s.byMonth).map(([k, v]) => <tr key={k}><td>{k}</td><td>{fmt(v)}</td></tr>)}
          </tbody></table>
        </div>
      </div>
      <div className="cp-card">
        <h3>Ledger</h3>
        {data.entries.length === 0 ? <p className="cp-muted">No income recorded yet. Use Record Income once money arrives.</p> : (
          <table className="cp-table">
            <thead><tr><th>When</th><th>Platform</th><th>Source</th><th>Amount</th><th>Note</th><th></th></tr></thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td>{fmtDate(e.recorded_at)}</td>
                  <td>{e.platform}</td>
                  <td>{e.source}</td>
                  <td>{e.currency} {fmt(Number(e.amount))}</td>
                  <td>{e.note || ''}</td>
                  <td><button className="cp-btn small ghost" onClick={() => remove(e.id)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------- Agents ----------

export function AgentsSection() {
  const [agents, setAgents] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get('/api/agents')
      .then((r) => setAgents(r.data.agents))
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, []);

  if (error) return <ErrorBox error={error} />;
  if (!agents) return <Loading />;

  const PHASE_LABELS = {
    'phase2-intelligence': 'Phase 2 — Intelligence',
    'phase3-production': 'Phase 3 — Production',
    'phase4-distribution': 'Phase 4 — Distribution',
    'phase5-analytics': 'Phase 5 — Analytics',
    'phase6-optimization': 'Phase 6 — Optimization',
    'phase7-monetization': 'Phase 7 — Monetization'
  };

  return (
    <div className="cp-card-row cp-wrap">
      {Object.entries(agents).map(([phase, members]) => (
        <div className="cp-card" key={phase}>
          <h3>{PHASE_LABELS[phase] || phase}</h3>
          <ul className="cp-list">
            {(Array.isArray(members) ? members : []).map((m, i) => (
              <li key={i}>{m} <span className="cp-pill ok">ready</span></li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------- Settings ----------

export function SettingsSection({ view }) {
  const [health, setHealth] = useState(null);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState(null);
  const [savedKey, setSavedKey] = useState(null);
  const [draft, setDraft] = useState({});

  useEffect(() => {
    api.get('/api/system').then((r) => setHealth(r.data)).catch((e) => setError(e.message));
    api.get('/api/settings')
      .then((r) => setSettings(r.data.settings))
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, []);

  const save = async (key) => {
    setError(null); setSavedKey(null);
    try {
      const value = draft[key] !== undefined ? draft[key] : (settings && settings[key]) || '';
      await api.put('/api/settings', { key, value });
      setSettings({ ...settings, [key]: value });
      setSavedKey(key);
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  if (error && !health) return <ErrorBox error={error} />;
  if (!health) return <Loading />;

  if (view === 'connections') {
    const PLATFORMS = [
      { key: 'tiktok', name: 'TikTok', note: 'Content Posting API - requires app registration + audit' },
      { key: 'instagram', name: 'Instagram', note: 'Graph API - requires Business account + App Review' },
      { key: 'facebook', name: 'Facebook', note: 'Shares the Meta app with Instagram' },
      { key: 'youtube', name: 'YouTube', note: 'Data API v3 - requires Google Cloud project' }
    ];
    return (
      <div className="cp-card">
        <h3>Platform connections</h3>
        <p className="cp-muted">
          Publishing currently runs in sandbox mode. Each platform needs its own API approval -
          these are external review queues (days to weeks) and the next launch blocker.
        </p>
        <table className="cp-table">
          <thead><tr><th>Platform</th><th>Status</th><th>What it takes</th></tr></thead>
          <tbody>
            {PLATFORMS.map((p) => (
              <tr key={p.key}>
                <td>{p.name}</td>
                <td><span className="cp-pill warn">sandbox</span></td>
                <td className="cp-muted">{p.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  if (view === 'brand') {
    const FIELDS = [
      { key: 'brand_voice', label: 'Brand voice', placeholder: 'Warm, direct, a little playful. No corporate filler.' },
      { key: 'posting_cadence', label: 'Posting cadence', placeholder: 'e.g. 2 posts/day, lunch + evening' },
      { key: 'auto_approve_threshold', label: 'Auto-approve threshold (0-10)', placeholder: '7.5' }
    ];
    return (
      <div className="cp-card cp-form-card">
        <h3>Brand & automation</h3>
        <ErrorBox error={error} />
        {settings === null ? <Loading /> : FIELDS.map((f) => (
          <div className="cp-setting" key={f.key}>
            <label>{f.label}</label>
            <div className="cp-setting-row">
              <input
                type="text"
                defaultValue={settings[f.key] || ''}
                placeholder={f.placeholder}
                onChange={(e) => setDraft({ ...draft, [f.key]: e.target.value })}
              />
              <button className="cp-btn small" onClick={() => save(f.key)}>Save</button>
              {savedKey === f.key && <span className="cp-success-inline">saved</span>}
            </div>
          </div>
        ))}
        <p className="cp-muted">Saved values are stored in the database; agents read them on the next cycle.</p>
      </div>
    );
  }

  // system (default)
  return (
    <div className="cp-card">
      <h3>System health</h3>
      <table className="cp-kv"><tbody>
        <tr><td>Service</td><td>{health.service}</td></tr>
        <tr><td>Orchestrator</td><td><span className="cp-pill ok">{health.orchestrator}</span></td></tr>
        <tr><td>Persistence</td><td><span className={`cp-pill ${health.persistence === 'mysql' ? 'ok' : 'warn'}`}>{health.persistence}</span></td></tr>
        <tr><td>Content generation</td><td><span className={`cp-pill ${health.contentGeneration === 'claude' ? 'ok' : 'warn'}`}>{health.contentGeneration}</span></td></tr>
        <tr><td>Model</td><td>{health.claude && health.claude.model ? health.claude.model : '—'}</td></tr>
        <tr><td>Claude calls / failures / refusals</td><td>
          {health.claude ? `${health.claude.calls} / ${health.claude.failures} / ${health.claude.refusals}` : '—'}
        </td></tr>
        <tr><td>Last Claude error</td><td className="cp-muted">{(health.claude && health.claude.lastError) || 'none'}</td></tr>
        <tr><td>DB migrated</td><td>{health.database && health.database.migrated ? 'yes' : 'no'}</td></tr>
        <tr><td>Server time</td><td>{fmtDate(health.timestamp)}</td></tr>
      </tbody></table>
    </div>
  );
}
