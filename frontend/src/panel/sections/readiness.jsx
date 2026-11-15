import React, { useState } from 'react';
import { readiness, alertsFor, RULES_CHECKED } from './readinessRules';

// Monetization readiness table (Monetization -> Opportunities) and the
// Dashboard notice when a bar is reached. Rules and numbers: readinessRules.js.

const fmt = (n) => (typeof n === 'number' ? n.toLocaleString() : n);

const STATUS = {
  check: { cls: 'ok', label: 'Bar met - confirm in the app' },
  progress: { cls: 'mute', label: 'Not yet' },
  invite: { cls: 'warn', label: 'By invitation' },
  closed: { cls: 'err', label: "Not open to Sam's" }
};

function share(b) {
  if (b.now === null || !b.need) return null;
  return Math.min(1, b.now / b.need);
}

function shareLabel(p) {
  if (p === null) return '';
  if (p >= 1) return '100%';
  if (p > 0 && p < 0.01) return 'under 1%';
  return Math.floor(p * 100) + '%';
}

function Bar({ b }) {
  if (b.unmeasured) {
    return (
      <div className="cp-ready-bar">
        <div className="cp-ready-bar-head"><span>{b.label}</span><span>needs {fmt(b.need)}</span></div>
        <div className="cp-muted">{b.unmeasured}</div>
      </div>
    );
  }
  const p = share(b);
  return (
    <div className="cp-ready-bar">
      <div className="cp-ready-bar-head">
        <span>{b.label}</span>
        <span>
          <strong>{b.now === null ? '—' : fmt(b.now)}</strong>
          {b.need !== null ? ' / ' + fmt(b.need) : ''}
          {p !== null ? ' · ' + shareLabel(p) : ''}
        </span>
      </div>
      {b.need !== null && (
        <div className={`cp-meter${b.met ? ' met' : ''}`}>
          <span style={{ width: (p === null ? 0 : p > 0 ? Math.max(p * 100, 1.5) : 0) + '%' }} />
        </div>
      )}
      {b.note && <div className="cp-muted">{b.note}</div>}
    </div>
  );
}

export function ReadinessTable({ metrics }) {
  let rows = [];
  try { rows = readiness(metrics); } catch { rows = []; }
  return (
    <div className="cp-card">
      <h3>Monetization readiness</h3>
      <p className="cp-muted">
        Sam&apos;s real numbers against each platform&apos;s published bar. A met bar is not an approval: only the
        platform&apos;s own screen (named on each card) can say yes.
      </p>
      <div className="cp-ready-grid">
        {rows.map((r) => {
          const s = STATUS[r.status] || STATUS.progress;
          return (
            <div className="cp-ready-item" key={r.id}>
              <div className="cp-ready-title">
                <div><strong>{r.platform}</strong> · {r.program}</div>
                <span className={`cp-pill ${s.cls}`}>{s.label}</span>
              </div>
              {r.bars.map((b) => <Bar b={b} key={b.label} />)}
              {r.either && (
                <div className="cp-ready-either">
                  <div className="cp-ready-label">and one of</div>
                  {r.either.map((b) => <Bar b={b} key={b.label} />)}
                </div>
              )}
              <div className="cp-ready-label">Missing</div>
              <ul className="cp-list">{r.missing.map((m) => <li key={m}>{m}</li>)}</ul>
              <div className="cp-ready-label">What to do</div>
              <p className="cp-ready-text">{r.action}</p>
              {r.note && <p className="cp-muted">{r.note}</p>}
              <p className="cp-ready-where">
                Check: {r.where} · <a href={r.source} target="_blank" rel="noreferrer">rules</a>
              </p>
            </div>
          );
        })}
      </div>
      <p className="cp-muted">
        Rules checked on {RULES_CHECKED}. Views count only the posts the system published, so the platforms&apos; own
        figures can be higher. No payout guesses: the platforms publish no rates. Record real money in Record Income.
      </p>
    </div>
  );
}

// Per-viewer "Got it" memory (a convenience only: in a private window the
// notice simply shows again).
const SEEN_KEY = 'sams_money_alerts_seen';
function readSeen() {
  try {
    const v = JSON.parse(window.localStorage.getItem(SEEN_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function writeSeen(list) {
  try { window.localStorage.setItem(SEEN_KEY, JSON.stringify(list)); } catch { /* shows again next time */ }
}

// Dashboard notice: a bar was reached, or the owner has something to do. A new
// bar (e.g. 10,000 Instagram followers) shows again after an earlier "Got it".
export function MoneyAlert({ metrics, goTo }) {
  const [seen, setSeen] = useState(readSeen);
  if (!metrics) return null;
  let rows = [];
  try { rows = alertsFor(readiness(metrics), seen); } catch { return null; }
  if (!rows.length) return null;
  const dismiss = () => {
    const next = seen.concat(rows.map((r) => r.alertKey));
    writeSeen(next);
    setSeen(next);
  };
  return (
    <div className="cp-card cp-money-alert">
      <h3>💰 Monetization</h3>
      <ul className="cp-list">
        {rows.map((r) => (
          <li key={r.alertKey}>
            {r.status === 'invite'
              ? <><strong>{r.platform}</strong> pays only by invitation. Register interest in {r.where}.</>
              : <><strong>{r.platform} {r.program}</strong>: every bar the system can see is reached. Confirm in {r.where}.</>}
          </li>
        ))}
      </ul>
      <div className="cp-money-actions">
        <button className="cp-btn small" onClick={() => goTo && goTo('money', 'opportunities')}>Open readiness</button>
        <button className="cp-btn small ghost" onClick={dismiss}>Got it</button>
      </div>
    </div>
  );
}
