'use client'

import { useEffect, useState, useMemo, useCallback, useRef } from 'react'
import Script from 'next/script'

// ============ Types ============
type DamageStatus = 'Pending Inspection' | 'Damaged' | 'No Visible Damage'
type DamageSeverity = 'Minor' | 'Moderate' | 'Major' | 'N/A'
type ActionRequired = 'Monitor' | 'Repair' | 'Replacement' | 'Assessment' | 'None'

interface Laptop {
  id?: number
  no: number
  assetNo: string
  serialNumber: string
  currentLocation: string
  userDepartment: string
  damageStatus: DamageStatus
  damageType: string
  damagedPart: string
  damageSeverity: DamageSeverity
  damageDescription: string
  inspector: string
  inspectionDate: string
  photoReference: string
  remarks: string
  actionRequired: ActionRequired
  createdAt: string
  updatedAt: string
  _photoCount?: number
  _lastKnownAsset?: string
}

interface Photo {
  id?: number
  laptopId: number
  photoType: string
  name: string
  blob: Blob
  createdAt: string
}

interface ToastMsg {
  id: number
  message: string
  type: 'success' | 'error' | 'warning' | 'info'
  description?: string
}

// Dexie is loaded via CDN script tag in layout
declare global {
  interface Window { Dexie: any; XLSX: any; JSZip: any; Tesseract: any }
}

const TOTAL_LAPTOPS = 26
const DB_NAME = 'LaptopDamageInspectionDB'

// ============ Dexie DB (client-side) ============
function getDB() {
  if (typeof window === 'undefined') return null
  if (!window.Dexie) return null
  const db = new window.Dexie(DB_NAME)
  db.version(1).stores({
    laptops: '++id, &no, assetNo, serialNumber, damageStatus, inspector',
    photos: '++id, laptopId, photoType, [laptopId+photoType]',
  })
  return db
}

// ============ Helpers ============
const makeLaptopCode = (no: number) => 'LT-' + String(no).padStart(3, '0')

function emptyLaptop(no: number): Laptop {
  const now = new Date().toISOString()
  return {
    no, assetNo: '', serialNumber: '', currentLocation: '', userDepartment: '',
    damageStatus: 'Pending Inspection', damageType: '', damagedPart: '',
    damageSeverity: 'N/A', damageDescription: '', inspector: '',
    inspectionDate: '', photoReference: '', remarks: '',
    actionRequired: 'None', createdAt: now, updatedAt: now,
  }
}

function sanitizeAssetName(assetNo: string): string | null {
  if (!assetNo || !assetNo.trim()) return null
  return assetNo.trim().replace(/[^A-Za-z0-9\-_]/g, '_')
}

async function ensureInitialized(db: any) {
  const count = await db.laptops.count()
  if (count === 0) {
    const records: Laptop[] = []
    for (let i = 1; i <= TOTAL_LAPTOPS; i++) records.push(emptyLaptop(i))
    await db.laptops.bulkAdd(records)
  }
}

async function refreshPhotoReference(db: any, laptopId: number) {
  const laptop = await db.laptops.get(laptopId)
  if (!laptop) return
  const photos = await db.photos.where('laptopId').equals(laptopId).toArray()
  const baseName = sanitizeAssetName(laptop.assetNo) || makeLaptopCode(laptop.no)
  const ref = photos.map((_: any, idx: number) => `${baseName}_${idx + 1}`).join(', ')
  await db.laptops.update(laptopId, { photoReference: ref, updatedAt: new Date().toISOString() })
  for (let i = 0; i < photos.length; i++) {
    const newName = `${baseName}_${i + 1}`
    if (photos[i].name !== newName) {
      await db.photos.update(photos[i].id, { name: newName })
    }
  }
}

function escapeHtml(s: any): string {
  if (s == null) return ''
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

// ============ OCR Smart ID Extraction ============
function extractLikelyId(rawText: string, target: 'assetNo' | 'serialNumber'): string {
  if (!rawText) return ''
  const lines = rawText.split(/\n/).map(line =>
    line.replace(/([A-Za-z0-9])\s+(?=[A-Za-z0-9])/g, '$1').trim()
  )
  const joined = lines.join('\n')

  if (target === 'assetNo') {
    const strict = joined.match(/EX\d{2}X\d{6,8}/i)
    if (strict) return strict[0].toUpperCase()
    const loose = joined.match(/EX\d{2,3}X?\d{6,8}/i)
    if (loose) return loose[0].toUpperCase()
    const candidates = joined.match(/[A-Z0-9OILSBGZiloxQD]{8,16}/gi) || []
    for (const cand of candidates) {
      const normalized = cand.toUpperCase()
        .replace(/[OQD]/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5')
        .replace(/B/g, '8').replace(/G/g, '6').replace(/Z/g, '2')
      const m = normalized.match(/EX\d{2}X\d{6,8}/)
      if (m) return m[0]
    }
  }

  if (target === 'serialNumber') {
    const labelled = joined.match(/(?:serial|s\/?n)\s*(?:no|number|#)?\s*[:\-]?\s*([A-Za-z0-9][A-Za-z0-9\-]{3,})/i)
    if (labelled?.[1]) return labelled[1].toUpperCase()
    const serialMatch = joined.match(/\b([A-Z]{2,4}\d{6,8})\b/i) || joined.match(/\b(\d{10,12})\b/)
    if (serialMatch?.[1]) return serialMatch[1].toUpperCase()
  }

  const cleaned = joined
    .replace(/serial\s*(no|number)?\s*[:#]?\s*/gi, ' ')
    .replace(/asset\s*(no|tag|number)?\s*[:#]?\s*/gi, ' ')
    .replace(/s\/n\s*[:#]?\s*/gi, ' ').replace(/a\/n\s*[:#]?\s*/gi, ' ').replace(/p\/n\s*[:#]?\s*/gi, ' ')
  const tokens = cleaned.split(/[^A-Za-z0-9\-]+/).filter(Boolean)
  let best = '', bestScore = -1
  for (const tok of tokens) {
    if (tok.length < 3) continue
    const normalized = tok.toUpperCase()
      .replace(/[OQD]/g, '0').replace(/[IL|]/g, '1').replace(/S/g, '5')
      .replace(/B/g, '8').replace(/G/g, '6').replace(/Z/g, '2')
    const hasDigit = /\d/.test(normalized)
    const hasLetter = /[A-Z]/.test(normalized)
    let score = tok.length
    if (hasDigit) score += 5
    if (hasLetter) score += 2
    if (hasDigit && hasLetter) score += 3
    if (tok.length >= 5 && tok.length <= 20) score += 2
    if (/EX\d{2}X\d{6,8}/.test(normalized)) score += 50
    if (score > bestScore) {
      bestScore = score
      best = /EX\d{2}X\d{6,8}/.test(normalized) ? normalized : tok
    }
  }
  return best.toUpperCase()
}

// ============ Image Preprocessing for Tesseract ============
async function preprocessImageForOcr(blob: Blob, scale: number = 2): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(blob); return }
      ctx.imageSmoothingEnabled = true
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(img, 0, 0, w, h)
      URL.revokeObjectURL(img.src)
      try {
        const imageData = ctx.getImageData(0, 0, w, h)
        const data = imageData.data
        const contrast = 1.6
        const intercept = 128 * (1 - contrast)
        for (let i = 0; i < data.length; i += 4) {
          const gray = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
          let v = gray * contrast + intercept
          if (v < 0) v = 0; if (v > 255) v = 255
          data[i] = data[i + 1] = data[i + 2] = v
        }
        const hist = new Array(256).fill(0)
        for (let i = 0; i < data.length; i += 4) hist[data[i]]++
        const total = w * h
        let sum = 0
        for (let t = 0; t < 256; t++) sum += t * hist[t]
        let sumB = 0, wB = 0, varMax = 0, threshold = 128
        for (let t = 0; t < 256; t++) {
          wB += hist[t]
          if (wB === 0) continue
          const wF = total - wB
          if (wF === 0) break
          sumB += t * hist[t]
          const mB = sumB / wB
          const mF = (sum - sumB) / wF
          const between = wB * wF * (mB - mF) * (mB - mF)
          if (between > varMax) { varMax = between; threshold = t }
        }
        for (let i = 0; i < data.length; i += 4) {
          const v = data[i] > threshold ? 255 : 0
          data[i] = data[i + 1] = data[i + 2] = v
        }
        ctx.putImageData(imageData, 0, 0)
        canvas.toBlob((outBlob) => resolve(outBlob || blob), 'image/png')
      } catch (e) {
        console.warn('preprocess failed', e)
        resolve(blob)
      }
    }
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Image load failed')) }
    img.src = URL.createObjectURL(blob)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function optimizeImage(file: File | Blob, maxDim: number = 1600, quality: number = 0.82): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height))
      const w = Math.round(img.width * scale)
      const h = Math.round(img.height * scale)
      const canvas = document.createElement('canvas')
      canvas.width = w; canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) { resolve(file); return }
      ctx.drawImage(img, 0, 0, w, h)
      canvas.toBlob((blob) => resolve(blob || file), 'image/jpeg', quality)
      URL.revokeObjectURL(img.src)
    }
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error('Failed to load image')) }
    img.src = URL.createObjectURL(file)
  })
}

export default function Home() {
  const [allLaptops, setAllLaptops] = useState<Laptop[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<'all' | DamageStatus>('all')
  const [selected, setSelected] = useState<Laptop | null>(null)
  const [open, setOpen] = useState(false)
  const [photos, setPhotos] = useState<Photo[]>([])
  const [form, setForm] = useState<Laptop | null>(null)
  const [saving, setSaving] = useState(false)
  const [ocrBusy, setOcrBusy] = useState(false)
  const [ocrProgress, setOcrProgress] = useState(0)
  const [ocrText, setOcrText] = useState('')
  const [showOcrBox, setShowOcrBox] = useState(false)
  const [previewSrc, setPreviewSrc] = useState<string | null>(null)
  const [toasts, setToasts] = useState<ToastMsg[]>([])
  const [resetOpen, setResetOpen] = useState(false)
  const [exportingZip, setExportingZip] = useState(false)
  const [zipProgress, setZipProgress] = useState(0)
  const fileCameraRef = useRef<HTMLInputElement | null>(null)
  const fileGalleryRef = useRef<HTMLInputElement | null>(null)
  const toastIdRef = useRef(0)

  const db = typeof window !== 'undefined' ? getDB() : null

  // ============ Toast ============
  const toast = useCallback((message: string, type: ToastMsg['type'] = 'info', description: string = '') => {
    const id = ++toastIdRef.current
    setToasts(prev => [...prev, { id, message, type, description }])
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id))
    }, 4500)
  }, [])

  // ============ Load All ============
  const loadAll = useCallback(async () => {
    if (!db) return
    try {
      await ensureInitialized(db)
      const all = await db.laptops.orderBy('no').toArray()
      for (const l of all) {
        if (l.id) {
          const count = await db.photos.where('laptopId').equals(l.id).count()
          l._photoCount = count
        } else { l._photoCount = 0 }
      }
      setAllLaptops(all)
    } catch (err) {
      console.error(err)
      toast('فشل تحميل البيانات', 'error')
    } finally {
      setLoading(false)
    }
  }, [db, toast])

  useEffect(() => { loadAll() }, [loadAll])

  // ============ Filtered laptops ============
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allLaptops.filter(l => {
      if (statusFilter !== 'all' && l.damageStatus !== statusFilter) return false
      if (!q) return true
      return (
        String(l.no).padStart(3, '0').includes(q) ||
        (l.assetNo || '').toLowerCase().includes(q) ||
        (l.serialNumber || '').toLowerCase().includes(q) ||
        (l.currentLocation || '').toLowerCase().includes(q) ||
        (l.userDepartment || '').toLowerCase().includes(q) ||
        (l.inspector || '').toLowerCase().includes(q)
      )
    })
  }, [allLaptops, search, statusFilter])

  // ============ Stats ============
  const stats = useMemo(() => {
    const total = allLaptops.length
    const inspected = allLaptops.filter(l => l.damageStatus !== 'Pending Inspection').length
    const damaged = allLaptops.filter(l => l.damageStatus === 'Damaged').length
    const clean = allLaptops.filter(l => l.damageStatus === 'No Visible Damage').length
    const pending = total - inspected
    const pct = total > 0 ? Math.round((inspected / total) * 100) : 0
    return { total, inspected, damaged, clean, pending, pct }
  }, [allLaptops])

  const lastUpdate = useMemo(() => {
    const last = allLaptops.map(l => l.updatedAt).filter(Boolean).sort().pop()
    return last ? new Date(last).toLocaleString('en-GB') : ''
  }, [allLaptops])

  // ============ Open Detail ============
  const openDetail = useCallback(async (laptop: Laptop) => {
    if (!db || !laptop.id) return
    setSelected(laptop)
    const newForm = { ...laptop, _lastKnownAsset: laptop.assetNo || '' }
    setForm(newForm)
    const photoList = await db.photos.where('laptopId').equals(laptop.id).toArray()
    setPhotos(photoList)
    setOpen(true)
    document.body.style.overflow = 'hidden'
  }, [db])

  const closeDetail = useCallback(() => {
    setOpen(false)
    document.body.style.overflow = ''
    setTimeout(() => { setSelected(null); setForm(null); setPhotos([]) }, 250)
  }, [])

  // ============ Update form field ============
  const update = useCallback(<K extends keyof Laptop>(key: K, value: Laptop[K]) => {
    setForm(prev => prev ? { ...prev, [key]: value } : prev)
  }, [])

  // ============ Save ============
  const saveLaptop = useCallback(async () => {
    if (!db || !form?.id) return
    setSaving(true)
    const patch: Partial<Laptop> = {
      assetNo: form.assetNo.trim(),
      serialNumber: form.serialNumber.trim(),
      currentLocation: form.currentLocation.trim(),
      userDepartment: form.userDepartment.trim(),
      damageStatus: form.damageStatus,
      damageType: form.damageType,
      damagedPart: form.damagedPart,
      damageSeverity: form.damageSeverity,
      damageDescription: form.damageDescription.trim(),
      inspector: form.inspector.trim(),
      remarks: form.remarks.trim(),
      actionRequired: form.actionRequired,
      updatedAt: new Date().toISOString(),
    }
    if (form.inspectionDate) {
      patch.inspectionDate = form.inspectionDate
    } else if (patch.damageStatus !== 'Pending Inspection' && !form.inspectionDate) {
      patch.inspectionDate = new Date().toISOString()
    } else if (patch.damageStatus === 'Pending Inspection') {
      patch.inspectionDate = ''
    }
    try {
      await db.laptops.update(form.id, patch)
      // If Asset No changed, refresh photo references
      const oldAsset = form._lastKnownAsset || ''
      if (patch.assetNo !== oldAsset) {
        await refreshPhotoReference(db, form.id)
        const newPhotos = await db.photos.where('laptopId').equals(form.id).toArray()
        setPhotos(newPhotos)
        setForm(prev => prev ? { ...prev, _lastKnownAsset: patch.assetNo } : prev)
      }
      const updated = await db.laptops.get(form.id)
      if (updated) {
        setForm(prev => prev ? { ...prev, ...updated, _lastKnownAsset: updated.assetNo || '' } : prev)
      }
      setAllLaptops(prev => prev.map(l => l.id === form.id ? { ...l, ...patch } : l))
      toast('تم الحفظ', 'success')
    } catch (err) {
      console.error(err)
      toast('فشل الحفظ', 'error')
    } finally {
      setSaving(false)
    }
  }, [db, form, toast])

  // ============ Handle status change (auto-save) ============
  const handleStatusChange = useCallback(async (newStatus: DamageStatus) => {
    if (!db || !form?.id) return
    update('damageStatus', newStatus)
    const newDate = (newStatus !== 'Pending Inspection' && !form.inspectionDate)
      ? new Date().toISOString() : form.inspectionDate
    if (newStatus !== 'Pending Inspection' && !form.inspectionDate) {
      update('inspectionDate', newDate)
    }
    try {
      await db.laptops.update(form.id, {
        damageStatus: newStatus,
        inspectionDate: newDate,
        updatedAt: new Date().toISOString(),
      })
      setAllLaptops(prev => prev.map(l => l.id === form.id ? { ...l, damageStatus: newStatus, inspectionDate: newDate } : l))
      toast('تم تحديث الحالة', 'success')
    } catch (err) {
      console.error(err)
      toast('فشل تحديث الحالة', 'error')
    }
  }, [db, form, update, toast])

  // ============ Handle file selected ============
  const handleFileSelected = useCallback(async (file: File | undefined) => {
    if (!file || !db || !form?.id) return
    try {
      const optimized = await optimizeImage(file)
      await db.photos.add({
        laptopId: form.id,
        photoType: 'overview',
        name: 'pending',
        blob: optimized,
        createdAt: new Date().toISOString(),
      })
      await refreshPhotoReference(db, form.id)
      const newPhotos = await db.photos.where('laptopId').equals(form.id).toArray()
      setPhotos(newPhotos)
      const updated = await db.laptops.get(form.id)
      if (updated) {
        setForm(prev => prev ? { ...prev, photoReference: updated.photoReference || '' } : prev)
      }
      const count = newPhotos.length
      setAllLaptops(prev => prev.map(l => l.id === form.id ? { ...l, _photoCount: count } : l))
      toast('تمت إضافة الصورة', 'success')
    } catch (err) {
      console.error(err)
      toast('فشل حفظ الصورة', 'error')
    }
  }, [db, form, toast])

  // ============ Delete photo ============
  const handleDeletePhoto = useCallback(async (photoId: number) => {
    if (!db || !form?.id) return
    await db.photos.delete(photoId)
    await refreshPhotoReference(db, form.id)
    const newPhotos = await db.photos.where('laptopId').equals(form.id).toArray()
    setPhotos(newPhotos)
    const updated = await db.laptops.get(form.id)
    if (updated) {
      setForm(prev => prev ? { ...prev, photoReference: updated.photoReference || '' } : prev)
    }
    setAllLaptops(prev => prev.map(l => l.id === form.id ? { ...l, _photoCount: newPhotos.length } : l))
    toast('تم حذف الصورة', 'success')
  }, [db, form, toast])

  // ============ Smart OCR (VLM API) ============
  const runSmartOcr = useCallback(async (blob: Blob, target: 'assetNo' | 'serialNumber') => {
    if (ocrBusy) return
    setOcrBusy(true)
    setShowOcrBox(true)
    setOcrProgress(20)
    setOcrText('جارٍ قراءة الرقم بالذكاء الاصطناعي...')
    try {
      const dataUrl = await blobToDataUrl(blob)
      setOcrProgress(40)
      setOcrText('جارٍ إرسال الصورة للسحابة...')
      const res = await fetch('/api/ocr', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: dataUrl, target }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setOcrProgress(80)
      setOcrText('جارٍ تحليل النتيجة...')
      const data = await res.json()
      setOcrProgress(100)
      if (data.ok && data.found && data.value) {
        if (target === 'assetNo') update('assetNo', data.value)
        else update('serialNumber', data.value)
        toast(`تم التعرف على: ${data.value}`, 'success', 'راجع الرقم ثم اضغط حفظ')
      } else if (data.ok && !data.found) {
        toast('الذكاء الاصطناعي لم يجد الرقم، جارٍ المحاولة المحلية...', 'warning')
        setOcrBusy(false)
        await runLocalOcr(blob, target)
        return
      } else {
        throw new Error(data.error || 'API error')
      }
    } catch (err) {
      console.error('Smart OCR failed:', err)
      toast('الذكاء الاصطناعي غير متاح، جارٍ OCR المحلي...', 'warning')
      setOcrBusy(false)
      await runLocalOcr(blob, target)
      return
    } finally {
      setOcrBusy(false)
      setTimeout(() => setShowOcrBox(false), 1500)
    }
  }, [ocrBusy, update, toast])

  // ============ Local OCR (Tesseract fallback) ============
  const runLocalOcr = useCallback(async (blob: Blob, target: 'assetNo' | 'serialNumber') => {
    if (ocrBusy) return
    if (!window.Tesseract) {
      toast('OCR المحلي غير متاح', 'error')
      return
    }
    setOcrBusy(true)
    setShowOcrBox(true)
    setOcrProgress(0)
    setOcrText('جارٍ تحسين الصورة...')
    try {
      const processed = await preprocessImageForOcr(blob, 2)
      const allTexts: string[] = []
      // Pass A: original
      setOcrText('محاولة 1 من 3: الصورة الأصلية...')
      setOcrProgress(10)
      try {
        const r1 = await window.Tesseract.recognize(blob, 'eng', {
          logger: (m: any) => { if (m.status === 'recognizing text') { setOcrProgress(10 + Math.round(m.progress * 25)); setOcrText(`محاولة 1 من 3: ${Math.round(m.progress*100)}%`) } }
        })
        allTexts.push(r1.data.text)
      } catch (e) { console.warn('pass A', e) }
      // Pass B: preprocessed
      setOcrText('محاولة 2 من 3: الصورة المحسّنة...')
      setOcrProgress(40)
      try {
        const r2 = await window.Tesseract.recognize(processed, 'eng', {
          logger: (m: any) => { if (m.status === 'recognizing text') { setOcrProgress(40 + Math.round(m.progress * 25)); setOcrText(`محاولة 2 من 3: ${Math.round(m.progress*100)}%`) } }
        })
        allTexts.push(r2.data.text)
      } catch (e) { console.warn('pass B', e) }
      // Pass C: whitelist
      setOcrText('محاولة 3 من 3: مع فلتر الأحرف...')
      setOcrProgress(70)
      try {
        const whitelist = target === 'assetNo' ? 'EX0123456789' : 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        const r3 = await window.Tesseract.recognize(processed, 'eng', {
          tessedit_char_whitelist: whitelist,
          tessedit_pageseg_mode: '6',
          logger: (m: any) => { if (m.status === 'recognizing text') { setOcrProgress(70 + Math.round(m.progress * 25)); setOcrText(`محاولة 3 من 3: ${Math.round(m.progress*100)}%`) } }
        })
        allTexts.push(r3.data.text)
      } catch (e) { console.warn('pass C', e) }
      setOcrProgress(100)
      setOcrText('جارٍ تحليل النتائج...')
      const combined = allTexts.join('\n\n---\n\n')
      const id = extractLikelyId(combined, target)
      if (id) {
        if (target === 'assetNo') update('assetNo', id)
        else update('serialNumber', id)
        toast(`تم التعرف على: ${id}`, 'success', 'راجع الرقم ثم اضغط حفظ')
      } else {
        const preview = combined.replace(/\n+/g, ' ').slice(0, 150) || 'النص فارغ'
        toast('لم أتعرف على رقم تلقائياً', 'warning', 'راجع النص واكتب الرقم يدوياً: ' + preview)
      }
    } catch (err) {
      console.error(err)
      toast('فشل تشغيل OCR', 'error', (err as Error).message || '')
    } finally {
      setOcrBusy(false)
      setTimeout(() => setShowOcrBox(false), 1500)
    }
  }, [ocrBusy, update, toast])

  // ============ Export Excel ============
  const exportExcel = useCallback(() => {
    if (!window.XLSX) { toast('مكتبة Excel غير متاحة', 'error'); return }
    const headers = [
      'No.', 'Laptop / Asset No.', 'Serial Number', 'Current Location', 'User / Department',
      'Damage Status', 'Damage Type', 'Damaged Part', 'Damage Severity', 'Damage Description',
      'Inspector', 'Inspection Date', 'Photo Reference', 'Remarks', 'Action Required'
    ]
    const data = [headers, ...allLaptops.map(l => [
      l.no, l.assetNo, l.serialNumber, l.currentLocation, l.userDepartment,
      l.damageStatus, l.damageType, l.damagedPart, l.damageSeverity, l.damageDescription,
      l.inspector, l.inspectionDate ? new Date(l.inspectionDate).toLocaleDateString('en-GB') : '',
      l.photoReference, l.remarks, l.actionRequired
    ])]
    const ws = window.XLSX.utils.aoa_to_sheet(data)
    ws['!cols'] = [{wch:5},{wch:18},{wch:18},{wch:18},{wch:18},{wch:18},{wch:16},{wch:16},{wch:12},{wch:50},{wch:18},{wch:14},{wch:30},{wch:30},{wch:14}]
    const wb = window.XLSX.utils.book_new()
    window.XLSX.utils.book_append_sheet(wb, ws, 'Damage Inspection')
    const summary = [
      ['Laptop Damage Inspection Report'],
      ['Generated', new Date().toLocaleString('en-GB')],
      ['Total Laptops', allLaptops.length],
      ['Inspected', stats.inspected],
      ['Pending', stats.pending],
      ['Damaged', stats.damaged],
      ['No Visible Damage', stats.clean]
    ]
    const sws = window.XLSX.utils.aoa_to_sheet(summary)
    sws['!cols'] = [{wch:22},{wch:30}]
    window.XLSX.utils.book_append_sheet(wb, sws, 'Summary')
    const buf = window.XLSX.write(wb, { type: 'array', bookType: 'xlsx' })
    const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
    const d = new Date(); const pad = (n: number) => String(n).padStart(2, '0')
    const filename = `Laptop_Damage_Inspection_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.xlsx`
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = filename
    document.body.appendChild(a); a.click(); document.body.removeChild(a)
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    toast('تم تصدير التقرير', 'success', `${allLaptops.length} جهاز في الملف`)
  }, [allLaptops, stats, toast])

  // ============ Download photos (single laptop) ============
  const downloadLaptopPhotos = useCallback(async () => {
    if (!form || photos.length === 0) { toast('لا توجد صور للتنزيل', 'warning'); return }
    const baseName = sanitizeAssetName(form.assetNo) || makeLaptopCode(form.no)
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i]
      const ext = (photo.blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
      const filename = `${baseName}_${i + 1}.${ext}`
      const url = URL.createObjectURL(photo.blob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      await new Promise(r => setTimeout(r, 200))
      URL.revokeObjectURL(url)
    }
    toast(`تم تنزيل ${photos.length} صورة`, 'success')
  }, [form, photos, toast])

  // ============ Download ALL photos as ZIP ============
  const downloadAllPhotosAsZip = useCallback(async () => {
    if (!db || !window.JSZip) { toast('مكتبة ZIP غير متاحة', 'error'); return }
    setExportingZip(true)
    setZipProgress(0)
    try {
      const laptops = await db.laptops.orderBy('no').toArray()
      const zip = new window.JSZip()
      let totalPhotos = 0
      const usedFolderNames = new Set<string>()
      for (const laptop of laptops) {
        const photoList = await db.photos.where('laptopId').equals(laptop.id).toArray()
        if (photoList.length === 0) continue
        let folderName = sanitizeAssetName(laptop.assetNo) || makeLaptopCode(laptop.no)
        let uniqueFolder = folderName
        let suffix = 2
        while (usedFolderNames.has(uniqueFolder.toLowerCase())) {
          uniqueFolder = `${folderName}_${suffix}`; suffix++
        }
        usedFolderNames.add(uniqueFolder.toLowerCase())
        for (let i = 0; i < photoList.length; i++) {
          const photo = photoList[i]
          const ext = (photo.blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg')
          const filename = `${folderName}_${i + 1}.${ext}`
          const arrayBuffer = await photo.blob.arrayBuffer()
          zip.file(`${uniqueFolder}/${filename}`, arrayBuffer)
          totalPhotos++
        }
      }
      if (totalPhotos === 0) {
        toast('لا توجد صور لتنزيلها', 'warning')
        setExportingZip(false); return
      }
      const zipBlob = await zip.generateAsync(
        { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
        (metadata: any) => setZipProgress(Math.round(metadata.percent))
      )
      const d = new Date(); const pad = (n: number) => String(n).padStart(2, '0')
      const filename = `Laptop_Photos_${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.zip`
      const url = URL.createObjectURL(zipBlob)
      const a = document.createElement('a')
      a.href = url; a.download = filename
      document.body.appendChild(a); a.click(); document.body.removeChild(a)
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      toast('تم إنشاء ملف ZIP', 'success', `${totalPhotos} صورة من ${usedFolderNames.size} جهاز`)
    } catch (err) {
      console.error(err)
      toast('فشل إنشاء ملف ZIP', 'error', (err as Error).message || '')
    } finally {
      setExportingZip(false)
    }
  }, [db, toast])

  // ============ Reset ============
  const resetAll = useCallback(async () => {
    if (!db) return
    await db.photos.clear()
    await db.laptops.clear()
    await ensureInitialized(db)
    setResetOpen(false)
    await loadAll()
    toast('تم حذف كل البيانات وإعادة التهيئة', 'success')
  }, [db, loadAll, toast])

  // ============ Render ============
  return (
    <>
      <Script src="https://cdn.tailwindcss.com?plugins=forms,typography" strategy="beforeInteractive" />
      <Script src="https://cdn.jsdelivr.net/npm/dexie@4.4.5/dist/dexie.min.js" strategy="beforeInteractive" />
      <Script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js" strategy="beforeInteractive" />
      <Script src="https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js" strategy="lazyOnload" />
      <Script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js" strategy="lazyOnload" />

      {/* Top App Bar */}
      <header className="sticky top-0 z-30 bg-white/95 backdrop-blur border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-3 sm:px-6 py-3 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600 text-white shrink-0">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="4" width="18" height="12" rx="2"/><path d="M2 20h20"/>
              </svg>
            </div>
            <div className="min-w-0">
              <h1 className="text-sm sm:text-base font-bold truncate">توثيق ضرر اللابتوبات</h1>
              <p className="text-[10px] sm:text-xs text-slate-500 truncate">Damage Inspection Register • 26 جهاز</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <button onClick={exportExcel} className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>
                <path d="M8 13h2"/><path d="M8 17h2"/><path d="M14 13h2"/><path d="M14 17h2"/>
              </svg>
              <span className="hidden sm:inline">تصدير Excel</span>
            </button>
            <button onClick={downloadAllPhotosAsZip} disabled={exportingZip} className="inline-flex items-center gap-1 px-3 py-2 rounded-md bg-orange-600 hover:bg-orange-700 text-white text-sm font-medium transition disabled:opacity-50" title="تنزيل كل صور الأجهزة في ملف ZIP">
              {exportingZip ? (
                <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" />
              ) : (
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/>
                </svg>
              )}
              <span className="hidden sm:inline">{exportingZip && zipProgress > 0 ? `${zipProgress}%` : 'كل الصور ZIP'}</span>
            </button>
            <button onClick={() => setResetOpen(true)} className="inline-flex items-center justify-center p-2 rounded-md border border-slate-300 hover:bg-slate-100 text-slate-600 transition" title="إعادة تعيين">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
              </svg>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-4 pb-24">
        {/* Stats */}
        <section className="rounded-xl border border-teal-200 bg-gradient-to-l from-teal-50 to-cyan-50 p-4 sm:p-6">
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div>
                <h2 className="text-lg sm:text-2xl font-bold tracking-tight">تقدم الفحص</h2>
                <p className="text-xs sm:text-sm text-slate-600 mt-0.5">تم فحص {stats.inspected} من أصل {stats.total} جهاز</p>
              </div>
              <div className="text-left">
                <div className="text-2xl sm:text-3xl font-bold text-teal-700">{stats.pct}%</div>
                <div className="text-xs text-slate-500">مكتمل</div>
              </div>
            </div>
            <div className="h-2 bg-teal-100 rounded-full overflow-hidden">
              <div className="h-full bg-teal-600 transition-all duration-500" style={{ width: `${stats.pct}%` }} />
            </div>
            <div className="grid grid-cols-3 gap-2 sm:gap-3 mt-1">
              <div className="flex items-center gap-2 rounded-lg bg-white/60 p-2 px-3">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-500" />
                <div className="flex flex-col"><span className="text-base sm:text-lg font-bold text-red-600">{stats.damaged}</span><span className="text-[10px] sm:text-xs text-slate-500">متضرر</span></div>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-white/60 p-2 px-3">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />
                <div className="flex flex-col"><span className="text-base sm:text-lg font-bold text-green-600">{stats.clean}</span><span className="text-[10px] sm:text-xs text-slate-500">سليم</span></div>
              </div>
              <div className="flex items-center gap-2 rounded-lg bg-white/60 p-2 px-3">
                <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-500" />
                <div className="flex flex-col"><span className="text-base sm:text-lg font-bold text-amber-600">{stats.pending}</span><span className="text-[10px] sm:text-xs text-slate-500">معلّق</span></div>
              </div>
            </div>
          </div>
        </section>

        {/* Offline notice */}
        <section className="rounded-xl border border-teal-200 bg-teal-50/50 p-3 flex items-center gap-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-teal-600 shrink-0">
            <path d="M12 8v4"/><path d="M14 14l-2-2"/><circle cx="12" cy="12" r="10"/>
          </svg>
          <p className="text-xs text-slate-600">البيانات محفوظة محلياً على جهازك (IndexedDB). OCR الذكي يعمل عبر السحابة، باقي الميزات تعمل أوفلاين.</p>
        </section>

        {/* Filters */}
        <section className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex flex-col sm:flex-row gap-2">
            <div className="relative flex-1">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none">
                <circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>
              </svg>
              <input value={search} onChange={e => setSearch(e.target.value)} type="text" placeholder="بحث برقم الجهاز، Asset، Serial، الموقع، الفاحص..." className="w-full pr-8 pl-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm" />
            </div>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value as 'all' | DamageStatus)} className="w-full sm:w-48 px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm bg-white">
              <option value="all">كل الحالات</option>
              <option value="Pending Inspection">بانتظار الفحص</option>
              <option value="Damaged">متضرر</option>
              <option value="No Visible Damage">سليم</option>
            </select>
          </div>
        </section>

        {/* Laptop Grid */}
        {loading ? (
          <div className="text-center py-20 text-slate-500">
            <div className="animate-spin h-8 w-8 border-2 border-teal-600 border-t-transparent rounded-full mx-auto mb-3" />
            <p className="text-sm">جارٍ التحميل...</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-20 text-slate-500 text-sm">لا توجد نتائج مطابقة</div>
        ) : (
          <section className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-2 sm:gap-3">
            {filtered.map(l => {
              let statusStyle = '', statusText = 'بانتظار الفحص', statusColor = 'text-amber-600', dotColor = 'bg-amber-500'
              if (l.damageStatus === 'Damaged') { statusStyle = 'border-red-300 bg-red-50'; statusText = 'متضرر'; statusColor = 'text-red-600'; dotColor = 'bg-red-500' }
              else if (l.damageStatus === 'No Visible Damage') { statusStyle = 'border-green-300 bg-green-50'; statusText = 'سليم'; statusColor = 'text-green-600'; dotColor = 'bg-green-500' }
              else { statusStyle = 'border-amber-200 bg-amber-50' }
              const hasData = l.assetNo || l.serialNumber || l.damageDescription || l.inspector
              return (
                <div key={l.id} role="button" tabIndex={0} onClick={() => openDetail(l)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(l) } }} className={`laptop-card cursor-pointer rounded-lg border p-3 transition-all hover:shadow-md hover:-translate-y-0.5 focus:outline-none focus:ring-2 focus:ring-teal-500 ${statusStyle}`}>
                  <div className="flex items-start justify-between gap-2 mb-2">
                    <div className="flex items-center gap-2">
                      <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-600 text-white font-bold text-sm shrink-0">{l.no}</div>
                      <div className="min-w-0">
                        <div className="font-mono text-xs text-slate-500">{makeLaptopCode(l.no)}</div>
                        <div className="text-sm font-semibold truncate">{l.assetNo || 'بدون Asset'}</div>
                      </div>
                    </div>
                    {(l._photoCount || 0) > 0 && (
                      <span className="shrink-0 inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 bg-slate-100 rounded">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3l-2.5-3z"/><circle cx="12" cy="13" r="3"/></svg>
                        {l._photoCount}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1.5 text-xs">
                    <span className={`inline-block h-2 w-2 rounded-full ${dotColor}`} />
                    <span className={`font-medium ${statusColor}`}>{statusText}</span>
                  </div>
                  {l.damagedPart && l.damageStatus === 'Damaged' && (
                    <div className="mt-1.5 text-xs text-slate-500 line-clamp-1">{l.damagedPart}{l.damageSeverity !== 'N/A' ? ` • ${l.damageSeverity}` : ''}</div>
                  )}
                  {!hasData && <div className="mt-1.5 text-[10px] text-slate-400 italic">اضغط لبدء الفحص</div>}
                </div>
              )
            })}
          </section>
        )}

        <footer className="mt-8 text-center text-[11px] text-slate-500 space-y-1">
          <p>البيانات لا تغادر جهازك أبداً (ما عدا صور OCR الذكي)</p>
          {stats.inspected > 0 && lastUpdate && (
            <p>آخر تحديث: <span dir="ltr">{lastUpdate}</span> • تم فحص {stats.inspected}/{stats.total}</p>
          )}
        </footer>
      </main>

      {/* Toasts */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto rounded-lg shadow-lg px-4 py-3 max-w-sm w-full text-sm border ${t.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' : t.type === 'error' ? 'bg-red-50 border-red-200 text-red-800' : t.type === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-white border-slate-200 text-slate-800'}`}>
            <div className="font-medium">{t.message}</div>
            {t.description && <div className="text-xs mt-0.5 opacity-80">{t.description}</div>}
          </div>
        ))}
      </div>

      {/* Detail Sheet */}
      {selected && form && (
        <div className={`fixed inset-0 z-40 ${open ? '' : 'hidden'}`}>
          <div className="absolute inset-0 bg-black/40" onClick={closeDetail} />
          <div className="absolute top-0 left-0 h-full w-full sm:max-w-2xl bg-white shadow-xl overflow-y-auto flex flex-col" style={{ transform: open ? 'translateX(0)' : 'translateX(-100%)', transition: 'transform 0.25s ease' }}>
            {/* Header */}
            <div className="sticky top-0 bg-white border-b border-slate-200 p-4 z-10">
              <div className="flex items-center justify-between gap-2">
                <div>
                  <h2 className="flex items-center gap-2 text-lg font-bold">
                    <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-teal-600 text-white text-xs font-bold">{form.no}</span>
                    <span className="font-mono text-sm">{makeLaptopCode(form.no)}</span>
                  </h2>
                  <p className="text-xs text-slate-500">رقم الجهاز في السجل: {form.no} / {TOTAL_LAPTOPS}</p>
                </div>
                <div className="flex gap-1">
                  <button onClick={downloadLaptopPhotos} className="inline-flex items-center gap-1 px-2 py-1.5 rounded-md border border-slate-300 hover:bg-slate-100 text-slate-700 text-xs font-medium transition">صور</button>
                  <button onClick={saveLaptop} disabled={saving} className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-xs font-medium transition disabled:opacity-50">
                    {saving ? <div className="animate-spin h-3.5 w-3.5 border-2 border-white border-t-transparent rounded-full" /> : 'حفظ'}
                  </button>
                </div>
              </div>
            </div>

            <div className="p-4 space-y-5 flex-1">
              {/* Asset & Serial */}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">معلومات الجهاز</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Laptop / Asset No.</label>
                    <input value={form.assetNo} onChange={e => update('assetNo', e.target.value)} dir="ltr" type="text" placeholder="مثال: EX91X23070455" className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Serial Number</label>
                    <input value={form.serialNumber} onChange={e => update('serialNumber', e.target.value)} dir="ltr" type="text" placeholder="مثال: 5CD1234ABC" className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm font-mono" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Current Location</label>
                    <input value={form.currentLocation} onChange={e => update('currentLocation', e.target.value)} type="text" placeholder="الموقع الحالي" className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">User / Department</label>
                    <input value={form.userDepartment} onChange={e => update('userDepartment', e.target.value)} type="text" placeholder="المستخدم أو القسم" className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm" />
                  </div>
                </div>
                <p className="text-[11px] text-slate-500">💡 اضغط <strong>🔍 OCR Asset</strong> على الصورة لقراءة الرقم تلقائياً بالذكاء الاصطناعي (دقة عالية حتى مع الصور المعقدة).</p>
              </section>

              <hr className="border-slate-200" />

              {/* Damage */}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">تقييم الضرر</h3>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Damage Status</label>
                  <select value={form.damageStatus} onChange={e => handleStatusChange(e.target.value as DamageStatus)} className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm bg-white">
                    <option value="Pending Inspection">بانتظار الفحص — Pending Inspection</option>
                    <option value="Damaged">متضرر — Damaged</option>
                    <option value="No Visible Damage">سليم — No Visible Damage</option>
                  </select>
                </div>
                {form.damageStatus === 'Damaged' && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium">Damage Type</label>
                      <select value={form.damageType} onChange={e => update('damageType', e.target.value)} className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm bg-white">
                        <option value="">— اختر —</option>
                        <option value="Crack">Crack - شق</option>
                        <option value="Dent">Dent - انبعاج</option>
                        <option value="Scratch">Scratch - خدش</option>
                        <option value="Broken Part">Broken Part - جزء مكسور</option>
                        <option value="Loose Part">Loose Part - جزء غير ثابت</option>
                        <option value="Other">Other - أخرى</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium">Damaged Part</label>
                      <select value={form.damagedPart} onChange={e => update('damagedPart', e.target.value)} className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm bg-white">
                        <option value="">— اختر —</option>
                        <option value="LCD Bezel">LCD Bezel - إطار الشاشة</option>
                        <option value="LCD Panel">LCD Panel - الشاشة</option>
                        <option value="Bottom Cover">Bottom Cover - الغطاء السفلي</option>
                        <option value="Top Cover">Top Cover - الغطاء العلوي</option>
                        <option value="Palm Rest">Palm Rest - مساحة الراحة</option>
                        <option value="Hinge">Hinge - المفصلة</option>
                        <option value="Keyboard">Keyboard - لوحة المفاتيح</option>
                        <option value="Touchpad">Touchpad - لوحة اللمس</option>
                        <option value="Ports">Ports - المنافذ</option>
                        <option value="Adapter">Adapter - المحول</option>
                        <option value="Other">Other - أخرى</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium">Damage Severity</label>
                      <select value={form.damageSeverity} onChange={e => update('damageSeverity', e.target.value as DamageSeverity)} className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm bg-white">
                        <option value="N/A">غير مطبق — N/A</option>
                        <option value="Minor">طفيف — Minor</option>
                        <option value="Moderate">متوسط — Moderate</option>
                        <option value="Major">كبير — Major</option>
                      </select>
                    </div>
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium">Action Required</label>
                      <select value={form.actionRequired} onChange={e => update('actionRequired', e.target.value as ActionRequired)} className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm bg-white">
                        <option value="None">لا شيء — None</option>
                        <option value="Monitor">مراقبة — Monitor</option>
                        <option value="Repair">إصلاح — Repair</option>
                        <option value="Replacement">استبدال — Replacement</option>
                        <option value="Assessment">تقييم — Assessment</option>
                      </select>
                    </div>
                  </div>
                )}
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Damage Description</label>
                  <textarea value={form.damageDescription} onChange={e => update('damageDescription', e.target.value)} rows={3} placeholder="مثال: Bottom cover cracked near left hinge." className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm resize-none" />
                </div>
              </section>

              <hr className="border-slate-200" />

              {/* Photos */}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">الأدلة المصورة</h3>
                {showOcrBox && (
                  <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 space-y-2">
                    <div className="flex items-center gap-2 text-sm">
                      <div className="animate-spin h-4 w-4 border-2 border-teal-600 border-t-transparent rounded-full" />
                      <span>{ocrText}</span>
                    </div>
                    <div className="h-1.5 bg-teal-100 rounded-full overflow-hidden">
                      <div className="h-full bg-teal-600 transition-all" style={{ width: `${ocrProgress}%` }} />
                    </div>
                  </div>
                )}
                <div className="grid grid-cols-2 gap-2">
                  <button onClick={() => fileCameraRef.current?.click()} className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-md border border-slate-300 hover:bg-slate-50 text-sm font-medium transition">تصوير</button>
                  <button onClick={() => fileGalleryRef.current?.click()} className="inline-flex items-center justify-center gap-1 px-3 py-2 rounded-md border border-slate-300 hover:bg-slate-50 text-sm font-medium transition">من المعرض</button>
                </div>
                <input ref={fileCameraRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelected(f); e.target.value = '' }} />
                <input ref={fileGalleryRef} type="file" accept="image/*" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFileSelected(f); e.target.value = '' }} />
                {photos.length === 0 ? (
                  <div className="rounded-lg border border-dashed border-slate-300 p-6 text-center">
                    <p className="text-xs text-slate-500">لا توجد صور بعد</p>
                  </div>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {photos.map((p, idx) => {
                      const url = URL.createObjectURL(p.blob)
                      return (
                        <div key={p.id} className="relative rounded-lg overflow-hidden border bg-slate-100 aspect-square">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={url} alt={p.name} className="h-full w-full object-cover cursor-pointer" onClick={() => setPreviewSrc(url)} />
                          <div className="absolute top-1 left-1 right-1 flex items-center justify-between">
                            <span className="bg-black/60 text-white text-[10px] px-1.5 py-0.5 rounded">{p.name}</span>
                            <button onClick={() => p.id && handleDeletePhoto(p.id)} className="bg-black/60 hover:bg-red-600 text-white rounded p-1">
                              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                            </button>
                          </div>
                          <div className="absolute bottom-1 left-1 right-1 flex flex-col gap-1">
                            <div className="flex gap-1">
                              <button disabled={ocrBusy} onClick={() => runSmartOcr(p.blob, 'assetNo')} className="flex-1 h-7 text-[10px] bg-teal-600 text-white hover:bg-teal-700 rounded font-medium">🔍 OCR Asset</button>
                              <button disabled={ocrBusy} onClick={() => runSmartOcr(p.blob, 'serialNumber')} className="flex-1 h-7 text-[10px] bg-teal-600 text-white hover:bg-teal-700 rounded font-medium">🔍 OCR Serial</button>
                            </div>
                            <button disabled={ocrBusy} onClick={() => runLocalOcr(p.blob, 'assetNo')} className="h-7 text-[10px] bg-slate-100 text-slate-600 hover:bg-slate-200 rounded">OCR محلي</button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
                {photos.length > 0 && (
                  <div className="text-[11px] text-slate-500">مرجع الصور: <span className="font-mono">{form.photoReference || '—'}</span></div>
                )}
              </section>

              <hr className="border-slate-200" />

              {/* Inspector & Date */}
              <section className="space-y-3">
                <h3 className="text-sm font-semibold">الفاحص والتاريخ</h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Inspector</label>
                    <input value={form.inspector} onChange={e => update('inspector', e.target.value)} type="text" placeholder="الاسم الكامل" className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm" />
                  </div>
                  <div className="space-y-1.5">
                    <label className="text-xs font-medium">Inspection Date</label>
                    <input value={form.inspectionDate ? new Date(form.inspectionDate).toISOString().slice(0, 10) : ''} onChange={e => update('inspectionDate', e.target.value ? new Date(e.target.value).toISOString() : '')} type="date" className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <label className="text-xs font-medium">Remarks</label>
                  <textarea value={form.remarks} onChange={e => update('remarks', e.target.value)} rows={2} placeholder="ملاحظات إضافية" className="w-full px-3 py-2 rounded-md border border-slate-300 focus:border-teal-500 focus:ring-2 focus:ring-teal-200 outline-none text-sm resize-none" />
                </div>
              </section>

              <hr className="border-slate-200" />
              <div className="text-[11px] text-slate-500 space-y-1">
                <div className="flex items-center justify-between">
                  <span>Photo Reference:</span>
                  <span className="font-mono text-[10px] px-1.5 py-0.5 bg-slate-100 rounded">{form.photoReference || '—'}</span>
                </div>
                <div className="flex items-center justify-between">
                  <span>آخر تحديث:</span>
                  <span dir="ltr">{form.updatedAt ? new Date(form.updatedAt).toLocaleString('en-GB') : '—'}</span>
                </div>
              </div>
              <div className="h-16" />
            </div>

            <div className="sticky bottom-0 bg-white/95 backdrop-blur border-t border-slate-200 p-3 flex gap-2 safe-bottom">
              <button onClick={closeDetail} className="flex-1 px-4 py-2 rounded-md border border-slate-300 hover:bg-slate-100 text-sm font-medium transition">إغلاق</button>
              <button onClick={saveLaptop} disabled={saving} className="flex-1 inline-flex items-center justify-center gap-1 px-4 py-2 rounded-md bg-teal-600 hover:bg-teal-700 text-white text-sm font-medium transition disabled:opacity-50">
                {saving ? <div className="animate-spin h-4 w-4 border-2 border-white border-t-transparent rounded-full" /> : 'حفظ التغييرات'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview Modal */}
      {previewSrc && (
        <div className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4" onClick={() => setPreviewSrc(null)}>
          <button className="absolute top-4 right-4 text-white bg-white/20 hover:bg-white/30 rounded-full p-2">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>
          </button>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewSrc} alt="معاينة" className="max-w-full max-h-full object-contain" />
        </div>
      )}

      {/* Reset Modal */}
      {resetOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-md w-full p-6 shadow-xl">
            <h3 className="text-lg font-bold mb-2">حذف كل البيانات؟</h3>
            <p className="text-sm text-slate-600 mb-4">سيتم حذف جميع سجلات الفحص والصور نهائياً وإعادة إنشاء 26 سجل فارغ. لا يمكن التراجع.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setResetOpen(false)} className="px-4 py-2 rounded-md border border-slate-300 hover:bg-slate-100 text-sm font-medium transition">إلغاء</button>
              <button onClick={resetAll} className="px-4 py-2 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium transition">نعم، احذف الكل</button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
