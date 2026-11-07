import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { entryVideoUrl, entryVideoTime, fmtVideoTime } from '../lib/video-sync.js'
import { videoSyncSheet } from '../sheets.jsx'

export default function VideoPill({ entry, isCurrent = false, onClick, className = '' }) {
  const online = useUI(s => !!s.videoSync?.online)
  if (!entry) return null
  const url = entryVideoUrl(entry)
  if (!url) return null

  const timeSec = entryVideoTime(entry)
  const timeFormatted = fmtVideoTime(timeSec)
  const isLive = Boolean(isCurrent && online)

  const label = timeFormatted ? timeFormatted : '0:00'
  const ariaLabel = isLive
    ? t('Video sync') + ' · ' + t('Connected') + ` (${label})`
    : t('Video sync') + ` (${label})`

  const handleClick = (e) => {
    e.stopPropagation()
    if (onClick) onClick()
    else videoSyncSheet()
  }

  return (
    <button
      type="button"
      className={`video-pill ${isLive ? 'active' : ''} ${className}`.trim()}
      onClick={handleClick}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {isLive && <span className="video-pill-dot" aria-hidden="true" />}
      <span className="video-pill-icon" aria-hidden="true">▶</span>
      <span className="video-pill-text">{label}</span>
    </button>
  )
}
