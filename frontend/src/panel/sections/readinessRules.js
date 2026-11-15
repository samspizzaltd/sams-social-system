// Monetization readiness (owner spec, section 28): every platform program set
// against the real numbers the system collects (GET /api/metrics).
//
// The bars come from the platforms' own help pages, checked on RULES_CHECKED.
// No platform tells the system whether an account is eligible, so a met bar
// means "confirm in the platform's app", never "eligible". Payouts are not
// guessed: the old demo engine invented them.
//
// Views are counted on the posts the system published (the platforms count
// every video of the account), so they can only be lower than the real figure.

export const RULES_CHECKED = '15 Nov 2026';

const DAY = 24 * 60 * 60 * 1000;
// YouTube: from this day new applicants for ad revenue need twice the watch
// hours / Shorts views (channels already in the program are not affected).
const YT_2027 = Date.parse('2027-02-01T00:00:00+04:00');

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const fmt = (n) => Number(n).toLocaleString('en-US');

function followers(metrics, platform) {
  const p = metrics && metrics.platforms && metrics.platforms[platform];
  return p ? num(p.followers) : null;
}

// Posts the system published on a platform in the last `days` days, and their views.
function lastDays(metrics, platform, days, now) {
  const since = now - days * DAY;
  let uploads = 0;
  let views = 0;
  for (const p of (metrics && metrics.posts) || []) {
    if (!p || p.platform !== platform || !p.published_at) continue;
    const t = Date.parse(String(p.published_at).replace(' ', 'T'));
    if (!Number.isFinite(t) || t < since) continue;
    uploads += 1;
    const v = num(p.views);
    if (v !== null) views += v;
  }
  return { uploads, views };
}

// One bar: met when the number is known and reaches the need.
function bar(label, now, need, extra) {
  return Object.assign({ label, now, need, met: now !== null && need !== null && now >= need }, extra || {});
}

function shortBy(b, noun) {
  if (b.now === null) return 'the ' + noun + ' figure (not read yet)';
  return fmt(Math.max(0, b.need - b.now)) + ' more ' + noun;
}

// statuses: 'check' (every bar the system can see is met - confirm in the app),
// 'progress' (not yet), 'invite' (the platform invites, no published bar),
// 'closed' (the program is not open to Sam's).
export function readiness(metrics, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const rows = [];

  // ---------- Facebook ----------
  const fb = followers(metrics, 'facebook_page');
  rows.push({
    id: 'fb_content',
    platform: 'Facebook',
    program: 'Content Monetization (ads on reels and videos)',
    status: 'invite',
    bars: [bar('Page followers', fb, null, { note: 'Meta publishes no follower or minutes bar for it' })],
    missing: ['An invitation from Meta'],
    action: 'Register interest: Facebook app, Professional dashboard, Monetization tab. Meta lists there anything that is still missing.',
    where: 'Facebook app → Professional dashboard → Monetization',
    source: 'https://creators.facebook.com/tools/facebook-content-monetization',
    alertKey: 'fb_content:invite'
  });

  // ---------- Instagram ----------
  const ig = followers(metrics, 'instagram');
  const gifts = bar('Followers', ig, 500);
  rows.push({
    id: 'ig_gifts',
    platform: 'Instagram',
    program: 'Gifts on reels',
    status: gifts.met ? 'check' : 'progress',
    bars: [gifts],
    missing: gifts.met
      ? ["Georgia must be on Instagram's Gifts country list (not confirmed)", 'A payout account set up in Instagram']
      : [shortBy(gifts, 'followers')],
    action: gifts.met
      ? 'Open Instagram, Professional dashboard, Monetization status. If Gifts is offered, you set up payouts and accept the terms yourself.'
      : 'Nothing to apply for yet - keep growing followers.',
    where: 'Instagram → Professional dashboard → Monetization status',
    source: 'https://help.instagram.com/738469380549477',
    alertKey: gifts.met ? 'ig_gifts:500' : null
  });

  const subs = bar('Followers', ig, 10000);
  rows.push({
    id: 'ig_subs',
    platform: 'Instagram',
    program: 'Subscriptions',
    status: subs.met ? 'check' : 'progress',
    bars: [subs],
    missing: subs.met ? ["Georgia must be on Instagram's Subscriptions country list (not confirmed)"] : [shortBy(subs, 'followers')],
    action: subs.met
      ? 'Open Instagram, Professional dashboard, Monetization status.'
      : 'Nothing to apply for yet - keep growing followers.',
    where: 'Instagram → Professional dashboard → Monetization status',
    source: 'https://help.instagram.com/427415519366046',
    alertKey: subs.met ? 'ig_subs:10000' : null
  });

  // ---------- YouTube ----------
  const yt = followers(metrics, 'youtube');
  const yt90 = lastDays(metrics, 'youtube', 90, now);
  const noHours = 'not read by the system (Shorts views add no watch hours)';

  const fanSubs = bar('Subscribers', yt, 500);
  const fanUploads = bar('Public uploads, last 90 days', yt90.uploads, 3);
  const fanShorts = bar('Shorts views, last 90 days', yt90.views, 3000000);
  const fanHours = bar('Watch hours, last 12 months', null, 3000, { unmeasured: noHours });
  const fanMet = fanSubs.met && fanUploads.met && fanShorts.met;
  const fanMissing = [];
  if (!fanSubs.met) fanMissing.push(shortBy(fanSubs, 'subscribers'));
  if (!fanUploads.met) fanMissing.push(shortBy(fanUploads, 'public uploads in 90 days'));
  if (!fanShorts.met) fanMissing.push(shortBy(fanShorts, 'Shorts views in 90 days') + ' (or 3,000 watch hours)');
  if (fanMet) fanMissing.push('Offered only in some countries - YouTube Studio shows whether Georgia has it');
  rows.push({
    id: 'yt_fan',
    platform: 'YouTube',
    program: 'Fan funding and Shopping',
    status: fanMet ? 'check' : 'progress',
    bars: [fanSubs, fanUploads],
    either: [fanShorts, fanHours],
    missing: fanMissing,
    action: fanMet
      ? 'Open YouTube Studio, Earn, and apply. You accept the terms and link AdSense yourself.'
      : 'Keep posting Shorts - subscribers are the first gap.',
    where: 'YouTube Studio → Earn',
    source: 'https://support.google.com/youtube/answer/13429240',
    alertKey: fanMet ? 'yt_fan:500' : null
  });

  const after2027 = now >= YT_2027;
  const adSubs = bar('Subscribers', yt, 1000);
  const adShorts = bar('Shorts views, last 90 days', yt90.views, after2027 ? 20000000 : 10000000);
  const adHours = bar('Watch hours, last 12 months', null, after2027 ? 8000 : 4000, { unmeasured: noHours });
  const adMet = adSubs.met && adShorts.met;
  const adMissing = [];
  if (!adSubs.met) adMissing.push(shortBy(adSubs, 'subscribers'));
  if (!adShorts.met) adMissing.push(shortBy(adShorts, 'Shorts views in 90 days') + ' (or ' + fmt(adHours.need) + ' watch hours)');
  rows.push({
    id: 'yt_ads',
    platform: 'YouTube',
    program: 'Partner Program (ad money)',
    status: adMet ? 'check' : 'progress',
    bars: [adSubs],
    either: [adShorts, adHours],
    missing: adMissing,
    action: adMet
      ? 'Open YouTube Studio, Earn, and apply. You accept the terms and link AdSense yourself.'
      : 'Keep posting Shorts - subscribers are the first gap.',
    note: after2027 ? null : 'From 1 Feb 2027 new channels need 8,000 watch hours or 20 million Shorts views (still 1,000 subscribers).',
    where: 'YouTube Studio → Earn',
    source: 'https://support.google.com/youtube/answer/72851',
    alertKey: adMet ? 'yt_ads:1000' : null
  });

  // ---------- TikTok ----------
  const tt = followers(metrics, 'tiktok');
  const tt30 = lastDays(metrics, 'tiktok', 30, now);
  rows.push({
    id: 'tt_rewards',
    platform: 'TikTok',
    program: 'Creator Rewards Program',
    status: 'closed',
    bars: [bar('Followers', tt, 10000), bar('Video views, last 30 days', tt30.views, 100000)],
    missing: [
      "Personal accounts only - Sam's posts as a business account",
      'Not offered in Georgia (only the US, UK, Germany, Japan, South Korea, France, Mexico and Brazil)',
      'Only videos of 1 minute or longer count'
    ],
    action: 'Nothing to apply for.',
    where: 'TikTok Studio → Monetization',
    source: 'https://support.tiktok.com/en/business-and-creator/creator-rewards-program/creator-rewards-program',
    alertKey: null
  });

  return rows;
}

// The rows whose bar was reached (or that need the owner's action) and that
// this viewer has not dismissed yet.
export function alertsFor(rows, dismissed) {
  const seen = new Set(Array.isArray(dismissed) ? dismissed : []);
  return (rows || []).filter((r) => r.alertKey && !seen.has(r.alertKey));
}
