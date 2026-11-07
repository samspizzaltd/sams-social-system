import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { Stat, ErrorBox, Loading, ConfirmButton } from './core';

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : n);
const fmtDate = (d) => {
  if (!d) return '—';
  const t = new Date(String(d).replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleString();
};

// Live platform-connection status + the TikTok connect/disconnect controls.
// Publishing on every platform still goes through the owner-approved queue.
function ConnectionsView() {
  const [meta, setMeta] = useState(null);
  const [tiktok, setTiktok] = useState(null);
  const [youtube, setYoutube] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => {
    api.get('/api/meta/status').then((r) => setMeta(r.data)).catch(() => setMeta({ unavailable: true }));
    api.get('/api/tiktok/status').then((r) => setTiktok(r.data)).catch(() => setTiktok({ unavailable: true }));
    api.get('/api/youtube/status').then((r) => setYoutube(r.data)).catch(() => setYoutube({ unavailable: true }));
  }, []);
  useEffect(() => { load(); }, [load]);

  const [connectUrl, setConnectUrl] = useState(null);
  const connectTikTok = async () => {
    setError(null); setNotice(null);
    try {
      const r = await api.get('/api/tiktok/connect-url');
      // Popup blockers eat window.open after an await (Safari always) - try,
      // but always render a real link as the reliable path. Each link works
      // once, so fetch a fresh one per click.
      const w = window.open(r.data.url, '_blank');
      setConnectUrl(r.data.url);
      setNotice(w
        ? 'A TikTok window opened - log in with the SAM’S TikTok account there, then come back and press Refresh.'
        : 'Your browser blocked the popup - use the "Open TikTok login" link below instead.');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  const [ytConnectUrl, setYtConnectUrl] = useState(null);
  const connectYouTube = async () => {
    setError(null); setNotice(null);
    try {
      const r = await api.get('/api/youtube/connect-url');
      const w = window.open(r.data.url, '_blank');
      setYtConnectUrl(r.data.url);
      setNotice(w
        ? 'A Google window opened - pick the SAM\u2019S MORE THAN PIZZA channel there, allow the permissions, then come back and press Refresh.'
        : 'Your browser blocked the popup - use the "Open Google login" link below instead.');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  const disconnectYouTube = async () => {
    setError(null);
    try {
      await api.post('/api/youtube/disconnect');
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  const disconnectTikTok = async () => {
    setError(null);
    try {
      await api.post('/api/tiktok/disconnect');
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    }
  };

  const pill = (ok, text) => <span className={`cp-pill ${ok ? 'ok' : 'warn'}`}>{text}</span>;
  const metaAccounts = (meta && meta.accounts) || [];
  const metaConnected = metaAccounts.some((a) => a.platform === 'instagram' && a.status === 'active');

  return (
    <div className="cp-card">
      <h3>Platform connections</h3>
      <ErrorBox error={error} />
      {notice && <div className="cp-success">{notice}</div>}
      {(meta && meta.unavailable) || (tiktok && tiktok.unavailable) || (youtube && youtube.unavailable) ? (
        <p className="cp-muted">Connection status is unavailable right now (server or database hiccup) - this does NOT mean the accounts are disconnected. Press Refresh in a minute before reconnecting anything.</p>
      ) : null}
      <table className="cp-table">
        <thead><tr><th>Platform</th><th>Status</th><th>Details</th><th></th></tr></thead>
        <tbody>
          <tr>
            <td>Instagram + Facebook</td>
            <td>{meta === null ? '…' : meta.unavailable ? <span className="cp-pill warn">status unavailable</span> : pill(metaConnected, metaConnected ? 'connected' : 'not connected')}</td>
            <td className="cp-muted">
              {metaAccounts.filter((a) => a.platform !== 'meta_user').map((a) => a.platform + ' (' + a.business_account_id + ')').join(' · ') || '—'}
            </td>
            <td></td>
          </tr>
          <tr>
            <td>TikTok</td>
            <td>{tiktok === null ? '…' : tiktok.unavailable ? <span className="cp-pill warn">status unavailable</span> : pill(!!tiktok.connected, tiktok.connected ? 'connected' : (tiktok.status === 'disconnected' ? 'disconnected' : 'not connected'))}</td>
            <td className="cp-muted">
              {tiktok && tiktok.profile
                ? (tiktok.profile.display_name || '') + (tiktok.profile.username ? ' (@' + tiktok.profile.username + ')' : '')
                : tiktok && tiktok.open_id ? 'open_id ' + tiktok.open_id : 'Sandbox until the app passes TikTok review'}
            </td>
            <td>
              {tiktok && tiktok.connected
                ? <ConfirmButton className="cp-btn small ghost" label="Disconnect" confirmLabel="Really disconnect?" onConfirm={disconnectTikTok} />
                : <button className="cp-btn small" disabled={!!(tiktok && tiktok.unavailable)} onClick={connectTikTok}>Connect TikTok</button>}
              {connectUrl && !(tiktok && tiktok.connected) && (
                <div><a href={connectUrl} target="_blank" rel="noopener noreferrer" onClick={() => setConnectUrl(null)}>Open TikTok login</a></div>
              )}
            </td>
          </tr>
          <tr>
            <td>YouTube</td>
            <td>{youtube === null ? '\u2026' : youtube.unavailable ? <span className="cp-pill warn">status unavailable</span> : pill(!!youtube.connected, youtube.connected ? 'connected' : (!youtube.configured ? 'keys not set' : youtube.status === 'disconnected' ? 'disconnected' : youtube.status === 'expired' ? 'login expired' : 'not connected'))}</td>
            <td className="cp-muted">
              {youtube && youtube.channel
                ? youtube.channel.title
                : youtube && youtube.channel_unavailable
                  ? 'connected - channel name temporarily unavailable'
                : youtube && !youtube.configured
                  ? 'Paste the Google keys at api.sams-social-system.sams.ge/auth/youtube/secret-setup first'
                  : youtube && youtube.channel_id ? 'channel ' + youtube.channel_id : 'Uploads stay Private until Google audits the project'}
            </td>
            <td>
              {youtube && youtube.channel_id && youtube.status !== 'disconnected'
                ? <ConfirmButton className="cp-btn small ghost" label="Disconnect" confirmLabel="Revoke access + delete data?" onConfirm={disconnectYouTube} />
                : <button className="cp-btn small" disabled={!!(youtube && (youtube.unavailable || !youtube.configured))} onClick={connectYouTube}>Connect YouTube</button>}
              {ytConnectUrl && !(youtube && youtube.connected) && (
                <div><a href={ytConnectUrl} target="_blank" rel="noopener noreferrer" onClick={() => setYtConnectUrl(null)}>Open Google login</a></div>
              )}
            </td>
          </tr>
          <tr>
            <td colSpan={4} className="cp-muted" style={{ fontSize: 13 }}>
              YouTube uploads use YouTube API Services - connecting means you agree to the{' '}
              <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a>; see also the{' '}
              <a href="http://www.google.com/policies/privacy" target="_blank" rel="noopener noreferrer">Google Privacy Policy</a> and our{' '}
              <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
              Disconnect revokes the access at Google and deletes the stored YouTube data; you can also revoke it in your{' '}
              <a href="https://security.google.com/settings/security/permissions" target="_blank" rel="noopener noreferrer">Google Account security settings</a>.
            </td>
          </tr>
        </tbody>
      </table>
      <button className="cp-btn small ghost" style={{ marginTop: 10 }} onClick={load}>Refresh</button>
      <TikTokRouteCard connected={!!(tiktok && tiktok.connected)} />
    </div>
  );
}

// How approved TikTok posts reach TikTok while TikTok has not audited the app
// (backend services/publicRoute.js). Owner 2026-11-07: no paid third parties.
function TikTokRouteCard({ connected }) {
  const [route, setRoute] = useState(null);
  const [test, setTest] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const loadTest = useCallback(() => {
    api.get('/api/tiktok/test-draft').then((r) => setTest(r.data)).catch(() => {});
  }, []);
  useEffect(() => {
    api.get('/api/settings')
      .then((r) => setRoute((r.data.settings && r.data.settings.tiktok_route) || 'wait'))
      .catch((e) => setError(e.response?.data?.error || e.message));
    loadTest();
  }, [loadTest]);

  const saveRoute = async (value) => {
    setBusy(true); setError(null); setNotice(null);
    try {
      await api.put('/api/settings', { key: 'tiktok_route', value });
      setRoute(value);
      setNotice(value === 'drafts'
        ? 'On: at each posting slot the approved TikTok post arrives in your TikTok inbox (Inbox → System notifications) - tap it and post it from the TikTok app.'
        : 'TikTok posts now wait until TikTok approves public posting.');
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };

  const sendTest = async () => {
    setBusy(true); setError(null); setNotice(null);
    try {
      const r = await api.post('/api/tiktok/test-draft', {});
      setNotice(r.data.note + (r.data.warning ? ' (' + r.data.warning + ')' : ''));
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
      loadTest();
    }
  };

  const STATE_TEXT = {
    starting: 'being sent…',
    processing: 'TikTok is still processing it',
    in_drafts: 'waiting in your TikTok inbox (Inbox → System notifications) ✓',
    posted: 'delivered - and you posted it ✓',
    failed: 'TikTok could not process it',
    refused: 'TikTok refused it',
    unreadable: 'TikTok status unreadable right now'
  };

  return (
    <div className="cp-card" style={{ marginTop: 14 }}>
      <h3>TikTok posts</h3>
      <ErrorBox error={error} />
      {notice && <div className="cp-success">{notice}</div>}
      <p className="cp-muted">
        TikTok only lets an app post publicly by itself after TikTok audits it, and keeps that audit for apps made for the public.
        What TikTok allows any app: sending the finished video to your TikTok inbox. It does not go into your profile's Drafts folder - TikTok shows it under Inbox → System notifications; tap it and post it from the TikTok app
        (paste the caption, pick who can watch - about 30 seconds), and it is public like any post you make yourself.
      </p>
      {route === null ? <Loading /> : (
        <div className="cp-setting">
          <label htmlFor="tiktok-route">Approved TikTok posts</label>
          <div className="cp-setting-row">
            <select id="tiktok-route" value={route} disabled={busy} onChange={(e) => saveRoute(e.target.value)}>
              <option value="wait">Wait until TikTok approves public posting</option>
              <option value="drafts">Send them to my TikTok inbox at their posting slot</option>
            </select>
          </div>
        </div>
      )}
      {route === 'drafts' && (
        <p className="cp-muted">
          TikTok takes at most 5 videos in 24 hours that you have not posted yet. Post each one when it arrives - when the inbox is full,
          the next post waits and tries again every 30 minutes. The test button is off while posts go to your inbox: every test takes one of those 5 places.
        </p>
      )}
      <div className="cp-content-actions" style={{ marginTop: 10 }}>
        {route === 'wait' && (
          <ConfirmButton className="cp-btn small ghost" disabled={busy || !connected}
            label="Send a test video" confirmLabel="Send the newest edit to my TikTok inbox?" onConfirm={sendTest} />
        )}
        <button className="cp-btn small ghost" disabled={busy} onClick={loadTest}>Check the test video</button>
      </div>
      {test && test.test && (
        <p className="cp-muted" style={{ marginTop: 6 }}>
          Test video: {test.test.title || 'video #' + test.test.media_id} - {STATE_TEXT[test.state] || test.state || '—'}
          {test.test.error ? ' - ' + test.test.error : ''}{test.detail ? ' - ' + test.detail : ''} ({fmtDate(test.test.at)})
        </p>
      )}
    </div>
  );
}

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
                  <td><ConfirmButton className="cp-btn small ghost" label="Delete" confirmLabel="Really delete?" onConfirm={() => remove(e.id)} /></td>
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
    return <ConnectionsView />;
  }

  if (view === 'brand') {
    const FIELDS = [
      { key: 'brand_voice', label: 'Brand voice', placeholder: 'Warm, direct, a little playful. No corporate filler.' },
      { key: 'posting_cadence', label: 'Posting cadence', placeholder: 'e.g. 2 posts/day, lunch + evening' },
      { key: 'auto_approve_threshold', label: 'Auto-approve drafts at score (0-10), or "off" to review every draft yourself', placeholder: 'off' },
      { key: 'audience_location', label: 'Target audience - location', placeholder: 'Tbilisi, Georgia' },
      { key: 'audience_age', label: 'Target audience - age range', placeholder: '18-40' },
      { key: 'audience_gender', label: 'Target audience - gender (all / women / men)', placeholder: 'all' },
      { key: 'audience_notes', label: 'Audience notes', placeholder: 'e.g. students near the university, Gulf tourists in summer' },
      { key: 'auto_cycle_enabled', label: 'Auto-run cycles (true / false)', placeholder: 'false' },
      { key: 'auto_cycle_times', label: 'Auto-cycle times, Tbilisi (comma-separated HH:MM)', placeholder: '09:30' },
      { key: 'auto_cycle_days', label: 'Auto-cycle days (all, or e.g. Sun,Mon)', placeholder: 'all' },
      { key: 'publish_slots', label: 'Posting slots, Tbilisi (comma-separated HH:MM - one post per platform per slot)', placeholder: '12:30,19:00' },
      { key: 'sound_mode', label: 'Sounds on autopilot edits (rotate = circulate the Sound Library, own = keep the sound each video came with)', placeholder: 'rotate' },
      { key: 'autoprep_buffer', label: 'Prepared videos allowed to wait for your review at once', placeholder: '5' }
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
        <p className="cp-muted">Saved values are stored in the database; the research and writing agents read them on the next cycle - audience settings steer every caption, script and trend search.</p>
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
