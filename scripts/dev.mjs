#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const serverDir = path.join(rootDir, 'server')
const serverEnvPath = path.join(serverDir, '.env')
const serverNodeModules = path.join(serverDir, 'node_modules')

const ANSI = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
}

/** 轻量读取 .env，只为了推导默认监听地址与端口，不修改当前进程环境 */
const readEnvFile = (filePath) => {
  const result = {}
  if (!existsSync(filePath)) {
    return result
  }
  const content = readFileSync(filePath, 'utf8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const eq = line.indexOf('=')
    if (eq <= 0) {
      continue
    }
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) {
      result[key] = value
    }
  }
  return result
}

const pipeWithPrefix = (stream, prefix, target) => {
  if (!stream) {
    return
  }
  let buffer = ''
  stream.setEncoding('utf8')
  stream.on('data', (chunk) => {
    buffer += chunk
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      target.write(`${prefix} ${line}\n`)
    }
  })
  stream.on('end', () => {
    if (buffer !== '') {
      target.write(`${prefix} ${buffer}\n`)
      buffer = ''
    }
  })
}

const checkHealth = (url) =>
  new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume()
      resolve(res.statusCode !== undefined && res.statusCode < 500)
    })
    req.setTimeout(500, () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })

const waitForBackend = async (url, isExited, timeoutMs = 15_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (isExited()) {
      return false
    }
    if (await checkHealth(url)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

if (!existsSync(serverNodeModules)) {
  process.stderr.write(
    `${ANSI.red}[dev] 未检测到 server/node_modules，请先运行：cd server && pnpm install${ANSI.reset}\n`
  )
  process.exit(1)
}

const fileEnv = readEnvFile(serverEnvPath)
const apiHost = process.env.HOST ?? fileEnv.HOST ?? '127.0.0.1'
const apiPort = process.env.PORT ?? fileEnv.PORT ?? '8787'
const webPort = process.env.WEB_PORT ?? '8090'
const connectHost = apiHost === '0.0.0.0' || apiHost === '::' ? '127.0.0.1' : apiHost
const apiTarget = (process.env.API_PROXY_TARGET ?? `http://${connectHost}:${apiPort}`).replace(
  /\/+$/,
  ''
)
const backendOrigin = process.env.BACKEND_ORIGIN ?? '/'

if (!existsSync(serverEnvPath)) {
  process.stdout.write(
    `${ANSI.yellow}[dev] 未找到 server/.env，使用开发默认配置启动（如需配置 DEEPSEEK_API_KEY，可执行 cp server/.env.example server/.env）${ANSI.reset}\n`
  )
}

const pnpmBin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const children = new Set()
let shuttingDown = false
let serverExited = false

const shutdown = (exitCode = 0) => {
  if (shuttingDown) {
    return
  }
  shuttingDown = true
  for (const child of children) {
    if (!child.killed) {
      child.kill('SIGTERM')
    }
  }
  const forceKill = setTimeout(() => {
    for (const child of children) {
      if (!child.killed) {
        child.kill('SIGKILL')
      }
    }
    process.exit(exitCode)
  }, 3000)
  forceKill.unref()

  if (children.size === 0) {
    clearTimeout(forceKill)
    process.exit(exitCode)
  }
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

const spawnTracked = (name, color, args, options) => {
  const child = spawn(pnpmBin, args, {
    cwd: rootDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  })
  const prefix = `${color}[${name}]${ANSI.reset}`
  pipeWithPrefix(child.stdout, prefix, process.stdout)
  pipeWithPrefix(child.stderr, prefix, process.stderr)
  children.add(child)
  child.on('exit', (code, signal) => {
    children.delete(child)
    if (name === 'server') {
      serverExited = true
    }
    if (shuttingDown) {
      if (children.size === 0) {
        process.exit(0)
      }
      return
    }
    const reason = signal ? `信号 ${signal}` : `退出码 ${code ?? 0}`
    process.stderr.write(`${ANSI.red}[dev] ${name} 意外退出（${reason}），正在停止其余进程${ANSI.reset}\n`)
    shutdown(code && code !== 0 ? code : 1)
  })
  return child
}

process.stdout.write(
  `${ANSI.green}[dev] 正在同时启动后端 (${apiTarget}) 与前端 (http://localhost:${webPort})${ANSI.reset}\n`
)

// 开发联调：本地 HTTP 下关闭 Secure Cookie 与 TRUST_PROXY，仍从 server/.env 读取 DEEPSEEK_API_KEY 等配置
spawnTracked('server', ANSI.cyan, ['--dir', 'server', 'dev'], {
  env: {
    ...process.env,
    NODE_ENV: process.env.NODE_ENV ?? 'development',
    COOKIE_SECURE: process.env.COOKIE_SECURE ?? 'false',
    TRUST_PROXY: process.env.TRUST_PROXY ?? 'false',
    LOG_LEVEL: process.env.LOG_LEVEL ?? 'info',
  },
})

const healthy = await waitForBackend(`${apiTarget}/api/health`, () => serverExited || shuttingDown)
if (shuttingDown) {
  process.exit(0)
}
if (!healthy) {
  process.stderr.write(
    `${ANSI.yellow}[dev] 等待后端健康检查超时，继续启动前端开发服务器${ANSI.reset}\n`
  )
}

spawnTracked('web', ANSI.green, ['exec', 'rspack', 'serve', '-c', 'rspack.config.ts'], {
  env: {
    ...process.env,
    BACKEND_ORIGIN: backendOrigin,
    API_PROXY_TARGET: apiTarget,
    WEB_PORT: String(webPort),
  },
})
