import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import { ErrorBox, Loading, ConfirmButton, PLATFORM_NAME, fmtSlot } from './core';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';
// MySQL dateStrings ("YYYY-MM-DD HH:MM:SS") are not parseable on every
// browser (iOS Safari) - normalize to ISO before Date().
const fmtDate = (d) => {
  if (!d) return '—';
  const t = new Date(String(d).replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleString();
};

// Views over the queue; "Needs you" is what waits for the owner.
const QUEUE_VIEWS = [
  { id: 'needs', label: 'Needs you', test: (q) => ['pending_review', 'failed', 'unknown', 'in_drafts'].includes(q.status) },
  { id: 'scheduled', label: 'Scheduled & publishing', test: (q) => ['approved_publishing', 'publishing'].includes(q.status) },
  { id: 'published', label: 'Published', test: (q) => q.status === 'published' },
  { id: 'dropped', label: 'Dropped', test: (q) => q.status === 'dropped' },
  { id: 'all', label: 'All', test: () => true }
];
const COMMIT_ON_UPLOAD = ['tiktok', 'youtube'];

const parseJson = (t) => { try { return JSON.parse(t || 'null'); } catch { return null; } };

// What the autopilot did to this video, and the remake buttons.
function MagicNote({ prep, busy, onRemake }) {
  const copy = parseJson(prep.copy_json) || {};
  const sound = prep.sound_choice === 'rotated'
    ? 'circulated sound "' + (prep.sound_title || 'sound #' + prep.sound_media_id) + '"'
    : 'its own sound';
  return (
    <div className="cp-magic-note">
      {copy.what_it_shows && <div><strong>What it shows:</strong> {copy.what_it_shows}</div>}
      <div>
        <strong>Edit:</strong>{' '}
        {copy.hook ? 'hook "' + copy.hook + '" · ' : ''}
        {copy.end_line ? 'end line "' + copy.end_line + '" · ' : ''}
        Sam's logo · 🎵 {sound}
        {prep.writer === 'template' ? ' · captions are TEMPLATES (Claude was offline) - edit them before approving' : ''}
      </div>
      {prep.sound_choice === 'rotated' && prep.sound_url && (
        <audio controls preload="none" src={API_BASE + prep.sound_url} style={{ height: 30, marginTop: 6, maxWidth: '100%' }} />
      )}
      {prep.status === 'staged' && (
        <div className="cp-content-actions" style={{ marginTop: 6 }}>
          <ConfirmButton className="cp-btn small ghost" disabled={!!busy}
            label={prep.sound_choice === 'rotated' ? 'Remake with its own sound' : 'Remake with a circulated sound'}
            confirmLabel="Replace the posts below?"
            onConfirm={() => onRemake(prep.media_id, prep.sound_choice === 'rotated' ? 'own' : 'rotate')} />
          {prep.sound_choice === 'rotated' && (
            <ConfirmButton className="cp-btn small ghost" disabled={!!busy}
              label="Remake with the next sound" confirmLabel="Replace the posts below?"
              onConfirm={() => onRemake(prep.media_id, 'rotate')} />
          )}
        </div>
      )}
      {prep.status !== 'staged' && <div className="cp-muted">A new version is being made ({prep.status})…</div>}
    </div>
  );
}

const STATUS_PILL = {
  pending_review: 'warn',
  approved_publishing: 'warn',
  publishing: 'warn',
  published: 'ok',
  in_drafts: 'warn',
  failed: 'err',
  unknown: 'err',
  dropped: 'err'
};

export function PublishQueue() {
  const [queue, setQueue] = useState(null);
  const [media, setMedia] = useState([]);
  const [content, setContent] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(0);
  const [form, setForm] = useState({ media_id: '', caption: '', instagram: true, facebook_page: false, tiktok: false, youtube: false });
  // TikTok approve sheet: TikTok's rules require showing the creator info and
  // letting the owner pick privacy + interaction settings per post.
  const [tkSheet, setTkSheet] = useState(null);
  // YouTube approve sheet: a title (YouTube requires one) and who can watch.
  const [ytSheet, setYtSheet] = useState(null);
  const pollRef = useRef(null);
  const aliveRef = useRef(true);
  const [systemOn, setSystemOn] = useState(null);
  const [preps, setPreps] = useState({}); // source library video id -> autopilot preparation
  const [editing, setEditing] = useState(null); // {id, caption}
  const [view, setView] = useState('needs');
  // "Approve all" sheet for one video: every post of it that waits for review.
  const [groupSheet, setGroupSheet] = useState(null);
  // How each platform's posts go out: direct | drafts (TikTok) | wait
  const [routes, setRoutes] = useState({});
  const tiktokDrafts = routes.tiktok === 'drafts';

  const load = useCallback(() => {
    api.get('/api/publish-queue')
      .then((r) => {
        if (!aliveRef.current) return; // response landed after unmount
        setError(null); // a stale failure banner must clear once polling recovers
        setQueue(r.data.queue);
        setRoutes(r.data.routes || {});
        // Keep polling while anything is mid-publish (slower while rows only
        // wait for a later posting slot).
        const soon = Date.now() + 60000;
        const fast = r.data.queue.some((q) => q.status === 'publishing' ||
          (q.status === 'approved_publishing' && (!q.scheduled_at || Number(q.scheduled_at) <= soon || q.creation_id)));
        const slow = r.data.queue.some((q) => q.status === 'approved_publishing');
        clearTimeout(pollRef.current);
        if (fast) pollRef.current = setTimeout(load, 15000);
        else if (slow) pollRef.current = setTimeout(load, 60000);
      })
      .catch((e) => {
        if (!aliveRef.current) return;
        setError(e.response?.data?.error || e.message);
        // One failed poll must not end polling - a row may still be mid-publish.
        clearTimeout(pollRef.current);
        pollRef.current = setTimeout(load, 30000);
      });
    api.get('/api/media').then((r) => { if (aliveRef.current) setMedia(r.data.media.filter((m) => m.url_path && (m.kind === 'rendered' || m.kind === 'video'))); }).catch(() => {});
    api.get('/api/content?status=approved').then((r) => { if (aliveRef.current) setContent(r.data.content); }).catch(() => {});
    api.get('/api/autopilot').then((r) => { if (aliveRef.current) setSystemOn(!!r.data.enabled); }).catch(() => {});
    api.get('/api/prep').then((r) => {
      if (!aliveRef.current) return;
      const map = {};
      for (const p of r.data.preps || []) map[p.media_id] = p;
      setPreps(map);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => {
      aliveRef.current = false;
      clearTimeout(pollRef.current);
    };
  }, [load]);

  const CAPTION_LIMIT = { instagram: 2200, facebook_page: 5000, tiktok: 2200, youtube: 5000 };

  const [staging, setStaging] = useState(false);
  const stage = async (e) => {
    e.preventDefault();
    if (staging) return; // double-click must not stage duplicate rows
    setError(null); setNotice(null);
    const platforms = [form.instagram && 'instagram', form.facebook_page && 'facebook_page', form.tiktok && 'tiktok', form.youtube && 'youtube'].filter(Boolean);
    if (!platforms.length) { setError('Pick at least one platform'); return; }
    // Validate the caption against every selected platform BEFORE posting, so
    // a partial batch never starts with a request that is guaranteed to fail.
    const tooLong = platforms.find((p) => form.caption.length > CAPTION_LIMIT[p]);
    if (tooLong) {
      setError('Caption is ' + form.caption.length + ' characters - too long for ' + tooLong + ' (max ' + CAPTION_LIMIT[tooLong] + '). Shorten it or untick that platform.');
      return;
    }
    setStaging(true);
    const staged = [];
    let failedPlatform = null;
    let failure = null;
    for (const platform of platforms) {
      try {
        await api.post('/api/publish-queue', {
          platform,
          media_id: Number(form.media_id),
          caption: form.caption
        });
        staged.push(platform);
        setForm((f) => ({ ...f, [platform]: false })); // a resubmit retries only what failed
      } catch (err) {
        failedPlatform = platform;
        failure = err.response?.data?.error || err.message;
        break;
      }
    }
    if (failure) {
      setError((staged.length ? 'Staged for ' + staged.join(' + ') + ', but ' : '') +
        failedPlatform + ' failed: ' + failure +
        (staged.length ? ' - press Stage again to retry only the failed platform.' : ''));
    } else {
      setNotice('Staged for review. Nothing publishes until you approve it below.');
      setForm((f) => ({ ...f, caption: '', instagram: true }));
    }
    setStaging(false);
    load();
  };

  const act = async (id, action, body) => {
    setBusy(id); setError(null); setNotice(null);
    try {
      const r = await api.post(`/api/publish-queue/${id}/${action}`, body || {});
      if (r.data && r.data.note) setNotice('#' + id + ': ' + r.data.note);
      setTkSheet(null);
      setYtSheet(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(0);
    }
  };

  // Open the TikTok options sheet for a row (fetches creator info first).
  const openTkSheet = async (row) => {
    const id = row.id;
    setError(null);
    setGroupSheet(null);
    setTkSheet({ id, loading: true, privacy_level: '', disable_comment: false, disable_duet: false, disable_stitch: false, when: row.prep_media_id ? 'slot' : 'now' });
    try {
      const r = await api.get('/api/tiktok/creator-info');
      setTkSheet((s) => (s && s.id === id ? { ...s, loading: false, creator: r.data.creator } : s));
    } catch (err) {
      setTkSheet((s) => (s && s.id === id ? { ...s, loading: false, error: err.response?.data?.error || err.message } : s));
    }
  };

  // Open the YouTube options sheet (fetches the connected channel first, so
  // the owner sees exactly which channel the video goes to).
  const openYtSheet = async (row) => {
    setError(null);
    setGroupSheet(null);
    const firstLine = Array.from(String(row.caption || '').split('\n')[0].replace(/[<>]/g, '').trim()).slice(0, 100).join('');
    // Autopilot rows carry the title Claude wrote for them.
    const preset = parseJson(row.post_options);
    const title = preset && preset.title ? String(preset.title) : firstLine;
    setYtSheet({ id: row.id, loading: true, title, privacy_status: '', when: row.prep_media_id ? 'slot' : 'now' });
    try {
      const r = await api.get('/api/youtube/channel-info');
      setYtSheet((s) => (s && s.id === row.id ? { ...s, loading: false, channel: r.data.channel, audited: r.data.audited, options: r.data.privacy_options } : s));
    } catch (err) {
      setYtSheet((s) => (s && s.id === row.id ? { ...s, loading: false, error: err.response?.data?.error || err.message } : s));
    }
  };

  // One decision per video: watch it once, read the captions, approve them all.
  // TikTok and YouTube still get their explicit choices (who can watch).
  const openGroupSheet = async (g) => {
    const pending = g.rows.filter((q) => q.status === 'pending_review');
    const yt = pending.find((q) => q.platform === 'youtube');
    const preset = yt ? parseJson(yt.post_options) : null;
    // Drafts route: who can watch etc. is chosen in the TikTok app itself.
    const wantTk = pending.some((q) => q.platform === 'tiktok') && !tiktokDrafts;
    setError(null);
    setTkSheet(null);
    setYtSheet(null);
    setGroupSheet({
      media_id: g.media_id,
      ids: pending.map((q) => q.id),
      when: g.prep ? 'slot' : 'now',
      tk: wantTk ? { loading: true, privacy_level: '', disable_comment: false, disable_duet: false, disable_stitch: false } : null,
      yt: yt ? {
        loading: true,
        privacy_status: '',
        title: preset && preset.title ? String(preset.title)
          : Array.from(String(yt.caption || '').split('\n')[0].replace(/[<>]/g, '').trim()).slice(0, 100).join('')
      } : null
    });
    const patch = (key, fields) => setGroupSheet((gs) => (gs && gs.media_id === g.media_id && gs[key]
      ? { ...gs, [key]: { ...gs[key], ...fields } } : gs));
    if (wantTk) {
      api.get('/api/tiktok/creator-info')
        .then((r) => patch('tk', { loading: false, creator: r.data.creator }))
        .catch((err) => patch('tk', { loading: false, error: err.response?.data?.error || err.message }));
    }
    if (yt) {
      api.get('/api/youtube/channel-info')
        .then((r) => patch('yt', { loading: false, channel: r.data.channel, audited: r.data.audited, options: r.data.privacy_options }))
        .catch((err) => patch('yt', { loading: false, error: err.response?.data?.error || err.message }));
    }
  };

  const approveGroup = async () => {
    const gs = groupSheet;
    if (!gs) return;
    setBusy(-1); setError(null); setNotice(null);
    const rows = (queue || []).filter((q) => gs.ids.includes(q.id) && q.status === 'pending_review');
    const done = [];
    const failed = [];
    for (const q of rows) {
      const body = { when: gs.when };
      if (q.platform === 'tiktok' && gs.tk) {
        Object.assign(body, {
          privacy_level: gs.tk.privacy_level,
          disable_comment: gs.tk.disable_comment,
          disable_duet: gs.tk.disable_duet,
          disable_stitch: gs.tk.disable_stitch
        });
      }
      if (q.platform === 'youtube') Object.assign(body, { title: gs.yt.title, privacy_status: gs.yt.privacy_status });
      try {
        await api.post(`/api/publish-queue/${q.id}/approve`, body);
        done.push(PLATFORM_NAME[q.platform] || q.platform);
      } catch (err) {
        failed.push((PLATFORM_NAME[q.platform] || q.platform) + ': ' + (err.response?.data?.error || err.message));
      }
    }
    setGroupSheet(null);
    setBusy(0);
    if (failed.length) {
      setError('Approved: ' + (done.join(', ') || 'nothing') + '. Not approved - ' + failed.join(' | '));
    } else {
      setNotice('Approved ' + done.join(', ') +
        (gs.when === 'slot' ? ' - each goes out in its next posting slot.' : ' - publishing right away.') +
        (systemOn === false ? ' The system is OFF, so they wait until you switch it ON on the Dashboard.' : ''));
    }
    load();
  };

  // TikTok drafts carry no caption - the owner pastes it in the TikTok app.
  const copyCaption = async (q) => {
    setError(null);
    try {
      await navigator.clipboard.writeText(String(q.caption || ''));
      setNotice('#' + q.id + ': caption copied - open the video from your TikTok inbox and paste it.');
    } catch {
      setError('Could not copy automatically - press and hold the caption text to copy it.');
    }
  };

  const saveCaption = async () => {
    if (!editing) return;
    setBusy(editing.id); setError(null);
    try {
      await api.put(`/api/publish-queue/${editing.id}/caption`, { caption: editing.caption });
      setEditing(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(0);
    }
  };

  const remake = async (mediaId, sound) => {
    setBusy(-mediaId); setError(null); setNotice(null);
    try {
      await api.post(`/api/prep/${mediaId}/again`, { sound });
      setNotice('A new version is being made - it replaces the posts waiting for review and appears here when ready (a few minutes, the video worker on your PC must be running).');
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(0);
    }
  };

  const useCaption = (id) => {
    const c = content.find((x) => String(x.id) === String(id));
    if (c) setForm((f) => ({ ...f, caption: c.caption }));
  };

  // ----- harvest of the account's own top videos -----
  const [harvest, setHarvest] = useState(null);
  const harvestPollRef = useRef(null);

  const pollHarvest = useCallback(() => {
    api.get('/api/harvest/status')
      .then((r) => {
        if (!aliveRef.current) return;
        setHarvest(r.data);
        clearTimeout(harvestPollRef.current);
        if (r.data.running) {
          harvestPollRef.current = setTimeout(pollHarvest, 5000);
        } else if (r.data.finishedAt) {
          load(); // staged rows just landed in the queue below
        }
      })
      .catch(() => {
        if (!aliveRef.current) return;
        // One failed poll must not freeze the card mid-harvest.
        clearTimeout(harvestPollRef.current);
        harvestPollRef.current = setTimeout(pollHarvest, 30000);
      });
  }, [load]);

  useEffect(() => {
    // Pick up an already-running harvest on mount (reload, second device) -
    // the poll self-stops when idle.
    pollHarvest();
    return () => clearTimeout(harvestPollRef.current);
  }, [pollHarvest]);

  const startHarvest = async () => {
    setError(null); setNotice(null);
    // Optimistic lock so a double-click cannot fire a second POST and show a
    // confusing "already running" error right after starting.
    setHarvest((h) => ({ ...(h || {}), running: true, scanned: 0, staged: 0 }));
    try {
      await api.post('/api/harvest/top', { min_views: 5000, limit: 12 });
      setNotice('Harvest started - your 5K+ view videos are being pulled in. They will appear below as pending review.');
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
    pollHarvest();
  };

  if (error && queue === null) return <ErrorBox error={error} />;

  // One card per video: watch it once, then approve each platform's post.
  const viewTest = (QUEUE_VIEWS.find((v) => v.id === view) || QUEUE_VIEWS[0]).test;
  const groups = [];
  const byMedia = new Map();
  for (const q of (queue || []).filter(viewTest)) {
    let g = byMedia.get(q.media_id);
    if (!g) {
      g = { media_id: q.media_id, url_path: q.url_path, title: q.media_title, rows: [], prep: null };
      byMedia.set(q.media_id, g);
      groups.push(g);
    }
    g.rows.push(q);
    if (q.prep_media_id && preps[q.prep_media_id] && Number(preps[q.prep_media_id].output_media_id) === Number(q.media_id)) {
      g.prep = preps[q.prep_media_id];
    }
  }

  const statusLabel = (q) => {
    if (q.status === 'in_drafts') return 'in your TikTok inbox - post it from the TikTok app';
    if (q.status === 'approved_publishing') {
      const committed = q.creation_id && COMMIT_ON_UPLOAD.includes(q.platform);
      if (committed || q.creation_id) return 'publishing';
      // TikTok / YouTube do not show this system's posts publicly yet - the
      // post waits instead of being refused or locked Private.
      if (q.waiting_route) return 'approved - waiting until ' + (PLATFORM_NAME[q.platform] || q.platform) + ' allows public posting';
      if (systemOn === false) return 'approved - waiting (system OFF)';
      if (q.scheduled_at && Number(q.scheduled_at) > Date.now()) return 'scheduled ' + fmtSlot(q.scheduled_at);
      return 'publishing soon';
    }
    return q.status.replace('_', ' ');
  };

  const whenSelect = (sheet, setSheet) => (
    <label>When
      <select value={sheet.when} onChange={(e) => setSheet({ ...sheet, when: e.target.value })}>
        <option value="slot">Next free posting slot</option>
        <option value="now">Right away</option>
      </select>
    </label>
  );

  const groupReady = (gs) => !!gs &&
    (!gs.tk || (!gs.tk.loading && !gs.tk.error && gs.tk.privacy_level)) &&
    (!gs.yt || (!gs.yt.loading && !gs.yt.error && gs.yt.privacy_status && String(gs.yt.title || '').trim()));

  const renderGroupSheet = (g) => {
    const pending = g.rows.filter((q) => q.status === 'pending_review');
    if (pending.length < 2) return null;
    const gs = groupSheet && groupSheet.media_id === g.media_id ? groupSheet : null;
    if (!gs) {
      return (
        <div className="cp-content-actions" style={{ marginTop: 8 }}>
          <button className="cp-btn small" disabled={!!busy} onClick={() => openGroupSheet(g)}>
            Approve all {pending.length} posts of this video…
          </button>
        </div>
      );
    }
    return (
      <div className="cp-card" style={{ marginTop: 10, background: 'var(--cp-bg, #faf7f4)' }}>
        <strong>Approve all {gs.ids.length} posts: {pending.map((q) => PLATFORM_NAME[q.platform] || q.platform).join(', ')}</strong>
        <p className="cp-muted" style={{ margin: '6px 0' }}>Each post goes out with the caption shown above it.</p>
        {tiktokDrafts && pending.some((q) => q.platform === 'tiktok') && (
          <p className="cp-muted" style={{ margin: '6px 0' }}>
            TikTok: at its slot the video arrives in your TikTok inbox (Inbox → System notifications) - tap it, paste the caption and post it from the TikTok app.
          </p>
        )}
        <div className="cp-form">
          {whenSelect(gs, setGroupSheet)}
          {gs.tk && (gs.tk.loading ? <Loading /> : gs.tk.error ? (
            <p className="cp-muted">TikTok: could not load creator info - {gs.tk.error}</p>
          ) : (
            <>
              <label>TikTok - who can watch
                <select value={gs.tk.privacy_level}
                  onChange={(e) => setGroupSheet({ ...gs, tk: { ...gs.tk, privacy_level: e.target.value } })}>
                  <option value="">— choose —</option>
                  {((gs.tk.creator && gs.tk.creator.privacy_level_options) || ['SELF_ONLY']).map((p) => (
                    <option key={p} value={p}>{{
                      PUBLIC_TO_EVERYONE: 'Everyone (public)',
                      MUTUAL_FOLLOW_FRIENDS: 'Friends (mutual follows)',
                      FOLLOWER_OF_CREATOR: 'Followers',
                      SELF_ONLY: 'Only me (private)'
                    }[p] || p}</option>
                  ))}
                </select>
              </label>
              {gs.tk.creator && (
                <p className="cp-muted" style={{ margin: '4px 0' }}>
                  TikTok posts as <strong>{gs.tk.creator.creator_nickname || gs.tk.creator.creator_username || 'the connected account'}</strong>
                  {gs.tk.creator.unaudited ? ' - only "Only me (private)" until TikTok approves our app review.' : ''}
                </p>
              )}
              <label className="cp-check">
                <input type="checkbox" checked={gs.tk.disable_comment}
                  disabled={!!(gs.tk.creator && gs.tk.creator.comment_disabled)}
                  onChange={(e) => setGroupSheet({ ...gs, tk: { ...gs.tk, disable_comment: e.target.checked } })} /> TikTok: turn off comments
              </label>
              <label className="cp-check">
                <input type="checkbox" checked={gs.tk.disable_duet}
                  disabled={!!(gs.tk.creator && gs.tk.creator.duet_disabled)}
                  onChange={(e) => setGroupSheet({ ...gs, tk: { ...gs.tk, disable_duet: e.target.checked } })} /> TikTok: turn off Duet
              </label>
              <label className="cp-check">
                <input type="checkbox" checked={gs.tk.disable_stitch}
                  disabled={!!(gs.tk.creator && gs.tk.creator.stitch_disabled)}
                  onChange={(e) => setGroupSheet({ ...gs, tk: { ...gs.tk, disable_stitch: e.target.checked } })} /> TikTok: turn off Stitch
              </label>
            </>
          ))}
          {gs.yt && (gs.yt.loading ? <Loading /> : gs.yt.error ? (
            <p className="cp-muted">YouTube: could not load the channel - {gs.yt.error}</p>
          ) : (
            <>
              <label className="cp-form-wide">YouTube title (max 100 characters)
                <input type="text" value={gs.yt.title} maxLength={100}
                  onChange={(e) => setGroupSheet({ ...gs, yt: { ...gs.yt, title: e.target.value } })} />
              </label>
              <label>YouTube - who can watch
                <select value={gs.yt.privacy_status}
                  onChange={(e) => setGroupSheet({ ...gs, yt: { ...gs.yt, privacy_status: e.target.value } })}>
                  <option value="">— choose —</option>
                  {(gs.yt.options || ['private']).map((p) => (
                    <option key={p} value={p}>{{
                      private: 'Private (only you)',
                      unlisted: 'Unlisted (anyone with the link)',
                      public: 'Public (everyone)'
                    }[p] || p}</option>
                  ))}
                </select>
              </label>
              {gs.yt.channel && (
                <p className="cp-muted" style={{ margin: '4px 0' }}>
                  YouTube uploads to <strong>{gs.yt.channel.title}</strong>{gs.yt.audited ? '' : ' - Private only until Google audits our project.'}
                  {' '}By uploading you agree to the{' '}
                  <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a>.
                </p>
              )}
            </>
          ))}
        </div>
        <div className="cp-content-actions">
          <button className="cp-btn small ghost" onClick={() => setGroupSheet(null)}>Cancel</button>
          <ConfirmButton className="cp-btn small" disabled={!!busy || !groupReady(gs)}
            label={'Approve all ' + gs.ids.length + (gs.when === 'slot' ? ' · next slots' : ' · publish now')}
            confirmLabel="Tap again - these post for real"
            onConfirm={approveGroup} />
        </div>
      </div>
    );
  };

  const renderRow = (q) => (
    <div className="cp-post-row" key={q.id}>
      <div className="cp-content-head">
        <strong>{PLATFORM_NAME[q.platform] || q.platform} · #{q.id}</strong>
        <span className={`cp-pill ${STATUS_PILL[q.status] || 'warn'}`}>{statusLabel(q)}</span>
      </div>
      {q.platform === 'tiktok' && tiktokDrafts && ['pending_review', 'failed', 'approved_publishing'].includes(q.status) && (
        <p className="cp-muted" style={{ margin: '4px 0' }}>Arrives in your TikTok inbox at its slot (Inbox → System notifications) - you post it from the TikTok app.</p>
      )}
      {q.status === 'in_drafts' && (() => {
        // TikTok's inbox upload carries the video only (its API takes no
        // caption or settings for inbox videos) - so the panel hands the owner
        // the caption with every hashtag, and the settings to tick in the app.
        const o = parseJson(q.post_options) || {};
        const onOff = (off) => (off ? 'off' : 'on');
        return (
          <div className="cp-magic-note" style={{ marginTop: 6 }}>
            <div><strong>In your TikTok inbox</strong> (TikTok → Inbox → System notifications → tap the video - it is not in your profile's Drafts folder).</div>
            <div style={{ marginTop: 4 }}>1. <strong>Copy caption</strong> below (all the hashtags are in it) and paste it as the TikTok description.</div>
            <div>2. Set: Who can watch → <strong>Everyone</strong> · Comments → <strong>{onOff(o.disable_comment)}</strong> · Duet → <strong>{onOff(o.disable_duet)}</strong> · Stitch → <strong>{onOff(o.disable_stitch)}</strong>.</div>
            <div>3. Post. The panel marks it published within about 10 minutes.</div>
          </div>
        );
      })()}
      {q.platform === 'youtube' && parseJson(q.post_options) && parseJson(q.post_options).title && (
        <p className="cp-muted" style={{ margin: '4px 0' }}>Title: {parseJson(q.post_options).title}</p>
      )}
      {editing && editing.id === q.id ? (
        <div>
          <textarea rows={5} value={editing.caption} maxLength={5000} style={{ width: '100%' }}
            onChange={(e) => setEditing({ ...editing, caption: e.target.value })} />
          <div className="cp-content-actions">
            <button className="cp-btn small" disabled={busy === q.id} onClick={saveCaption}>Save caption</button>
            <button className="cp-btn small ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <p className="cp-caption">{q.caption}</p>
      )}
      <div className="cp-content-actions">
        <span className="cp-muted">
          {fmtDate(q.created_at)}
          {q.error ? ' · ' + String(q.error).slice(0, 140) : ''}
          {q.permalink ? <> · <a href={q.permalink} target="_blank" rel="noreferrer">view post</a></> : null}
        </span>
        {['pending_review', 'failed'].includes(q.status) && (
          q.platform === 'tiktok' && !tiktokDrafts ? (
            <button className="cp-btn small" disabled={busy === q.id} onClick={() => openTkSheet(q)}>
              {q.status === 'failed' ? 'Retry' : 'Approve…'}
            </button>
          ) : q.platform === 'youtube' ? (
            <button className="cp-btn small" disabled={busy === q.id} onClick={() => openYtSheet(q)}>
              {q.status === 'failed' ? 'Retry' : 'Approve…'}
            </button>
          ) : (
            <>
              <ConfirmButton className="cp-btn small" disabled={busy === q.id}
                label={q.status === 'failed' ? 'Retry · next slot' : 'Approve · next slot'}
                confirmLabel="Tap again to approve"
                onConfirm={() => act(q.id, 'approve', { when: 'slot' })} />
              <ConfirmButton className="cp-btn small ghost" disabled={busy === q.id}
                label="Approve · publish now"
                confirmLabel="Publish for real?"
                onConfirm={() => act(q.id, 'approve', { when: 'now' })} />
            </>
          )
        )}
        {['pending_review', 'failed'].includes(q.status) && !(editing && editing.id === q.id) && (
          <button className="cp-btn small ghost" disabled={busy === q.id}
            onClick={() => setEditing({ id: q.id, caption: q.caption })}>Edit caption</button>
        )}
        {q.status === 'approved_publishing' && !q.creation_id && !q.waiting_route && q.scheduled_at && Number(q.scheduled_at) > Date.now() && (
          <ConfirmButton className="cp-btn small ghost" disabled={busy === q.id}
            label="Publish now instead" confirmLabel="Publish for real?"
            onConfirm={() => act(q.id, 'now')} />
        )}
        {q.status === 'unknown' && (
          <span className="cp-muted">Check the account before acting - this post may already be live.</span>
        )}
        {q.status === 'in_drafts' && (
          <>
            <button className="cp-btn" disabled={busy === q.id} onClick={() => copyCaption(q)}>Copy caption</button>
            <ConfirmButton className="cp-btn small ghost" disabled={busy === q.id}
              label="I posted it" confirmLabel="Posted on TikTok?" onConfirm={() => act(q.id, 'posted')} />
          </>
        )}
        {['pending_review', 'failed', 'approved_publishing', 'unknown', 'in_drafts'].includes(q.status) && (
          <ConfirmButton className="cp-btn small ghost" disabled={busy === q.id}
            label={q.status === 'in_drafts' ? 'Not posting it' : 'Drop'} confirmLabel="Really drop?" onConfirm={() => act(q.id, 'drop')} />
        )}
      </div>
      {ytSheet && ytSheet.id === q.id && (
        <div className="cp-card" style={{ marginTop: 10, background: 'var(--cp-bg, #faf7f4)' }}>
          <strong>YouTube upload options</strong>
          {ytSheet.loading ? <Loading /> : ytSheet.error ? (
            <p className="cp-muted">Could not load the channel: {ytSheet.error}</p>
          ) : (
            <>
              {ytSheet.channel && (
                <p className="cp-muted" style={{ margin: '6px 0' }}>
                  Uploading to channel <strong>{ytSheet.channel.title}</strong>
                </p>
              )}
              {!ytSheet.audited && (
                <p className="cp-muted" style={{ margin: '6px 0' }}>
                  Until Google audits our YouTube API project, uploads are locked to <strong>Private</strong> -
                  YouTube won't let them be made public, even from YouTube Studio, until the audit passes.
                </p>
              )}
              <div className="cp-form">
                <label className="cp-form-wide">Title (max 100 characters)
                  <input type="text" value={ytSheet.title} maxLength={100}
                    onChange={(e) => setYtSheet({ ...ytSheet, title: e.target.value })} />
                </label>
                <label>Who can watch this video
                  <select value={ytSheet.privacy_status}
                    onChange={(e) => setYtSheet({ ...ytSheet, privacy_status: e.target.value })}>
                    <option value="">— choose —</option>
                    {(ytSheet.options || ['private']).map((p) => (
                      <option key={p} value={p}>{{
                        private: 'Private (only you)',
                        unlisted: 'Unlisted (anyone with the link)',
                        public: 'Public (everyone)'
                      }[p] || p}</option>
                    ))}
                  </select>
                </label>
                {whenSelect(ytSheet, setYtSheet)}
              </div>
              <p className="cp-muted" style={{ margin: '6px 0' }}>The caption above becomes the video description. Marked "not made for kids".</p>
              <p className="cp-muted" style={{ margin: '6px 0' }}>
                By uploading you agree to the{' '}
                <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a>.
              </p>
            </>
          )}
          <div className="cp-content-actions">
            <button className="cp-btn small ghost" onClick={() => setYtSheet(null)}>Cancel</button>
            <ConfirmButton className="cp-btn small"
              disabled={busy === q.id || ytSheet.loading || !!ytSheet.error || !ytSheet.privacy_status || !String(ytSheet.title || '').trim()}
              label={ytSheet.when === 'slot' ? 'Confirm · upload at next slot' : 'Confirm & upload to YouTube'}
              confirmLabel="Tap again - this uploads for real"
              onConfirm={() => act(q.id, 'approve', {
                title: ytSheet.title,
                privacy_status: ytSheet.privacy_status,
                when: ytSheet.when
              })} />
          </div>
        </div>
      )}
      {tkSheet && tkSheet.id === q.id && (
        <div className="cp-card" style={{ marginTop: 10, background: 'var(--cp-bg, #faf7f4)' }}>
          <strong>TikTok posting options</strong>
          {tkSheet.loading ? <Loading /> : tkSheet.error ? (
            <p className="cp-muted">Could not load creator info: {tkSheet.error}</p>
          ) : (
            <>
              {tkSheet.creator && (
                <p className="cp-muted" style={{ margin: '6px 0' }}>
                  Posting as <strong>{tkSheet.creator.creator_nickname || tkSheet.creator.creator_username || 'connected account'}</strong>
                  {tkSheet.creator.creator_username ? ' (@' + tkSheet.creator.creator_username + ')' : ''}
                </p>
              )}
              {tkSheet.creator && tkSheet.creator.unaudited && (
                <p className="cp-muted" style={{ margin: '6px 0' }}>
                  Until TikTok approves our app review, TikTok only accepts <strong>Only me (private)</strong> posts.
                  The video still lands on the profile - visible to the account only.
                </p>
              )}
              <div className="cp-form">
                <label>Who can watch this video
                  <select value={tkSheet.privacy_level}
                    onChange={(e) => setTkSheet({ ...tkSheet, privacy_level: e.target.value })}>
                    <option value="">— choose —</option>
                    {((tkSheet.creator && tkSheet.creator.privacy_level_options) || ['SELF_ONLY']).map((p) => (
                      <option key={p} value={p}>{{
                        PUBLIC_TO_EVERYONE: 'Everyone (public)',
                        MUTUAL_FOLLOW_FRIENDS: 'Friends (mutual follows)',
                        FOLLOWER_OF_CREATOR: 'Followers',
                        SELF_ONLY: 'Only me (private)'
                      }[p] || p}</option>
                    ))}
                  </select>
                </label>
                {whenSelect(tkSheet, setTkSheet)}
                <label className="cp-check">
                  <input type="checkbox" checked={tkSheet.disable_comment}
                    disabled={!!(tkSheet.creator && tkSheet.creator.comment_disabled)}
                    onChange={(e) => setTkSheet({ ...tkSheet, disable_comment: e.target.checked })} /> Turn off comments
                </label>
                <label className="cp-check">
                  <input type="checkbox" checked={tkSheet.disable_duet}
                    disabled={!!(tkSheet.creator && tkSheet.creator.duet_disabled)}
                    onChange={(e) => setTkSheet({ ...tkSheet, disable_duet: e.target.checked })} /> Turn off Duet
                </label>
                <label className="cp-check">
                  <input type="checkbox" checked={tkSheet.disable_stitch}
                    disabled={!!(tkSheet.creator && tkSheet.creator.stitch_disabled)}
                    onChange={(e) => setTkSheet({ ...tkSheet, disable_stitch: e.target.checked })} /> Turn off Stitch
                </label>
              </div>
            </>
          )}
          <div className="cp-content-actions">
            <button className="cp-btn small ghost" onClick={() => setTkSheet(null)}>Cancel</button>
            <ConfirmButton className="cp-btn small"
              disabled={busy === q.id || tkSheet.loading || !tkSheet.privacy_level}
              label={tkSheet.when === 'slot' ? 'Confirm · post at next slot' : 'Confirm & publish to TikTok'}
              confirmLabel="Tap again - this posts for real"
              onConfirm={() => act(q.id, 'approve', {
                privacy_level: tkSheet.privacy_level,
                disable_comment: tkSheet.disable_comment,
                disable_duet: tkSheet.disable_duet,
                disable_stitch: tkSheet.disable_stitch,
                when: tkSheet.when
              })} />
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div>
      <ErrorBox error={error} />
      {notice && <div className="cp-success">{notice}</div>}

      <div className="cp-card">
        <h3>Harvest your top posts</h3>
        <p className="cp-muted">
          Pulls your own Instagram and Facebook videos with 5,000+ views into the media
          library and stages them below as reposts. Nothing publishes without your Approve.
        </p>
        <button className="cp-btn" onClick={startHarvest} disabled={harvest && harvest.running}>
          {harvest && harvest.running ? 'Harvesting…' : 'Harvest 5K+ view videos'}
        </button>
        {harvest && (
          <p className="cp-muted" style={{ marginTop: 8 }}>
            {harvest.running ? 'Running… ' : harvest.finishedAt ? 'Last run: ' : ''}
            scanned {harvest.scanned} · staged {harvest.staged}
            {harvest.error ? ' · failed: ' + harvest.error : ''}
            {!harvest.running && harvest.skipped && harvest.skipped.length > 0 && (
              <> · skipped {harvest.skipped.length}: {harvest.skipped.slice(-3).join('; ')}</>
            )}
          </p>
        )}
      </div>

      <div className="cp-card">
        <h3>Stage a post for review</h3>
        <p className="cp-muted">
          Staging is safe - a staged post sits here until you watch it and press Approve.
          Only server-hosted videos (rendered output or uploads) can be published.
        </p>
        <form onSubmit={stage}>
          <div className="cp-form">
            <label>Video
              <select value={form.media_id} required onChange={(e) => setForm({ ...form, media_id: e.target.value })}>
                <option value="">— pick a video —</option>
                {media.map((m) => <option key={m.id} value={m.id}>#{m.id} {m.title || m.kind}</option>)}
              </select>
            </label>
            <label>Copy caption from approved content
              <select onChange={(e) => useCaption(e.target.value)} defaultValue="">
                <option value="">— optional —</option>
                {content.map((c) => <option key={c.id} value={c.id}>#{c.id} {c.title}</option>)}
              </select>
            </label>
            <label className="cp-check"><input type="checkbox" checked={form.instagram}
              onChange={(e) => setForm({ ...form, instagram: e.target.checked })} /> Instagram</label>
            <label className="cp-check"><input type="checkbox" checked={form.facebook_page}
              onChange={(e) => setForm({ ...form, facebook_page: e.target.checked })} /> Facebook Page</label>
            <label className="cp-check"><input type="checkbox" checked={form.tiktok}
              onChange={(e) => setForm({ ...form, tiktok: e.target.checked })} /> TikTok</label>
            <label className="cp-check"><input type="checkbox" checked={form.youtube}
              onChange={(e) => setForm({ ...form, youtube: e.target.checked })} /> YouTube</label>
          </div>
          <label className="cp-caption-label">Caption
            <textarea
              required
              rows={3}
              value={form.caption}
              maxLength={5000}
              onChange={(e) => setForm({ ...form, caption: e.target.value })}
              placeholder="Exactly what will appear under the post"
            />
          </label>
          <button className="cp-btn" type="submit" disabled={staging}>{staging ? 'Staging…' : 'Stage for review'}</button>
        </form>
      </div>

      <div className="cp-card">
        <h3>Review queue</h3>
        {systemOn === false && queue && queue.some((q) => q.status === 'approved_publishing') && (
          <div className="cp-magic-note">
            The system is switched <strong>OFF</strong> - approved posts are waiting and will go out once you
            switch it ON on the Dashboard.
          </div>
        )}
        <div className="cp-content-actions" style={{ marginBottom: 12 }}>
          {QUEUE_VIEWS.map((v) => (
            <button key={v.id} type="button" className={'cp-btn small' + (view === v.id ? '' : ' ghost')} onClick={() => setView(v.id)}>
              {v.label} ({queue ? queue.filter(v.test).length : 0})
            </button>
          ))}
        </div>
        {queue === null ? <Loading /> : groups.length === 0 ? (
          <p className="cp-muted">
            {queue.length === 0
              ? 'Nothing staged. Content only reaches the real accounts through this queue.'
              : 'Nothing in this view.'}
          </p>
        ) : (
          <div className="cp-content-list">
            {groups.map((g) => (
              <div className="cp-card cp-content-item" key={g.media_id}>
                <div className="cp-content-head">
                  <strong>{g.title || 'video #' + g.media_id}</strong>
                  {g.prep && <span className="cp-pill ok">✨ prepared by autopilot</span>}
                </div>
                <div className="cp-video-group">
                  <div>
                    {g.url_path ? (
                      <video controls preload="metadata" className="cp-review-video" src={API_BASE + g.url_path} />
                    ) : <span className="cp-muted">video file missing on the server</span>}
                  </div>
                  <div>
                    {g.prep && <MagicNote prep={g.prep} busy={busy} onRemake={remake} />}
                    {g.rows.map(renderRow)}
                    {renderGroupSheet(g)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
