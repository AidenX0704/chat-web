import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * 口令散列使用 Node 自带的 scrypt：无原生依赖、抗 GPU/ASIC 暴力破解。
 * 参数存进散列串里，将来调高成本时旧口令仍可验证，并在登录成功后自动重算。
 */
export type ScryptParams = {
  N: number
  r: number
  p: number
  keyLen: number
}

/** OWASP 建议的 scrypt 最低成本：N=2^15、r=8、p=1，约 30 MiB 内存 / 单次 100ms 量级 */
const CURRENT: ScryptParams = { N: 32768, r: 8, p: 1, keyLen: 32 }
/** N 提高后默认 maxmem(32MiB) 不够，需要显式放宽 */
const MAX_MEM = 128 * 1024 * 1024
const ALGORITHM = 'scrypt'
const SALT_BYTES = 16

const encode = (params: ScryptParams, salt: Buffer, hash: Buffer): string =>
  [ALGORITHM, params.N, params.r, params.p, salt.toString('base64url'), hash.toString('base64url')].join(
    '$'
  )

type ParsedHash = { params: ScryptParams; salt: Buffer; hash: Buffer }

const parse = (stored: string): ParsedHash | null => {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== ALGORITHM) {
    return null
  }
  const N = Number(parts[1])
  const r = Number(parts[2])
  const p = Number(parts[3])
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) {
    return null
  }
  if (N < 4096 || N > 2 ** 20 || r < 1 || r > 32 || p < 1 || p > 16) {
    return null
  }
  try {
    const salt = Buffer.from(parts[4] as string, 'base64url')
    const hash = Buffer.from(parts[5] as string, 'base64url')
    if (salt.length === 0 || hash.length === 0) {
      return null
    }
    return { params: { N, r, p, keyLen: hash.length }, salt, hash }
  } catch {
    return null
  }
}

const derive = (password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      params.keyLen,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEM },
      (error, derived) => {
        if (error) {
          reject(error)
          return
        }
        resolve(derived)
      }
    )
  })

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(SALT_BYTES)
  const hash = await derive(password, salt, CURRENT)
  return encode(CURRENT, salt, hash)
}

export type VerifyResult = {
  ok: boolean
  /** 散列参数落后于当前成本时，登录成功后应静默重算 */
  needsRehash: boolean
}

export const verifyPassword = async (password: string, stored: string): Promise<VerifyResult> => {
  const parsed = parse(stored)
  if (!parsed) {
    return { ok: false, needsRehash: false }
  }
  const derived = await derive(password, parsed.salt, parsed.params)
  const ok =
    derived.length === parsed.hash.length && timingSafeEqual(derived, parsed.hash)
  const needsRehash =
    parsed.params.N !== CURRENT.N || parsed.params.r !== CURRENT.r || parsed.params.p !== CURRENT.p || parsed.params.keyLen !== CURRENT.keyLen
  return { ok, needsRehash: ok && needsRehash }
}

/**
 * 账号不存在时也执行一次同等代价的散列计算：
 * 否则「用户不存在」会明显快于「密码错误」，攻击者据此即可枚举账号。
 */
let dummyHash: Promise<string> | undefined

export const consumeDummyPasswordCheck = async (password: string): Promise<void> => {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'))
  const stored = await dummyHash
  await verifyPassword(password, stored)
}
