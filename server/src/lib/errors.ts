/** 带状态码的错误：只在 expose 为 true 时把 message 返回给客户端。 */
export class HttpError extends Error {
  readonly statusCode: number
  readonly code: string
  readonly expose: boolean
  readonly retryAfterMs: number | undefined

  constructor(
    statusCode: number,
    code: string,
    message: string,
    options: { expose?: boolean; retryAfterMs?: number } = {}
  ) {
    super(message)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = code
    this.expose = options.expose ?? true
    this.retryAfterMs = options.retryAfterMs
  }
}

export const badRequest = (code: string, message: string) => new HttpError(400, code, message)
export const unauthorized = (message = '未登录或登录已失效') =>
  new HttpError(401, 'unauthorized', message)
export const forbidden = (code: string, message: string) => new HttpError(403, code, message)
export const notFound = (code: string, message: string) => new HttpError(404, code, message)
export const conflict = (code: string, message: string) => new HttpError(409, code, message)
export const payloadTooLarge = (message: string) => new HttpError(413, 'payload_too_large', message)
export const tooManyRequests = (message: string, retryAfterMs: number) =>
  new HttpError(429, 'too_many_requests', message, { retryAfterMs })
export const internal = (message = '服务器内部错误') =>
  new HttpError(500, 'internal_error', message, { expose: false })
