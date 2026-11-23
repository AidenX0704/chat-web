import * as XLSX from 'xlsx'

export type CellValue = string | number | null

export type ParsedColumn = {
  /** SQLite 列名（合法且唯一，查询时可加双引号引用） */
  sqlName: string
  /** 原始表头名称 */
  label: string
  type: 'INTEGER' | 'REAL' | 'TEXT'
}

export type ParsedSheet = {
  /** 原始工作表名称 */
  name: string
  /** SQLite 表名（sheet_1, sheet_2 ...） */
  tableName: string
  columns: ParsedColumn[]
  /** 清洗后的行数据（与 columns 等长） */
  rows: CellValue[][]
  /** 估算转为紧凑文本后的 Token 数 */
  estimatedTokens: number
}

export type ParsedWorkbook = {
  sheets: ParsedSheet[]
  totalRows: number
  estimatedTokens: number
}

/** 估算文本的 DeepSeek Token 数：中文约 0.65 token/字，ASCII 约 0.3 token/字符 */
export const estimateTokens = (text: string): number => {
  let cjk = 0
  let other = 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3000 && code <= 0x303f) ||
      (code >= 0xff00 && code <= 0xffef)
    ) {
      cjk += 1
    } else {
      other += 1
    }
  }
  return Math.ceil(cjk * 0.65 + other * 0.3)
}

const pad2 = (n: number): string => (n < 10 ? `0${n}` : String(n))

const formatDate = (date: Date): string => {
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  const y = date.getFullYear()
  const m = pad2(date.getMonth() + 1)
  const d = pad2(date.getDate())
  const hh = date.getHours()
  const mm = date.getMinutes()
  const ss = date.getSeconds()
  if (hh === 0 && mm === 0 && ss === 0) {
    return `${y}-${m}-${d}`
  }
  return `${y}-${m}-${d} ${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`
}

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
  if (raw instanceof Date) {
    const formatted = formatDate(raw)
    return formatted === '' ? null : formatted
  }
  const str = String(raw)
  const trimmed = str.trim()
  if (trimmed === '') {
    return null
  }
  return str
}

/** 尝试把 CSV 中的数字字符串识别为数值，保留前导零（如邮编、工号 00123）与超长数字（如身份证、订单号）为文本 */
const parseNumericString = (value: string): number | null => {
  const trimmed = value.trim()
  if (trimmed === '' || trimmed.length > 15) {
    return null
  }
  if (/^0\d/.test(trimmed) || /^-0\d/.test(trimmed)) {
    return null
  }
  if (!/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
    return null
  }
  const num = Number(trimmed)
  return Number.isFinite(num) ? num : null
}

/** 解码 CSV 文本：优先 UTF-8，若包含大量乱码替换符则回退 GB18030（兼容中文 Windows 导出的 CSV） */
const decodeTextBuffer = (buffer: Buffer): string => {
  let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer)
  if (text.startsWith('\uFEFF')) {
    text = text.slice(1)
  }
  const sample = text.slice(0, 8192)
  const replacementCount = (sample.match(/\uFFFD/g) ?? []).length
  if (replacementCount > 0) {
    try {
      const gbk = new TextDecoder('gb18030', { fatal: false }).decode(buffer)
      const gbkReplacements = (gbk.slice(0, 8192).match(/\uFFFD/g) ?? []).length
      if (gbkReplacements < replacementCount) {
        return gbk.startsWith('\uFEFF') ? gbk.slice(1) : gbk
      }
    } catch {
      // 部分运行环境可能无 gb18030 解码器，保留 UTF-8 结果
    }
  }
  return text
}

/** 在前几行中自动探测 CSV 分隔符（逗号 / 制表符 / 分号） */
const detectDelimiter = (text: string, ext: string): string => {
  if (ext === 'tsv') {
    return '\t'
  }
  const candidates = [',', '\t', ';'] as const
  const lines: string[] = []
  let inQuotes = false
  let start = 0
  for (let i = 0; i < text.length && lines.length < 10; i += 1) {
    const ch = text[i]
    if (ch === '"') {
      inQuotes = !inQuotes
    } else if (!inQuotes && (ch === '\n' || ch === '\r')) {
      const line = text.slice(start, i).trim()
      if (line !== '') {
        lines.push(line)
      }
      if (ch === '\r' && text[i + 1] === '\n') {
        i += 1
      }
      start = i + 1
    }
  }
  if (lines.length === 0) {
    const tail = text.slice(start).trim()
    if (tail !== '') {
      lines.push(tail)
    }
  }
  let best = ','
  let bestScore = -1
  for (const sep of candidates) {
    const counts = lines.map((line) => {
      let quoted = false
      let count = 0
      for (let i = 0; i < line.length; i += 1) {
        const ch = line[i]
        if (ch === '"') {
          quoted = !quoted
        } else if (!quoted && ch === sep) {
          count += 1
        }
      }
      return count
    })
    const nonZero = counts.filter((c) => c > 0)
    if (nonZero.length === 0) {
      continue
    }
    const first = counts[0] ?? 0
    const consistent = counts.every((c) => c === first)
    const score = (consistent ? 1000 : 0) + nonZero.reduce((a, b) => a + b, 0)
    if (score > bestScore) {
      bestScore = score
      best = sep
    }
  }
  return best
}

/** RFC-4180 风格 CSV/TSV 解析器：支持引号内换行、双引号转义 */
const parseDelimitedText = (text: string, delimiter: string): unknown[][] => {
  const rows: unknown[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let fieldStart = true

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!
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

/** 生成可读且 SQLite 安全的列名 */
const sanitizeColumnName = (raw: string, index: number, used: Set<string>): string => {
  let base = raw
    .trim()
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[^\p{L}\p{N}_]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)

  if (base === '' || base.toLowerCase() === '_row_num') {
    base = `col_${index + 1}`
  } else if (/^\d/.test(base)) {
    base = `c_${base}`
  }

  let candidate = base
  let suffix = 2
  while (used.has(candidate.toLowerCase())) {
    candidate = `${base}_${suffix}`
    suffix += 1
  }
  used.add(candidate.toLowerCase())
  return candidate
}

const buildParsedSheet = (
  name: string,
  tableName: string,
  rawRows: unknown[][],
  tryParseNumbers: boolean
): ParsedSheet | null => {
  // 找到第一个非空行作为表头
  let headerRowIndex = -1
  for (let i = 0; i < rawRows.length; i += 1) {
    const r = rawRows[i]
    if (r && r.some((cell) => normalizeCell(cell) !== null)) {
      headerRowIndex = i
      break
    }
  }
  if (headerRowIndex === -1) {
    return null
  }

  const headerRaw = rawRows[headerRowIndex]!
  let maxCols = headerRaw.length
  const dataRawRows: CellValue[][] = []

  for (let i = headerRowIndex + 1; i < rawRows.length; i += 1) {
    const rawRow = rawRows[i]
    if (!rawRow || rawRow.length === 0) {
      continue
    }
    let hasValue = false
    const normalized: CellValue[] = new Array<CellValue>(rawRow.length)
    for (let c = 0; c < rawRow.length; c += 1) {
      let val = normalizeCell(rawRow[c])
      if (tryParseNumbers && typeof val === 'string') {
        const parsed = parseNumericString(val)
        if (parsed !== null) {
          val = parsed
        }
      }
      normalized[c] = val
      if (val !== null) {
        hasValue = true
      }
    }
    if (hasValue) {
      if (normalized.length > maxCols) {
        maxCols = normalized.length
      }
      dataRawRows.push(normalized)
    }
  }

  // 找出所有至少在表头或数据中出现过非空值的列，剔除全空列
  const activeColIndices: number[] = []
  for (let c = 0; c < maxCols; c += 1) {
    const headerVal = normalizeCell(headerRaw[c])
    let hasAny = headerVal !== null
    if (!hasAny) {
      for (let r = 0; r < dataRawRows.length; r += 1) {
        if ((dataRawRows[r]?.[c] ?? null) !== null) {
          hasAny = true
          break
        }
      }
    }
    if (hasAny) {
      activeColIndices.push(c)
    }
  }

  if (activeColIndices.length === 0) {
    return null
  }

  const usedSqlNames = new Set<string>(['_row_num'])
  const colLabels: string[] = []
  const colSqlNames: string[] = []
  for (let idx = 0; idx < activeColIndices.length; idx += 1) {
    const srcCol = activeColIndices[idx]!
    const headerVal = normalizeCell(headerRaw[srcCol])
    const label = headerVal === null ? `列${idx + 1}` : String(headerVal).trim()
    colLabels.push(label)
    colSqlNames.push(sanitizeColumnName(label, idx, usedSqlNames))
  }

  // 推断每列类型并整理行数据、估算 Token
  const colCount = activeColIndices.length
  const hasText = new Array<boolean>(colCount).fill(false)
  const hasReal = new Array<boolean>(colCount).fill(false)
  const hasInt = new Array<boolean>(colCount).fill(false)

  let estimatedTokens = estimateTokens(colLabels.join('\t')) + colCount
  const rows: CellValue[][] = new Array<CellValue[]>(dataRawRows.length)

  for (let r = 0; r < dataRawRows.length; r += 1) {
    const srcRow = dataRawRows[r]!
    const outRow = new Array<CellValue>(colCount)
    for (let c = 0; c < colCount; c += 1) {
      const val = srcRow[activeColIndices[c]!] ?? null
      outRow[c] = val
      if (val !== null) {
        if (typeof val === 'number') {
          if (Number.isInteger(val)) {
            hasInt[c] = true
          } else {
            hasReal[c] = true
          }
          estimatedTokens += Math.ceil(String(val).length * 0.35) + 1
        } else {
          hasText[c] = true
          estimatedTokens += estimateTokens(val) + 1
        }
      }
    }
    estimatedTokens += 1 // 换行
    rows[r] = outRow
  }

  const columns: ParsedColumn[] = colSqlNames.map((sqlName, c) => ({
    sqlName,
    label: colLabels[c]!,
    type: hasText[c] ? 'TEXT' : hasReal[c] ? 'REAL' : hasInt[c] ? 'INTEGER' : 'TEXT',
  }))

  return {
    name,
    tableName,
    columns,
    rows,
    estimatedTokens,
  }
}

const getExt = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

const extractDenseRows = (sheet: XLSX.WorkSheet): unknown[][] => {
  // dense 模式下 sheet['!data'] 是二维 CellObject 数组，直接提取 .v/.w 比 sheet_to_json 省内存且快得多
  const dense = (sheet as { '!data'?: ({ v?: unknown; w?: string; t?: string } | undefined)[][] })[
    '!data'
  ]
  if (Array.isArray(dense)) {
    const rows: unknown[][] = []
    for (let r = 0; r < dense.length; r += 1) {
      const src = dense[r]
      if (!src) {
        rows.push([])
        continue
      }
      const out: unknown[] = new Array(src.length)
      for (let c = 0; c < src.length; c += 1) {
        const cell = src[c]
        if (!cell) {
          out[c] = null
        } else if (cell.t === 'e') {
          out[c] = cell.w ?? null
        } else {
          out[c] = cell.v ?? cell.w ?? null
        }
      }
      rows.push(out)
    }
    return rows
  }
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    raw: true,
    defval: null,
    blankrows: false,
  })
}

export const parseSpreadsheetBuffer = (filename: string, buffer: Buffer): ParsedWorkbook => {
  const ext = getExt(filename)
  const sheets: ParsedSheet[] = []

  if (ext === 'csv' || ext === 'tsv') {
    const text = decodeTextBuffer(buffer)
    const delimiter = detectDelimiter(text, ext)
    const rawRows = parseDelimitedText(text, delimiter)
    const sheetName = filename.replace(/\.[^.]+$/, '') || 'Sheet1'
    const parsed = buildParsedSheet(sheetName, 'sheet_1', rawRows, true)
    if (parsed) {
      sheets.push(parsed)
    }
  } else {
    const workbook = XLSX.read(buffer, {
      type: 'buffer',
      dense: true,
      cellDates: true,
      cellFormula: false,
      cellHTML: false,
      cellStyles: false,
    })
    let tableIndex = 1
    for (const sheetName of workbook.SheetNames) {
      const sheet = workbook.Sheets[sheetName]
      if (!sheet) {
        continue
      }
      const rawRows = extractDenseRows(sheet)
      const parsed = buildParsedSheet(sheetName, `sheet_${tableIndex}`, rawRows, false)
      if (parsed) {
        sheets.push(parsed)
        tableIndex += 1
      }
    }
  }

  let totalRows = 0
  let estimatedTokens = 0
  for (const sheet of sheets) {
    totalRows += sheet.rows.length
    estimatedTokens += sheet.estimatedTokens
  }
  return { sheets, totalRows, estimatedTokens }
}
