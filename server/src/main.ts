import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createApp } from './app.js'
import { loadConfig } from './config.js'

const loadDotEnv = (): void => {
  const envPath = fileURLToPath(new URL('../.env', import.meta.url))
  if (existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    process.loadEnvFile(envPath)
  }
}

const main = async (): Promise<void> => {
  loadDotEnv()
  const config = loadConfig()
  const { app } = await createApp({ config })

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, '正在关闭服务')
    try {
      await app.close()
      process.exit(0)
    } catch (error) {
      app.log.error({ err: error }, '关闭服务失败')
      process.exit(1)
    }
  }

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    app.log.error({ err: reason }, '未处理的 Promise 拒绝')
  })

  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    `服务已启动 http://${config.host}:${config.port}（env=${config.env}, 账号=${config.account.username}, 数据库=${config.databasePath}）`
  )
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('启动失败：', error)
  process.exit(1)
})
