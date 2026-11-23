/** 统一使用毫秒时间戳，便于与前端 Date.now() 对齐。 */
export const now = (): number => Date.now()

export const minutes = (value: number): number => value * 60 * 1000
