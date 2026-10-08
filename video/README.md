# Video render pipeline

Turns queued render jobs from the control panel into real vertical MP4s (1080x1920).
Runs on the owner's Windows PC — never on the server (shared hosting cannot run Chromium).

## One-time setup

```
cd video
npm install
copy .env.example .env     # then edit .env with the panel login
# In .env, MEDIA_ROOTS lists the folders (semicolon-separated) that registered
# local paths may be read from - the worker refuses files outside them.
```

## Daily use

1. In the control panel: **Media & Video → Library** — upload photos/clips, or register
   files that live on this PC by full path.
2. **Media & Video → Render Queue** — pick a template, attach approved content and media,
   queue the job.
3. On this PC:

```
cd video
node render-worker.mjs           # process the queue once
node render-worker.mjs --watch   # keep polling every 30s
```

Finished MP4s are uploaded back to the media library (kind `rendered`) and the job is
marked done in the panel.

## Templates

| Template | Length | Needs |
| --- | --- | --- |
| MenuCard | 15s | 1 photo + dish name + price |
| ScriptPromo | 30s | 1 photo or video; uses the Claude-written script beats from attached content |
| ReviewQuote | 10s | 1 photo + a quote |

Preview/tune templates visually: `npm run studio` (Remotion Studio).
