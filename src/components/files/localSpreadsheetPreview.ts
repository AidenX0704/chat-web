import type { SpreadsheetPreviewData } from '../../services/spreadsheets.js'

type CellValue = string | number | null

export type LocalParsedSheet = {
  name: string
  tableName: string
  columns: { sqlName: string; label: string; type: 'INTEGER' | 'REAL' | 'TEXT' }[]
  rows: { rowNum: number; values: CellValue[] }[]
}

export type LocalParsedWorkbook = {
  filename: string
  sizeBytes: number
  totalRows: number
  sheets: LocalParsedSheet[]
}

const getExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n))

const normalizeCell = (raw: unknown): CellValue => {
  if (raw === null || raw === undefined) {
    return null
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null
  }
  if (typeof raw === 'boolean') {
    return raw ? 'true' : 'false'
  }
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const base = `${raw.getFullYear()}-${pad2(raw.getMonth() + 1)}-${pad2(raw.getDate())}`
    return raw.getHours() === 0 && raw.getMinutes() === 0 && raw.getSeconds() === 0
      ? base
      : `${base} ${pad2(raw.getHours())}:${pad2(raw.getMinutes())}:${pad2(raw.getSeconds())}`
  }
  const str = String(raw)
  return str.trim() === '' ? null : str
}

const decodeCsv = (buffer: ArrayBuffer): string => {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (text.startsWith('\uFEFF')) {
    text = text.slice(1)
  }
  const sample = text.slice(0, 8192)
  const bad = (sample.match(/\uFFFD/g) ?? []).length
  if (bad > 0) {
    try {
      const gbk = new TextDecoder('gb18030', { fatal: false }).decode(buffer)
      const gbkBad = (gbk.slice(0, 8192).match(/\uFFFD/g) ?? []).length
      if (gbkBad < bad) {
        return gbk.startsWith('\uFEFF') ? gbk.slice(1) : gbk
      }
    } catch {
      // ignore
    }
  }
  return text
}

const parseDelimited = (text: string, delimiter: string): unknown[][] => {
  const rows: unknown[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let fieldStart = true
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 1
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (fieldStart && ch === '"') {
      inQuotes = true
      fieldStart = false
      continue
    }
    if (ch === delimiter) {
      row.push(field)
      field = ''
      fieldStart = true
      continue
    }
    if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 1
      }
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      fieldStart = true
      continue
    }
    field += ch
    fieldStart = false
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const buildLocalSheet = (
  name: string,
  tableName: string,
  rawRows: unknown[][]
): LocalParsedSheet | null => {
  let headerIdx = -1
  for (let i = 0; i < rawRows.length; i += 1) {
    if (rawRows[i]?.some((cell) => normalizeCell(cell) !== null)) {
      headerIdx = i
      break
    }
  }
  if (headerIdx === -1) {
    return null
  }
  const headerRaw = rawRows[headerIdx]
  let maxCols = headerRaw.length
  const dataRows: CellValue[][] = []
  for (let i = headerIdx + 1; i < rawRows.length; i += 1) {
    const r = rawRows[i]
    if (!r || r.length === 0) {
      continue
    }
    const vals = r.map(normalizeCell)
    if (vals.some((v) => v !== null)) {
      maxCols = Math.max(maxCols, vals.length)
      dataRows.push(vals)
    }
  }

  const activeCols: number[] = []
  for (let c = 0; c < maxCols; c += 1) {
    if (
      normalizeCell(headerRaw[c]) !== null ||
      dataRows.some((r) => (r[c] ?? null) !== null)
    ) {
      activeCols.push(c)
    }
  }
  if (activeCols.length === 0) {
    return null
  }

  const columns = activeCols.map((srcCol, idx) => {
    const val = normalizeCell(headerRaw[srcCol])
    const label = val === null ? `列${idx + 1}` : String(val).trim()
    return { sqlName: `col_${idx + 1}`, label, type: 'TEXT' as const }
  })

  const rows = dataRows.map((r, idx) => ({
    rowNum: idx + 1,
    values: activeCols.map((srcCol) => r[srcCol] ?? null),
  }))

  return { name, tableName, columns, rows }
}

/** 仅在没有后端表格索引（静态模式/草稿上传中）时使用；XLSX 通过动态 import 按需加载，不增大首屏包体 */
export const parseLocalSpreadsheet = async (
  blob: Blob,
  filename: string
): Promise<LocalParsedWorkbook> => {
  const ext = getExt(filename)
  const buffer = await blob.arrayBuffer()
  const sheets: LocalParsedSheet[] = []

  if (ext === 'csv' || ext === 'tsv') {
    const text = decodeCsv(buffer)
    const firstLine = text.slice(0, 4096).split(/\r?\n/)[0] ?? ''
    const delimiter =
      ext === 'tsv'
        ? '\t'
        : (firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',')
    const parsed = buildLocalSheet(
      filename.replace(/\.[^.]+$/, '') || 'Sheet1',
      'sheet_1',
      parseDelimited(text, delimiter)
    )
    if (parsed) {
      sheets.push(parsed)
    }
  } else {
    const XLSX = await import('xlsx')
    const workbook = XLSX.read(buffer, {
      type: 'array',
      dense: true,
      cellDates: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
    })
    let idx = 1
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet) {
        continue
      }
      const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
        header: 1,
        raw: true,
        defval: null,
        blankrows: false,
      })
      const parsed = buildLocalSheet(sheetName, `sheet_${idx}`, rawRows)
      if (parsed) {
        sheets.push(parsed)
        idx += 1
      }
    }
  }

  return {
    filename,
    sizeBytes: blob.size,
    totalRows: sheets.reduce((sum, s) => sum + s.rows.length, 0),
    sheets,
  }
}

export const sliceLocalSpreadsheetPreview = (
  workbook: LocalParsedWorkbook,
  options: { sheet?: string; offset?: number; limit?: number; search?: string }
): SpreadsheetPreviewData => {
  const active =
    workbook.sheets.find((s) => s.name === options.sheet) ??
    workbook.sheets[0] ?? {
      name: 'Sheet1',
      tableName: 'sheet_1',
      columns: [],
      rows: [],
    }
  const keyword = (options.search ?? '').trim().toLowerCase()
  const matched =
    keyword === ''
      ? active.rows
      : active.rows.filter((row) =>
          row.values.some((v) => v !== null && String(v).toLowerCase().includes(keyword))
        )
  const offset = Math.max(0, options.offset ?? 0)
  const limit = Math.max(1, options.limit ?? 100)
  return {
    id: 'local',
    filename: workbook.filename,
    sizeBytes: workbook.sizeBytes,
    totalRows: workbook.totalRows,
    estimatedTokens: 0,
    mode: 'inline',
    sheets: workbook.sheets.map((s) => ({
      name: s.name,
      tableName: s.tableName,
      rowCount: s.rows.length,
      colCount: s.columns.length,
    })),
    activeSheet: active.name,
    columns: active.columns,
    rows: matched.slice(offset, offset + limit),
    filteredRows: matched.length,
    offset,
    limit,
  }
}
