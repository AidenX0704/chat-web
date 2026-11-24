/** 日志脱敏：任何请求都不打印凭据类请求头。 */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
]
