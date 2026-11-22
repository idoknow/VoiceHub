import { createError, defineEventHandler, getQuery, setResponseStatus } from 'h3'
import { db } from '~/drizzle/db'
import { cardCodeAssignments, cardCodeRedeemLogs, cardCodes, songs } from '~/drizzle/schema'
import { desc, eq, sql } from 'drizzle-orm'
import { formatDateTime } from '~/utils/timeUtils'

const CODE_MAX_LENGTH = 128
// 券码可能带自定义前缀/后缀（站点开放接口只限制长度），因此只拒绝空白与控制字符，
// 不能用收紧的字母数字正则把有效券码挡在 400。
const CODE_INVALID_PATTERN = /[\s\u0000-\u001F\u007F]/

export default defineEventHandler(async (event) => {
  const apiKey = event.context.apiKey
  if (!apiKey) {
    throw createError({ statusCode: 401, message: 'API认证失败' })
  }

  try {
    const query = getQuery(event)
    const code = typeof query.code === 'string' ? query.code : ''

    // 开放 API 契约固定该错误体，消费方按状态码与 message 判断
    if (!code || code.length > CODE_MAX_LENGTH || CODE_INVALID_PATTERN.test(code)) {
      setResponseStatus(event, 400)
      return { success: false, message: '点歌券码格式无效' }
    }

    // 券码大小写不敏感精确匹配：库内大小写不统一，不接受模糊匹配
    const [cardCode] = await db
      .select()
      .from(cardCodes)
      .where(sql`lower(${cardCodes.code}) = ${code.toLowerCase()}`)
      .limit(1)

    if (!cardCode) {
      setResponseStatus(event, 404)
      return { success: false, message: '点歌券不存在' }
    }

    // 最新一条派发记录；不返回 userId / userNameSnapshot 等持有人身份
    const [assignment] = await db
      .select({
        status: cardCodeAssignments.status,
        assignedAt: cardCodeAssignments.assignedAt,
        usedAt: cardCodeAssignments.usedAt,
        recycledAt: cardCodeAssignments.recycledAt,
        recycleReason: cardCodeAssignments.recycleReason,
        failureReason: cardCodeAssignments.failureReason
      })
      .from(cardCodeAssignments)
      .where(eq(cardCodeAssignments.cardCodeId, cardCode.id))
      .orderBy(desc(cardCodeAssignments.assignedAt), desc(cardCodeAssignments.id))
      .limit(1)

    // 最新一条核销记录，联表取歌曲信息
    const [redeem] = await db
      .select({
        redeemedAt: cardCodeRedeemLogs.redeemedAt,
        source: cardCodeRedeemLogs.source,
        songId: cardCodeRedeemLogs.songId,
        songTitle: songs.title,
        songArtist: songs.artist
      })
      .from(cardCodeRedeemLogs)
      .leftJoin(songs, eq(cardCodeRedeemLogs.songId, songs.id))
      .where(eq(cardCodeRedeemLogs.cardCodeId, cardCode.id))
      .orderBy(desc(cardCodeRedeemLogs.redeemedAt), desc(cardCodeRedeemLogs.id))
      .limit(1)

    return {
      success: true,
      data: {
        code: cardCode.code,
        status: cardCode.status,
        note: cardCode.note,
        createdAt: cardCode.createdAt,
        createdAtText: formatDateTime(cardCode.createdAt),
        updatedAt: cardCode.updatedAt,
        updatedAtText: formatDateTime(cardCode.updatedAt),
        assignedAt: cardCode.assignedAt,
        assignedAtText: cardCode.assignedAt ? formatDateTime(cardCode.assignedAt) : null,
        redeemedAt: cardCode.redeemedAt,
        redeemedAtText: cardCode.redeemedAt ? formatDateTime(cardCode.redeemedAt) : null,
        assignment: assignment
          ? {
              status: assignment.status,
              assignedAt: assignment.assignedAt,
              assignedAtText: formatDateTime(assignment.assignedAt),
              usedAt: assignment.usedAt,
              usedAtText: assignment.usedAt ? formatDateTime(assignment.usedAt) : null,
              recycledAt: assignment.recycledAt,
              recycledAtText: assignment.recycledAt ? formatDateTime(assignment.recycledAt) : null,
              recycleReason: assignment.recycleReason,
              failureReason: assignment.failureReason
            }
          : null,
        redeem: redeem
          ? {
              redeemedAt: redeem.redeemedAt,
              redeemedAtText: formatDateTime(redeem.redeemedAt),
              source: redeem.source,
              songId: redeem.songId,
              songTitle: redeem.songTitle,
              songArtist: redeem.songArtist
            }
          : null
      }
    }
  } catch (err: any) {
    if (err.statusCode) throw err
    console.error('开放API查询点歌券状态失败', err)
    throw createError({ statusCode: 500, message: '查询点歌券状态失败' })
  }
})
