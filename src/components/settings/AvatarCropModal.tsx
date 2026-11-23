import { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import styles from './AvatarCropModal.module.css'

const STAGE_SIZE = 280
const CROP_SIZE = 224
const OUTPUT_SIZE = 256
const MIN_ZOOM = 1
const MAX_ZOOM = 3
const MAX_BASE64_LENGTH = 245_000

type Size = { width: number; height: number }
type Offset = { x: number; y: number }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 保证图片始终完全覆盖圆形裁切区，避免拖出空白边角 */
const clampOffset = (offset: Offset, natural: Size, scale: number): Offset => {
  const maxX = Math.max(0, (natural.width * scale - CROP_SIZE) / 2)
  const maxY = Math.max(0, (natural.height * scale - CROP_SIZE) / 2)
  return {
    x: clamp(offset.x, -maxX, maxX),
    y: clamp(offset.y, -maxY, maxY),
  }
}

/** 把当前裁切区绘制到 256×256 画布并导出为 base64 Data URL */
const exportCroppedDataUrl = (
  image: HTMLImageElement,
  natural: Size,
  scale: number,
  offset: Offset
): string => {
  const canvas = document.createElement('canvas')
  canvas.width = OUTPUT_SIZE
  canvas.height = OUTPUT_SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    throw new Error('canvas_unavailable')
  }

  const cropNaturalSize = CROP_SIZE / scale
  const sx = natural.width / 2 - offset.x / scale - cropNaturalSize / 2
  const sy = natural.height / 2 - offset.y / scale - cropNaturalSize / 2

  const draw = (fillWhite: boolean) => {
    ctx.clearRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
    if (fillWhite) {
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
    }
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(image, sx, sy, cropNaturalSize, cropNaturalSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
  }

  // 优先 WebP（体积小且保留透明通道）；不支持 WebP 编码的浏览器回落 JPEG
  draw(false)
  for (const quality of [0.88, 0.76, 0.62]) {
    const webp = canvas.toDataURL('image/webp', quality)
    if (webp.startsWith('data:image/webp;base64,')) {
      if (webp.length <= MAX_BASE64_LENGTH || quality === 0.62) {
        return webp
      }
    } else {
      break
    }
  }

  draw(true)
  for (const quality of [0.88, 0.76, 0.62]) {
    const jpeg = canvas.toDataURL('image/jpeg', quality)
    if (jpeg.length <= MAX_BASE64_LENGTH || quality === 0.62) {
      return jpeg
    }
  }
  return canvas.toDataURL('image/jpeg', 0.6)
}

export const AvatarCropModal = ({
  file,
  saving,
  onCancel,
  onConfirm,
}: {
  file: File
  saving: boolean
  onCancel: () => void
  onConfirm: (dataUrl: string) => void
}) => {
  const t = useTranslate()
  const [objectUrl, setObjectUrl] = useState<string | null>(null)
  const [natural, setNatural] = useState<Size | null>(null)
  const [zoom, setZoom] = useState(1)
  const [offset, setOffset] = useState<Offset>({ x: 0, y: 0 })
  const [dragging, setDragging] = useState(false)

  const stageRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const dragStartRef = useRef<{ pointerX: number; pointerY: number; origin: Offset } | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setObjectUrl(url)
    setNatural(null)
    setZoom(1)
    setOffset({ x: 0, y: 0 })
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [file])

  const baseScale = natural ? CROP_SIZE / Math.min(natural.width, natural.height) : 1
  const scale = baseScale * zoom

  const applyZoom = useCallback(
    (nextZoomRaw: number) => {
      const nextZoom = clamp(Number(nextZoomRaw.toFixed(3)), MIN_ZOOM, MAX_ZOOM)
      setZoom((prevZoom) => {
        if (!natural || prevZoom === nextZoom) {
          return nextZoom
        }
        const ratio = nextZoom / prevZoom
        const nextScale = (CROP_SIZE / Math.min(natural.width, natural.height)) * nextZoom
        setOffset((prev) =>
          clampOffset({ x: prev.x * ratio, y: prev.y * ratio }, natural, nextScale)
        )
        return nextZoom
      })
    },
    [natural]
  )

  // 滚轮缩放需要 passive: false 阻止弹窗外滚动
  useEffect(() => {
    const stage = stageRef.current
    if (!stage || !natural) {
      return
    }
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const delta = -event.deltaY * 0.0022
      setZoom((prevZoom) => {
        const nextZoom = clamp(Number((prevZoom + delta).toFixed(3)), MIN_ZOOM, MAX_ZOOM)
        if (nextZoom === prevZoom) {
          return prevZoom
        }
        const ratio = nextZoom / prevZoom
        const nextScale = (CROP_SIZE / Math.min(natural.width, natural.height)) * nextZoom
        setOffset((prev) =>
          clampOffset({ x: prev.x * ratio, y: prev.y * ratio }, natural, nextScale)
        )
        return nextZoom
      })
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    return () => stage.removeEventListener('wheel', onWheel)
  }, [natural])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!natural || saving) {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    setDragging(true)
    dragStartRef.current = {
      pointerX: event.clientX,
      pointerY: event.clientY,
      origin: offset,
    }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const start = dragStartRef.current
    if (!start || !natural) {
      return
    }
    const next = {
      x: start.origin.x + (event.clientX - start.pointerX),
      y: start.origin.y + (event.clientY - start.pointerY),
    }
    setOffset(clampOffset(next, natural, scale))
  }

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragStartRef.current) {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId)
      }
      dragStartRef.current = null
      setDragging(false)
    }
  }

  const handleConfirm = () => {
    const image = imgRef.current
    if (!image || !natural || saving) {
      return
    }
    try {
      const dataUrl = exportCroppedDataUrl(image, natural, scale, offset)
      onConfirm(dataUrl)
    } catch {
      showToast({ key: 'accountAvatarSaveFailed', type: 'error' })
    }
  }

  return (
    <Modal
      title={t('accountAvatarCropTitle')}
      closable={!saving}
      className={styles.modal}
      onClose={() => {
        if (!saving) {
          onCancel()
        }
      }}
      footer={
        <>
          <Button variant="outlined" disabled={saving} onClick={onCancel}>
            {t('cancel')}
          </Button>
          <Button variant="primary" disabled={!natural || saving} onClick={handleConfirm}>
            {saving ? t('accountAvatarSaving') : t('accountAvatarSave')}
          </Button>
        </>
      }
    >
      <div className={styles.body}>
        <div
          ref={stageRef}
          className={styles.stage}
          data-dragging={dragging || undefined}
          style={{ width: STAGE_SIZE, height: STAGE_SIZE }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerEnd}
          onPointerCancel={onPointerEnd}
        >
          {objectUrl ? (
            <img
              ref={imgRef}
              src={objectUrl}
              alt=""
              draggable={false}
              className={styles.image}
              style={
                natural
                  ? {
                      width: natural.width * scale,
                      height: natural.height * scale,
                      transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`,
                      opacity: 1,
                    }
                  : { opacity: 0 }
              }
              onLoad={(event) => {
                const img = event.currentTarget
                if (img.naturalWidth > 0 && img.naturalHeight > 0) {
                  setNatural({ width: img.naturalWidth, height: img.naturalHeight })
                } else {
                  showToast({ key: 'accountAvatarLoadFailed', type: 'error' })
                  onCancel()
                }
              }}
              onError={() => {
                showToast({ key: 'accountAvatarLoadFailed', type: 'error' })
                onCancel()
              }}
            />
          ) : null}
          <div
            className={styles.mask}
            aria-hidden
            style={{ width: CROP_SIZE, height: CROP_SIZE }}
          />
        </div>

        <div className={styles.hint}>{t('accountAvatarCropHint')}</div>

        <div className={styles.controls}>
          <span className={styles.zoomLabel}>{t('accountAvatarZoom')}</span>
          <button
            type="button"
            className={styles.stepBtn}
            disabled={!natural || saving || zoom <= MIN_ZOOM}
            aria-label="Zoom out"
            onClick={() => applyZoom(zoom - 0.15)}
          >
            −
          </button>
          <input
            type="range"
            className={styles.slider}
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={0.01}
            value={zoom}
            disabled={!natural || saving}
            aria-label={t('accountAvatarZoom')}
            onChange={(event) => applyZoom(Number(event.target.value))}
          />
          <button
            type="button"
            className={styles.stepBtn}
            disabled={!natural || saving || zoom >= MAX_ZOOM}
            aria-label="Zoom in"
            onClick={() => applyZoom(zoom + 0.15)}
          >
            +
          </button>
          <span className={styles.zoomValue}>{Math.round(zoom * 100)}%</span>
        </div>
      </div>
    </Modal>
  )
}
