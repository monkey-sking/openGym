import React from 'react'

/**
 * Returns visual styling for an individual plate disc by weight and unit.
 * Follows IWF / Olympic color standards: Red (25kg/55lb), Blue (20kg/45lb),
 * Yellow (15kg/35lb), Green (10kg/25lb), White (5kg), Black (2.5kg/10lb).
 */
export function plateVisual(weight, unit = 'kg') {
  const w = Number(weight) || 0
  const isLb = unit === 'lb'

  if (isLb) {
    if (w >= 55) return { bg: '#e03131', h: 16, w: 5 }
    if (w >= 45) return { bg: '#1971c2', h: 16, w: 5 }
    if (w >= 35) return { bg: '#f59f00', h: 14, w: 5 }
    if (w >= 25) return { bg: '#2f9e44', h: 12, w: 4 }
    if (w >= 10) return { bg: '#343a40', h: 10, w: 4 }
    if (w >= 5)  return { bg: '#495057', h: 9,  w: 3 }
    return { bg: '#868e96', h: 8, w: 3 }
  }

  // kg
  if (w >= 25)  return { bg: '#e03131', h: 16, w: 5 }
  if (w >= 20)  return { bg: '#1971c2', h: 16, w: 5 }
  if (w >= 15)  return { bg: '#f59f00', h: 14, w: 5 }
  if (w >= 10)  return { bg: '#2f9e44', h: 12, w: 4 }
  if (w >= 5)   return { bg: '#f8f9fa', h: 10, w: 4, border: '1px solid #adb5bd' }
  if (w >= 2.5) return { bg: '#343a40', h: 9,  w: 3 }
  if (w >= 2)   return { bg: '#1971c2', h: 8,  w: 3 }
  if (w >= 1.5) return { bg: '#f59f00', h: 8,  w: 3 }
  if (w >= 1)   return { bg: '#2f9e44', h: 7,  w: 3 }
  if (w >= 0.5) return { bg: '#f8f9fa', h: 7,  w: 3, border: '1px solid #adb5bd' }
  return { bg: '#868e96', h: 8, w: 3 }
}

/**
 * Visual Plate Bar: renders miniature barbell plate discs stacked along the sleeve.
 * Extremely glanceable in the gym — athletes recognize plate colors without reading text.
 */
export default function PlateBar({ plates, unit = 'kg', className = '' }) {
  if (!Array.isArray(plates) || plates.length === 0) return null

  return (
    <div className={`plate-bar ${className}`.trim()} aria-hidden="true">
      <div className="plate-collar" />
      {plates.map((p, idx) => {
        const spec = plateVisual(p, unit)
        return (
          <div
            key={idx}
            className="plate-disc"
            style={{
              height: spec.h,
              width: spec.w,
              backgroundColor: spec.bg,
              border: spec.border || 'none',
              boxSizing: 'border-box',
            }}
            title={`${p} ${unit}`}
          />
        )
      })}
    </div>
  )
}
