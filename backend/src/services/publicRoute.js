const tiktokPublish = require('./tiktokPublish');
const youtubePublish = require('./youtubePublish');

// Can a platform show what this system posts to it? (owner 2026-11-07: "figure
// out why they are not allowing post publicly")
//
// TikTok and YouTube only make API posts public when the posting app has passed
// their own review:
//  - TikTok: an app that has not passed its Direct Post audit may only post to
//    a PRIVATE TikTok account (error unaudited_client_can_only_post_to_private_accounts),
//    so every post to the public Sam's account is refused.
//  - YouTube: every upload from a Google project that has not passed the
//    YouTube API audit is locked Private for good - it can never be made
//    public, only uploaded again.
// Until a platform has such a route, its approved posts WAIT in the schedule
// (nothing is refused, nothing is burned) and go out once the route exists.
// The route opens when TIKTOK_APP_AUDITED / YOUTUBE_APP_AUDITED is set true.

const NAMES = { tiktok: 'TikTok', youtube: 'YouTube' };

function waiting(platform) {
  if (platform === 'tiktok') return !tiktokPublish.appAudited();
  if (platform === 'youtube') return !youtubePublish.appAudited();
  return false;
}

// Platforms whose posts currently wait.
function waitingPlatforms() {
  return Object.keys(NAMES).filter(waiting);
}

// Owner-facing reason a post waits, or null when it can go out.
function reason(platform) {
  return waiting(platform)
    ? NAMES[platform] + ' does not allow public posts from this system yet - the post waits until it does'
    : null;
}

module.exports = { waiting, waitingPlatforms, reason, NAMES };
