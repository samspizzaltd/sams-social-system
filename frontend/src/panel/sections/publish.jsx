import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import { ErrorBox, Loading, ConfirmButton } from './core';

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';
// MySQL dateStrings ("YYYY-MM-DD HH:MM:SS") are not parseable on every
// browser (iOS Safari) - normalize to ISO before Date().
const fmtDate = (d) => {
  if (!d) return '—';
  const t = new Date(String(d).replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleString();
};

const STATUS_PILL = {
  pending_review: 'warn',
  approved_publishing: 'warn',
  publishing: 'warn',
  published: 'ok',
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
  const [form, setForm] = useState({ media_id: '', caption: '', instagram: true, facebook_page: false, tiktok: false });
  // TikTok approve sheet: TikTok's rules require showing the creator info and
  // letting the owner pick privacy + interaction settings per post.
  const [tkSheet, setTkSheet] = useState(null);
  const pollRef = useRef(null);
  const aliveRef = useRef(true);

  const load = useCallback(() => {
    api.get('/api/publish-queue')
      .then((r) => {
        if (!aliveRef.current) return; // response landed after unmount
        setError(null); // a stale failure banner must clear once polling recovers
        setQueue(r.data.queue);
        // Keep polling while anything is mid-publish.
        const active = r.data.queue.some((q) => q.status === 'approved_publishing' || q.status === 'publishing');
        clearTimeout(pollRef.current);
        if (active) pollRef.current = setTimeout(load, 15000);
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
  }, []);

  useEffect(() => {
    aliveRef.current = true;
    load();
    return () => {
      aliveRef.current = false;
      clearTimeout(pollRef.current);
    };
  }, [load]);

  const CAPTION_LIMIT = { instagram: 2200, facebook_page: 5000, tiktok: 2200 };

  const [staging, setStaging] = useState(false);
  const stage = async (e) => {
    e.preventDefault();
    if (staging) return; // double-click must not stage duplicate rows
    setError(null); setNotice(null);
    const platforms = [form.instagram && 'instagram', form.facebook_page && 'facebook_page', form.tiktok && 'tiktok'].filter(Boolean);
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
    setBusy(id); setError(null);
    try {
      await api.post(`/api/publish-queue/${id}/${action}`, body || {});
      setTkSheet(null);
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setBusy(0);
    }
  };

  // Open the TikTok options sheet for a row (fetches creator info first).
  const openTkSheet = async (id) => {
    setError(null);
    setTkSheet({ id, loading: true, privacy_level: '', disable_comment: false, disable_duet: false, disable_stitch: false });
    try {
      const r = await api.get('/api/tiktok/creator-info');
      setTkSheet((s) => (s && s.id === id ? { ...s, loading: false, creator: r.data.creator } : s));
    } catch (err) {
      setTkSheet((s) => (s && s.id === id ? { ...s, loading: false, error: err.response?.data?.error || err.message } : s));
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
        {queue === null ? <Loading /> : queue.length === 0 ? (
          <p className="cp-muted">Nothing staged. Content only reaches the real accounts through this queue.</p>
        ) : (
          <div className="cp-content-list">
            {queue.map((q) => (
              <div className="cp-card cp-content-item" key={q.id}>
                <div className="cp-content-head">
                  <strong>#{q.id} · {q.platform === 'instagram' ? 'Instagram' : q.platform === 'tiktok' ? 'TikTok' : 'Facebook Page'} · {q.media_title || 'video #' + q.media_id}</strong>
                  <span className={`cp-pill ${STATUS_PILL[q.status] || 'warn'}`}>{q.status.replace('_', ' ')}</span>
                </div>
                {q.url_path && (
                  <video controls preload="metadata" className="cp-review-video"
                    src={API_BASE + q.url_path} />
                )}
                <p className="cp-caption">{q.caption}</p>
                <div className="cp-content-actions">
                  <span className="cp-muted">
                    {fmtDate(q.created_at)}
                    {q.error ? ' · ' + String(q.error).slice(0, 140) : ''}
                    {q.permalink ? <> · <a href={q.permalink} target="_blank" rel="noreferrer">view post</a></> : null}
                  </span>
                  {['pending_review', 'failed'].includes(q.status) && (
                    q.platform === 'tiktok' ? (
                      <button className="cp-btn small" disabled={busy === q.id} onClick={() => openTkSheet(q.id)}>
                        {q.status === 'failed' ? 'Retry' : 'Approve & publish'}
                      </button>
                    ) : (
                      <ConfirmButton className="cp-btn small" disabled={busy === q.id}
                        label={q.status === 'failed' ? 'Retry' : 'Approve & publish'}
                        confirmLabel="Publish for real?"
                        onConfirm={() => act(q.id, 'approve')} />
                    )
                  )}
                  {q.status === 'unknown' && (
                    <span className="cp-muted">Check the account before acting - this post may already be live.</span>
                  )}
                  {['pending_review', 'failed', 'approved_publishing', 'unknown'].includes(q.status) && (
                    <ConfirmButton className="cp-btn small ghost" disabled={busy === q.id}
                      label="Drop" confirmLabel="Really drop?" onConfirm={() => act(q.id, 'drop')} />
                  )}
                </div>
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
                        label="Confirm & publish to TikTok"
                        confirmLabel="Tap again - this posts for real"
                        onConfirm={() => act(q.id, 'approve', {
                          privacy_level: tkSheet.privacy_level,
                          disable_comment: tkSheet.disable_comment,
                          disable_duet: tkSheet.disable_duet,
                          disable_stitch: tkSheet.disable_stitch
                        })} />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
