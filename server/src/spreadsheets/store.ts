import { createHash } from 'node:crypto'
import { mkdirSync, promises as fs } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { estimateTokens, parseSpreadsheetBuffer, type CellValue } from './parser.js'

/** 小于此阈值直接把清洗后的紧凑 TSV 内联进提示词，省去多余工具往返 */
const INLINE_MAX_TOKENS = 10_000
const INLINE_MAX_ROWS = 400
/** 工具单次返回字符上限，确保单轮上下文远低于 32,768 tokens */
const MAX_TOOL_OUTPUT_CHARS = 12_000
const MAX_SQL_ROWS = 200
const MAX_PREVIEW_LIMIT = 200
const SAMPLE_ROW_COUNT = 5

export type SheetColumnMeta = {
  sqlName: string
  label: string
  type: 'INTEGER' | 'REAL' | 'TEXT'
  nonEmpty: number
  distinctCount: number
  min?: number
  max?: number
  avg?: number
  sampleValues: string[]
}

export type SheetMeta = {
  name: string
  tableName: string
  rowCount: number
  colCount: number
  estimatedTokens: number
  columns: SheetColumnMeta[]
  sampleRows: Record<string, CellValue>[]
}

export type SpreadsheetMeta = {
  id: string
  filename: string
  sizeBytes: number
  createdAt: number
  totalRows: number
  estimatedTokens: number
  mode: 'inline' | 'structured'
  sheets: SheetMeta[]
  profileText: string
  inlineText?: string
}

export type PreviewResult = {
  id: string
  filename: string
  sizeBytes: number
  totalRows: number
  estimatedTokens: number
  mode: 'inline' | 'structured'
  sheets: { name: string; tableName: string; rowCount: number; colCount: number }[]
  activeSheet: string
  columns: { sqlName: string; label: string; type: 'INTEGER' | 'REAL' | 'TEXT' }[]
  rows: { rowNum: number; values: CellValue[] }[]
  filteredRows: number
  offset: number
  limit: number
}

export type ToolExecResult = {
  content: string
  isError?: boolean
  summary: string
}

export type SheetChunk = {
  index: number
  startRow: number
  endRow: number
  rowCount: number
  tsv: string
}

const quoteIdent = (name: string): string => `"${name.replace(/"/g, '""')}"`

const escapeTsvCell = (value: unknown): string => {
  if (value === null || value === undefined) {
    return ''
  }
  const str = String(value)
  if (str.length > 500) {
    return `${str.slice(0, 500).replace(/[\t\r\n]+/g, ' ')}…`
  }
  return str.replace(/[\t\r\n]+/g, ' ')
}

const escapeLike = (keyword: string): string =>
  keyword.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')

/** 去掉 SQL 字符串字面量与注释，仅用于安全关键字检查 */
const stripSqlLiteralsAndComments = (sql: string): string => {
  let out = ''
  let i = 0
  while (i < sql.length) {
    const ch = sql[i]!
    const next = sql[i + 1]
    if (ch === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') {
        i += 1
      }
      out += ' '
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i += 1
      }
      i += 2
      out += ' '
      continue
    }
    if (ch === "'" || ch === '"') {
      const quote = ch
      i += 1
      while (i < sql.length) {
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      out += ' '
      continue
    }
    out += ch
    i += 1
  }
  return out
}

const FORBIDDEN_SQL_KEYWORD =
  /\b(ATTACH|DETACH|PRAGMA|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|VACUUM|REINDEX|TRIGGER|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|LOAD_EXTENSION)\b/i

const validateReadOnlySql = (rawSql: string): string => {
  const trimmed = rawSql.trim().replace(/;+\s*$/, '')
  if (trimmed === '') {
    throw new Error('SQL 不能为空')
  }
  const stripped = stripSqlLiteralsAndComments(trimmed).trim()
  if (stripped.includes(';')) {
    throw new Error('只允许执行单条只读 SELECT/WITH 查询')
  }
  if (!/^(SELECT|WITH)\b/i.test(stripped)) {
    throw new Error('只允许执行只读 SELECT 或 WITH 查询')
  }
  const forbidden = FORBIDDEN_SQL_KEYWORD.exec(stripped)
  if (forbidden) {
    throw new Error(`不允许在只读查询中使用关键字 ${forbidden[1]}`)
  }
  return trimmed
}

const ownerDirName = (ownerKey: string): string => {
  const prefix = ownerKey.startsWith('guest:') ? 'guest' : 'user'
  const hash = createHash('sha256').update(ownerKey).digest('hex').slice(0, 24)
  return `${prefix}-${hash}`
}

const roundNum = (n: number): number => Math.round(n * 10000) / 10000

const buildProfileText = (
  id: string,
  filename: string,
  totalRows: number,
  estimatedTokens: number,
  sheets: SheetMeta[]
): string => {
  const lines: string[] = [
    `[已结构化入库的表格附件]`,
    `- file_id: ${id}`,
    `- 文件名: ${filename}`,
    `- 工作表数: ${sheets.length}，总数据行: ${totalRows}，原始估算 Token: ~${estimatedTokens}`,
    `- 注意: 该表格较大，已存入本地只读 SQLite 数据库，每张表都有 1-based 行号列 _row_num。请使用表格分析工具（query_sheet_sql / read_sheet_rows / search_sheet_text / map_reduce_sheet）完整读取与计算，切勿凭样本猜测全表结果。`,
    '',
  ]

  for (const sheet of sheets) {
    lines.push(
      `### 工作表 "${sheet.name}" -> SQL 表名: ${sheet.tableName}（${sheet.rowCount} 行 × ${sheet.colCount} 列）`
    )
    lines.push('列定义（SQL列名 | 原表头 | 类型 | 非空数 | 去重数 | 统计/样例）:')
    for (const col of sheet.columns) {
      const stats: string[] = []
      if (col.min !== undefined && col.max !== undefined) {
        stats.push(`范围 ${roundNum(col.min)}~${roundNum(col.max)}`)
        if (col.avg !== undefined) {
          stats.push(`均值 ${roundNum(col.avg)}`)
        }
      } else if (col.sampleValues.length > 0) {
        stats.push(`样例: ${col.sampleValues.slice(0, 4).join(' / ')}`)
      }
      const headerDiff = col.label !== col.sqlName ? col.label : '='
      lines.push(
        `  - "${col.sqlName}" (${headerDiff}) | ${col.type} | 非空:${col.nonEmpty} | 唯一:${col.distinctCount}${stats.length > 0 ? ` | ${stats.join(', ')}` : ''}`
      )
    }

    if (sheet.sampleRows.length > 0) {
      lines.push(`前 ${sheet.sampleRows.length} 行样例（TSV）:`)
      const colNames = sheet.columns.map((c) => c.sqlName)
      lines.push(`_row_num\t${colNames.join('\t')}`)
      sheet.sampleRows.forEach((row, idx) => {
        const vals = colNames.map((name) => escapeTsvCell(row[name]))
        lines.push(`${idx + 1}\t${vals.join('\t')}`)
      })
    }
    lines.push('')
  }

  return lines.join('\n').trim()
}

const buildInlineText = (filename: string, sheets: SheetMeta[], db: Database.Database): string => {
  const lines: string[] = [`[表格附件: ${filename}（已清洗为紧凑格式，以下为完整内容）]`]
  for (const sheet of sheets) {
    lines.push(`\n### 工作表: ${sheet.name}（共 ${sheet.rowCount} 行 × ${sheet.colCount} 列）`)
    const colLabels = sheet.columns.map((c) => escapeTsvCell(c.label))
    lines.push(`_row_num\t${colLabels.join('\t')}`)
    const selectCols = ['_row_num', ...sheet.columns.map((c) => quoteIdent(c.sqlName))].join(', ')
    const stmt = db.prepare(`SELECT ${selectCols} FROM ${quoteIdent(sheet.tableName)} ORDER BY _row_num ASC`)
    for (const row of stmt.iterate() as Iterable<Record<string, CellValue>>) {
      const vals = [
        String(row._row_num ?? ''),
        ...sheet.columns.map((c) => escapeTsvCell(row[c.sqlName])),
      ]
      lines.push(vals.join('\t'))
    }
  }
  return lines.join('\n').trim()
}

const formatRowsAsTsv = (
  columns: string[],
  rows: Record<string, unknown>[],
  maxChars = MAX_TOOL_OUTPUT_CHARS
): { text: string; shownRows: number; truncatedByChars: boolean } => {
  const header = columns.join('\t')
  const lines = [header]
  let totalChars = header.length
  let shownRows = 0
  let truncatedByChars = false

  for (const row of rows) {
    const line = columns.map((col) => escapeTsvCell(row[col])).join('\t')
    if (totalChars + line.length + 1 > maxChars && shownRows > 0) {
      truncatedByChars = true
      break
    }
    lines.push(line)
    totalChars += line.length + 1
    shownRows += 1
  }
  return { text: lines.join('\n'), shownRows, truncatedByChars }
}

export const createSpreadsheetStore = (rootDir: string) => {
  const baseRoot = path.resolve(rootDir, '_spreadsheets')

  const ownerDir = (ownerKey: string) => path.join(baseRoot, ownerDirName(ownerKey))
  const dbPathOf = (ownerKey: string, id: string) => path.join(ownerDir(ownerKey), `${id}.sqlite`)
  const metaPathOf = (ownerKey: string, id: string) =>
    path.join(ownerDir(ownerKey), `${id}.meta.json`)

  const resolveSheet = (meta: SpreadsheetMeta, sheetRef?: string): SheetMeta => {
    if (!sheetRef || sheetRef.trim() === '') {
      const first = meta.sheets[0]
      if (!first) {
        throw new Error('该表格没有有效数据表')
      }
      return first
    }
    const target = sheetRef.trim()
    const found =
      meta.sheets.find((s) => s.name === target || s.tableName === target) ??
      meta.sheets.find(
        (s) => s.name.toLowerCase() === target.toLowerCase() || s.tableName.toLowerCase() === target.toLowerCase()
      )
    if (!found) {
      const available = meta.sheets.map((s) => `${s.name}(${s.tableName})`).join(', ')
      throw new Error(`找不到工作表 "${target}"，可用工作表: ${available}`)
    }
    return found
  }

  const getMeta = async (ownerKey: string, id: string): Promise<SpreadsheetMeta | null> => {
    try {
      const raw = await fs.readFile(metaPathOf(ownerKey, id), 'utf8')
      return JSON.parse(raw) as SpreadsheetMeta
    } catch {
      return null
    }
  }

  return {
    async ensureRoot(): Promise<void> {
      await fs.mkdir(baseRoot, { recursive: true })
    },

    async ingest(
      ownerKey: string,
      id: string,
      filename: string,
      buffer: Buffer
    ): Promise<SpreadsheetMeta> {
      const workbook = parseSpreadsheetBuffer(filename, buffer)
      if (workbook.sheets.length === 0) {
        throw new Error('表格中没有读取到有效数据')
      }

      const dir = ownerDir(ownerKey)
      mkdirSync(dir, { recursive: true })
      const dbPath = dbPathOf(ownerKey, id)
      const tempPath = `${dbPath}.tmp-${process.pid}-${Date.now()}`
      await fs.rm(tempPath, { force: true })

      const db = new Database(tempPath)
      const sheetMetas: SheetMeta[] = []
      let inlineText: string | undefined

      try {
        db.pragma('journal_mode = OFF')
        db.pragma('synchronous = OFF')
        db.pragma('temp_store = MEMORY')

        for (const sheet of workbook.sheets) {
          const colDefs = [
            '_row_num INTEGER PRIMARY KEY',
            ...sheet.columns.map((col) => `${quoteIdent(col.sqlName)} ${col.type}`),
          ]
          db.exec(`CREATE TABLE ${quoteIdent(sheet.tableName)} (${colDefs.join(', ')})`)

          const insertCols = ['_row_num', ...sheet.columns.map((c) => quoteIdent(c.sqlName))]
          const placeholders = insertCols.map(() => '?').join(', ')
          const insertStmt = db.prepare(
            `INSERT INTO ${quoteIdent(sheet.tableName)} (${insertCols.join(', ')}) VALUES (${placeholders})`
          )

          const insertBatch = db.transaction((rows: CellValue[][]) => {
            for (let i = 0; i < rows.length; i += 1) {
              insertStmt.run(i + 1, ...rows[i]!)
            }
          })
          insertBatch(sheet.rows)

          // 计算各列画像统计
          const columnMetas: SheetColumnMeta[] = []
          for (const col of sheet.columns) {
            const qCol = quoteIdent(col.sqlName)
            const qTable = quoteIdent(sheet.tableName)
            if (col.type === 'INTEGER' || col.type === 'REAL') {
              const stat = db
                .prepare(
                  `SELECT COUNT(${qCol}) AS nonEmpty, COUNT(DISTINCT ${qCol}) AS distinctCount,
                          MIN(${qCol}) AS minVal, MAX(${qCol}) AS maxVal, AVG(${qCol}) AS avgVal
                   FROM ${qTable}`
                )
                .get() as {
                nonEmpty: number
                distinctCount: number
                minVal: number | null
                maxVal: number | null
                avgVal: number | null
              }
              columnMetas.push({
                sqlName: col.sqlName,
                label: col.label,
                type: col.type,
                nonEmpty: stat.nonEmpty,
                distinctCount: stat.distinctCount,
                ...(stat.minVal !== null ? { min: stat.minVal } : {}),
                ...(stat.maxVal !== null ? { max: stat.maxVal } : {}),
                ...(stat.avgVal !== null ? { avg: stat.avgVal } : {}),
                sampleValues: [],
              })
            } else {
              const stat = db
                .prepare(
                  `SELECT COUNT(${qCol}) AS nonEmpty, COUNT(DISTINCT ${qCol}) AS distinctCount
                   FROM ${qTable}`
                )
                .get() as { nonEmpty: number; distinctCount: number }
              const samples = db
                .prepare(
                  `SELECT DISTINCT ${qCol} AS val FROM ${qTable} WHERE ${qCol} IS NOT NULL LIMIT 5`
                )
                .all() as { val: CellValue }[]
              columnMetas.push({
                sqlName: col.sqlName,
                label: col.label,
                type: col.type,
                nonEmpty: stat.nonEmpty,
                distinctCount: stat.distinctCount,
                sampleValues: samples
                  .map((s) => escapeTsvCell(s.val).slice(0, 60))
                  .filter((s) => s !== ''),
              })
            }
          }

          const sampleRows: Record<string, CellValue>[] = sheet.rows
            .slice(0, SAMPLE_ROW_COUNT)
            .map((row) => {
              const record: Record<string, CellValue> = {}
              sheet.columns.forEach((col, idx) => {
                record[col.sqlName] = row[idx] ?? null
              })
              return record
            })

          sheetMetas.push({
            name: sheet.name,
            tableName: sheet.tableName,
            rowCount: sheet.rows.length,
            colCount: sheet.columns.length,
            estimatedTokens: sheet.estimatedTokens,
            columns: columnMetas,
            sampleRows,
          })
        }

        const mode: 'inline' | 'structured' =
          workbook.estimatedTokens <= INLINE_MAX_TOKENS && workbook.totalRows <= INLINE_MAX_ROWS
            ? 'inline'
            : 'structured'

        if (mode === 'inline') {
          inlineText = buildInlineText(filename, sheetMetas, db)
        }

        const profileText = buildProfileText(
          id,
          filename,
          workbook.totalRows,
          workbook.estimatedTokens,
          sheetMetas
        )

        const meta: SpreadsheetMeta = {
          id,
          filename,
          sizeBytes: buffer.length,
          createdAt: Date.now(),
          totalRows: workbook.totalRows,
          estimatedTokens: workbook.estimatedTokens,
          mode,
          sheets: sheetMetas,
          profileText,
          ...(inlineText !== undefined ? { inlineText } : {}),
        }

        db.close()
        await fs.rename(tempPath, dbPath)
        await fs.writeFile(metaPathOf(ownerKey, id), JSON.stringify(meta), 'utf8')
        return meta
      } catch (error) {
        try {
          db.close()
        } catch {
          // ignore
        }
        await fs.rm(tempPath, { force: true })
        throw error
      }
    },

    getMeta,

    async preview(
      ownerKey: string,
      id: string,
      options: { sheet?: string; offset?: number; limit?: number; search?: string } = {}
    ): Promise<PreviewResult | null> {
      const meta = await getMeta(ownerKey, id)
      if (!meta) {
        return null
      }
      const active = resolveSheet(meta, options.sheet)
      const offset = Math.max(0, Math.floor(options.offset ?? 0))
      const limit = Math.min(MAX_PREVIEW_LIMIT, Math.max(1, Math.floor(options.limit ?? 100)))
      const search = (options.search ?? '').trim()

      const db = new Database(dbPathOf(ownerKey, id), { readonly: true, fileMustExist: true })
      try {
        const qTable = quoteIdent(active.tableName)
        const colNames = active.columns.map((c) => c.sqlName)
        const selectCols = ['_row_num', ...colNames.map(quoteIdent)].join(', ')

        let whereClause = ''
        const params: unknown[] = []
        if (search !== '') {
          const pattern = `%${escapeLike(search)}%`
          const clauses = colNames.map((name) => `CAST(${quoteIdent(name)} AS TEXT) LIKE ? ESCAPE '\\'`)
          whereClause = ` WHERE ${clauses.join(' OR ')}`
          for (let i = 0; i < colNames.length; i += 1) {
            params.push(pattern)
          }
        }

        const filteredRows =
          search === ''
            ? active.rowCount
            : ((db.prepare(`SELECT COUNT(*) AS cnt FROM ${qTable}${whereClause}`).get(...params) as {
                cnt: number
              })?.cnt ?? 0)

        const rawRows = db
          .prepare(
            `SELECT ${selectCols} FROM ${qTable}${whereClause} ORDER BY _row_num ASC LIMIT ? OFFSET ?`
          )
          .all(...params, limit, offset) as Record<string, CellValue>[]

        const rows = rawRows.map((row) => ({
          rowNum: Number(row._row_num ?? 0),
          values: colNames.map((name) => row[name] ?? null),
        }))

        return {
          id: meta.id,
          filename: meta.filename,
          sizeBytes: meta.sizeBytes,
          totalRows: meta.totalRows,
          estimatedTokens: meta.estimatedTokens,
          mode: meta.mode,
          sheets: meta.sheets.map((s) => ({
            name: s.name,
            tableName: s.tableName,
            rowCount: s.rowCount,
            colCount: s.colCount,
          })),
          activeSheet: active.name,
          columns: active.columns.map((c) => ({
            sqlName: c.sqlName,
            label: c.label,
            type: c.type,
          })),
          rows,
          filteredRows,
          offset,
          limit,
        }
      } finally {
        db.close()
      }
    },

    async querySql(ownerKey: string, id: string, rawSql: string): Promise<ToolExecResult> {
      const meta = await getMeta(ownerKey, id)
      if (!meta) {
        return { content: `找不到表格 file_id=${id}`, isError: true, summary: '表格不存在' }
      }
      let sql: string
      try {
        sql = validateReadOnlySql(rawSql)
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : 'SQL 校验失败',
          isError: true,
          summary: 'SQL 校验失败',
        }
      }

      const db = new Database(dbPathOf(ownerKey, id), { readonly: true, fileMustExist: true })
      try {
        const stmt = db.prepare(sql)
        if (!stmt.reader) {
          return { content: '只允许执行返回结果集的 SELECT 查询', isError: true, summary: '非法 SQL' }
        }
        const collected: Record<string, unknown>[] = []
        let hasMore = false
        for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
          if (collected.length >= MAX_SQL_ROWS) {
            hasMore = true
            break
          }
          collected.push(row)
        }
        if (collected.length === 0) {
          return { content: '查询结果为空（0 行）', summary: '查询返回 0 行' }
        }
        const cols = Object.keys(collected[0]!)
        const formatted = formatRowsAsTsv(cols, collected)
        const notes: string[] = []
        if (hasMore) {
          notes.push(`结果超过 ${MAX_SQL_ROWS} 行，已截断展示前 ${formatted.shownRows} 行，请使用 LIMIT/OFFSET 或 GROUP BY/WHERE 进一步聚合或分页。`)
        } else if (formatted.truncatedByChars) {
          notes.push(`结果字符数超过单次上限，已展示前 ${formatted.shownRows}/${collected.length} 行，请筛选需要的列或缩小 LIMIT。`)
        }
        const content =
          notes.length > 0 ? `${formatted.text}\n\n[提示] ${notes.join(' ')}` : formatted.text
        return {
          content,
          summary: hasMore
            ? `返回 ${formatted.shownRows}+ 行`
            : `返回 ${formatted.shownRows} 行`,
        }
      } catch (error) {
        return {
          content: `SQL 执行错误: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
          summary: 'SQL 执行出错',
        }
      } finally {
        db.close()
      }
    },

    async readRows(
      ownerKey: string,
      id: string,
      options: { sheet?: string; startRow?: number; limit?: number; columns?: string[] }
    ): Promise<ToolExecResult> {
      const meta = await getMeta(ownerKey, id)
      if (!meta) {
        return { content: `找不到表格 file_id=${id}`, isError: true, summary: '表格不存在' }
      }
      let active: SheetMeta
      try {
        active = resolveSheet(meta, options.sheet)
      } catch (error) {
        return {
          content: error instanceof Error ? error.message : String(error),
          isError: true,
          summary: '工作表不存在',
        }
      }

      const startRow = Math.max(1, Math.floor(options.startRow ?? 1))
      const limit = Math.min(MAX_SQL_ROWS, Math.max(1, Math.floor(options.limit ?? 50)))

      let selectedCols = active.columns
      if (Array.isArray(options.columns) && options.columns.length > 0) {
        const wanted = new Set(options.columns.map((c) => c.trim()))
        const matched = active.columns.filter((c) => wanted.has(c.sqlName) || wanted.has(c.label))
        if (matched.length > 0) {
          selectedCols = matched
        }
      }

      const db = new Database(dbPathOf(ownerKey, id), { readonly: true, fileMustExist: true })
      try {
        const selectSql = ['_row_num', ...selectedCols.map((c) => quoteIdent(c.sqlName))].join(', ')
        const rows = db
          .prepare(
            `SELECT ${selectSql} FROM ${quoteIdent(active.tableName)} WHERE _row_num >= ? ORDER BY _row_num ASC LIMIT ?`
          )
          .all(startRow, limit) as Record<string, unknown>[]

        if (rows.length === 0) {
          return {
            content: `工作表 "${active.name}" 从第 ${startRow} 行起没有更多数据（总行数 ${active.rowCount}）。`,
            summary: '无更多行',
          }
        }
        const cols = ['_row_num', ...selectedCols.map((c) => c.sqlName)]
        const formatted = formatRowsAsTsv(cols, rows)
        const firstRow = Number(rows[0]?._row_num ?? startRow)
        const lastRow = Number(rows[formatted.shownRows - 1]?._row_num ?? firstRow)
        const headerInfo = `工作表 "${active.name}"（总计 ${active.rowCount} 行），当前展示第 ${firstRow}–${lastRow} 行：`
        return {
          content: `${headerInfo}\n${formatted.text}`,
          summary: `读取第 ${firstRow}–${lastRow} 行 / 共 ${active.rowCount} 行`,
        }
      } finally {
        db.close()
      }
    },

    async searchText(
      ownerKey: string,
      id: string,
      options: { keyword: string; sheet?: string; column?: string; offset?: number; limit?: number }
    ): Promise<ToolExecResult> {
      const meta = await getMeta(ownerKey, id)
      if (!meta) {
        return { content: `找不到表格 file_id=${id}`, isError: true, summary: '表格不存在' }
      }
      const keyword = (options.keyword ?? '').trim()
      if (keyword === '') {
        return { content: '搜索关键词不能为空', isError: true, summary: '关键词为空' }
      }

      const sheetsToSearch = options.sheet
        ? (() => {
            try {
              return [resolveSheet(meta, options.sheet)]
            } catch {
              return []
            }
          })()
        : meta.sheets

      if (sheetsToSearch.length === 0) {
        return {
          content: `找不到工作表 "${options.sheet}"`,
          isError: true,
          summary: '工作表不存在',
        }
      }

      const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)))
      const offset = Math.max(0, Math.floor(options.offset ?? 0))
      const pattern = `%${escapeLike(keyword)}%`

      const db = new Database(dbPathOf(ownerKey, id), { readonly: true, fileMustExist: true })
      try {
        const sections: string[] = []
        let totalMatched = 0
        let remainingChars = MAX_TOOL_OUTPUT_CHARS

        for (const sheet of sheetsToSearch) {
          const targetCols = options.column
            ? sheet.columns.filter(
                (c) => c.sqlName === options.column || c.label === options.column
              )
            : sheet.columns
          if (targetCols.length === 0) {
            continue
          }
          const qTable = quoteIdent(sheet.tableName)
          const clauses = targetCols.map(
            (c) => `CAST(${quoteIdent(c.sqlName)} AS TEXT) LIKE ? ESCAPE '\\'`
          )
          const whereSql = `WHERE ${clauses.join(' OR ')}`
          const params = targetCols.map(() => pattern)

          const cnt =
            (db.prepare(`SELECT COUNT(*) AS cnt FROM ${qTable} ${whereSql}`).get(...params) as {
              cnt: number
            })?.cnt ?? 0
          totalMatched += cnt
          if (cnt === 0 || remainingChars <= 200) {
            continue
          }

          const selectCols = ['_row_num', ...sheet.columns.map((c) => quoteIdent(c.sqlName))].join(
            ', '
          )
          const rows = db
            .prepare(
              `SELECT ${selectCols} FROM ${qTable} ${whereSql} ORDER BY _row_num ASC LIMIT ? OFFSET ?`
            )
            .all(...params, limit, offset) as Record<string, unknown>[]

          const cols = ['_row_num', ...sheet.columns.map((c) => c.sqlName)]
          const formatted = formatRowsAsTsv(cols, rows, remainingChars)
          const section = `### 工作表 "${sheet.name}"（命中 ${cnt} 行，展示 ${formatted.shownRows} 行）\n${formatted.text}`
          sections.push(section)
          remainingChars -= section.length
        }

        if (totalMatched === 0) {
          return { content: `未找到包含 "${keyword}" 的行`, summary: '未命中任何行' }
        }
        return {
          content: sections.join('\n\n'),
          summary: `命中 ${totalMatched} 行`,
        }
      } finally {
        db.close()
      }
    },

    async buildChunks(
      ownerKey: string,
      id: string,
      options: {
        sheet?: string
        columns?: string[]
        maxTokensPerChunk?: number
        startRow?: number
        endRow?: number
      } = {}
    ): Promise<{ meta: SpreadsheetMeta; sheet: SheetMeta; chunks: SheetChunk[] }> {
      const meta = await getMeta(ownerKey, id)
      if (!meta) {
        throw new Error(`找不到表格 file_id=${id}`)
      }
      const active = resolveSheet(meta, options.sheet)
      const maxTokens = Math.min(14_000, Math.max(2_000, options.maxTokensPerChunk ?? 10_000))

      let selectedCols = active.columns
      if (Array.isArray(options.columns) && options.columns.length > 0) {
        const wanted = new Set(options.columns.map((c) => c.trim()))
        const matched = active.columns.filter((c) => wanted.has(c.sqlName) || wanted.has(c.label))
        if (matched.length > 0) {
          selectedCols = matched
        }
      }

      const startRow = Math.max(1, Math.floor(options.startRow ?? 1))
      const endRow = Math.min(active.rowCount, Math.floor(options.endRow ?? active.rowCount))

      const db = new Database(dbPathOf(ownerKey, id), { readonly: true, fileMustExist: true })
      try {
        const header = ['_row_num', ...selectedCols.map((c) => c.label)].join('\t')
        const headerTokens = estimateTokens(header) + 4
        const selectCols = ['_row_num', ...selectedCols.map((c) => quoteIdent(c.sqlName))].join(
          ', '
        )
        const stmt = db.prepare(
          `SELECT ${selectCols} FROM ${quoteIdent(active.tableName)} WHERE _row_num >= ? AND _row_num <= ? ORDER BY _row_num ASC`
        )

        const chunks: SheetChunk[] = []
        let lines: string[] = [header]
        let tokens = headerTokens
        let chunkStartRow = 0
        let chunkEndRow = 0
        let chunkRowCount = 0

        const flush = () => {
          if (chunkRowCount === 0) {
            return
          }
          chunks.push({
            index: chunks.length + 1,
            startRow: chunkStartRow,
            endRow: chunkEndRow,
            rowCount: chunkRowCount,
            tsv: lines.join('\n'),
          })
          lines = [header]
          tokens = headerTokens
          chunkStartRow = 0
          chunkEndRow = 0
          chunkRowCount = 0
        }

        for (const row of stmt.iterate(startRow, endRow) as Iterable<Record<string, CellValue>>) {
          const rowNum = Number(row._row_num ?? 0)
          const line = [
            String(rowNum),
            ...selectedCols.map((c) => escapeTsvCell(row[c.sqlName])),
          ].join('\t')
          const lineTokens = estimateTokens(line) + 2
          if (chunkRowCount > 0 && tokens + lineTokens > maxTokens) {
            flush()
          }
          if (chunkRowCount === 0) {
            chunkStartRow = rowNum
          }
          chunkEndRow = rowNum
          chunkRowCount += 1
          lines.push(line)
          tokens += lineTokens
        }
        flush()

        return { meta, sheet: active, chunks }
      } finally {
        db.close()
      }
    },

    async remove(ownerKey: string, id: string): Promise<void> {
      await Promise.all([
        fs.rm(dbPathOf(ownerKey, id), { force: true }),
        fs.rm(metaPathOf(ownerKey, id), { force: true }),
      ])
    },

    /** 定期清理过期的访客临时表格库，避免磁盘无限增长 */
    async pruneGuests(olderThanMs: number): Promise<void> {
      let entries: string[]
      try {
        entries = await fs.readdir(baseRoot)
      } catch {
        return
      }
      const cutoff = Date.now() - olderThanMs
      for (const entry of entries) {
        if (!entry.startsWith('guest-')) {
          continue
        }
        const dir = path.join(baseRoot, entry)
        let files: string[]
        try {
          files = await fs.readdir(dir)
        } catch {
          continue
        }
        for (const file of files) {
          const full = path.join(dir, file)
          try {
            const stat = await fs.stat(full)
            if (stat.mtimeMs < cutoff) {
              await fs.rm(full, { force: true })
            }
          } catch {
            // ignore
          }
        }
      }
    },
  }
}

export type SpreadsheetStore = ReturnType<typeof createSpreadsheetStore>
