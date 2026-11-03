# A routine out of a follow-along video (Bilibili)

**Plan → ⋯ (Plan options) → Add a routine from a video** turns a Bilibili link into an
ordinary routine: one timed block per chapter the uploader wrote. Nothing is guessed — the
chapter list and its seconds are Bilibili's own, so the phone's timer walks the video's
timeline in the video's order.

Implementation: `frontend/src/lib/video-plan.js` (the reader and the bundle) and
`videoPlanSheet` in `frontend/src/sheets.jsx` (the sheet). The entry point is the Plan header
menu in `frontend/src/views/Plan.jsx`.

## The video has to have chapters

`player/v2` answers with `data.view_points[] = { from, to, content }` — the chapters the
uploader typed into the description. Each one becomes one block (`mode: 'time'`, `sec` from
the timestamps, a 5 s rest between blocks, none after the last). The chapter's name and its
range ride in the block's note. For a chapter with no catalogue match, the video's link travels
on the custom exercise (`lib/media-refs.js` `linkKind` calls bilibili.com a video, so the card
says *Watch video*).

A chapter whose name the import matcher resolves exactly to one catalogue exercise, or to a
curated alias (`lib/import-csv.js`), uses that catalogue exercise: the block then carries its
real body part, equipment and media. Near matches, and names shared by several catalogue
entries, are deliberately left custom rather than guessed. The note always keeps the chapter's
name, its range and the video URL, so a mapped block still says what to play. The block also
carries that URL as `videoUrl`, separate from the custom exercise's link, so video sync can pick
the source tab even when the chapter's exercise comes from the catalogue. Both `vstart` and
`videoUrl` travel when the plan is shared.

A video **with no chapters still arrives** — as one block as long as the video. Splitting it
up would be inventing structure the video does not have, so the sheet says so instead.

Multi-part uploads (分P) are read as **part 1**: `view.duration` is the sum of every part, so
using it would hand the last chapter the runtime of the parts nobody is following. `pages[0]`
carries the length and the chapters of the part the reader is actually following.

## Why the phone reads it through native HTTP

`readVideo` calls Bilibili through `lib/capacitor-fetch.js` (`nativeFetch`) on the phone.
That is not a preference:

- Bilibili sends **no CORS header** for `capacitor://localhost`, so a WebView `fetch` of the
  API can only fail;
- worse, a request that carries a foreign `Origin` is answered with a bare **403** before it is
  read. Measured 2026-10-31: the same URL and headers, differing only by `Origin`, is 200
  without one and 403 with one.

Native HTTP sends no `Origin` at all, which is what the API expects. `nativeFetch` also now
passes `res.url` through, which is how a `b23.tv/…` short link is followed to the video it
points at (`res.url` is the URL after redirects).

**Consequence:** the web build — the demo site included — cannot read a video, so
`Plan.jsx` offers the entry only when `MOBILE` (`lib/mobile.js`, `VITE_MOBILE=1`). The sheet
fails with "Couldn’t reach Bilibili. Check the connection and try again." if it is ever driven
from a browser.

## What the sheet hands over

`videoPlanBundle(video)` builds the same object shape an exported plan file has
(`opengym_plan: 1`, `routines[]`, `customEx[]`), and the sheet passes it straight into
`parsePlan` + `planImportSheet`. A video therefore arrives through the ordinary import sheet —
with its counts, its "Add to my plan" and the weekly switch — and the routine can be
scheduled, reordered and trained like any other. Bilibili's error codes are told apart
(anti-bot 403 / gone `-404` / Bilibili's own message) so the sheet can say what happened
instead of a generic failure.

## Tests

`frontend/src/lib/video-plan.test.js` covers the link parser, the chapter maths (a missing
`to`, the last chapter clamping to the video, sub-second chapters dropped), the bundle shape,
catalogue mapping and its conservative fallbacks, and the reader against a fake fetcher —
normal chapters, a multi-part upload read as part 1, a `b23.tv` redirect via `res.url`, a 403,
and `code: -404`. No test touches the network.
