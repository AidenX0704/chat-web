import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify'
import { isShareToken, type ShareRepo } from '../db/shares.js'
import { notFound, unauthorized } from '../lib/errors.js'

const SHARE_NOT_FOUND = '分享链接不存在或已失效'

export type ShareRoutesOptions = { shares: ShareRepo }

/**
 * 只读分享页的数据来源。
 *
 * 这组路由刻意不挂登录校验：链接本身就是凭据，拿到链接的人可以直接查看。
 * 返回的是一份定格的快照，所以不会暴露会话的实时状态，也不受后续编辑影响。
 */
export const shareRoutes: FastifyPluginAsync<ShareRoutesOptions> = async (app, { shares }) => {
  app.get<{ Params: { token: string } }>(
    '/api/shares/:token',
    async (request, reply: FastifyReply) => {
      const { token } = request.params
      if (!isShareToken(token)) {
        throw notFound('share_not_found', SHARE_NOT_FOUND)
      }
      const row = shares.get(token)
      if (!row) {
        throw notFound('share_not_found', SHARE_NOT_FOUND)
      }
      let session: unknown = null
      try {
        session = (JSON.parse(row.data) as { session?: unknown }).session ?? null
      } catch {
        session = null
      }
      if (session === null) {
        throw notFound('share_not_found', SHARE_NOT_FOUND)
      }
      // 分享内容可能随时被刷新，也不能被搜索引擎收录
      reply.header('cache-control', 'no-store')
      reply.header('x-robots-tag', 'noindex, nofollow')
      return {
        share: {
          token: row.token,
          title: row.title,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          session,
        },
      }
    }
  )
}

export type ShareManageRoutesOptions = { shares: ShareRepo }

/**
 * 已登录用户管理自己的分享链接：列表与撤销。
 * 和上面的公开读取分开注册——这一组必须带登录态，撤销后旧链接立即失效。
 */
export const shareManageRoutes: FastifyPluginAsync<ShareManageRoutesOptions> = async (
  app,
  { shares }
) => {
  app.addHook('preHandler', app.authenticate)

  const userIdOf = (request: FastifyRequest): string => {
    const userId = request.authUser?.id
    if (!userId) {
      throw unauthorized()
    }
    return userId
  }

  app.get('/api/shares', async (request, reply: FastifyReply) => {
    const userId = userIdOf(request)
    reply.header('cache-control', 'no-store')
    return {
      shares: shares.listByUser(userId).map((row) => ({
        token: row.token,
        path: '/s/' + row.token,
        chatId: row.chat_id,
        title: row.title,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    }
  })

  app.delete<{ Params: { token: string } }>(
    '/api/shares/:token',
    async (request, reply: FastifyReply) => {
      const userId = userIdOf(request)
      const { token } = request.params
      if (!isShareToken(token)) {
        throw notFound('share_not_found', SHARE_NOT_FOUND)
      }
      if (shares.remove(token, userId) === 0) {
        throw notFound('share_not_found', SHARE_NOT_FOUND)
      }
      reply.header('cache-control', 'no-store')
      reply.code(204)
      return null
    }
  )
}
