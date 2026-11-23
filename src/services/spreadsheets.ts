import {
  BACKEND_ORIGIN,
  getSessionToken,
  notifyUnauthorized,
  usesBearerToken,
} from './auth/session.js'
import type { ClientToolDefinition } from './api/types.js'
import { ApiError } from './api/client.js'

export const SPREADSHEET_EXTS = new Set(['xlsx', 'xls', 'csv', 'tsv'])

export const isSpreadsheetName = (name: string): boolean => {
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  return SPREADSHEET_EXTS.has(ext)
}

export type SpreadsheetSummary = {
  id: string
  filename: string
  sizeBytes: number
  totalRows: number
  sheetCount: number
  estimatedTokens: number
  mode: 'inline' | 'structured'
  sheets: { name: string; tableName: string; rowCount: number; colCount: number }[]
  profileText: string
  inlineText?: string
}

export type SpreadsheetPreviewData = {
  id: string
  filename: string
  sizeBytes: number
  totalRows: number
  estimatedTokens: number
  mode: 'inline' | 'structured'
  sheets: { name: string; tableName: string; rowCount: number; colCount: number }[]
  activeSheet: string
  columns: { sqlName: string; label: string; type: 'INTEGER' | 'REAL' | 'TEXT' }[]
  rows: { rowNum: number; values: (string | number | null)[] }[]
  filteredRows: number
  offset: number
  limit: number
}

export type SpreadsheetToolResponse = {
  content: string
  isError?: boolean
  summary: string
}

export const SPREADSHEET_TOOL_NAMES = new Set([
  'query_sheet_sql',
  'read_sheet_rows',
  'search_sheet_text',
  'map_reduce_sheet',
])

/** 暴露给大模型的四个只读表格分析工具（符合 Anthropic Messages API 工具定义规范） */
export const SPREADSHEET_TOOLS: ClientToolDefinition[] = [
  {
    name: 'query_sheet_sql',
    description:
      '在已入库的只读 SQLite 表格数据库上执行单条 SELECT/WITH 查询。适合精确统计（COUNT/SUM/AVG/MIN/MAX）、分组汇总（GROUP BY）、多条件筛选（WHERE）、排序取 Top-N、多工作表 JOIN。列名与表名请严格参照表格画像（含中文或特殊字符的列名请用双引号包裹，每张表都有 1-based 行号列 _row_num）。',
    input_schema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: '表格画像中给出的 file_id。',
        },
        sql: {
          type: 'string',
          description: '单条只读 SQLite SELECT 或 WITH 查询语句，建议使用 LIMIT 控制返回行数。',
        },
      },
      required: ['file_id', 'sql'],
    },
  },
  {
    name: 'read_sheet_rows',
    description:
      '按行号区间分页精读表格原始行数据（TSV 格式，带 _row_num）。适合查看明细内容或逐页阅读指定范围。',
    input_schema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: '表格画像中给出的 file_id。',
        },
        sheet: {
          type: 'string',
          description: '工作表名称或 SQL 表名（如 sheet_1），省略时默认第一个工作表。',
        },
        start_row: {
          type: 'integer',
          description: '起始行号（从 1 开始，对应 _row_num），默认 1。',
        },
        limit: {
          type: 'integer',
          description: '本次读取的行数，默认 50，最大 200。',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：仅返回指定的列名列表，减少无关列干扰。',
        },
      },
      required: ['file_id'],
    },
  },
  {
    name: 'search_sheet_text',
    description:
      '在表格的全部工作表或指定工作表/列中按关键词模糊搜索匹配的行，返回总命中行数和具体行号与内容。',
    input_schema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: '表格画像中给出的 file_id。',
        },
        keyword: {
          type: 'string',
          description: '要搜索的关键词（不区分大小写，子串匹配）。',
        },
        sheet: {
          type: 'string',
          description: '可选：限定搜索的工作表名称或 SQL 表名。',
        },
        column: {
          type: 'string',
          description: '可选：限定搜索的列名。',
        },
        offset: {
          type: 'integer',
          description: '可选：翻页偏移量，默认 0。',
        },
        limit: {
          type: 'integer',
          description: '可选：最多返回行数，默认 50，最大 100。',
        },
      },
      required: ['file_id', 'keyword'],
    },
  },
  {
    name: 'map_reduce_sheet',
    description:
      '全表并发分片精读工具。当用户要求把大表格中所有文本记录逐条完整阅读、分类归因、总结观点、提取非结构化信息（SQL 无法直接计算语义）时调用此工具。服务端会自动将整张工作表安全切片并并发逐片阅读后汇总，100% 覆盖每一行。',
    input_schema: {
      type: 'object',
      properties: {
        file_id: {
          type: 'string',
          description: '表格画像中给出的 file_id。',
        },
        sheet: {
          type: 'string',
          description: '可选：工作表名称或 SQL 表名，默认第一个工作表。',
        },
        columns: {
          type: 'array',
          items: { type: 'string' },
          description: '可选：只传入与阅读任务相关的列名，可大幅提升速度与精度。',
        },
        instruction: {
          type: 'string',
          description: '给每个分片阅读器的明确提取与统计指令（如需要提取哪些字段、分类维度、是否保留行号）。',
        },
        start_row: {
          type: 'integer',
          description: '可选：起始行号（1-based），分批续读时使用。',
        },
        end_row: {
          type: 'integer',
          description: '可选：结束行号（1-based）。',
        },
      },
      required: ['file_id', 'instruction'],
    },
  },
]

const authHeaders = (extra: Record<string, string> = {}): Headers => {
  const headers = new Headers(extra)
  headers.set('x-session-mode', usesBearerToken() ? 'bearer' : 'cookie')
  const token = getSessionToken()
  if (token) {
    headers.set('authorization', `Bearer ${token}`)
  }
  return headers
}

const requestJson = async <T>(path: string, init: RequestInit): Promise<T> => {
  let response: Response
  try {
    response = await fetch(`${BACKEND_ORIGIN}/api${path}`, {
      ...init,
      headers: authHeaders(init.headers as Record<string, string> | undefined),
      credentials: 'include',
    })
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (response.status === 401) {
    notifyUnauthorized()
  }
  const text = await response.text().catch(() => '')
  let parsed: unknown = null
  try {
    parsed = text ? (JSON.parse(text) as unknown) : null
  } catch {
    // non-json
  }
  if (!response.ok) {
    const errObj = (parsed as { error?: { code?: string; message?: string } } | null)?.error
    throw new ApiError(
      'http',
      errObj?.message ?? (text || response.statusText),
      response.status,
      errObj?.code
    )
  }
  return parsed as T
}

/** 上传表格到自建后端解析入库，返回结构化画像 */
export const uploadSpreadsheet = async (
  id: string,
  file: Blob,
  name: string,
  signal?: AbortSignal
): Promise<SpreadsheetSummary> => {
  const body = await requestJson<{ spreadsheet: SpreadsheetSummary }>('/spreadsheets', {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      'x-file-name': encodeURIComponent(name),
      'x-file-id': id,
    },
    body: file,
    signal,
  })
  return body.spreadsheet
}

/** 获取后端表格的分页预览数据 */
export const fetchSpreadsheetPreview = async (
  id: string,
  params: { sheet?: string; offset?: number; limit?: number; search?: string } = {},
  signal?: AbortSignal
): Promise<SpreadsheetPreviewData> => {
  const query = new URLSearchParams()
  if (params.sheet) {
    query.set('sheet', params.sheet)
  }
  if (params.offset !== undefined) {
    query.set('offset', String(params.offset))
  }
  if (params.limit !== undefined) {
    query.set('limit', String(params.limit))
  }
  if (params.search) {
    query.set('search', params.search)
  }
  const qs = query.toString()
  const body = await requestJson<{ preview: SpreadsheetPreviewData }>(
    `/spreadsheets/${encodeURIComponent(id)}/preview${qs ? `?${qs}` : ''}`,
    { method: 'GET', signal }
  )
  return body.preview
}

/** 执行模型发起的表格只读工具 */
export const runSpreadsheetTool = async (
  id: string,
  name: string,
  input: Record<string, unknown>,
  signal?: AbortSignal
): Promise<SpreadsheetToolResponse> =>
  requestJson<SpreadsheetToolResponse>(`/spreadsheets/${encodeURIComponent(id)}/tool`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, input }),
    signal,
  })
