import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import * as XLSX from 'xlsx'
import { createSpreadsheetStore } from '../src/spreadsheets/store.js'
import { createTestApp, jsonOf, loginCookie, userCookie } from './helpers.js'

const makeTempDir = () => mkdtempSync(path.join(os.tmpdir(), 'chat-web-sheets-'))

test('小表格 CSV 自动清洗并走 inline 模式，同时支持分页预览与搜索', async () => {
  const dir = makeTempDir()
  const { app } = await createTestApp({ DATA_DIR: dir })
  try {
    const cookie = await loginCookie(app)
    const csv = [
      '\uFEFF部门,姓名,销售额,备注',
      '华东,张三,1200,"VIP, 重要客户"',
      ',,,',
      '华北,李四,3500,"第一行\n第二行"',
      '华东,王五,2800,普通',
    ].join('\n')

    const upload = await app.inject({
      method: 'POST',
      url: '/api/spreadsheets',
      headers: {
        cookie,
        'content-type': 'text/csv',
        'x-file-name': encodeURIComponent('销售表.csv'),
        'x-file-id': 'sheet-csv-1',
      },
      payload: Buffer.from(csv, 'utf8'),
    })
    assert.equal(upload.statusCode, 201)
    const { spreadsheet } = jsonOf<{
      spreadsheet: {
        id: string
        mode: string
        totalRows: number
        sheetCount: number
        inlineText?: string
        profileText: string
      }
    }>(upload.body)
    assert.equal(spreadsheet.id, 'sheet-csv-1')
    assert.equal(spreadsheet.mode, 'inline')
    assert.equal(spreadsheet.totalRows, 3)
    assert.equal(spreadsheet.sheetCount, 1)
    assert.ok(spreadsheet.inlineText?.includes('张三'))
    assert.ok(spreadsheet.inlineText?.includes('3500'))

    const preview = await app.inject({
      method: 'GET',
      url: '/api/spreadsheets/sheet-csv-1/preview?offset=0&limit=2&search=%E5%8D%8E%E4%B8%9C',
      headers: { cookie },
    })
    assert.equal(preview.statusCode, 200)
    const { preview: data } = jsonOf<{
      preview: {
        filteredRows: number
        rows: { rowNum: number; values: unknown[] }[]
      }
    }>(preview.body)
    assert.equal(data.filteredRows, 2)
    assert.equal(data.rows.length, 2)
    assert.equal(data.rows[0]?.rowNum, 1)
    assert.equal(data.rows[1]?.rowNum, 3)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超大 XLSX 多工作表自动切换 structured 模式，支持只读 SQL、分页读行、搜索与防注入校验', async () => {
  const dir = makeTempDir()
  const { app } = await createTestApp({ DATA_DIR: dir })
  try {
    const cookie = await loginCookie(app)
    const otherCookie = userCookie(app, 'other-user')

    // 构造 600 行订单表 + 3 行部门映射表，触发 structured 模式（> 400 行）
    const orderRows: unknown[][] = [['订单号', '部门', '金额', '说明']]
    for (let i = 1; i <= 600; i += 1) {
      const dept = i % 3 === 0 ? '华东' : i % 3 === 1 ? '华北' : '华南'
      const note = i === 488 ? '特殊异常单：需要加急退款审核' : `常规订单明细描述内容编号-${i}`
      orderRows.push([`ORD-${String(i).padStart(4, '0')}`, dept, i * 10, note])
    }
    const deptRows: unknown[][] = [
      ['部门', '负责人'],
      ['华东', '陈经理'],
      ['华北', '刘经理'],
      ['华南', '赵经理'],
    ]

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(orderRows), '订单明细')
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(deptRows), '部门信息')
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer

    const upload = await app.inject({
      method: 'POST',
      url: '/api/spreadsheets',
      headers: {
        cookie,
        'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'x-file-name': encodeURIComponent('年度汇总.xlsx'),
        'x-file-id': 'big-xlsx-1',
      },
      payload: xlsxBuf,
    })
    assert.equal(upload.statusCode, 201)
    const { spreadsheet } = jsonOf<{
      spreadsheet: {
        mode: string
        totalRows: number
        sheetCount: number
        inlineText?: string
        profileText: string
      }
    }>(upload.body)
    assert.equal(spreadsheet.mode, 'structured')
    assert.equal(spreadsheet.totalRows, 603)
    assert.equal(spreadsheet.sheetCount, 2)
    assert.equal(spreadsheet.inlineText, undefined)
    assert.ok(spreadsheet.profileText.includes('sheet_1'))
    assert.ok(spreadsheet.profileText.includes('sheet_2'))

    // 1. 跨表 SQL 聚合查询
    const sqlRes = await app.inject({
      method: 'POST',
      url: '/api/spreadsheets/big-xlsx-1/tool',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        name: 'query_sheet_sql',
        input: {
          sql: 'SELECT o."部门", d."负责人", COUNT(*) AS cnt, SUM(o."金额") AS total FROM sheet_1 o JOIN sheet_2 d ON o."部门" = d."部门" GROUP BY o."部门" ORDER BY total DESC',
        },
      },
    })
    assert.equal(sqlRes.statusCode, 200)
    const sqlBody = jsonOf<{ content: string; isError?: boolean }>(sqlRes.body)
    assert.equal(sqlBody.isError, undefined)
    assert.ok(sqlBody.content.includes('华东'))
    assert.ok(sqlBody.content.includes('陈经理'))
    assert.ok(sqlBody.content.includes('200'))

    // 2. 写操作与多语句 SQL 必须被拦截
    const badSql = await app.inject({
      method: 'POST',
      url: '/api/spreadsheets/big-xlsx-1/tool',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        name: 'query_sheet_sql',
        input: { sql: 'SELECT 1; DROP TABLE sheet_1' },
      },
    })
    assert.equal(badSql.statusCode, 200)
    assert.equal(jsonOf<{ isError?: boolean }>(badSql.body).isError, true)

    // 3. 搜索关键字精确定位到第 488 行
    const searchRes = await app.inject({
      method: 'POST',
      url: '/api/spreadsheets/big-xlsx-1/tool',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        name: 'search_sheet_text',
        input: { keyword: '加急退款' },
      },
    })
    assert.equal(searchRes.statusCode, 200)
    const searchBody = jsonOf<{ content: string; summary: string }>(searchRes.body)
    assert.ok(searchBody.content.includes('488'))
    assert.ok(searchBody.content.includes('ORD-0488'))
    assert.equal(searchBody.summary, '命中 1 行')

    // 4. 按行号分页精读
    const rowsRes = await app.inject({
      method: 'POST',
      url: '/api/spreadsheets/big-xlsx-1/tool',
      headers: { cookie, 'content-type': 'application/json' },
      payload: {
        name: 'read_sheet_rows',
        input: { sheet: '订单明细', start_row: 598, limit: 10 },
      },
    })
    assert.equal(rowsRes.statusCode, 200)
    const rowsBody = jsonOf<{ content: string }>(rowsRes.body)
    assert.ok(rowsBody.content.includes('ORD-0598'))
    assert.ok(rowsBody.content.includes('ORD-0600'))

    // 5. 其他用户不能预览或查询他人的表格
    const forbiddenPreview = await app.inject({
      method: 'GET',
      url: '/api/spreadsheets/big-xlsx-1/preview',
      headers: { cookie: otherCookie },
    })
    assert.equal(forbiddenPreview.statusCode, 404)
  } finally {
    await app.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildChunks 按 Token 预算切分大表且 100% 覆盖全部行无遗漏', async () => {
  const dir = makeTempDir()
  const store = createSpreadsheetStore(dir)
  try {
    await store.ensureRoot()
    const lines = ['编号,长文本内容']
    for (let i = 1; i <= 500; i += 1) {
      lines.push(`${i},"第 ${i} 条用户反馈内容：系统在处理超长表格上传时希望能完整阅读并支持在线预览展示。"`)
    }
    await store.ingest('user:u1', 'chunk-test', 'feedback.csv', Buffer.from(lines.join('\n'), 'utf8'))
    const { chunks } = await store.buildChunks('user:u1', 'chunk-test', {
      maxTokensPerChunk: 2_500,
    })
    assert.ok(chunks.length >= 3)
    assert.equal(chunks[0]?.startRow, 1)
    assert.equal(chunks.at(-1)?.endRow, 500)
    let totalRows = 0
    for (let i = 0; i < chunks.length; i += 1) {
      totalRows += chunks[i]!.rowCount
      if (i > 0) {
        assert.equal(chunks[i]!.startRow, chunks[i - 1]!.endRow + 1)
      }
    }
    assert.equal(totalRows, 500)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
