import { describe, it, expect } from 'vitest'
import {
  parseVideoLink, chaptersOf, readVideo, videoPlanBundle, clock, chapterLabel,
  VideoLinkError, VIDEO_REST_SEC
} from './video-plan.js'
import { EXIDX } from './exercises.js'

// A fetcher shaped like the two the reader accepts: the real nativeFetch (phone) and the
// WebView's own fetch (browser). Both answer with { ok, status, url, text() }; only url matters
// beyond the body, and only for the b23.tv redirect.
const json = (data, { status = 200, url = '' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  text: async () => JSON.stringify(data)
})
const html = (body, { status = 200, url = '' } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  text: async () => body
})

// The two calls readVideo makes, keyed by the path they hit. `page` is the view.pages[0] shape.
const API = 'https://api.bilibili.com/x/'
function biliFetcher({ view, player, viewRes, playerRes } = {}) {
  const calls = []
  const fetcher = async (url, init) => {
    calls.push({ url, init })
    if (url.startsWith(API + 'web-interface/view')) {
      if (viewRes) return viewRes
      return json({ code: 0, data: view })
    }
    if (url.startsWith(API + 'player/v2')) {
      if (playerRes) return playerRes
      return json({ code: 0, data: player })
    }
    throw new Error('unexpected url ' + url)
  }
  fetcher.calls = calls
  return fetcher
}

const PAGE = (over = {}) => ({ cid: 111, page: 1, part: '完整版', duration: 300, ...over })
const VIEW = (over = {}) => ({
  bvid: 'BV1De4y1D7am', title: '核心训练', owner: { name: '教练' }, duration: 300,
  pages: [PAGE()], ...over
})
const POINTS = (...ps) => ({ view_points: ps })
const CH = (from, to, content) => ({ from, to, content })

describe('parseVideoLink', () => {
  it('takes a full Bilibili video URL, and the bare id inside it', () => {
    expect(parseVideoLink('https://www.bilibili.com/video/BV1Jw411c7JV/?spm_id=1'))
      .toEqual({ bvid: 'BV1Jw411c7JV' })
    expect(parseVideoLink('BV1Jw411c7JV')).toEqual({ bvid: 'BV1Jw411c7JV' })
    expect(parseVideoLink('  看这个 BV1Jw411c7JV 呵呵 ')).toEqual({ bvid: 'BV1Jw411c7JV' })
  })

  it('reads an av link as its numeric id', () => {
    expect(parseVideoLink('https://www.bilibili.com/video/av12345')).toEqual({ aid: 12345 })
  })

  it('marks a b23.tv short link as one that has to be followed', () => {
    expect(parseVideoLink('https://b23.tv/abcdefg')).toEqual({ short: 'https://b23.tv/abcdefg' })
  })

  it('refuses anything that is not a Bilibili video', () => {
    expect(parseVideoLink('')).toBeNull()
    expect(parseVideoLink('   ')).toBeNull()
    expect(parseVideoLink('看这个视频')).toBeNull()
    expect(parseVideoLink('https://youtube.com/watch?v=abc')).toBeNull()
    expect(parseVideoLink('https://www.bilibili.com/space/12345')).toBeNull()
  })

  it('goes by the video id, so a look-alike host still names the real video', () => {
    // Nothing but the id is used to build the request, which always goes to api.bilibili.com —
    // so a spoofed host around a real id is harmless, and is read as that video.
    expect(parseVideoLink('https://bilibili.com.evil.example/video/BV1Jw411c7JV'))
      .toEqual({ bvid: 'BV1Jw411c7JV' })
  })
})

describe('chaptersOf', () => {
  it('uses the chapter’s own end when the API gives one', () => {
    const out = chaptersOf(POINTS(CH(0, 60, '热身'), CH(60, 200, '正式'), CH(200, 300, '拉伸')), 300)
    expect(out).toEqual([
      { name: '热身', start: 0, end: 60, sec: 60 },
      { name: '正式', start: 60, end: 200, sec: 140 },
      { name: '拉伸', start: 200, end: 300, sec: 100 }
    ])
  })

  it('ends a chapter with no end at the next chapter, and the last with the video', () => {
    const out = chaptersOf(POINTS(CH(0, undefined, '一'), CH(90, undefined, '二')), 240)
    expect(out.map(c => [c.start, c.end])).toEqual([[0, 90], [90, 240]])
  })

  it('clamps a chapter that runs past the video, and drops one shorter than a second', () => {
    const out = chaptersOf(POINTS(CH(0, 500, '太长了'), CH(500, 500, '零长')), 120)
    expect(out).toEqual([{ name: '太长了', start: 0, end: 120, sec: 120 }])
  })

  it('is empty for a video with no chapters', () => {
    expect(chaptersOf({}, 300)).toEqual([])
    expect(chaptersOf(null, 300)).toEqual([])
  })
})

describe('readVideo', () => {
  it('reads the title, the uploader, the length and the chapters', async () => {
    const fetcher = biliFetcher({
      view: VIEW(),
      player: POINTS(CH(0, 81, '片头'), CH(81, 300, '正片'))
    })
    const v = await readVideo('https://www.bilibili.com/video/BV1De4y1D7am', { fetcher })
    expect(v).toMatchObject({ bvid: 'BV1De4y1D7am', title: '核心训练', uploader: '教练', sec: 300, part: '' })
    expect(v.chapters.map(c => c.name)).toEqual(['片头', '正片'])
  })

  it('reads part 1 of a multi-part upload, not the sum of every part', async () => {
    const fetcher = biliFetcher({
      view: VIEW({ duration: 900, pages: [PAGE({ part: '完整版', duration: 300 }), PAGE({ cid: 222, part: '纯享', duration: 600 })] }),
      player: POINTS(CH(0, 300, '正片'))
    })
    const v = await readVideo('BV1De4y1D7am', { fetcher })
    expect(v.sec).toBe(300)
    expect(v.part).toBe('完整版')
    expect(v.parts).toBe(2)
    // The player call is made for part 1's cid.
    const playerCall = fetcher.calls.find(c => c.url.includes('player/v2'))
    expect(playerCall.url).toContain('cid=111')
  })

  it('follows a b23.tv short link and reads the video it lands on', async () => {
    const fetcher = async (url, init) => {
      if (url.startsWith('https://b23.tv/')) {
        return html('', { url: 'https://www.bilibili.com/video/BV1De4y1D7am/?spm_id_from=333' })
      }
      return biliFetcher({ view: VIEW(), player: POINTS(CH(0, 300, '整段')) })(url, init)
    }
    const v = await readVideo('https://b23.tv/abcdefg', { fetcher })
    expect(v.bvid).toBe('BV1De4y1D7am')
    expect(v.chapters).toHaveLength(1)
  })

  it('tells a refused request from a video that is gone', async () => {
    await expect(readVideo('BV1De4y1D7am', { fetcher: biliFetcher({ viewRes: html('<html>blocked</html>', { status: 403 }) }) }))
      .rejects.toMatchObject({ code: 'refused' })
    await expect(readVideo('BV1De4y1D7am', { fetcher: biliFetcher({ viewRes: json({ code: -404, message: '啥都木有' }) }) }))
      .rejects.toMatchObject({ code: 'missing' })
  })

  it('carries Bilibili’s own message for any other error code', async () => {
    const err = await readVideo('BV1De4y1D7am', { fetcher: biliFetcher({ viewRes: json({ code: -400, message: '请求错误' }) }) })
      .catch(e => e)
    expect(err).toBeInstanceOf(VideoLinkError)
    expect(err.code).toBe('api')
    expect(err.message).toContain('请求错误')
  })

  it('refuses a link that is not a Bilibili video before it fetches anything', async () => {
    let called = 0
    const fetcher = async () => { called++; return json({}) }
    await expect(readVideo('https://youtube.com/watch?v=abc', { fetcher })).rejects.toMatchObject({ code: 'link' })
    expect(called).toBe(0)
  })
})

describe('videoPlanBundle', () => {
  const video = {
    bvid: 'BV1De4y1D7am',
    url: 'https://www.bilibili.com/video/BV1De4y1D7am/',
    title: '核心训练',
    uploader: '教练',
    sec: 300,
    part: '',
    parts: 1,
    chapters: [
      { name: '片头', start: 0, end: 81, sec: 81 },
      { name: '正片', start: 81, end: 300, sec: 219 }
    ]
  }

  it('makes one routine with one timed block per chapter', () => {
    const b = videoPlanBundle(video, { iso: '2026-10-31', unit: 'kg' })
    expect(b.opengym_plan).toBe(1)
    expect(b.name).toBe('核心训练')
    expect(b.routines).toHaveLength(1)
    expect(b.routines[0].ex).toHaveLength(2)
    expect(b.routines[0].ex.map(e => [e.mode, e.sec, e.sets])).toEqual([['time', 81, 1], ['time', 219, 1]])
    expect(b.routines[0].ex.map(e => e.vstart)).toEqual([0, 81])
    expect(b.routines[0].ex.map(e => e.videoUrl)).toEqual([video.url, video.url])
    expect(b.customEx).toHaveLength(2)
  })

  it('rests between chapters but not after the last one', () => {
    const ex = videoPlanBundle(video, { iso: '2026-10-31' }).routines[0].ex
    expect(ex[0].restSec).toBe(VIDEO_REST_SEC)
    expect(ex[1].restSec).toBeUndefined()
  })

  it('uses the catalogue for an exact name or a known alias', () => {
    const b = videoPlanBundle({
      ...video,
      chapters: [
        { name: 'Kettlebell Swing', start: 0, end: 60, sec: 60 },
        { name: 'Dumbbell Curl', start: 60, end: 120, sec: 60 },
        { name: '片头', start: 120, end: 300, sec: 180 }
      ]
    }, { iso: '2026-10-31' })

    // Exact catalogue name, curated alias, then the one chapter with no match.
    expect(b.routines[0].ex.map(e => e.id)).toEqual(['0549', '0294', expect.stringMatching(/^video-/)])
    expect(b.routines[0].ex[0]).toMatchObject({ sets: 1, mode: 'time', sec: 60, vstart: 0 })
    expect(b.routines[0].ex[0].videoUrl).toBe(video.url)
    expect(b.routines[0].ex[0].note).toContain('1/3 Kettlebell Swing')
    expect(b.routines[0].ex[0].note).toContain(video.url)
    expect(EXIDX[b.routines[0].ex[0].id]).toMatchObject({ id: '0549', bp: 'upper legs', eq: 'kettlebell' })
    expect(EXIDX[b.routines[0].ex[1].id]).toMatchObject({ id: '0294', n: 'dumbbell biceps curl' })

    // Only the unmatched chapter becomes a custom exercise, and it keeps the video link.
    expect(b.customEx).toHaveLength(1)
    expect(b.customEx[0].id).toBe(b.routines[0].ex[2].id)
    expect(b.customEx[0].url).toBe(video.url)
  })

  it('does not guess a near or ambiguous catalogue match', () => {
    const b = videoPlanBundle({
      ...video,
      chapters: [
        { name: 'Plank', start: 0, end: 60, sec: 60 },
        { name: 'Lever Chest Press', start: 60, end: 120, sec: 60 },
        { name: 'Barbell Deadlift', start: 120, end: 180, sec: 60 },
        { name: '热身', start: 180, end: 300, sec: 120 }
      ]
    }, { iso: '2026-10-31' })

    const ids = b.routines[0].ex.map(e => e.id)
    expect(ids.every(id => /^video-/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(4)
    expect(b.customEx).toHaveLength(4)
  })

  it('keeps repeated catalogue chapters as separate blocks', () => {
    const b = videoPlanBundle({
      ...video,
      chapters: [
        { name: 'Dumbbell Curl', start: 0, end: 60, sec: 60 },
        { name: 'Dumbbell Curl', start: 60, end: 120, sec: 60 }
      ]
    }, { iso: '2026-10-31' })

    expect(b.routines[0].ex.map(e => e.id)).toEqual(['0294', '0294'])
    expect(b.routines[0].ex.map(e => e.vstart)).toEqual([0, 60])
    expect(b.routines[0].ex.map(e => e.sec)).toEqual([60, 60])
    expect(b.routines[0].ex.map(e => e.videoUrl)).toEqual([video.url, video.url])
    expect(b.routines[0].ex[0].restSec).toBe(VIDEO_REST_SEC)
    expect(b.routines[0].ex[1].restSec).toBeUndefined()
    expect(b.routines[0].ex.map(e => e.note)).toEqual([
      expect.stringContaining('1/2 Dumbbell Curl'),
      expect.stringContaining('2/2 Dumbbell Curl')
    ])
    expect(b.customEx).toHaveLength(0)
  })

  it('links each chapter’s custom exercise back to the video', () => {
    const b = videoPlanBundle(video, { iso: '2026-10-31' })
    for (const c of b.customEx) {
      expect(c.url).toBe(video.url)
      expect(c.bp).toBe('cardio')
      expect(c.desc).toContain(video.url)
      expect(c.id).toMatch(/^[A-Za-z0-9-]+$/)
    }
    // The block's exercise id and its custom exercise id are the same exercise.
    expect(b.routines[0].ex.map(e => e.id)).toEqual(b.customEx.map(c => c.id))
  })

  it('puts the chapter’s place and the video’s clock in the block note', () => {
    const note = videoPlanBundle(video, { iso: '2026-10-31' }).routines[0].ex[0].note
    expect(note).toContain('1/2 片头')
    expect(note).toContain('0:00–1:21')
    expect(note).toContain(video.url)
  })

  it('brings a chapterless video as one block as long as the video', () => {
    const b = videoPlanBundle({ ...video, chapters: [] }, { iso: '2026-10-31' })
    expect(b.routines[0].ex).toHaveLength(1)
    expect(b.routines[0].ex[0].sec).toBe(300)
    expect(b.routines[0].ex[0].restSec).toBeUndefined()
    expect(b.customEx).toHaveLength(1)
  })
})

describe('clock and chapterLabel', () => {
  it('writes the video’s own clock', () => {
    expect(clock(0)).toBe('0:00')
    expect(clock(81)).toBe('1:21')
    expect(clock(2034)).toBe('33:54')
    expect(clock(3725)).toBe('1:02:05')
  })

  it('numbers a chapter when there is more than one', () => {
    expect(chapterLabel({ name: '片头', start: 0 }, 0, 3)).toBe('1/3 片头')
    expect(chapterLabel({ name: '', start: 81 }, 0, 1)).toBe('1:21')
  })
})
