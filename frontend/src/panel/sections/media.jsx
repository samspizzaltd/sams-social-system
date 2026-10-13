import React, { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { ErrorBox, Loading, ConfirmButton } from './core';

const fmtDate = (d) => {
  if (!d) return '—';
  const t = new Date(String(d).replace(' ', 'T'));
  return Number.isNaN(t.getTime()) ? String(d) : t.toLocaleString();
};
const fmtSize = (b) => {
  if (!b) return '';
  if (b > 1048576) return (b / 1048576).toFixed(1) + ' MB';
  return Math.round(b / 1024) + ' KB';
};

const API_BASE = import.meta.env.VITE_API_URL || 'http://localhost:3000';

// ---------- Media Library ----------

export function MediaLibrary() {
  const [media, setMedia] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [localPath, setLocalPath] = useState('');
  const [pathTitle, setPathTitle] = useState('');

  const load = useCallback(() => {
    api.get('/api/media')
      .then((r) => setMedia(r.data.media))
      .catch((e) => setError(e.response?.data?.error || e.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const [dragOver, setDragOver] = useState(false);
  const [progress, setProgress] = useState(null); // {done, total, current}

  // Accepts one or many files (from the picker or drag & drop) and uploads
  // them one by one - the server takes a single file per request.
  const uploadFiles = async (fileList) => {
    const files = Array.from(fileList || []).filter(
      (f) => /^(image|video)\//.test(f.type) || /\.(jpe?g|png|webp|gif|mp4|mov|webm)$/i.test(f.name)
    );
    const skipped = (fileList ? fileList.length : 0) - files.length;
    if (!files.length) {
      setError('No usable files - drop photos (jpg, png, webp, gif) or videos (mp4, mov, webm).');
      return;
    }
    setError(null); setNotice(null); setUploading(true);
    const failures = [];
    let done = 0;
    for (const file of files) {
      setProgress({ done, total: files.length, current: file.name });
      try {
        const form = new FormData();
        form.append('file', file);
        form.append('title', file.name);
        await api.post('/api/media/upload', form, { timeout: 180000 });
        done++;
        load(); // each finished file appears in the library right away
      } catch (err) {
        failures.push(file.name + ': ' + (err.response?.data?.error || err.message));
      }
    }
    setUploading(false);
    setProgress(null);
    if (failures.length) {
      setError('Uploaded ' + done + ' of ' + files.length + '. Failed - ' + failures.join(' | '));
    } else {
      setNotice('Uploaded ' + done + (done === 1 ? ' file' : ' files') +
        (skipped > 0 ? ' (' + skipped + ' skipped - not a photo/video)' : ''));
    }
    load();
  };

  const onUpload = async (e) => {
    await uploadFiles(e.target.files);
    e.target.value = '';
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (!uploading) uploadFiles(e.dataTransfer.files);
  };

  const addPath = async (e) => {
    e.preventDefault();
    setError(null); setNotice(null);
    try {
      await api.post('/api/media/path', { local_path: localPath, title: pathTitle || undefined });
      setNotice('Registered local file: ' + localPath);
      setLocalPath(''); setPathTitle('');
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const remove = async (id) => {
    try { await api.delete(`/api/media/${id}`); load(); }
    catch (err) { setError(err.response?.data?.error || err.message); }
  };

  return (
    <div>
      <ErrorBox error={error} />
      {notice && <div className="cp-success">{notice}</div>}

      <div className="cp-card-row">
        <div className="cp-card">
          <h3>Upload photos or videos</h3>
          <p className="cp-muted">Stored on the server (max 60 MB each). Photos and short clips of dishes, the kitchen, the shop front.</p>
          <div
            className={'cp-dropzone' + (dragOver ? ' drag' : '') + (uploading ? ' busy' : '')}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragEnter={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            {uploading && progress ? (
              <span>Uploading {progress.done + 1} of {progress.total}: {progress.current}…</span>
            ) : (
              <span>{dragOver ? 'Drop them here' : 'Drag & drop files here (one or many)'}</span>
            )}
          </div>
          <input type="file" accept="image/*,video/*" multiple onChange={onUpload} disabled={uploading} />
        </div>

        <div className="cp-card">
          <h3>Register a file on your computer</h3>
          <p className="cp-muted">
            For large videos that stay on your PC. The render pipeline runs on the same
            computer and reads them directly - nothing is uploaded.
          </p>
          <form onSubmit={addPath} className="cp-form">
            <label className="cp-form-wide">Full path on your PC
              <input type="text" value={localPath} placeholder="D:\Photos\shawarma-spit.mp4"
                onChange={(e) => setLocalPath(e.target.value)} required />
            </label>
            <label>Title (optional)
              <input type="text" value={pathTitle} onChange={(e) => setPathTitle(e.target.value)} />
            </label>
            <button className="cp-btn" type="submit">Register</button>
          </form>
        </div>
      </div>

      <div className="cp-card">
        <h3>Library</h3>
        {media === null ? <Loading /> : media.length === 0 ? (
          <p className="cp-muted">No media yet. Upload a photo above, or register a file path.</p>
        ) : (
          <table className="cp-table">
            <thead><tr><th>Preview</th><th>Title</th><th>Kind</th><th>Where</th><th>Added</th><th></th></tr></thead>
            <tbody>
              {media.map((m) => (
                <tr key={m.id}>
                  <td>
                    {m.url_path && m.kind === 'photo' ? (
                      <img src={API_BASE + m.url_path} alt="" className="cp-thumb" />
                    ) : m.url_path ? (
                      <a href={API_BASE + m.url_path} target="_blank" rel="noreferrer">open</a>
                    ) : (
                      <span className="cp-muted">on PC</span>
                    )}
                  </td>
                  <td>#{m.id} {m.title || '—'}</td>
                  <td><span className={`cp-pill ${m.kind === 'rendered' ? 'ok' : 'warn'}`}>{m.kind}</span></td>
                  <td className="cp-muted">{m.url_path ? 'server ' + (fmtSize(m.size_bytes) || '') : m.local_path}</td>
                  <td className="cp-muted">{fmtDate(m.created_at)}</td>
                  <td><ConfirmButton className="cp-btn small ghost" label="Remove" confirmLabel="Really remove?" onConfirm={() => remove(m.id)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ---------- Render Queue ----------

const TEMPLATES = [
  { id: 'MenuCard', label: 'Menu Card', hint: 'One dish photo + name + price + CTA. 15s vertical.' },
  { id: 'ScriptPromo', label: 'Script Promo', hint: 'Background photo/video with the Claude-written script beats as animated captions. 30s vertical.' },
  { id: 'ReviewQuote', label: 'Review Quote', hint: 'A customer quote over a photo. 10s vertical.' }
];

export function RenderQueue() {
  const [jobs, setJobs] = useState(null);
  const [content, setContent] = useState([]);
  const [media, setMedia] = useState([]);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [form, setForm] = useState({ template: 'MenuCard', content_id: '', media_ids: [], title: '', price: '', quote: '' });

  const load = useCallback(() => {
    api.get('/api/render-jobs')
      .then((r) => setJobs(r.data.jobs))
      .catch((e) => setError(e.response?.data?.error || e.message));
    api.get('/api/content?status=approved').then((r) => setContent(r.data.content)).catch(() => {});
    api.get('/api/media').then((r) => setMedia(r.data.media)).catch(() => {});
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleMedia = (id) => {
    setForm((f) => ({
      ...f,
      media_ids: f.media_ids.includes(id) ? f.media_ids.filter((x) => x !== id) : [...f.media_ids, id]
    }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null); setNotice(null);
    try {
      const params = {};
      if (form.title) params.title = form.title;
      if (form.price) params.price = form.price;
      if (form.quote) params.quote = form.quote;
      await api.post('/api/render-jobs', {
        template: form.template,
        content_id: form.content_id || undefined,
        media_ids: form.media_ids,
        params
      });
      setNotice('Render job queued. Run the render worker on your PC to produce the video.');
      setForm({ ...form, media_ids: [], title: '', price: '', quote: '' });
      load();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const statusPill = (s) => (s === 'done' ? 'ok' : s === 'failed' ? 'err' : 'warn');

  return (
    <div>
      <ErrorBox error={error} />
      {notice && <div className="cp-success">{notice}</div>}

      <div className="cp-card">
        <h3>Queue a video render</h3>
        <form onSubmit={submit}>
          <div className="cp-form">
            <label>Template
              <select value={form.template} onChange={(e) => setForm({ ...form, template: e.target.value })}>
                {TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
              </select>
            </label>
            <label>Attach approved content (optional)
              <select value={form.content_id} onChange={(e) => setForm({ ...form, content_id: e.target.value })}>
                <option value="">— none —</option>
                {content.map((c) => <option key={c.id} value={c.id}>#{c.id} {c.title}</option>)}
              </select>
            </label>
            {form.template === 'MenuCard' && (
              <>
                <label>Dish name
                  <input type="text" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Chicken Shawarma" />
                </label>
                <label>Price
                  <input type="text" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} placeholder="15 GEL" />
                </label>
              </>
            )}
            {form.template === 'ReviewQuote' && (
              <label className="cp-form-wide">Quote
                <input type="text" value={form.quote} onChange={(e) => setForm({ ...form, quote: e.target.value })} placeholder="Best shawarma in Tbilisi, hands down." />
              </label>
            )}
          </div>
          <p className="cp-muted">{TEMPLATES.find((t) => t.id === form.template)?.hint}</p>

          <h3 style={{ marginTop: 14 }}>Pick media</h3>
          {media.length === 0 ? (
            <p className="cp-muted">The library is empty - add photos or videos first.</p>
          ) : (
            <div className="cp-media-pick">
              {media.filter((m) => m.kind !== 'rendered').map((m) => (
                <label key={m.id} className={`cp-media-chip ${form.media_ids.includes(m.id) ? 'active' : ''}`}>
                  <input type="checkbox" checked={form.media_ids.includes(m.id)} onChange={() => toggleMedia(m.id)} />
                  #{m.id} {m.title || m.kind}{m.local_path ? ' (on PC)' : ''}
                </label>
              ))}
            </div>
          )}
          <button className="cp-btn" type="submit">Queue render</button>
        </form>
      </div>

      <div className="cp-card">
        <h3>Jobs</h3>
        {jobs === null ? <Loading /> : jobs.length === 0 ? (
          <p className="cp-muted">No render jobs yet.</p>
        ) : (
          <table className="cp-table">
            <thead><tr><th>#</th><th>Template</th><th>Content</th><th>Status</th><th>Output</th><th>When</th></tr></thead>
            <tbody>
              {jobs.map((j) => (
                <tr key={j.id}>
                  <td>{j.id}</td>
                  <td>{j.template}</td>
                  <td className="cp-muted">{j.content ? j.content.title : '—'}</td>
                  <td>
                    <span className={`cp-pill ${statusPill(j.status)}`}>{j.status}</span>
                    {j.error ? <div className="cp-muted">{String(j.error).slice(0, 120)}</div> : null}
                  </td>
                  <td>{j.output_media_id ? '#' + j.output_media_id : '—'}</td>
                  <td className="cp-muted">{fmtDate(j.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="cp-muted">
          Queued jobs are rendered on your PC: open PowerShell in the project and run
          <code> node video/render-worker.mjs</code>. Finished videos appear in the Library as kind
          &quot;rendered&quot;.
        </p>
      </div>
    </div>
  );
}
