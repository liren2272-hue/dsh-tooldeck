/**
 * dsh-tooldeck —— 可扩展的「工具台」面板插件（宿主侧）。
 *
 * 职责：
 *  - 在 webServer 注册一条 POST /api/dsh-tooldeck/run 路由：body = { action, params }，
 *    派发到动作注册表（见 lib/actions/registry.mjs），返回 `{ ok, text, data }` JSON。
 *  - 注册一条 GET /api/dsh-tooldeck/actions：把当前已注册动作的轻量描述回给卡片，
 *    卡片据此动态渲染按钮（新增动作 = 挂一条记录，卡片零改动）。
 *  - 暴露 `ctx.tooldeck.register(action)` provider，让其它插件运行时注入自己的动作，
 *    实现用户要的「接入其他功能」扩展点（不写死、不重启注册表）。
 *
 * 零依赖 @deepseek-ai/*：只用 node: 内置模块 + 标准 fetch。所有异步挂 .catch，
 * 任何异常都不外泄到宿主进程。
 */

import { registry } from './actions/registry.mjs'
import { installHealth } from './health/installHealth.mjs'

export const name = 'dsh-tooldeck'
export const inject = ['webServer', 'tools']

function logger(ctx) {
  const log = typeof ctx?.get === 'function' ? ctx.get('logger') : undefined
  return {
    info: (...args) => log?.info?.(...args),
    warn: (...args) => log?.warn?.(...args),
  }
}

function writeJson(response, status, body) {
  const payload = JSON.stringify(body)
  try {
    response.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    })
    response.end(payload)
  } catch {
    /* 连接已断开，忽略 */
  }
}

async function readBody(request) {
  const chunks = []
  try {
    for await (const chunk of request) chunks.push(chunk)
  } catch {
    return Buffer.alloc(0)
  }
  return Buffer.concat(chunks)
}

async function safeJson(request) {
  try {
    const raw = await readBody(request)
    if (raw.length === 0) return {}
    return JSON.parse(raw.toString('utf8'))
  } catch {
    return null
  }
}

export async function apply(ctx, _config = {}) {
  const log = logger(ctx)

  // 并入原 dsh-health 宿主逻辑：注册 dsh_health 工具 + 后台回收僵尸 run 定时器。
  // _config.health 透传 health 子配置（autoReclaim / staleRunMs / sweepIntervalMs 等）。
  try {
    const r = installHealth(ctx, _config?.health ?? {})
    log.info?.(`[dsh-tooldeck] health 模块已接入：${r.installed ? 'dsh_health 已注册' : '工具注册表不可用、仅定时回收'}`)
  } catch (error) {
    log.warn?.(`[dsh-tooldeck] health 模块接入失败：${String(error?.message ?? error)}`)
  }

  // 自举内置动作（dsh-health:check / dsh-health:reclaim）。失败不致命。
  try {
    await registry.bootstrapBuiltins()
    log.info?.(`[dsh-tooldeck] 已注册 ${registry.size} 个内置动作`)
  } catch (error) {
    log.warn?.(`[dsh-tooldeck] 内置动作自举失败：${String(error?.message ?? error)}`)
  }

  // 暴露扩展点：其它插件可运行时注入动作。
  try {
    if (typeof ctx.provide === 'function') {
      ctx.provide('tooldeck', {
        register: (action) => registry.register(action),
        list: () => registry.list(),
        run: (id, params) => registry.run(id, params),
      })
      log.info?.('[dsh-tooldeck] 已暴露 ctx.tooldeck 扩展点')
    } else {
      log.warn?.('[dsh-tooldeck] ctx.provide 不可用，运行时动作注入被禁用（内置动作仍可用）')
    }
  } catch (error) {
    log.warn?.(`[dsh-tooldeck] 暴露扩展点失败：${String(error?.message ?? error)}`)
  }

  // Host 侧 HTTP 路由。
  ctx.inject(['webServer'], (webCtx) => {
    const register = (path, handler) => {
      try {
        webCtx.webServer.register({ kind: 'exact', path, handler })
      } catch (error) {
        log.warn?.(`[dsh-tooldeck] 路由注册失败 ${path}：${String(error?.message ?? error)}`)
      }
    }

    // 动作清单（卡片拉取后动态渲染按钮）。
    register('/api/dsh-tooldeck/actions', async (_request, response) => {
      try {
        writeJson(response, 200, { actions: registry.list() })
      } catch (error) {
        writeJson(response, 500, { error: String(error?.message ?? error) })
      }
    })

    // 执行一条动作。
    register('/api/dsh-tooldeck/run', async (request, response) => {
      if (request.method !== 'POST') {
        writeJson(response, 405, { ok: false, text: 'method_not_allowed' })
        return
      }
      const body = await safeJson(request)
      if (body === null || typeof body !== 'object' || typeof body.action !== 'string') {
        writeJson(response, 400, { ok: false, text: '请求体须为 { action: string, params?: object }' })
        return
      }
      try {
        const result = await registry.run(body.action, body.params ?? {})
        writeJson(response, 200, result)
      } catch (error) {
        writeJson(response, 500, { ok: false, text: `执行失败：${String(error?.message ?? error)}` })
      }
    })
  })

  log.info?.('[dsh-tooldeck] 面板路由已挂载：/api/dsh-tooldeck/actions、/api/dsh-tooldeck/run')
}
