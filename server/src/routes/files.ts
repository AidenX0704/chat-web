import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import type { Config } from '../config.js'
import type { ChatRepo } from '../db/chats.js'
import type { UserFileRepo } from '../db/userFiles.js'
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js'
import { isSafeId, type BlobStore } from '../storage/blobs.js'

export type FileRoutesOptions = {
  config: Config
  chats: ChatRepo
  files: UserFileRepo
  blobs: BlobStore
}

/**
 * 附件原件：多端同步后，另一台设备要能看到同一张图，原件必须留在服务端。
 * 走 raw 流式读写，不在内存里整块缓冲。
 */
export const fileRoutes: FastifyPluginAsync<FileRoutesOptions> = async (app, options) => {
  const { config, chats, files, blobs } = options

  app.addHook('preHandler', app.authenticate)

  const requireUser = (request: FastifyRequest): string => {
    const userId = request.authUser?.id
    if (!userId) {
      throw unauthorized()
    }
    return userId
  }

  const readFileId = (request: FastifyRequest): string => {
    const id = (request.params as { id?: string }).id ?? ''
    if (!isSafeId(id)) {
      throw badRequest('invalid_file_id', '文件 ID 不合法')
    }
    return id
  }

  /** 上传（覆盖写）；同一 id 重复上传视为幂等替换 */
  app.put<{ Params: { id: string } }>('/api/files/:id', async (request, reply: FastifyReply) => {
    const userId = requireUser(request)
    const fileId = readFileId(request)

    const body = request.body
    const source =
      body === null || body === undefined
        ? null
        : typeof body === 'string' || Buffer.isBuffer(body)
          ? Buffer.from(body as string | Buffer)
          : (body as NodeJS.ReadableStream)

    if (source === null || (typeof source !== 'string' && !Buffer.isBuffer(source) && !('pipe' in source))) {
      throw badRequest('invalid_file_body', '请求体格式不正确')
    }

    const previousSize = files.sizeOf(userId, fileId)
    let size: number
    try {
      size = await blobs.write(userId, fileId, source as NodeJS.ReadableStream | Buffer, config.files.maxBytes)
    } catch (error) {
      if (error instanceof Error && error.message === 'file_too_large') {
        throw badRequest('file_too_large', `单个附件不能超过 ${Math.floor(config.files.maxBytes / (1024 * 1024))}MB`)
      }
      throw error
    }

    const used = files.totalSize(userId) - previousSize + size
    if (used > config.files.quotaBytes) {
      await blobs.remove(userId, fileId)
      throw forbidden('storage_quota_exceeded', '附件存储空间已满')
    }

    const mime = (request.headers['content-type'] ?? 'application/octet-stream').split(';')[0] ?? ''
    files.put({ userId, id: fileId, size, mime, at: Date.now() })
    reply.header('cache-control', 'no-store')
    reply.code(201)
    return { id: fileId, size, mime }
  })

  app.get<{ Params: { id: string } }>('/api/files/:id', async (request, reply: FastifyReply) => {
    const userId = requireUser(request)
    const fileId = readFileId(request)
    const row = files.get(userId, fileId)
    if (!row) {
      throw notFound('file_not_found', '文件不存在')
    }
    const blob = await blobs.read(userId, fileId)
    if (!blob) {
      files.remove(userId, fileId)
      throw notFound('file_not_found', '文件不存在')
    }
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': row.mime === '' ? 'application/octet-stream' : row.mime,
      'content-length': String(blob.size),
      etag: `"${fileId}-${blob.size}"`,
      // 附件内容不可变（id 由内容维度唯一），允许浏览器缓存；私有，不进共享缓存
      'cache-control': 'private, max-age=86400',
      'x-content-type-options': 'nosniff',
    })
    blob.stream.pipe(reply.raw)
    blob.stream.on('error', () => reply.raw.destroy())
  })

  app.delete<{ Params: { id: string } }>('/api/files/:id', async (request, reply: FastifyReply) => {
    const userId = requireUser(request)
    const fileId = readFileId(request)
    if (chats.fileReferenced(userId, fileId, '')) {
      throw conflict('file_in_use', '还有会话引用这个文件')
    }
    files.remove(userId, fileId)
    await blobs.remove(userId, fileId)
    reply.code(204)
    return null
  })
}
