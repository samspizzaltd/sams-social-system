import React, { useState, useEffect, useCallback, useRef } from 'react';
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
  const [tkBiz, setTkBiz] = useState(null); // TikTok business interface (2026-11-13)
  const [youtube, setYoutube] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => {
    api.get('/api/meta/status').then((r) => setMeta(r.data)).catch(() => setMeta({ unavailable: true }));
    api.get('/api/tiktok/status').then((r) => setTiktok(r.data)).catch(() => setTiktok({ unavailable: true }));
    api.get('/api/tiktok-business/status').then((r) => setTkBiz(r.data)).catch(() => setTkBiz({ unavailable: true }));
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
                  : youtube && youtube.channel_id ? 'channel ' + youtube.channel_id : 'not connected yet'}
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
      <TikTokBusinessCard status={tkBiz} onChanged={load} />
      <TikTokRouteCard connected={!!(tiktok && tiktok.connected)} business={!!(tkBiz && tkBiz.ready)} />
    </div>
  );
}

const API_ORIGIN = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// TikTok through TikTok's business interface (backend services/tiktokBusiness.js):
// approved TikTok posts go out publicly by themselves, with the caption.
function TikTokBusinessCard({ status, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [link, setLink] = useState(null);
  const run = async (fn) => {
    setBusy(true); setError(null); setNotice(null);
    try { await fn(); } catch (e) { setError(e.response?.data?.error || e.message); }
    setBusy(false);
    onChanged();
  };
  const connect = () => run(async () => {
    const r = await api.get('/api/tiktok-business/connect-url');
    const w = window.open(r.data.url, '_blank');
    setLink(r.data.url);
    setNotice(w
      ? 'A TikTok window opened - log in with the SAM\u2019S TikTok account, allow the permissions, then come back and press Refresh.'
      : 'Your browser blocked the popup - use the "Open TikTok login" link below instead.');
  });
  const verify = () => run(async () => {
    await api.post('/api/tiktok-business/verify-url');
    setNotice('TikTok confirmed the video address ✓');
  });
  const disconnect = () => run(async () => {
    const r = await api.post('/api/tiktok-business/disconnect');
    setNotice(r.data.note);
  });
  if (status === null) return <div className="cp-card" style={{ marginTop: 14 }}><Loading /></div>;
  if (status.unavailable) {
    return (
      <div className="cp-card" style={{ marginTop: 14 }}>
        <h3>TikTok - business interface</h3>
        <p className="cp-muted">This arrives with the next server update.</p>
      </div>
    );
  }
  const steps = [
    ['The TikTok app keys are saved on the server', status.configured && status.auth_url_set],
    ['Sam\u2019s TikTok is connected' + (status.username ? ' (@' + status.username + ')' : ''), status.connected],
    ['TikTok verified our video address', status.url_verified]
  ];
  return (
    <div className="cp-card" style={{ marginTop: 14 }}>
      <h3>TikTok - business interface</h3>
      <ErrorBox error={error} />
      {notice && <div className="cp-success">{notice}</div>}
      <p className="cp-muted">
        TikTok's business interface lets the system post your approved TikTok videos publicly by itself, with the caption -
        like Instagram and Facebook. It needs a TikTok developer app that TikTok has approved (free); then these three steps.
      </p>
      <ul className="cp-list">
        {steps.map(([t, ok]) => <li key={t}>{ok ? '✓' : '○'} {t}</li>)}
      </ul>
      {status.ready && (
        <p><span className="cp-pill ok">TikTok posts go out publicly</span>
          {status.followers !== null && status.followers !== undefined ? <span className="cp-muted"> · {fmt(status.followers)} followers</span> : null}</p>
      )}
      {status.connected && status.can_publish === false && (
        <p className="cp-muted">The connection has no posting permission (video.publish) - check the app's "TikTok Accounts" permission, then connect again.</p>
      )}
      {!status.url_verified && status.url_error && <p className="cp-muted">Video address: {status.url_error}</p>}
      {status.last_error && <p className="cp-muted">Last problem: {status.last_error}</p>}
      {status.refresh_expires_at && (
        <p className="cp-muted">The connection lasts until {fmtDate(status.refresh_expires_at)} - press Connect again before then.</p>
      )}
      <p className="cp-muted" style={{ fontSize: 12.5 }}>
        For the TikTok app settings - redirect URL: <code>{status.redirect_uri}</code>
      </p>
      <div className="cp-content-actions" style={{ flexWrap: 'wrap' }}>
        <a className="cp-btn small ghost" href={API_ORIGIN + '/auth/tiktok-business/secret-setup'} target="_blank" rel="noopener noreferrer">
          {status.configured ? 'Change the app keys' : 'Set up the app keys'}
        </a>
        {status.connected
          ? <ConfirmButton className="cp-btn small ghost" label="Disconnect" confirmLabel="Really disconnect TikTok (business)?" onConfirm={disconnect} />
          : <button className="cp-btn small" disabled={busy || !status.configured || !status.auth_url_set} onClick={connect}>Connect TikTok (business)</button>}
        <button className="cp-btn small ghost" disabled={busy || !status.configured} onClick={verify}>Verify video address</button>
      </div>
      {link && !status.connected && (
        <div style={{ marginTop: 6 }}><a href={link} target="_blank" rel="noopener noreferrer" onClick={() => setLink(null)}>Open TikTok login</a></div>
      )}
    </div>
  );
}

// How approved TikTok posts reach TikTok while TikTok has not audited the app
// (backend services/publicRoute.js). Owner 2026-11-07: no paid third parties.
function TikTokRouteCard({ connected, business }) {
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
      {business && (
        <p><span className="cp-pill ok">Public posting through TikTok's business interface is on</span>
          <span className="cp-muted"> - approved TikTok posts go out by themselves at their slots. The setting below only matters if that connection stops.</span></p>
      )}
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
          TikTok takes at most 5 videos in 24 hours that you have not posted yet. Post each one from the TikTok app on your phone when it arrives (they do not show on tiktok.com) - when the inbox is full,
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

// ---------- Analytics (real platform numbers) ----------

const PLATFORM_LABEL = { instagram: 'Instagram', facebook_page: 'Facebook', tiktok: 'TikTok', youtube: 'YouTube' };
const dash = (v) => (v === null || v === undefined ? '—' : fmt(v));
const watchSec = (ms) => (ms === null || ms === undefined ? '—' : (ms / 1000).toFixed(1) + ' s');

// GET /api/metrics - the numbers services/metrics.js collected from the
// platforms. 'not-deployed' = the server does not have the endpoint yet.
export function useMetrics() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(() => api.get('/api/metrics')
    .then((r) => { setData(r.data); setError(null); return r.data; })
    .catch((e) => {
      setError(e.response?.status === 404 ? 'not-deployed' : (e.response?.data?.error || e.message));
      return null;
    }), []);
  useEffect(() => { load(); }, [load]);
  return { data, error, load };
}

function followerHint(p) {
  if (!p || p.followers === null || p.followers === undefined) return 'not read yet';
  const h = (p.followerHistory || []).filter((x) => x.followers !== null);
  if (h.length >= 2) {
    const diff = h[h.length - 1].followers - h[0].followers;
    return (diff >= 0 ? '+' : '') + fmt(diff) + ' since ' + h[0].day;
  }
  return 'as of ' + p.followersDay;
}

// Plain-language lines from the last refresh (what a platform refused etc.).
function runNotes(lastRun) {
  const out = [];
  if (!lastRun) return out;
  if (lastRun.error) out.push('Last refresh failed: ' + lastRun.error);
  for (const [k, r] of Object.entries(lastRun.platforms || {})) {
    for (const n of r.notes || []) out.push(PLATFORM_LABEL[k] + ': ' + n);
    if (r.failed) out.push(PLATFORM_LABEL[k] + ': ' + r.failed + ' post(s) could not be read (deleted on the platform?) - their last known numbers are kept.');
  }
  return out;
}

export function AnalyticsSection() {
  const { data, error, load } = useMetrics();
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState(null);
  const pollRef = useRef(null);

  useEffect(() => () => clearTimeout(pollRef.current), []);

  const refresh = async () => {
    setNotice(null);
    try {
      await api.post('/api/metrics/refresh');
      setRefreshing(true);
      const tick = async () => {
        const d = await load();
        if (d && d.running) { pollRef.current = setTimeout(tick, 4000); return; }
        setRefreshing(false);
        setNotice('Updated from Instagram and Facebook.');
      };
      pollRef.current = setTimeout(tick, 3000);
    } catch (e) {
      setNotice(e.response?.data?.error || e.message);
    }
  };

  if (error === 'not-deployed') return <p className="cp-muted">Real numbers arrive with the next server update.</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;

  const ig = data.platforms.instagram;
  const fb = data.platforms.facebook_page;
  const notes = runNotes(data.lastRun);
  const busy = refreshing || data.running;
  const chart = data.posts.filter((p) => p.views !== null).slice(0, 20).reverse();
  const maxViews = Math.max(1, ...chart.map((p) => p.views));

  return (
    <div>
      <div className="cp-stat-row">
        <Stat label="Instagram followers" value={dash(ig.followers)} hint={followerHint(ig)} />
        <Stat label="Facebook followers" value={dash(fb.followers)} hint={followerHint(fb)} />
        <Stat label="Views" value={dash(data.totals.views)} hint={'on the ' + data.totals.tracked + ' posts we can read'} />
        <Stat label="Interactions" value={dash(data.totals.interactions)} hint="likes + comments + shares + saves" />
      </div>

      <div className="cp-card">
        <div className="cp-content-head">
          <h3>By platform</h3>
          <button className="cp-btn small" disabled={busy} onClick={refresh}>{busy ? 'Refreshing…' : 'Refresh now'}</button>
        </div>
        <p className="cp-muted">
          Real numbers from the platforms{data.lastRun ? ', last read ' + fmtDate(data.lastRun.at) : ' - the first read happens a minute or two after the server starts'}.
          They refresh by themselves every {data.refreshEveryHours} hours. "—" means the platform does not give us that number.
        </p>
        {notice && <p className="cp-muted"><strong>{notice}</strong></p>}
        <div className="cp-table-scroll">
          <table className="cp-table">
            <thead><tr><th>Platform</th><th>Followers</th><th>Posts read</th><th>Views</th><th>Reach</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Saves</th></tr></thead>
            <tbody>
              {['instagram', 'facebook_page', 'tiktok'].filter((k) => data.platforms[k] && !data.platforms[k].note).map((k) => {
                const p = data.platforms[k];
                return (
                  <tr key={k}>
                    <td>{PLATFORM_LABEL[k]}</td><td>{dash(p.followers)}</td><td>{p.tracked}/{p.published}</td>
                    <td>{dash(p.views)}</td><td>{dash(p.reach)}</td><td>{dash(p.likes)}</td>
                    <td>{dash(p.comments)}</td><td>{dash(p.shares)}</td><td>{dash(p.saves)}</td>
                  </tr>
                );
              })}
              {['tiktok', 'youtube'].filter((k) => data.platforms[k] && data.platforms[k].note).map((k) => (
                <tr key={k}><td>{PLATFORM_LABEL[k]}</td><td colSpan={8} className="cp-muted">{data.platforms[k].note}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
        {notes.length > 0 && (
          <ul className="cp-list cp-muted">{notes.map((n, i) => <li key={i}>{n}</li>)}</ul>
        )}
      </div>

      {data.slots.length > 0 && (
        <div className="cp-card">
          <h3>Posting slots — average per post</h3>
          <table className="cp-table">
            <thead><tr><th>Platform</th><th>Slot (Tbilisi)</th><th>Posts</th><th>Avg views</th><th>Avg interactions</th></tr></thead>
            <tbody>
              {data.slots.map((s) => (
                <tr key={s.platform + s.slot}>
                  <td>{PLATFORM_LABEL[s.platform]}</td><td>{s.slot}</td><td>{s.posts}</td><td>{fmt(s.avgViews)}</td><td>{fmt(s.avgInteractions)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {chart.length > 1 && (
        <div className="cp-card">
          <h3>Views per post — latest {chart.length}</h3>
          <div className="cp-bars">
            {chart.map((p) => (
              <div className="cp-bar-wrap" key={p.queue_id} title={PLATFORM_LABEL[p.platform] + ' · ' + fmtDate(p.published_at) + ' · ' + fmt(p.views) + ' views'}>
                <div className="cp-bar" style={{ height: `${Math.max(4, Math.round((p.views / maxViews) * 120))}px` }} />
                <div className="cp-bar-label">{p.platform === 'instagram' ? 'IG' : 'FB'} #{p.queue_id}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="cp-card">
        <h3>Every published post</h3>
        {data.posts.length === 0 ? <p className="cp-muted">Nothing published yet.</p> : (
          <div className="cp-table-scroll">
            <table className="cp-table">
              <thead><tr><th>When</th><th>Platform</th><th>Post</th><th>Views</th><th>Reach</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Saves</th><th>Avg watch</th></tr></thead>
              <tbody>
                {data.posts.map((p) => (
                  <tr key={p.queue_id}>
                    <td>{fmtDate(p.published_at)}</td>
                    <td>{PLATFORM_LABEL[p.platform] || p.platform}</td>
                    <td>
                      {p.permalink ? <a href={p.permalink} target="_blank" rel="noreferrer">{p.caption || 'open'}</a> : (p.caption || '—')}
                      {!p.collected && <div className="cp-muted">numbers not collected for {PLATFORM_LABEL[p.platform] || p.platform}</div>}
                      {p.collected && !p.fetched_at && <div className="cp-muted">not read yet</div>}
                      {p.error && <div className="cp-muted">{p.error}</div>}
                    </td>
                    <td>{dash(p.views)}</td><td>{dash(p.reach)}</td><td>{dash(p.likes)}</td>
                    <td>{dash(p.comments)}</td><td>{dash(p.shares)}</td><td>{dash(p.saves)}</td><td>{watchSec(p.avg_watch_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

// Real top posts + slot averages, for Growth Intelligence.
function RealWhatWorked({ view }) {
  const { data, error } = useMetrics();
  if (error === 'not-deployed' || error || !data) return null;
  if (view === 'schedule') {
    return (
      <div className="cp-card">
        <h3>Your real posts — average views by slot</h3>
        {data.slots.length === 0 ? <p className="cp-muted">No post numbers yet - they appear after the first refresh.</p> : (
          <table className="cp-table">
            <thead><tr><th>Platform</th><th>Slot (Tbilisi)</th><th>Posts</th><th>Avg views</th></tr></thead>
            <tbody>
              {data.slots.map((s) => (
                <tr key={s.platform + s.slot}><td>{PLATFORM_LABEL[s.platform]}</td><td>{s.slot}</td><td>{s.posts}</td><td>{fmt(s.avgViews)}</td></tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    );
  }
  const top = data.posts.filter((p) => p.views !== null).sort((a, b) => b.views - a.views).slice(0, 3);
  return (
    <div className="cp-card">
      <h3>What worked — your top posts (real views)</h3>
      {top.length === 0 ? <p className="cp-muted">No post numbers yet - they appear after the first refresh.</p> : (
        <ul className="cp-list">
          {top.map((p) => (
            <li key={p.queue_id}>
              <strong>{fmt(p.views)} views</strong> · {PLATFORM_LABEL[p.platform]} · {p.permalink ? <a href={p.permalink} target="_blank" rel="noreferrer">{p.caption || 'open'}</a> : p.caption}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Monetization -> Opportunities: real audience only, no invented payouts.
function RealAudience() {
  const { data, error } = useMetrics();
  if (error === 'not-deployed') return <p className="cp-muted">Real audience numbers arrive with the next server update.</p>;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  return (
    <div className="cp-card">
      <h3>Your audience today (real)</h3>
      <table className="cp-kv"><tbody>
        <tr><td>Instagram followers</td><td>{dash(data.platforms.instagram.followers)}</td></tr>
        <tr><td>Facebook followers</td><td>{dash(data.platforms.facebook_page.followers)}</td></tr>
        <tr><td>Views on posts we can read</td><td>{dash(data.totals.views)}</td></tr>
      </tbody></table>
      <p className="cp-muted">
        The "program eligibility", "potential $/month" and opportunity list shown here before were made up by the
        old demo engine (it assumed 15,000 followers) and have been removed. Record real income in Record Income when it arrives.
      </p>
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
  if (!intel) return <p className="cp-muted">No intelligence data in the latest cycle.</p>;

  if (view === 'schedule') {
    return (
      <div>
        <RealWhatWorked view="schedule" />
        <div className="cp-card">
          <h3>Suggested posting times (Claude's research, not measured)</h3>
          <ul className="cp-list">
            {(intel.bestTimes || []).map((t, i) => <li key={i}>{t}</li>)}
          </ul>
        </div>
      </div>
    );
  }

  return (
    <div>
      <RealWhatWorked view="gaps" />
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
    </div>
  );
}

// ---------- Monetization ----------

export function MonetizationSection({ view }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [form, setForm] = useState({ platform: 'tiktok', source: 'creator_fund', amount: '', currency: 'GEL', note: '' });
  const [saved, setSaved] = useState(false);

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
    return <RealAudience />;
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
