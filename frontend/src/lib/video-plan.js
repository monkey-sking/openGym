// A follow-along video as a routine: one timed block per chapter.
//
// The split is the uploader's own, not a guess. Bilibili publishes the chapter list its author
// wrote (api.bilibili.com/x/player/v2 → view_points), and each chapter becomes one block of the
// routine: the video's own order, the video's own seconds. The timer that runs on the phone is
// therefore the video's timeline, and the chapter's name rides along in the block's note.
//
// A video nobody wrote chapters for still arrives — as ONE block as long as the video — because
// splitting up a chapterless video would be inventing structure the video does not have.
//
// The phone reaches the API through nativeFetch (lib/capacitor-fetch.js), and it has to:
// the WebView's own fetch would fail twice over. Bilibili sends no CORS header for
// capacitor://localhost, and a request that carries a foreign Origin is answered with a bare 403
// before it is read (measured 2026-10-31: the same URL, same headers, differs only by Origin).
// Native HTTP sends no Origin at all, which is what the API expects — see docs/dev/VIDEO_PLAN.md.

import { nativeFetch } from './capacitor-fetch.js'
import { uid, todayISO } from './format.js'
import { t } from './i18n-core.js'
import { exerciseCandidates } from './import-csv.js'

const API = 'https://api.bilibili.com/x'
// Bilibili's own API is not a public one: it is the one its website calls, and it asks to be
// treated like a page of the site rather than a client of an open API.
const REFERER = 'https://www.bilibili.com/'
// `BV` + base58 (newer uploads are longer than the original 10). A URL is the usual carrier, but
// the id is also pasted on its own, or sits in a query string, so the whole input is searched.
const BVID_RE = /BV[0-9A-Za-z]{10,}/
const AID_RE = /\/video\/av(\d+)/i

/** The rest between two chapters of one video: long enough that the phone does not fight the
 *  video for the tap, short enough that the video does not run away in the pause. */
export const VIDEO_REST_SEC = 5

/** A refused request (the anti-bot page), a video that is gone, a phone with no network: each
 *  one is worth its own sentence, so the sheet can say what actually happened. */
export class VideoLinkError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'VideoLinkError'
    this.code = code
  }
}

const offline = () => t('Couldn’t reach Bilibili. Check the connection and try again.')
const refused = () => t('Bilibili refused that request. Wait a moment, then try again.')
const missing = () => t('Bilibili doesn’t have that video. Check the link.')

/** The video a pasted link points at, as far as the link itself says.
 *  `{ bvid }` or `{ aid }` for a video, `{ short }` for a b23.tv link that has to be followed,
 *  null for anything else (including a Bilibili page that isn't a video). */
export function parseVideoLink(raw) {
  const s = String(raw == null ? '' : raw).trim()
  if (!s) return null
  const direct = s.match(BVID_RE)
  if (direct) return { bvid: direct[0] }
  let u = null
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s) } catch { return null }
  const host = u.hostname.replace(/\.$/, '').toLowerCase()
  const isBili = host === 'bilibili.com' || host.endsWith('.bilibili.com')
  const isShort = host === 'b23.tv' || host.endsWith('.b23.tv')
  if (!isBili && !isShort) return null
  const av = u.pathname.match(AID_RE)
  if (av && Number(av[1]) > 0) return { aid: Number(av[1]) }
  // A short link's id is opaque: only the redirect says which video it is.
  if (isShort) return { short: u.href }
  return null
}

async function net(fetcher, url, { signal, accept = 'application/json' } = {}) {
  try {
    return await fetcher(url, {
      headers: { Accept: accept, Referer: REFERER },
      ...(signal ? { signal } : {})
    })
  } catch (e) {
    if (e && e.name === 'AbortError') throw e
    throw new VideoLinkError('network', offline())
  }
}

/** One JSON API call, with the three answers that are not a payload told apart: the anti-bot
 *  HTML page (a 403, or a body JSON.parse cannot read), an id Bilibili does not know, and the
 *  rest of the error codes, which carry a message of Bilibili's own. */
async function apiJson(fetcher, url, signal) {
  const res = await net(fetcher, url, { signal })
  const text = typeof res.text === 'function' ? await res.text().catch(() => '') : ''
  let data = null
  try { data = JSON.parse(text) } catch { data = null }
  if (!data || typeof data.code !== 'number') {
    if (res.status === 403 || res.status === 412 || !res.ok) throw new VideoLinkError('refused', refused())
    throw new VideoLinkError('network', offline())
  }
  if (data.code !== 0) {
    if (data.code === -404 || data.code === 62002 || data.code === 62012) throw new VideoLinkError('missing', missing())
    if (data.code === -403 || data.code === -412 || data.code === -352) throw new VideoLinkError('refused', refused())
    throw new VideoLinkError('api', t('Bilibili said: {0}', String(data.message || data.code)))
  }
  return data.data || {}
}

/** The chapter list of one page of a video, as blocks of seconds.
 *  `to` is what the API answers with; a chapter that has none ends where the next one starts,
 *  and the last one ends with the video. */
export function chaptersOf(player, durationSec) {
  const points = Array.isArray(player && player.view_points) ? player.view_points : []
  const dur = Math.max(0, Math.round(Number(durationSec) || 0))
  const out = []
  points.forEach((p, i) => {
    if (!p) return
    const start = Math.max(0, Math.round(Number(p.from) || 0))
    const nextFrom = points[i + 1] ? Math.max(0, Math.round(Number(points[i + 1].from) || 0)) : dur
    let end = Math.round(Number(p.to))
    if (!Number.isFinite(end) || end <= start) end = nextFrom
    if (dur > 0) end = Math.min(end, dur)
    const sec = end - start
    if (sec < 1) return
    out.push({ name: String(p.content || '').trim(), start, end: start + sec, sec })
  })
  return out
}

/** The video behind a pasted link, read from Bilibili.
 *
 *  Multi-part uploads (分P) are read as their part 1 — the 正片 / 完整版 — and its own length:
 *  `view.duration` is the sum of every part, so using it would hand the last chapter all the
 *  runtime of the parts nobody is following. */
export async function readVideo(raw, { fetcher = nativeFetch, signal } = {}) {
  const link = parseVideoLink(raw)
  if (!link) throw new VideoLinkError('link', t('That isn’t a Bilibili video link. Paste a bilibili.com/video/BV… link.'))
  let id = link
  if (link.short) {
    const res = await net(fetcher, link.short, { signal, accept: 'text/html' })
    const followed = parseVideoLink(res.url || '')
    if (!followed || followed.short) throw new VideoLinkError('link', t('That link didn’t lead to a video.'))
    id = followed
  }
  const view = await apiJson(fetcher, API + '/web-interface/view?' + (id.bvid ? 'bvid=' + id.bvid : 'aid=' + id.aid), signal)
  const bvid = String(view.bvid || id.bvid || '')
  const pages = (Array.isArray(view.pages) ? view.pages : []).filter(p => p && p.cid)
  const page = pages[0] || { cid: view.cid, part: '', duration: view.duration }
  if (!page.cid || !bvid) throw new VideoLinkError('missing', missing())
  const sec = Math.max(0, Math.round(Number(page.duration) || Number(view.duration) || 0))
  const player = await apiJson(fetcher, API + '/player/v2?bvid=' + bvid + '&cid=' + page.cid, signal)
  return {
    bvid,
    url: 'https://www.bilibili.com/video/' + bvid + '/',
    title: String(view.title || '').trim(),
    uploader: String((view.owner || {}).name || '').trim(),
    sec,
    // Which part this is, when the upload has several: the sheet says so rather than pretending
    // the chapters cover the whole submission.
    part: pages.length > 1 ? String(page.part || '').trim() : '',
    parts: pages.length,
    chapters: chaptersOf(player, sec)
  }
}

/** m:ss — the video's own clock, as a viewer reads it under the player. */
export function clock(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  if (h) return h + ':' + String(m).padStart(2, '0') + ':' + String(r).padStart(2, '0')
  return m + ':' + String(r).padStart(2, '0')
}

/** How one chapter is named wherever it appears: its place in the video, then its own name.
 *  The video's words are kept as they are — they are what the viewer hears, and translating a
 *  chapter name would make the block harder to find in the video, not easier. */
export const chapterLabel = (chapter, at, count) =>
  (count > 1 ? (at + 1) + '/' + count + ' ' : '') + (chapter.name || clock(chapter.start))

/** The block's note: where in the video it is, and which video, so a block opened weeks later
 *  still says what to play. */
function blockNote(video, chapter, at, count, restSec) {
  const lines = [chapterLabel(chapter, at, count) + ' · ' + clock(chapter.start) + '–' + clock(chapter.end)]
  if (restSec > 0 && at < count - 1) lines.push(clock(chapter.end) + ' → ' + clock(video.chapters[at + 1] ? video.chapters[at + 1].start : chapter.end))
  lines.push([video.uploader, video.url].filter(Boolean).join(' · '))
  return lines.join('\n')
}

// A chapter is mapped only when the import matcher is certain: the curated alias table, or a
// catalogue name that normalises to exactly one exercise. `near` is deliberately ignored, and
// so is an exact name shared by two catalogue entries — a chapter called "Plank" has several
// candidates, and picking one would silently prescribe the wrong exercise.
function chapterCatalogueId(name) {
  const hit = exerciseCandidates(name)
  return hit.id && (hit.kind === 'alias' || hit.kind === 'exact') ? hit.id : null
}

/** The bundle "Import a plan file" reads: one routine, one block per chapter. A chapter that
 *  names a catalogue exercise uses it; the rest become custom exercises so the video's link
 *  travels with them (lib/media-refs.js linkKind makes that link "Watch video" rather than a
 *  bare URL). The note always carries the link, including on mapped chapters.
 *
 *  It is the same shape as an exported plan deliberately: the routine then arrives through the
 *  ordinary import sheet, with its counts, and can be scheduled, reordered and trained like any
 *  other routine. A video with no chapters arrives as the single block it is. */
export function videoPlanBundle(video, { unit = 'kg', iso = todayISO(), restSec = VIDEO_REST_SEC } = {}) {
  const chapters = video.chapters.length
    ? video.chapters
    : [{ name: video.title, start: 0, end: video.sec, sec: Math.max(1, video.sec) }]
  const count = chapters.length
  const stamp = (video.bvid || 'video').toLowerCase()
  const idAt = i => 'video-' + stamp + '-' + (i + 1)
  const catalogueIds = chapters.map(c => chapterCatalogueId(c.name))
  const title = video.title || video.bvid
  return {
    opengym_plan: 1,
    exported: iso,
    name: title,
    unit,
    week: {},
    routines: [{
      id: uid(),
      name: title.slice(0, 60),
      emoji: 'timer',
      ex: chapters.map((c, i) => ({
        id: catalogueIds[i] || idAt(i),
        sets: 1,
        mode: 'time',
        sec: c.sec,
        vstart: c.start,
        videoUrl: video.url,
        ...(restSec > 0 && i < count - 1 ? { restSec } : {}),
        note: blockNote(video, c, i, count, restSec)
      }))
    }],
    customEx: chapters.flatMap((c, i) => catalogueIds[i] ? [] : [{
      id: idAt(i),
      n: chapterLabel(c, i, count).slice(0, 60),
      bp: 'cardio',
      desc: [
        title,
        [video.uploader, clock(video.sec), clock(c.start) + '–' + clock(c.end)].filter(Boolean).join(' · '),
        video.url
      ].filter(Boolean).join('\n'),
      url: video.url,
      tg: 'cardiovascular system',
      primaries: ['cardiovascular system'],
      muscleGroups: ['cardiovascular system']
    }])
  }
}
