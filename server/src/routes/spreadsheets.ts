import { randomUUID } from 'node:crypto'
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { GuestPolicyRepo } from '../db/guestPolicy.js'
import { badRequest, forbidden, HttpError, notFound, payloadTooLarge, unauthorized } from '../lib/errors.js'
import { isSafeId } from '../storage/blobs.js'
import { executeMapReduceSheet } from '../spreadsheets/mapReduce.js'
import type { SpreadsheetStore } from '../spreadsheets/store.js'

const SUPPORTED_EXTS = new Set(['xlsx', 'xls', 'csv', 'tsv'])

const getExt = (filename: string): string => {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : ''
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readBodyBuffer = async (
  body: unknown,
  maxBytes: number
): Promise<Buffer> => {
  if (Buffer.isBuffer(body)) {
    if (body.length > maxBytes) {
      throw payloadTooLarge(`表格文件不能超过 ${Math.floor(maxBytes / (1024 * 1024))}MB`)
    }
    return body
  }
  if (typeof body === 'string') {
    const buf = Buffer.from(body, 'utf8')
    if (buf.length > maxBytes) {
      throw payloadTooLarge(`表格文件不能超过 ${Math.floor(maxBytes / (1024 * 1024))}MB`)
    }
    return buf
  }
  if (body !== null && typeof body === 'object' && 'pipe' in body) {
    const stream = body as NodeJS.ReadableStream
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
      total += buf.length
      if (total > maxBytes) {
        throw payloadTooLarge(`表格文件不能超过 ${Math.floor(maxBytes / (1024 * 1024))}MB`)
      }
      chunks.push(buf)
    }
    return Buffer.concat(chunks, total)
  }
  throw badRequest('invalid_file_body', '请求体格式不正确')
}

export type SpreadsheetRoutesOptions = {
  config: Config
  spreadsheets: SpreadsheetStore
  policy: GuestPolicyRepo
}

export const spreadsheetRoutes: FastifyPluginAsync<SpreadsheetRoutesOptions> = async (
  app,
  { config, spreadsheets, policy }
) => {
  /** 登录用户按 userId 隔离；未登录且管理员允许访客使用附件时按 IP 隔离 */
  const authorize = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const presented =
      request.headers.authorization !== undefined ||
      request.cookies?.[config.cookieName] !== undefined
    if (presented) {
      await app.authenticate(request, reply)
      return
    }
    const current = policy.get()
    if (!current.enabled) {
      throw new HttpError(401, 'guest_disabled', '管理员已关闭免登录免费对话，请登录后使用')
    }
    const ipRule = policy.getIpRule(request.ip)
    if (ipRule?.blocked) {
      throw forbidden('guest_ip_blocked', '当前 IP 已被限制使用免费对话，请登录后使用')
    }
    if (!current.allowAttachments) {
      throw forbidden('guest_attachments_disabled', '免登录暂不支持上传附件，请登录后使用')
    }
    request.guestIp = request.ip
  }

  const ownerKeyOf = (request: FastifyRequest): string => {
    if (request.authUser?.id) {
      return `user:${request.authUser.id}`
    }
    if (request.guestIp !== undefined) {
      return `guest:${request.guestIp}`
    }
    throw unauthorized()
  }

  const readId = (request: FastifyRequest): string => {
    const id = (request.params as { id?: string }).id ?? ''
    if (!isSafeId(id)) {
      throw badRequest('invalid_spreadsheet_id', '表格 ID 不合法')
    }
    return id
  }

  app.addHook('preHandler', authorize)

  /** 上传并解析表格入库，返回结构化画像（小表同时附带紧凑 TSV） */
  app.post('/api/spreadsheets', async (request, reply: FastifyReply) => {
    const ownerKey = ownerKeyOf(request)
    const rawNameHeader = request.headers['x-file-name']
    const rawName = typeof rawNameHeader === 'string' ? rawNameHeader.trim() : ''
    let filename = 'table.xlsx'
    if (rawName !== '') {
      try {
        filename = decodeURIComponent(rawName)
      } catch {
        filename = rawName
      }
    }
    const ext = getExt(filename)
    if (!SUPPORTED_EXTS.has(ext)) {
      throw badRequest('unsupported_spreadsheet', '仅支持 xlsx / xls / csv / tsv 表格文件')
    }

    const rawIdHeader = request.headers['x-file-id']
    const candidateId = typeof rawIdHeader === 'string' ? rawIdHeader.trim() : ''
    const id = candidateId !== '' ? candidateId : randomUUID()
    if (!isSafeId(id)) {
      throw badRequest('invalid_spreadsheet_id', '表格 ID 不合法')
    }

    const maxBytes = Math.min(config.files.maxBytes, config.chatProxy.maxBodyBytes)
    const buffer = await readBodyBuffer(request.body, maxBytes)
    if (buffer.length === 0) {
      throw badRequest('empty_file', '上传的表格文件为空')
    }

    try {
      const meta = await spreadsheets.ingest(ownerKey, id, filename, buffer)
      reply.header('cache-control', 'no-store')
      reply.code(201)
      return {
        spreadsheet: {
          id: meta.id,
          filename: meta.filename,
          sizeBytes: meta.sizeBytes,
          totalRows: meta.totalRows,
          sheetCount: meta.sheets.length,
          estimatedTokens: meta.estimatedTokens,
          mode: meta.mode,
          sheets: meta.sheets.map((s) => ({
            name: s.name,
            tableName: s.tableName,
            rowCount: s.rowCount,
            colCount: s.colCount,
          })),
          profileText: meta.profileText,
          ...(meta.inlineText !== undefined ? { inlineText: meta.inlineText } : {}),
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : '表格解析失败'
      throw badRequest('spreadsheet_parse_failed', message)
    }
  })

  /** 表格分页预览（供前端附件预览弹窗使用） */
  app.get<{
    Params: { id: string }
    Querystring: { sheet?: string; offset?: string; limit?: string; search?: string }
  }>('/api/spreadsheets/:id/preview', async (request, reply: FastifyReply) => {
    const ownerKey = ownerKeyOf(request)
    const id = readId(request)
    const offset = request.query.offset !== undefined ? Number(request.query.offset) : 0
    const limit = request.query.limit !== undefined ? Number(request.query.limit) : 100
    if (!Number.isFinite(offset) || offset < 0 || !Number.isFinite(limit) || limit < 1) {
      throw badRequest('invalid_pagination', '分页参数不合法')
    }
    try {
      const preview = await spreadsheets.preview(ownerKey, id, {
        sheet: request.query.sheet,
        offset,
        limit,
        search: request.query.search,
      })
      if (!preview) {
        throw notFound('spreadsheet_not_found', '表格不存在或已过期')
      }
      reply.header('cache-control', 'no-store')
      return { preview }
    } catch (error) {
      if (error instanceof Error && 'statusCode' in error) {
        throw error
      }
      throw badRequest('preview_failed', error instanceof Error ? error.message : '预览失败')
    }
  })

  /** 执行大模型发起的表格分析工具（只读 SQL / 分页读行 / 搜索 / 全表分片精读） */
  app.post<{ Params: { id: string } }>(
    '/api/spreadsheets/:id/tool',
    async (request, reply: FastifyReply) => {
      const ownerKey = ownerKeyOf(request)
      const id = readId(request)
      const body = request.body
      if (!isRecord(body) || typeof body.name !== 'string') {
        throw badRequest('invalid_tool_request', '缺少工具名称')
      }
      const input = isRecord(body.input) ? body.input : {}

      const controller = new AbortController()
      request.raw.on('close', () => {
        if (!reply.raw.writableEnded) {
          controller.abort()
        }
      })

      let result
      switch (body.name) {
        case 'query_sheet_sql':
          result = await spreadsheets.querySql(
            ownerKey,
            id,
            typeof input.sql === 'string' ? input.sql : ''
          )
          break
        case 'read_sheet_rows':
          result = await spreadsheets.readRows(ownerKey, id, {
            sheet: typeof input.sheet === 'string' ? input.sheet : undefined,
            startRow: typeof input.start_row === 'number' ? input.start_row : undefined,
            limit: typeof input.limit === 'number' ? input.limit : undefined,
            columns: Array.isArray(input.columns)
              ? input.columns.filter((c): c is string => typeof c === 'string')
              : undefined,
          })
          break
        case 'search_sheet_text':
          result = await spreadsheets.searchText(ownerKey, id, {
            keyword: typeof input.keyword === 'string' ? input.keyword : '',
            sheet: typeof input.sheet === 'string' ? input.sheet : undefined,
            column: typeof input.column === 'string' ? input.column : undefined,
            offset: typeof input.offset === 'number' ? input.offset : undefined,
            limit: typeof input.limit === 'number' ? input.limit : undefined,
          })
          break
        case 'map_reduce_sheet':
          result = await executeMapReduceSheet(
            spreadsheets,
            config.chatProxy,
            ownerKey,
            id,
            {
              sheet: typeof input.sheet === 'string' ? input.sheet : undefined,
              columns: Array.isArray(input.columns)
                ? input.columns.filter((c): c is string => typeof c === 'string')
                : undefined,
              instruction: typeof input.instruction === 'string' ? input.instruction : '',
              startRow: typeof input.start_row === 'number' ? input.start_row : undefined,
              endRow: typeof input.end_row === 'number' ? input.end_row : undefined,
            },
            controller.signal
          )
          break
        default:
          throw badRequest('unknown_tool', `不支持的表格工具: ${body.name}`)
      }

      reply.header('cache-control', 'no-store')
      return result
    }
  )

  app.delete<{ Params: { id: string } }>('/api/spreadsheets/:id', async (request, reply) => {
    const ownerKey = ownerKeyOf(request)
    const id = readId(request)
    await spreadsheets.remove(ownerKey, id)
    reply.code(204)
    return null
  })
}
