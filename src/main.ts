import {
  layoutNextLine,
  layoutWithLines,
  prepareWithSegments,
  type LayoutCursor,
  type PreparedTextWithSegments,
} from '@chenglou/pretext'
import giraffeSvgRaw from './assets/giraffe.svg?raw'
import germPngUrl from './assets/germ.png'
import './style.css'

const REPORT_TITLE = 'Microbe Observation Report'
const SECTION_TITLE = 'Colony Notes'

const BODY_FONT = '400 17px "Source Serif 4", Georgia, serif'
const TITLE_FONT = '600 13px system-ui, sans-serif'
const SECTION_FACE = '600 22px "Source Serif 4", Georgia, serif'
const BODY_LH = 26
const SECTION_LH = 28

const MIN_SLOT = 44

const BODY_TEXT = `This plate documents a spiky colony form with a translucent membrane and dense nodules near the core. Under magnification the edge appears soft, but the silhouette is highly irregular, with long protrusions that create narrow channels around the body. Those channels are precisely where a rectangular layout fails: the text either collides with the shape or leaves too much dead space.

In this report view, each line band is computed against the colony alpha mask. We gather blocked intervals, subtract them from the available column width, and fill the remaining slots from left to right. The result looks like contour wrapping in a publishing tool, but the line breaks are generated with Pretext using cached width data rather than DOM measurements.

Operationally this matters for performance. When the object moves, the page does not query layout metrics from live elements. It reruns pure arithmetic over preprocessed text and the current obstacle geometry. That keeps interaction stable and avoids reflow-heavy loops that can hurt responsiveness.

You can drag the specimen to test this directly. The paragraphs should reorganize around the updated contour while preserving readable rhythm and line height. The goal is not a static poster; it is a dynamic, computational layout that still reads like a designed editorial page.

This is a practical pattern for dashboards, science explainers, and interactive stories: blend expressive shapes with deterministic text flow, and keep the hot path independent from the browser layout engine.`

type Interval = { left: number; right: number }

type PositionedLine = { x: number; y: number; text: string }

function mergeIntervals(intervals: Interval[]): Interval[] {
  if (intervals.length === 0) return []
  const sorted = [...intervals].sort((a, b) => a.left - b.left)
  const out: Interval[] = []
  let cur = sorted[0]!
  for (let i = 1; i < sorted.length; i++) {
    const n = sorted[i]!
    if (n.left <= cur.right) cur = { left: cur.left, right: Math.max(cur.right, n.right) }
    else {
      out.push(cur)
      cur = n
    }
  }
  out.push(cur)
  return out
}

function carveSlots(base: Interval, blocked: Interval[]): Interval[] {
  let slots: Interval[] = [base]
  for (const b of blocked) {
    const next: Interval[] = []
    for (const slot of slots) {
      if (b.right <= slot.left || b.left >= slot.right) {
        next.push(slot)
        continue
      }
      if (b.left > slot.left) next.push({ left: slot.left, right: b.left })
      if (b.right < slot.right) next.push({ left: b.right, right: slot.right })
    }
    slots = next
  }
  return slots.filter(s => s.right - s.left >= MIN_SLOT)
}

function scanRowAlpha(data: ImageData, row: number, thresh: number): Interval[] {
  const w = data.width
  const base = row * w * 4
  const runs: Interval[] = []
  let start = -1
  for (let x = 0; x < w; x++) {
    const a = data.data[base + x * 4 + 3]
    if (a > thresh) {
      if (start < 0) start = x
    } else {
      if (start >= 0) {
        runs.push({ left: start, right: x })
        start = -1
      }
    }
  }
  if (start >= 0) runs.push({ left: start, right: w })
  return runs
}

function alphaBlockedForBand(
  data: ImageData,
  imgRect: { x: number; y: number; w: number; h: number },
  bandTop: number,
  bandBottom: number,
): Interval[] {
  const { x: ix, y: iy, w: iw, h: ih } = imgRect
  const y0 = Math.max(bandTop, iy)
  const y1 = Math.min(bandBottom, iy + ih)
  if (y0 >= y1) return []

  const dh = data.height
  const dw = data.width
  const collected: Interval[] = []

  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    const v = (y + 0.5 - iy) / ih
    if (v < 0 || v > 1) continue
    const row = Math.min(dh - 1, Math.max(0, Math.floor(v * dh)))
    for (const run of scanRowAlpha(data, row, 40)) {
      const pxL = ix + (run.left / dw) * iw
      const pxR = ix + (run.right / dw) * iw
      collected.push({ left: pxL, right: pxR })
    }
  }
  return mergeIntervals(collected)
}

function layoutColumn(
  prepared: PreparedTextWithSegments,
  start: LayoutCursor,
  regionX: number,
  regionY: number,
  regionW: number,
  regionH: number,
  lineHeight: number,
  silhouetteBlocked: (t: number, b: number) => Interval[],
  singleSlotOnly: boolean,
): { lines: PositionedLine[]; cursor: LayoutCursor } {
  let cursor = start
  const lines: PositionedLine[] = []
  let done = false
  let lineTop = regionY

  while (lineTop + lineHeight <= regionY + regionH && !done) {
    const blocked = silhouetteBlocked(lineTop, lineTop + lineHeight)
    const slots = carveSlots({ left: regionX, right: regionX + regionW }, blocked)
    if (slots.length === 0) {
      lineTop += lineHeight
      continue
    }

    const ordered = singleSlotOnly
      ? [
          slots.reduce((a, b) => {
            const aw = a.right - a.left
            const bw = b.right - b.left
            if (bw > aw) return b
            if (bw < aw) return a
            return a.left < b.left ? a : b
          }),
        ]
      : [...slots].sort((a, b) => a.left - b.left)

    for (const slot of ordered) {
      const w = slot.right - slot.left
      const line = layoutNextLine(prepared, cursor, w)
      if (line === null) {
        done = true
        break
      }
      lines.push({
        x: Math.round(slot.left),
        y: Math.round(lineTop),
        text: line.text,
      })
      cursor = line.end
    }
    lineTop += lineHeight
  }

  return { lines, cursor }
}

const canvas = document.querySelector('#page') as HTMLCanvasElement
const ctx = canvas.getContext('2d')!

let preparedBody: PreparedTextWithSegments | null = null
let preparedSection: PreparedTextWithSegments | null = null
let giraffePath: Path2D | null = null
let imageData: ImageData | null = null
let giraffePhoto: HTMLImageElement | null = null
let maskW = 320
let maskH = 520
let mediaAspect = 320 / 520

let giraffeDx = 0
let giraffeDy = 0
let drag: { px: number; py: number; ox: number; oy: number } | null = null

function getSvgAttr(svg: string, attr: string): string | null {
  const m = svg.match(new RegExp(`${attr}\\s*=\\s*"([^"]+)"`))
  return m ? m[1] : null
}

function initGiraffe(): void {
  const pathD = getSvgAttr(giraffeSvgRaw, 'd')
  const viewBox = getSvgAttr(giraffeSvgRaw, 'viewBox')
  if (!pathD || !viewBox) throw new Error('invalid giraffe svg')

  const vb = viewBox.split(/\s+/).map(Number)
  const vbW = Number.isFinite(vb[2]) ? vb[2] : 320
  const vbH = Number.isFinite(vb[3]) ? vb[3] : 520
  const rw = 320
  const rh = 520

  giraffePath = new Path2D(pathD)
  maskW = rw
  maskH = rh
  mediaAspect = vbW / vbH
  const oc = document.createElement('canvas')
  oc.width = rw
  oc.height = rh
  const octx = oc.getContext('2d')!
  octx.clearRect(0, 0, rw, rh)
  octx.save()
  octx.scale(rw / vbW, rh / vbH)
  octx.fillStyle = '#000'
  octx.fill(giraffePath)
  octx.restore()
  imageData = octx.getImageData(0, 0, rw, rh)
}

function loadGiraffePhoto(): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const nw = Math.max(1, img.naturalWidth || img.width)
      const nh = Math.max(1, img.naturalHeight || img.height)
      mediaAspect = nw / nh
      const maxDim = 640
      const scale = Math.min(1, maxDim / Math.max(nw, nh))
      const rw = Math.max(1, Math.round(nw * scale))
      const rh = Math.max(1, Math.round(nh * scale))
      maskW = rw
      maskH = rh
      const oc = document.createElement('canvas')
      oc.width = rw
      oc.height = rh
      const octx = oc.getContext('2d')!
      octx.clearRect(0, 0, rw, rh)
      octx.drawImage(img, 0, 0, rw, rh)
      imageData = octx.getImageData(0, 0, rw, rh)
      giraffePhoto = img
      resolve()
    }
    img.onerror = () => reject(new Error('failed to load local germ.png'))
    img.src = germPngUrl
  })
}

function rebuildPrepared() {
  preparedBody = prepareWithSegments(BODY_TEXT, BODY_FONT)
  preparedSection = prepareWithSegments(SECTION_TITLE, SECTION_FACE)
}

function hitGiraffe(px: number, py: number, rect: { x: number; y: number; w: number; h: number }): boolean {
  return px >= rect.x && px <= rect.x + rect.w && py >= rect.y && py <= rect.y + rect.h
}

function pageLayout(vw: number, vh: number) {
  const tw = Math.min(720, vw * 0.92)
  const th = Math.min(vh * 0.9, tw * 1.38)
  const ox = (vw - tw) / 2
  const oy = (vh - th) / 2
  const padX = 36
  const barH = 48
  const padTop = barH + 20
  const bodyLeft = ox + padX
  const bodyW = tw - padX * 2
  let baseW = tw * 0.48
  let baseH = baseW / mediaAspect
  const maxMediaH = th * 0.76
  if (baseH > maxMediaH) {
    baseH = maxMediaH
    baseW = baseH * mediaAspect
  }
  const baseX = bodyLeft + bodyW - baseW * 0.92
  const baseY = oy + th - baseH * 0.88
  return { tw, th, ox, oy, padX, barH, padTop, bodyLeft, bodyW, baseW, baseH, baseX, baseY }
}

function draw() {
  if (!preparedBody || !preparedSection || !imageData) return

  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const dpr = Math.min(2, window.devicePixelRatio || 1)

  const L = pageLayout(vw, vh)
  const { tw, th, ox, oy, padX, barH, padTop, bodyLeft, bodyW, baseW, baseH, baseX, baseY } = L

  canvas.width = Math.round(vw * dpr)
  canvas.height = Math.round(vh * dpr)
  canvas.style.width = `${vw}px`
  canvas.style.height = `${vh}px`
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)

  ctx.fillStyle = '#1a1a1c'
  ctx.fillRect(0, 0, vw, vh)

  ctx.shadowColor = 'rgba(0,0,0,0.45)'
  ctx.shadowBlur = 40
  ctx.shadowOffsetY = 12
  ctx.fillStyle = '#eae4d8'
  roundRect(ctx, ox, oy, tw, th, 14)
  ctx.fill()
  ctx.shadowBlur = 0
  ctx.shadowOffsetY = 0

  ctx.fillStyle = '#5c4033'
  ctx.beginPath()
  const rr = 14
  ctx.moveTo(ox + rr, oy)
  ctx.lineTo(ox + tw - rr, oy)
  ctx.quadraticCurveTo(ox + tw, oy, ox + tw, oy + rr)
  ctx.lineTo(ox + tw, oy + barH)
  ctx.lineTo(ox, oy + barH)
  ctx.lineTo(ox, oy + rr)
  ctx.quadraticCurveTo(ox, oy, ox + rr, oy)
  ctx.closePath()
  ctx.fill()

  ctx.fillStyle = 'rgba(255,255,255,0.92)'
  ctx.font = TITLE_FONT
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'center'
  ctx.fillText(REPORT_TITLE, ox + tw / 2, oy + barH / 2 + 1)

  const sectionW = tw - padX * 2
  const sectionLines = layoutWithLines(preparedSection, sectionW, SECTION_LH).lines
  ctx.fillStyle = '#3d3530'
  ctx.font = SECTION_FACE
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  let sy = oy + padTop
  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i]!
    ctx.fillText(line.text, ox + tw / 2, sy)
    sy += SECTION_LH
  }

  const bodyTop = sy + 18
  const bodyH = oy + th - bodyTop - 28

  const giraffeRect = {
    x: baseX + giraffeDx,
    y: baseY + giraffeDy,
    w: baseW,
    h: baseH,
  }

  const silhouetteBlocked = (t: number, b: number) =>
    alphaBlockedForBand(imageData!, giraffeRect, t, b)

  const { lines } = layoutColumn(
    preparedBody,
    { segmentIndex: 0, graphemeIndex: 0 },
    bodyLeft,
    bodyTop,
    bodyW,
    bodyH,
    BODY_LH,
    silhouetteBlocked,
    vw < 640,
  )

  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = '#2b2620'
  ctx.font = BODY_FONT
  for (const ln of lines) {
    ctx.fillText(ln.text, ln.x, ln.y)
  }

  if (giraffePhoto) {
    ctx.drawImage(giraffePhoto, giraffeRect.x, giraffeRect.y, giraffeRect.w, giraffeRect.h)
  } else if (giraffePath) {
    ctx.save()
    ctx.translate(giraffeRect.x, giraffeRect.y)
    ctx.scale(giraffeRect.w / maskW, giraffeRect.h / maskH)
    ctx.fillStyle = '#8f6f4f'
    ctx.fill(giraffePath)
    ctx.restore()
  }

  canvas.style.cursor = drag ? 'grabbing' : hitGiraffe(pointerX, pointerY, giraffeRect) ? 'grab' : 'default'
}

let pointerX = 0
let pointerY = 0
let raf = 0
function schedule() {
  if (raf) return
  raf = requestAnimationFrame(() => {
    raf = 0
    draw()
  })
}

function roundRect(
  c: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  const rr = Math.min(r, w / 2, h / 2)
  c.beginPath()
  c.moveTo(x + rr, y)
  c.lineTo(x + w - rr, y)
  c.quadraticCurveTo(x + w, y, x + w, y + rr)
  c.lineTo(x + w, y + h - rr)
  c.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
  c.lineTo(x + rr, y + h)
  c.quadraticCurveTo(x, y + h, x, y + h - rr)
  c.lineTo(x, y + rr)
  c.quadraticCurveTo(x, y, x + rr, y)
  c.closePath()
}

canvas.addEventListener('pointerdown', e => {
  pointerX = e.clientX
  pointerY = e.clientY
  if (!imageData) return
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight
  const { baseW, baseH, baseX, baseY } = pageLayout(vw, vh)
  const gr = { x: baseX + giraffeDx, y: baseY + giraffeDy, w: baseW, h: baseH }
  if (hitGiraffe(e.clientX, e.clientY, gr)) {
    canvas.setPointerCapture(e.pointerId)
    drag = { px: e.clientX, py: e.clientY, ox: giraffeDx, oy: giraffeDy }
  }
  schedule()
})

canvas.addEventListener('pointermove', e => {
  pointerX = e.clientX
  pointerY = e.clientY
  if (drag) {
    giraffeDx = drag.ox + (e.clientX - drag.px)
    giraffeDy = drag.oy + (e.clientY - drag.py)
  }
  schedule()
})

canvas.addEventListener('pointerup', e => {
  drag = null
  pointerX = e.clientX
  pointerY = e.clientY
  schedule()
})

canvas.addEventListener('pointercancel', () => {
  drag = null
  schedule()
})

window.addEventListener('resize', schedule)

void (async () => {
  await document.fonts.ready
  rebuildPrepared()
  try {
    await loadGiraffePhoto()
  } catch {
    initGiraffe()
  }
  schedule()
})()
