const tiktokPublish = require('./tiktokPublish');
const youtubePublish = require('./youtubePublish');
const youtubeReturn = require('./youtubeReturn');
const brandConfig = require('./brandConfig');

// How each platform's approved posts reach the public right now (owner
// 2026-11-07: "figure out why they are not allowing post publicly", then "not
// a third party app for money").
//
// TikTok only makes API posts public when the posting app has passed its own
// review; YouTube did the same until 2 Nov 2026:
//  - TikTok: an app that has not passed its Direct Post audit may only post to
//    a PRIVATE TikTok account (unaudited_client_can_only_post_to_private_accounts),
//    and TikTok's guidelines keep that audit for apps made for the public - a
//    tool that posts to your own accounts does not qualify. What TikTok DOES
//    allow any app: sending the video to the owner's TikTok drafts, where he
//    posts it himself (publicly) from the TikTok app - route 'drafts', switched
//    on with the setting tiktok_route = drafts.
//  - YouTube: uploads from a Google project that had not passed the YouTube
//    API audit used to be locked Private. Google lifted that on 2 Nov 2026,
//    so YouTube is 'direct' - unless YOUTUBE_APP_AUDITED=false switches
//    public uploads off, and only after the one-time return of the posts
//    approved as Private-only (youtubeReturn.js) has run.
//
// Routes:
//  'direct' - the system publishes the post itself (public)
//  'drafts' - TikTok only: the video goes to the owner's TikTok drafts
//  'wait'   - no public route yet: approved posts wait in the schedule
//             (nothing refused, nothing burned) and go out once one exists.
// TIKTOK_APP_AUDITED = true in .env switches TikTok to 'direct'.

const NAMES = { tiktok: 'TikTok', youtube: 'YouTube' };

async function routes() {
  const cfg = await brandConfig.get();
  const tiktokDrafts = String(cfg.tiktok_route || '').trim().toLowerCase() === 'drafts';
  return {
    instagram: 'direct',
    facebook_page: 'direct',
    tiktok: tiktokPublish.appAudited() ? 'direct' : tiktokDrafts ? 'drafts' : 'wait',
    youtube: youtubePublish.appAudited() && (await youtubeReturn.ready()) ? 'direct' : 'wait'
  };
}

// Platforms whose posts currently wait.
async function waitingPlatforms(r) {
  const rr = r || (await routes());
  return Object.keys(rr).filter((p) => rr[p] === 'wait');
}

// Owner-facing reason a post waits (r = routes()), or null when it can go out.
function reason(platform, r) {
  if (!r || r[platform] !== 'wait') return null;
  if (platform === 'tiktok') {
    return 'TikTok does not allow public posts from this system yet - the post waits (or send TikTok posts to your TikTok inbox: Settings → Platform Connections)';
  }
  if (platform === 'youtube') {
    return 'YouTube uploads are switched off on the server for now - the post waits until they are switched on';
  }
  return (NAMES[platform] || platform) + ' does not allow public posts from this system yet - the post waits until it does';
}

module.exports = { routes, waitingPlatforms, reason, NAMES };
