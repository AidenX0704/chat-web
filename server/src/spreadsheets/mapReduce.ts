import type { ChatProxyConfig } from '../config.js'
import type { SheetChunk, SpreadsheetStore, ToolExecResult } from './store.js'

const MAP_CONCURRENCY = 4
const MAX_CHUNKS_PER_CALL = 50
const REDUCE_THRESHOLD_CHARS = 10_000
const FINAL_MAX_CHARS = 12_000

type AnthropicMessageResponse = {
  content?: Array<{ type?: string; text?: string }>
  error?: { message?: string }
}

const callFlash = async (
  proxy: ChatProxyConfig,
  system: string,
  userContent: string,
  signal?: AbortSignal
): Promise<string> => {
  if (!proxy.enabled || !proxy.apiKey) {
    throw new Error('服务端未配置上游 API Key，无法执行分片精读')
  }
  const response = await fetch(`${proxy.origin}/anthropic/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': proxy.apiKey,
    },
    body: JSON.stringify({
      model: 'deepseek-flash',
      max_tokens: 4096,
      thinking: { type: 'disabled' },
      system,
      messages: [{ role: 'user', content: userContent }],
      stream: false,
    }),
    signal,
  })
  const text = await response.text()
  let parsed: AnthropicMessageResponse | null = null
  try {
    parsed = JSON.parse(text) as AnthropicMessageResponse
  } catch {
    // non-json error body
  }
  if (!response.ok) {
    const msg = parsed?.error?.message ?? (text || `HTTP ${response.status}`)
    throw new Error(msg)
  }
  const blocks = parsed?.content ?? []
  return blocks
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text!)
    .join('')
    .trim()
}

const runWithConcurrency = async <T, R>(
  items: T[],
  limit: number,
  worker: (item: T, idx: number) => Promise<R>
): Promise<R[]> => {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const runWorker = async () => {
    while (nextIndex < items.length) {
      const idx = nextIndex
      nextIndex += 1
      results[idx] = await worker(items[idx]!, idx)
    }
  }
  const count = Math.min(limit, items.length)
  await Promise.all(Array.from({ length: count }, () => runWorker()))
  return results
}

export const executeMapReduceSheet = async (
  store: SpreadsheetStore,
  proxy: ChatProxyConfig,
  ownerKey: string,
  id: string,
  options: {
    sheet?: string
    columns?: string[]
    instruction: string
    startRow?: number
    endRow?: number
  },
  signal?: AbortSignal
): Promise<ToolExecResult> => {
  const instruction = (options.instruction ?? '').trim()
  if (instruction === '') {
    return {
      content: 'map_reduce_sheet 需要提供明确的 instruction（逐片阅读提取指令）',
      isError: true,
      summary: '缺少阅读指令',
    }
  }

  let built: Awaited<ReturnType<SpreadsheetStore['buildChunks']>>
  try {
    built = await store.buildChunks(ownerKey, id, {
      sheet: options.sheet,
      columns: options.columns,
      maxTokensPerChunk: 10_000,
      startRow: options.startRow,
      endRow: options.endRow,
    })
  } catch (error) {
    return {
      content: error instanceof Error ? error.message : String(error),
      isError: true,
      summary: '分片失败',
    }
  }

  if (built.chunks.length === 0) {
    return {
      content: `工作表 "${built.sheet.name}" 在指定范围内没有数据行。`,
      summary: '无数据行',
    }
  }

  const totalChunks = built.chunks.length
  const selectedChunks: SheetChunk[] = built.chunks.slice(0, MAX_CHUNKS_PER_CALL)
  const truncatedChunks = totalChunks > MAX_CHUNKS_PER_CALL

  const mapSystem =
    '你是严谨的表格分片阅读助手。你会收到大型表格的一个连续分片（TSV 格式，第一列为原始行号 _row_num）。' +
    '请严格按用户指令逐行阅读本分片，只提取与任务相关的准确事实、分类计数、关键条目与对应行号；' +
    '不要编造不存在的内容；若本分片无相关内容，仅回复“无相关记录”。输出请精炼结构化。'

  try {
    const partials = await runWithConcurrency(selectedChunks, MAP_CONCURRENCY, async (chunk) => {
      const prompt = [
        `文件: ${built.meta.filename} | 工作表: ${built.sheet.name}`,
        `当前分片: 第 ${chunk.index}/${totalChunks} 片（行号 _row_num ${chunk.startRow}–${chunk.endRow}，共 ${chunk.rowCount} 行）`,
        `阅读指令: ${instruction}`,
        '',
        '分片数据（TSV）:',
        chunk.tsv,
      ].join('\n')
      const out = await callFlash(proxy, mapSystem, prompt, signal)
      return `## 分片 ${chunk.index}（行 ${chunk.startRow}–${chunk.endRow}）\n${out}`
    })

    const combined = partials.join('\n\n')
    const firstRow = selectedChunks[0]!.startRow
    const lastRow = selectedChunks[selectedChunks.length - 1]!.endRow

    let finalBody = combined
    if (combined.length > REDUCE_THRESHOLD_CHARS) {
      const reduceSystem =
        '你是数据汇总助手。下面是对同一张大型表格多个连续分片逐片阅读的结果。' +
        '请将所有分片结果无遗漏地合并、去重、累加计数，并保留关键代表性行号（_row_num）。输出清晰、结构化、控制在 3000 字以内。'
      const reducePrompt = [
        `文件: ${built.meta.filename} | 工作表: ${built.sheet.name}`,
        `覆盖范围: 第 ${firstRow}–${lastRow} 行（共 ${selectedChunks.length} 个分片）`,
        `原始阅读指令: ${instruction}`,
        '',
        '各分片提取结果:',
        combined.slice(0, 80_000),
      ].join('\n')
      finalBody = await callFlash(proxy, reduceSystem, reducePrompt, signal)
    }

    if (finalBody.length > FINAL_MAX_CHARS) {
      finalBody = `${finalBody.slice(0, FINAL_MAX_CHARS)}\n\n[提示] 汇总输出过长已截断。`
    }

    const footer = truncatedChunks
      ? `\n\n[范围说明] 本次已完整阅读第 ${firstRow}–${lastRow} 行（共 ${selectedChunks.length}/${totalChunks} 片）。如需继续阅读剩余行，请再次调用 map_reduce_sheet 并传入 start_row=${lastRow + 1}。`
      : `\n\n[范围说明] 已 100% 完整分片阅读工作表 "${built.sheet.name}" 第 ${firstRow}–${lastRow} 行（共 ${selectedChunks.length} 片）。`

    return {
      content: `${finalBody}${footer}`,
      summary: truncatedChunks
        ? `已分片精读 ${selectedChunks.length}/${totalChunks} 片（行 ${firstRow}–${lastRow}）`
        : `已完成全表 ${selectedChunks.length} 片精读（行 ${firstRow}–${lastRow}）`,
    }
  } catch (error) {
    return {
      content: `分片精读失败: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
      summary: '分片精读失败',
    }
  }
}
