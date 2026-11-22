import assert from 'node:assert/strict'
import test from 'node:test'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

/**
 * 真正运行 open/card-codes/status.get.ts：证明按券码查询券状态的契约。
 * - 券码大小写不敏感精确匹配（SQL 侧 lower 比较），不做模糊匹配；
 * - 找不到返回 404 与固定错误体；
 * - 派发 / 核销只回最新一条，且不含持有人身份字段；
 * - 时间同时给原始值与北京时间文案。
 */

const source = fileURLToPath(
  new URL('../../server/api/open/card-codes/status.get.ts', import.meta.url)
)
const timeUtilsPath = fileURLToPath(new URL('../../app/utils/timeUtils.ts', import.meta.url))

const modules: Record<string, string> = {
  h3: `export const defineEventHandler = fn => fn;
    export const getQuery = event => event.query || {};
    export const createError = ({ statusCode, message }) => Object.assign(new Error(message), { statusCode });
    export const setResponseStatus = (event, statusCode) => { event.statusCode = statusCode; };`,
  'drizzle-orm': `export const eq = (column, value) => ({ op: 'eq', column, value });
    export const desc = column => ({ op: 'desc', column });
    export const sql = (strings, ...values) => ({ op: 'sql', text: strings.join('?'), values });`,
  '~/drizzle/db': `export const db = { select: (...args) => globalThis.__cardCodeDb.select(...args) };`,
  '~/drizzle/schema': `const table = (name, columns) => ({ __table: name, ...columns });
    export const cardCodes = table('cardCodes', {
      id: 'cardCodes.id', code: 'cardCodes.code', status: 'cardCodes.status', note: 'cardCodes.note',
      createdAt: 'cardCodes.createdAt', updatedAt: 'cardCodes.updatedAt',
      assignedAt: 'cardCodes.assignedAt', redeemedAt: 'cardCodes.redeemedAt'
    });
    export const cardCodeAssignments = table('cardCodeAssignments', {
      id: 'cardCodeAssignments.id', cardCodeId: 'cardCodeAssignments.cardCodeId',
      status: 'cardCodeAssignments.status', assignedAt: 'cardCodeAssignments.assignedAt',
      usedAt: 'cardCodeAssignments.usedAt', recycledAt: 'cardCodeAssignments.recycledAt',
      recycleReason: 'cardCodeAssignments.recycleReason', failureReason: 'cardCodeAssignments.failureReason'
    });
    export const cardCodeRedeemLogs = table('cardCodeRedeemLogs', {
      id: 'cardCodeRedeemLogs.id', cardCodeId: 'cardCodeRedeemLogs.cardCodeId',
      redeemedAt: 'cardCodeRedeemLogs.redeemedAt', source: 'cardCodeRedeemLogs.source',
      songId: 'cardCodeRedeemLogs.songId'
    });
    export const songs = table('songs', { id: 'songs.id', title: 'songs.title', artist: 'songs.artist' });`
}

const compiled = await build({
  entryPoints: [source],
  bundle: true,
  platform: 'node',
  format: 'esm',
  write: false,
  alias: { '~/utils/timeUtils': timeUtilsPath },
  plugins: [
    {
      name: 'card-code-status-fixture',
      setup(b) {
        b.onResolve({ filter: /^(h3|drizzle-orm|~\/drizzle\/)/ }, args => ({
          path: args.path,
          namespace: 'fixture'
        }))
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, args => ({
          contents: modules[args.path],
          loader: 'js'
        }))
      }
    }
  ]
})
const { default: handler } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].contents).toString('base64')}`
)

const CODE = '20261122153000001234-001'

/** 链式 select 桩：记录 where/orderBy 调用，limit 返回夹具行 */
function makeDb() {
  const target = globalThis as any
  const chain = (tableKey: string) => {
    const q: any = {
      where(condition: unknown) {
        target.__queries.push({ table: tableKey, where: condition })
        return q
      },
      leftJoin(table: any) {
        target.__queries.push({ table: tableKey, joined: table.__table })
        return q
      },
      orderBy(...args: unknown[]) {
        target.__queries.push({ table: tableKey, orderBy: args })
        return q
      },
      limit(n: number) {
        return Promise.resolve((target.__rows[tableKey] || []).slice(0, n))
      }
    }
    return q
  }
  return {
    select() {
      return {
        from(table: any) {
          return chain(table.__table)
        }
      }
    }
  }
}

function fixture({
  rows = {},
  code = CODE,
  apiKey = { id: 1 } as unknown
}: {
  rows?: Record<string, unknown[]>
  code?: string
  apiKey?: unknown
}) {
  const target = globalThis as any
  target.__rows = {
    cardCodes: [
      {
        id: 12,
        code: CODE,
        status: 'AVAILABLE',
        note: 'voicehubpay | source=shop',
        createdAt: new Date('2026-11-22T07:30:00.000Z'),
        updatedAt: new Date('2026-11-22T07:31:00.000Z'),
        assignedAt: null,
        redeemedAt: null,
        // 站内身份信息：不应出现在响应里
        assignedTo: 7,
        lockedBy: 8,
        redeemedBy: 9
      }
    ],
    cardCodeAssignments: [],
    cardCodeRedeemLogs: [],
    ...rows
  }
  target.__queries = []
  const event: any = {
    context: { apiKey },
    query: { code }
  }
  return event
}

test('正常找到：返回券与北京时间文案，无派发/核销时两项为 null', async () => {
  const target = globalThis as any
  target.__cardCodeDb = makeDb()
  const event = fixture({})
  const result: any = await handler(event)

  assert.equal(result.success, true)
  const { data } = result
  assert.equal(data.code, CODE)
  assert.equal(data.status, 'AVAILABLE')
  assert.equal(data.note, 'voicehubpay | source=shop')

  // 原始值保留，文案为北京时间（UTC 07:30 → 15:30）
  assert.equal(data.createdAt.toISOString(), '2026-11-22T07:30:00.000Z')
  assert.equal(data.createdAtText, '2026/11/22 15:30:00')
  assert.equal(data.updatedAtText, '2026/11/22 15:31:00')
  assert.equal(data.assignedAt, null)
  assert.equal(data.assignedAtText, null)
  assert.equal(data.redeemedAt, null)
  assert.equal(data.redeemedAtText, null)
  assert.equal(data.assignment, null)
  assert.equal(data.redeem, null)

  // 券码查询用 SQL lower 精确比较，后续派发/核销均按券 id 查
  const lookup = target.__queries[0]
  assert.equal(lookup.table, 'cardCodes')
  assert.match(lookup.where.text, /lower\(/)
  assert.equal(lookup.where.values[0], 'cardCodes.code')
  assert.equal(lookup.where.values[1], CODE.toLowerCase())
  for (const q of target.__queries.slice(1)) {
    if (q.where) assert.equal(q.where.value, 12)
  }
  assert.equal(target.__queries.length, 6)
})

test('券码大小写不敏感精确匹配', async () => {
  const target = globalThis as any
  target.__cardCodeDb = makeDb()
  const event = fixture({ code: CODE.toLowerCase() })
  const result: any = await handler(event)

  assert.equal(result.success, true)
  assert.equal(result.data.code, CODE)
  assert.equal(target.__queries[0].where.values[1], CODE.toLowerCase())
})

test('找不到券码返回 404 与固定错误体', async () => {
  const target = globalThis as any
  const event = fixture({ code: 'NOPE-404' })
  // 空结果：券不存在时不应继续查派发/核销
  target.__rows = { cardCodes: [], cardCodeAssignments: [], cardCodeRedeemLogs: [] }
  target.__cardCodeDb = makeDb()
  const result: any = await handler(event)

  assert.equal(event.statusCode, 404)
  assert.deepEqual(result, { success: false, message: '点歌券不存在' })
  assert.equal(target.__queries.length, 1)
})

test('带派发记录：返回最新一条，且不含持有人身份字段', async () => {
  const target = globalThis as any
  target.__cardCodeDb = makeDb()
  const event = fixture({
    rows: {
      cardCodeAssignments: [
        {
          id: 31,
          cardCodeId: 12,
          status: 'ASSIGNED',
          assignedAt: new Date('2026-11-22T07:31:00.000Z'),
          usedAt: null,
          recycledAt: null,
          recycleReason: null,
          failureReason: null,
          // 身份信息：不得外泄
          userId: 7,
          userNameSnapshot: '张三',
          assignedBy: 1,
          assignedByName: '管理员',
          note: 'internal'
        }
      ]
    }
  })
  const result: any = await handler(event)

  const { assignment } = result.data
  assert.equal(assignment.status, 'ASSIGNED')
  assert.equal(assignment.assignedAt.toISOString(), '2026-11-22T07:31:00.000Z')
  assert.equal(assignment.assignedAtText, '2026/11/22 15:31:00')
  assert.equal(assignment.usedAtText, null)
  assert.equal(assignment.recycledAtText, null)
  assert.equal(assignment.recycleReason, null)
  assert.equal(assignment.failureReason, null)
  assert.equal(result.data.redeem, null)

  // 派发记录按 assignedAt 倒序取最新
  const assignmentQuery = target.__queries.find((q: any) => q.table === 'cardCodeAssignments' && q.orderBy)
  assert.equal(assignmentQuery.orderBy[0].op, 'desc')
  assert.equal(assignmentQuery.orderBy[0].column, 'cardCodeAssignments.assignedAt')
  const assignmentWhere = target.__queries.find((q: any) => q.table === 'cardCodeAssignments' && q.where)
  assert.equal(assignmentWhere.where.value, 12)

  // 响应任何层级都不含身份字段或其值
  const serialized = JSON.stringify(result)
  for (const forbidden of ['userId', 'userNameSnapshot', 'assignedBy', 'assignedto', '张三', '管理员', 'internal']) {
    assert.equal(serialized.includes(forbidden), false, `响应不应包含 ${forbidden}`)
  }
})

test('带回收 / 失败原因的派发记录原样返回', async () => {
  const target = globalThis as any
  target.__cardCodeDb = makeDb()
  const event = fixture({
    rows: {
      cardCodeAssignments: [
        {
          id: 32,
          cardCodeId: 12,
          status: 'RECYCLED',
          assignedAt: new Date('2026-11-22T07:31:00.000Z'),
          usedAt: new Date('2026-11-22T08:00:00.000Z'),
          recycledAt: new Date('2026-11-22T09:00:00.000Z'),
          recycleReason: '未按时使用',
          failureReason: null,
          userId: 7
        }
      ]
    }
  })
  const result: any = await handler(event)

  assert.equal(result.data.assignment.status, 'RECYCLED')
  assert.equal(result.data.assignment.usedAtText, '2026/11/22 16:00:00')
  assert.equal(result.data.assignment.recycledAtText, '2026/11/22 17:00:00')
  assert.equal(result.data.assignment.recycleReason, '未按时使用')
})

test('带核销记录：返回核销时间、来源与歌曲信息', async () => {
  const target = globalThis as any
  target.__cardCodeDb = makeDb()
  const event = fixture({
    rows: {
      cardCodeRedeemLogs: [
        {
          id: 41,
          cardCodeId: 12,
          redeemedAt: new Date('2026-11-22T10:00:00.000Z'),
          source: 'SCHEDULE_AUTO',
          songId: 12,
          // 联表取到的歌曲字段
          songTitle: '告白气球',
          songArtist: '周杰伦',
          // 身份信息：不得外泄
          redeemedBy: 7
        }
      ]
    }
  })
  const result: any = await handler(event)

  assert.equal(result.data.redeem.redeemedAt.toISOString(), '2026-11-22T10:00:00.000Z')
  assert.equal(result.data.redeem.redeemedAtText, '2026/11/22 18:00:00')
  assert.equal(result.data.redeem.source, 'SCHEDULE_AUTO')
  assert.equal(result.data.redeem.songId, 12)
  assert.equal(result.data.redeem.songTitle, '告白气球')
  assert.equal(result.data.redeem.songArtist, '周杰伦')
  assert.equal(result.data.assignment, null)

  // 核销记录按 redeemedAt 倒序取最新，并联表 songs
  const redeemQuery = target.__queries.find((q: any) => q.table === 'cardCodeRedeemLogs' && q.orderBy)
  const redeemJoin = target.__queries.find((q: any) => q.table === 'cardCodeRedeemLogs' && q.joined)
  assert.equal(redeemJoin.joined, 'songs')
  assert.equal(redeemQuery.orderBy[0].column, 'cardCodeRedeemLogs.redeemedAt')
  assert.equal(JSON.stringify(result).includes('redeemedBy'), false)
})

test('核销记录对应歌曲已删除时歌曲字段为 null', async () => {
  const target = globalThis as any
  target.__cardCodeDb = makeDb()
  const event = fixture({
    rows: {
      cardCodeRedeemLogs: [
        {
          id: 42,
          cardCodeId: 12,
          redeemedAt: new Date('2026-11-22T10:00:00.000Z'),
          source: 'MANUAL',
          songId: null,
          songTitle: null,
          songArtist: null
        }
      ]
    }
  })
  const result: any = await handler(event)

  assert.equal(result.data.redeem.songId, null)
  assert.equal(result.data.redeem.songTitle, null)
  assert.equal(result.data.redeem.songArtist, null)
})

test('券码缺失 / 超长 / 空白与控制字符一律 400，且不查库', async () => {
  const target = globalThis as any
  target.__cardCodeDb = {
    select: () => assert.fail('参数非法时不应查询数据库')
  }

  for (const code of ['', 'A'.repeat(129), 'abc def', 'abc\tdef', 'abc\u0000def']) {
    const event = fixture({ code })
    const result: any = await handler(event)
    assert.equal(event.statusCode, 400, `code=${code} 应返回 400`)
    assert.deepEqual(result, { success: false, message: '点歌券码格式无效' })
  }

  // 自定义前缀/后缀可能含中文或标点，属于有效券码，应进入查询（这里查无此券 → 404）
  target.__cardCodeDb = makeDb()
  for (const code of ['带中文', 'abc/def', 'abc.def']) {
    const event = fixture({ code, rows: { cardCodes: [] } })
    const result: any = await handler(event)
    assert.equal(event.statusCode, 404, `code=${code} 应按有效券码查询`)
    assert.deepEqual(result, { success: false, message: '点歌券不存在' })
  }

  // 128 字符边界允许
  const boundary = fixture({ code: 'A'.repeat(128) })
  const result: any = await handler(boundary)
  assert.equal(result.success, true)
})

test('缺少 apiKey context 时 401', async () => {
  const target = globalThis as any
  target.__cardCodeDb = { select: () => assert.fail('未认证时不应查询数据库') }
  const event = fixture({ apiKey: null })
  await assert.rejects(() => handler(event), (error: any) => {
    assert.equal(error.statusCode, 401)
    return true
  })
})
