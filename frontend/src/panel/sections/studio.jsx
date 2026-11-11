import React, { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import { ErrorBox, Loading, ConfirmButton } from './core';

// Content Studio pages added 2026-11-11 (owner: "harvest top sounds that are
// hitting high trends ... once I review and approve ... added to the sounds",
// and "a special section for recommendations the system will take into
// consideration when assigning the sounds and when creating videos").

const fmtWhen = (d) => {
  if (!d) return '—';
  const t = new Date(String(d).replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleString();
};

const fmtAge = (h) => {
  const n = Number(h);
  if (!Number.isFinite(n)) return '';
  if (n < 1) return 'less than an hour ago';
  if (n < 48) return Math.round(n) + ' h ago';
  return Math.round(n / 24) + ' days ago';
};

const BADGE = {
  just_started: { label: '🔥 Just started trending', pill: 'ok' },
  climbing: { label: '↑ Climbing', pill: 'ok' },
  holding: { label: '● Trending', pill: 'warn' },
  fading: { label: '↓ Fading', pill: 'err' },
  gone: { label: 'No longer trending', pill: 'err' },
  watch: { label: '🎯 Watch list match', pill: 'warn' }
};

const SOUND_VIEWS = [
  { id: 'new', label: 'Waiting for you' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'watch', label: 'Watch list' },
  { id: 'all', label: 'All' }
];

// The watch list: names searched in Instagram's sound library on every read.
function WatchList({ terms, onSaved }) {
  const [text, setText] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const value = text === null ? (terms || []).join(', ') : text;
  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const list = value.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
      const r = await api.put('/api/trend-sounds/watch', { terms: list });
      setText(null);
      setMsg('Saved ' + r.data.terms.length + ' name(s) - they are searched on the next read (press "Check now" to search right away).');
      onSaved && onSaved();
    } catch (e) {
      setMsg(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="cp-card">
      <h3 style={{ marginTop: 0 }}>Watch list</h3>
      <p className="cp-muted" style={{ margin: '4px 0' }}>
        Artists, songs or words to look for in Instagram's sound library on every read - for example Fairuz in every spelling.
        Matches show up under Waiting for you with a 🎯 badge (Instagram gives no play counts, so these are matches, not trends).
      </p>
      <label className="cp-form-wide" style={{ display: 'block' }}>Names, separated by commas (up to 12)
        <input type="text" value={value} maxLength={600} style={{ width: '100%' }}
          placeholder="Fairuz, فيروز, Fayrouz, Fairouz, Fairoz"
          onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="cp-content-actions">
        <button className="cp-btn small" disabled={busy || text === null} onClick={save}>Save watch list</button>
        {msg && <span className="cp-muted">{msg}</span>}
      </div>
    </div>
  );
}

export function TrendingSounds() {
  const [view, setView] = useState('new');
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState('');
  // Preview links expire (~1.5 days): a broken one is refreshed ONCE per sound
  // per visit - never in a loop if the fresh link fails too.
  const refreshedRef = useRef(new Set());

  const load = useCallback(() => {
    api.get(view === 'watch' ? '/api/trend-sounds?status=all&watch=1' : '/api/trend-sounds?status=' + view)
      .then((r) => { setData(r.data); setError(null); })
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, [view]);

  useEffect(() => { setData(null); load(); }, [load]);

  const checkNow = async () => {
    setError(null); setNotice(null);
    try {
      await api.post('/api/trend-sounds/check-now');
      setNotice('Reading Instagram\'s trending lists - this takes a few seconds.');
      setTimeout(load, 6000);
    } catch (e) {
      const d = e.response?.data || {};
      if (d.retry_in_s) setNotice('Checked a moment ago - try again in ' + Math.ceil(d.retry_in_s / 60) + ' min.');
      else if (d.running) setNotice('Already reading the lists - refresh in a few seconds.');
      else setError(d.error || e.message);
    }
  };

  const decide = async (s, action) => {
    setBusy(s.audio_id); setError(null); setNotice(null);
    try {
      await api.post('/api/trend-sounds/' + encodeURIComponent(s.audio_id) + '/' + action);
      setNotice('"' + (s.title || s.audio_id) + '": ' + { approve: 'approved - offered for Instagram posts', reject: 'rejected', undo: 'back in Waiting for you' }[action]);
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy('');
    }
  };

  const refreshPreview = async (s) => {
    setBusy(s.audio_id); setError(null);
    try {
      const r = await api.post('/api/trend-sounds/' + encodeURIComponent(s.audio_id) + '/preview');
      setData((d) => d && {
        ...d,
        sounds: d.sounds.map((x) => (x.audio_id === s.audio_id ? { ...x, preview_url: r.data.preview_url || x.preview_url, preview_link: r.data.preview_link || x.preview_link } : x))
      });
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy('');
    }
  };

  const radar = data && data.radar;
  const last = radar && radar.last_run;
  const counts = (data && data.counts) || {};

  return (
    <div>
      <div className="cp-card">
        <h3 style={{ marginTop: 0 }}>Trending Sounds</h3>
        <p className="cp-muted" style={{ margin: '4px 0' }}>
          Every {radar ? radar.every_hours : 6} hours the system reads Instagram's own list of trending music and sounds and keeps
          track of when each one appeared, so the ones that are <strong>just starting to trend</strong> come first. Listen,
          then approve the ones that fit Sam's.
        </p>
        <p className="cp-muted" style={{ margin: '4px 0' }}>
          Approved sounds are offered for <strong>Instagram posts</strong>: the system picks one that fits the video (following your
          Recommendations), you see it on the post before you approve it, and Instagram adds the licensed track when it publishes.
          TikTok, YouTube and Facebook keep our own sounds - a copied hit song gets those posts muted or claimed.
        </p>
        <div className="cp-content-actions">
          <span className="cp-muted">
            {last
              ? 'Last read ' + fmtWhen(last.at) + ' - ' + (last.error
                ? 'problem: ' + last.error
                : Object.entries(last.lists || {}).map(([t, l]) => (t === 'music' ? 'music' : 'original sounds') + ' ' +
                  (l.ok ? l.seen + ' (' + l.new + ' new)' : 'failed: ' + l.error)).join(' · '))
              : radar && radar.running ? 'Reading the lists…' : 'Not read yet since the server started (first read a few minutes after a restart).'}
          </span>
          <button className="cp-btn small" onClick={checkNow}>Check now</button>
        </div>
      </div>
      {data && <WatchList terms={data.watch_terms} onSaved={load} />}
      <ErrorBox error={error} />
      {notice && <div className="cp-card cp-muted">{notice}</div>}
      <div className="cp-card">
        <div className="cp-content-actions" style={{ marginBottom: 8 }}>
          {SOUND_VIEWS.map((v) => (
            <button key={v.id} type="button" className={'cp-btn small' + (view === v.id ? '' : ' ghost')} onClick={() => setView(v.id)}>
              {v.label}{v.id !== 'all' && counts[v.id] !== undefined ? ' (' + counts[v.id] + ')' : ''}
            </button>
          ))}
        </div>
        {data === null ? <Loading /> : data.sounds.length === 0 ? (
          <p className="cp-muted">
            {view === 'new' ? 'Nothing waiting - new trending sounds appear here after each read.' : 'No sounds here.'}
          </p>
        ) : data.sounds.map((s) => {
          const b = BADGE[s.badge] || BADGE.holding;
          return (
            <div className="cp-post-row" key={s.audio_id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              {s.cover_url ? (
                <img src={s.cover_url} alt="" width={64} height={64} style={{ borderRadius: 8, objectFit: 'cover', flex: '0 0 64px' }} />
              ) : (
                <div style={{ width: 64, height: 64, borderRadius: 8, background: '#eee', display: 'flex', alignItems: 'center', justifyContent: 'center', flex: '0 0 64px' }}>🎵</div>
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="cp-content-head">
                  <strong>{s.title || 'Untitled sound'}</strong>
                  <span className={'cp-pill ' + b.pill}>{b.label}</span>
                </div>
                <div className="cp-muted">
                  {s.artist ? s.artist + ' · ' : ''}{s.audio_type === 'original_sound' ? 'original sound' : 'music'}
                  {s.duration_ms ? ' · ' + Math.round(s.duration_ms / 1000) + ' s' : ''}
                  {s.last_position ? ' · #' + s.last_position + ' in the list' : ''}
                  {s.last_position && s.best_position && s.best_position !== s.last_position ? ' (best #' + s.best_position + ')' : ''}
                  {' · first seen ' + fmtAge(s.age_hours)}
                  {s.badge === 'fading' || s.badge === 'gone' ? ' · last seen ' + fmtAge(s.unseen_hours) : ''}
                  {s.uses ? ' · on ' + s.uses + ' of our posts' : ''}
                </div>
                {s.watch_terms && s.watch_terms.length > 0 && (
                  <div className="cp-muted">🎯 Watch list: {s.watch_terms.join(', ')}</div>
                )}
                {s.preview_url && (
                  <audio controls preload="none" src={s.preview_url} style={{ height: 30, marginTop: 6, maxWidth: '100%' }}
                    onError={() => {
                      if (refreshedRef.current.has(s.audio_id)) return;
                      refreshedRef.current.add(s.audio_id);
                      refreshPreview(s);
                    }} />
                )}
                <div className="cp-content-actions" style={{ marginTop: 6 }}>
                  {s.preview_link && <a className="cp-btn small ghost" href={s.preview_link} target="_blank" rel="noreferrer">Open on Instagram</a>}
                  {!s.preview_url && <button className="cp-btn small ghost" disabled={busy === s.audio_id} onClick={() => refreshPreview(s)}>Get a preview</button>}
                  {s.status === 'new' && (
                    <>
                      <button className="cp-btn small" disabled={busy === s.audio_id} onClick={() => decide(s, 'approve')}>Approve</button>
                      <button className="cp-btn small ghost" disabled={busy === s.audio_id} onClick={() => decide(s, 'reject')}>Reject</button>
                    </>
                  )}
                  {s.status === 'approved' && (
                    <>
                      <span className="cp-pill ok">approved</span>
                      <ConfirmButton className="cp-btn small ghost" disabled={busy === s.audio_id}
                        label="Stop offering it" confirmLabel="Reject this sound?" onConfirm={() => decide(s, 'reject')} />
                    </>
                  )}
                  {s.status === 'rejected' && (
                    <>
                      <span className="cp-pill err">rejected</span>
                      <button className="cp-btn small ghost" disabled={busy === s.audio_id} onClick={() => decide(s, 'undo')}>Back to waiting</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

const AREA_LABEL = {
  sounds: 'Sounds',
  editing: 'Video editing (hook & end line)',
  captions: 'Captions & titles',
  other: 'Everything'
};
const EMPTY = { body: '', areas: ['sounds'] };

export function Recommendations() {
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [draft, setDraft] = useState(EMPTY);
  const [editing, setEditing] = useState(null); // {id, body, areas}
  const [busy, setBusy] = useState(0);

  const load = useCallback(() => {
    api.get('/api/recommendations')
      .then((r) => { setItems(r.data.recommendations); setError(null); })
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, []);
  useEffect(load, [load]);

  const toggleArea = (obj, set, area) => {
    const has = obj.areas.includes(area);
    set({ ...obj, areas: has ? obj.areas.filter((a) => a !== area) : obj.areas.concat(area) });
  };

  const save = async () => {
    setBusy(-1); setError(null); setNotice(null);
    try {
      await api.post('/api/recommendations', draft);
      setDraft(EMPTY);
      setNotice('Saved - the system follows it from the next video it prepares.');
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(0);
    }
  };

  const update = async (id, patch, msg) => {
    setBusy(id); setError(null); setNotice(null);
    try {
      await api.put('/api/recommendations/' + id, patch);
      if (msg) setNotice(msg);
      setEditing(null);
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(0);
    }
  };

  const remove = async (id) => {
    setBusy(id); setError(null); setNotice(null);
    try {
      await api.delete('/api/recommendations/' + id);
      load();
    } catch (e) {
      setError(e.response?.data?.error || e.message);
    } finally {
      setBusy(0);
    }
  };

  const areaChecks = (obj, set) => (
    <div className="cp-content-actions">
      {Object.keys(AREA_LABEL).map((a) => (
        <label key={a} className="cp-check">
          <input type="checkbox" checked={obj.areas.includes(a)} onChange={() => toggleArea(obj, set, a)} /> {AREA_LABEL[a]}
        </label>
      ))}
    </div>
  );

  return (
    <div>
      <div className="cp-card">
        <h3 style={{ marginTop: 0 }}>Recommendations</h3>
        <p className="cp-muted" style={{ margin: '4px 0' }}>
          Tell the system how you want things done. It follows these every time it prepares a library video: when it picks the
          sound (our own circulated sounds and the Instagram trending ones you approved) and when it writes the hook, the end
          line and the captions. It still never invents prices, offers or claims, and you still approve every post.
        </p>
        <label className="cp-form-wide" style={{ display: 'block', marginTop: 8 }}>New recommendation
          <textarea rows={3} maxLength={1000} value={draft.body} style={{ width: '100%' }}
            placeholder={'e.g. "Use upbeat Middle Eastern music for shawarma and kebab videos" or "Hooks in Georgian, captions in Georgian and English"'}
            onChange={(e) => setDraft({ ...draft, body: e.target.value })} />
        </label>
        <div className="cp-muted" style={{ marginTop: 4 }}>Where it applies:</div>
        {areaChecks(draft, setDraft)}
        <div className="cp-content-actions">
          <button className="cp-btn small" disabled={busy === -1 || !draft.body.trim() || !draft.areas.length} onClick={save}>Save recommendation</button>
        </div>
      </div>
      <ErrorBox error={error} />
      {notice && <div className="cp-card cp-muted">{notice}</div>}
      <div className="cp-card">
        {items === null ? <Loading /> : items.length === 0 ? (
          <p className="cp-muted">No recommendations yet.</p>
        ) : items.map((r) => (
          <div className="cp-post-row" key={r.id}>
            {editing && editing.id === r.id ? (
              <div>
                <textarea rows={3} maxLength={1000} value={editing.body} style={{ width: '100%' }}
                  onChange={(e) => setEditing({ ...editing, body: e.target.value })} />
                {areaChecks(editing, setEditing)}
                <div className="cp-content-actions">
                  <button className="cp-btn small" disabled={busy === r.id || !editing.body.trim() || !editing.areas.length}
                    onClick={() => update(r.id, { body: editing.body, areas: editing.areas }, 'Saved.')}>Save</button>
                  <button className="cp-btn small ghost" onClick={() => setEditing(null)}>Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="cp-content-head">
                  <span style={{ whiteSpace: 'pre-wrap', opacity: r.active ? 1 : 0.55 }}>{r.body}</span>
                  <span className={'cp-pill ' + (r.active ? 'ok' : 'err')}>{r.active ? 'in use' : 'paused'}</span>
                </div>
                <div className="cp-content-actions">
                  <span className="cp-muted">{r.areas.map((a) => AREA_LABEL[a] || a).join(' · ')} · {fmtWhen(r.updated_at)}</span>
                  <button className="cp-btn small ghost" disabled={busy === r.id}
                    onClick={() => update(r.id, { active: !r.active }, r.active ? 'Paused.' : 'In use again.')}>
                    {r.active ? 'Pause' : 'Use again'}
                  </button>
                  <button className="cp-btn small ghost" disabled={busy === r.id}
                    onClick={() => setEditing({ id: r.id, body: r.body, areas: r.areas })}>Edit</button>
                  <ConfirmButton className="cp-btn small ghost" disabled={busy === r.id}
                    label="Delete" confirmLabel="Delete it?" onConfirm={() => remove(r.id)} />
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
