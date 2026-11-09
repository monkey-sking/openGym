// The page half: the one <video> the athlete is following, and nothing else. The background
// sends a command when the workout pauses or resumes; this script pauses or plays that video and
// reports a pause or play the athlete made by hand. No seeking, no volume, no autoplay of a
// video that was paused before the workout started.
(() => {
  if (globalThis.__openGymVideoSync) return
  globalThis.__openGymVideoSync = true

  // A play/pause this script caused is not news for the phone. The window is generous because
  // `pause` fires after the media element has processed it, and on a loaded page sometimes a
  // frame or two later.
  let suppressUntil = 0
  let lastUrl = location.href
  let announceTimer = null
  // Set by the background when it opens this page for a play:false start. The site's autoplay is
  // paused at the first playable video, and stays paused until an explicit resume arrives.
  let held = false
  let holdKnown = false
  const SOFT_SYNC_THRESHOLD_SEC = 1.5

  const videos = () => [...document.querySelectorAll('video')]

  // The largest video with a real timeline: a page can carry a hidden preview or an ad clip
  // beside the one being watched.
  function primary () {
    let best = null
    let bestArea = 0
    for (const v of videos()) {
      if (!(v.duration > 0) || v.readyState === 0) continue
      const r = v.getBoundingClientRect()
      const area = Math.max(0, r.width) * Math.max(0, r.height)
      if (area > bestArea) { best = v; bestArea = area }
      else if (!best) best = v
    }
    return best
  }

  const usable = v => Boolean(v && v.duration > 0 && !v.ended)

  const UNAVAILABLE_SELECTORS = [
    '.error-container',
    '.error-body',
    '.error-panel',
    '.van-framepreview-error',
    'yt-player-error-message-renderer',
    '#player-error-message-container'
  ]
  const UNAVAILABLE_TEXT_RE = /当前稿件up主设置为仅自见|啊叻？视频不见了|视频不见了|视频去哪了呢|稿件不见了|该视频已被删除|视频已失效|This video is private|This video is unavailable|Video unavailable/i

  function unavailableReason () {
    try {
      for (const sel of UNAVAILABLE_SELECTORS) {
        const nodes = document.querySelectorAll?.(sel)
        if (nodes && nodes.length > 0) return 'video-unavailable'
      }
      const text = `${document.title || ''} ${document.body?.innerText || document.body?.textContent || ''}`
      if (UNAVAILABLE_TEXT_RE.test(text)) return 'video-unavailable'
    } catch { /* ignore DOM inspection errors */ }
    return null
  }

  // A held page is a video the background opened paused. Pause the first playable one, and every
  // autoplay attempt after it, without reporting those pauses as the athlete's own.
  function enforceHold () {
    if (!held) return
    const v = primary()
    if (!v || v.paused) return
    suppressUntil = Date.now() + 1500
    v.pause()
  }

  function announce () {
    clearTimeout(announceTimer)
    announceTimer = setTimeout(() => {
      const v = primary()
      chrome.runtime.sendMessage({
        type: 'og:video',
        hasVideo: !!v,
        playing: !!(v && !v.paused),
        title: document.title,
        url: location.href,
        currentTime: v ? v.currentTime : null,
        duration: v ? v.duration : null
      }).catch(() => {})
    }, 250)
  }

  // Only the primary element's events count. A page with two <video> tags (a preview reacting
  // to hover) must not pause the workout.
  const isPrimary = el => {
    const v = primary()
    return !!v && el === v
  }

  document.addEventListener('play', ev => {
    if (!(ev.target instanceof HTMLVideoElement) || !isPrimary(ev.target)) return
    if (held) { enforceHold(); announce(); return }
    if (Date.now() < suppressUntil) { announce(); return }
    chrome.runtime.sendMessage({
      type: 'og:event', action: 'resume', url: location.href, at: Date.now()
    }).catch(() => {})
    announce()
  }, true)

  // The player may start through its own autoplay path without a play event the page can see
  // first (a segment swap, a chapter start). Catch it as soon as the element reports playback.
  document.addEventListener('playing', ev => {
    if (!(ev.target instanceof HTMLVideoElement) || !isPrimary(ev.target)) return
    enforceHold()
  }, true)
  document.addEventListener('canplay', ev => {
    if (!(ev.target instanceof HTMLVideoElement) || !isPrimary(ev.target)) return
    enforceHold()
  }, true)

  document.addEventListener('pause', ev => {
    const v = ev.target
    if (!(v instanceof HTMLVideoElement) || !isPrimary(v)) return
    // Reaching the end is the video finishing, not the athlete stopping it.
    if (v.ended || Date.now() < suppressUntil) { announce(); return }
    chrome.runtime.sendMessage({
      type: 'og:event', action: 'pause', url: location.href, at: Date.now()
    }).catch(() => {})
    announce()
  }, true)

  document.addEventListener('loadedmetadata', () => { enforceHold(); announce() }, true)
  document.addEventListener('emptied', announce, true)
  document.addEventListener('ended', announce, true)
  new MutationObserver(() => { enforceHold(); announce() }).observe(document.documentElement, { childList: true, subtree: true })

  async function apply (cmd) {
    const action = typeof cmd === 'string' ? cmd : cmd?.action
    const v = primary()
    // The background waits for this before it tells the phone the tab is ready. It never changes
    // playback, so a page still loading can be probed without side effects.
    if (action === 'status') {
      const hasVideo = usable(v)
      const unavailable = !hasVideo && !!unavailableReason()
      return {
        ok: true,
        action,
        hasVideo,
        ...(unavailable ? { unavailable: true, reason: 'video-unavailable' } : {}),
        paused: v ? v.paused : null,
        currentTime: v ? v.currentTime : null,
        duration: v ? v.duration : null
      }
    }
    if (!usable(v)) {
      if (unavailableReason()) return { ok: false, reason: 'video-unavailable', unavailable: true }
      return { ok: false, reason: 'no-video' }
    }
    if (action === 'seek') {
      const pos = Number(cmd?.pos)
      if (!Number.isFinite(pos)) return { ok: false, reason: 'bad-pos' }
      const offset = Number(cmd?.offset) || 0
      const target = Math.max(0, Math.min(v.duration || Infinity, pos + offset))
      const diff = Math.abs(v.currentTime - target)
      // Only seek if explicitly forced (chapter boundary/nudge) or difference exceeds threshold (default 5s)
      if (!cmd?.force) {
        if (!v.paused && v.currentTime >= target) {
          return { ok: true, action: 'seek', seeked: false, diff, currentTime: v.currentTime }
        }
        if (diff < SOFT_SYNC_THRESHOLD_SEC) {
          return { ok: true, action: 'seek', seeked: false, diff, currentTime: v.currentTime }
        }
      }
      suppressUntil = Date.now() + 1500
      v.currentTime = target
      announce()
      return { ok: true, action: 'seek', seeked: true, target, currentTime: v.currentTime }
    }
    if (action === 'pause') {
      if (!v.paused) {
        suppressUntil = Date.now() + 1500
        v.pause()
      }
      announce()
      return { ok: true, action, paused: v.paused }
    }
    if (action === 'resume') {
      // An explicit resume is the one thing that releases a held page, even if the hold flag and
      // this command arrive in separate messages (or the worker restarted in between).
      held = false
      holdKnown = true
      const pos = Number(cmd?.pos)
      const hasPos = Number.isFinite(pos)
      const target = hasPos
        ? Math.max(0, Math.min(v.duration || Infinity, pos + (Number(cmd?.offset) || 0)))
        : null
      const exact = target != null && cmd?.force === true
      if (exact) {
        suppressUntil = Date.now() + 1500
        v.currentTime = target
      }
      if (v.paused) {
        suppressUntil = Date.now() + 1500
        try {
          await v.play()
        } catch (error) {
          return { ok: false, reason: error?.name === 'NotAllowedError' ? 'blocked' : 'play-failed' }
        }
      }
      announce()
      return { ok: true, action, paused: v.paused, ...(exact ? { seeked: true, target } : {}) }
    }
    // A start retargets the extension at this tab. When the workout names a start timestamp
    // (vstart / ?t=85) and the video is not already there, seek to it so the follow-along
    // begins from the right point. It does not touch play/pause; the background sends a
    // separate resume for a play:true start.
    if (action === 'start') {
      const pos = Number(cmd?.pos)
      const hasPos = Number.isFinite(pos)
      const target = hasPos
        ? Math.max(0, Math.min(v.duration || Infinity, pos + (Number(cmd?.offset) || 0)))
        : null
      if (target != null && target > 0 && Math.abs(v.currentTime - target) >= 1) {
        suppressUntil = Date.now() + 1500
        v.currentTime = target
        announce()
        return { ok: true, action, seeked: true, target, currentTime: v.currentTime }
      }
      return { ok: true, action }
    }
    // end has nothing to undo. It does not touch playback.
    return { ok: true, action }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
    if (msg?.type === 'og:hold') {
      holdKnown = true
      held = msg.held === true
      enforceHold()
      respond?.({ ok: true, held })
      return
    }
    if (msg?.type !== 'og:command') return
    apply(msg).then(respond).catch(error => respond({ ok: false, reason: String(error?.message || error) }))
    return true
  })

  // This script may have loaded after the background already opened the page paused (or after a
  // worker restart). Ask whether this tab is held, but never let that answer override a newer
  // hold/resume message that arrived meanwhile.
  try {
    Promise.resolve(chrome.runtime.sendMessage({ type: 'og:hold?' }))
      .then(res => {
        if (!holdKnown && res?.held === true) { held = true; enforceHold() }
      })
      .catch(() => {})
  } catch { /* no background yet: the hold message will arrive when it sets one */ }

  // Bilibili changes the page under the same tab without a reload; keep the background's idea of
  // which video this tab holds current.
  setInterval(() => {
    if (location.href === lastUrl) return
    lastUrl = location.href
    announce()
  }, 3000)

  announce()
})()
