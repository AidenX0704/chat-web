import { createReadStream, createWriteStream, mkdirSync, promises as fs } from 'node:fs'
import path from 'node:path'

/** 只允许字母数字与 _ - . ，避免路径穿越 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/

export const isSafeId = (value: string): boolean => SAFE_ID.test(value)

/**
 * 附件原件存储：一层用户目录 + 一个扁平文件名。
 * 不按日期分目录，因为删除、统计都按 (user, id) 定位，扁平结构最简单。
 */
export const createBlobStore = (rootDir: string) => {
  const root = path.resolve(rootDir)
  const userDir = (userId: string) => path.join(root, userId)
  const filePath = (userId: string, fileId: string) => path.join(root, userId, fileId)

  return {
    async ensureRoot(): Promise<void> {
      await fs.mkdir(root, { recursive: true })
    },
    /** 先写临时文件再原子重命名，避免并发读到半个文件 */
    async write(userId: string, fileId: string, source: NodeJS.ReadableStream | Buffer, maxBytes: number): Promise<number> {
      mkdirSync(userDir(userId), { recursive: true })
      const target = filePath(userId, fileId)
      const temp = `${target}.tmp-${process.pid}-${Date.now()}`
      let size = 0
      let tooLarge = false
      await new Promise<void>((resolve, reject) => {
        const out = createWriteStream(temp)
        out.on('error', reject)
        out.on('finish', () => resolve())
        if (Buffer.isBuffer(source)) {
          size = source.length
          if (size > maxBytes) {
            tooLarge = true
            out.destroy()
            resolve()
            return
          }
          out.end(source)
          return
        }
        source.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > maxBytes) {
            tooLarge = true
            ;(source as unknown as { destroy?: () => void }).destroy?.()
            out.destroy()
            resolve()
          }
        })
        source.on('error', reject)
        source.pipe(out)
      })
      if (tooLarge) {
        await fs.rm(temp, { force: true })
        throw new Error('file_too_large')
      }
      await fs.rename(temp, target)
      return size
    },
    async read(userId: string, fileId: string): Promise<{ stream: NodeJS.ReadableStream; size: number } | null> {
      const target = filePath(userId, fileId)
      try {
        const stat = await fs.stat(target)
        if (!stat.isFile()) {
          return null
        }
        return { stream: createReadStream(target), size: stat.size }
      } catch {
        return null
      }
    },
    async remove(userId: string, fileId: string): Promise<void> {
      await fs.rm(filePath(userId, fileId), { force: true })
    },
  }
}

export type BlobStore = ReturnType<typeof createBlobStore>
