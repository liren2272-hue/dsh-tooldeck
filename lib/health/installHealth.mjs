import { resolveConfig } from './config.mjs'
import { createTools } from './tools.mjs'
import { reclaimStaleRuns, readSkillLedgers } from './ledger.mjs'

/**
 * 把原 dsh-health 宿主逻辑（注册 dsh_health 工具 + 后台回收僵尸 run 定时器）并入 dsh-tooldeck。
 * 由 tooldeck 的 lib/index.mjs 在 apply() 内调用。
 * 保留 dsh-health 的全部行为：从 ctx 取工具注册表（绝不裸读 ctx.tools），
 * autoReclaim 时启动 startupDelay + 周期性 sweep（均 .unref，宿主退出即停）。
 */
export function installHealth(ctx, pluginConfig = {}) {
  const config = resolveConfig(pluginConfig ?? {})

  // ① 取工具注册表（三层回退，绝不裸读 ctx.tools）
  let registry = null
  try {
    const reflect = ctx.reflect || ctx.get?.('reflect')
    if (reflect?.get) {
      for (const arg of [false, 'tools', undefined]) {
        try {
          const r = reflect.get('tools', arg)
          if (r && typeof r.register === 'function') { registry = r; break }
        } catch {}
      }
    }
    if (!registry && typeof ctx.get === 'function') {
      const r = ctx.get('tools')
      if (r && typeof r.register === 'function') registry = r
    }
  } catch {}

  if (registry && typeof registry.register === 'function') {
    try {
      registry.register(createTools(config))
    } catch (error) {
      ctx.get?.('logger')?.warn?.('[dsh-tooldeck:health] register dsh_health failed:', error)
    }
  } else {
    ctx.get?.('logger')?.warn?.('[dsh-tooldeck:health] tools registry unavailable; dsh_health not registered')
  }

  // ② 后台回收（与 dsh-health 同式：startupDelay 后首次，周期 sweep；均 unref）
  if (config.autoReclaim) {
    const runReclaim = () => {
      try {
        const res = reclaimStaleRuns(config.skillsDir, { staleMs: config.staleRunMs, now: Date.now() })
        if (res.wrote) {
          ctx.get?.('logger')?.info?.(`[dsh-tooldeck:health] reclaimed ${res.settled} zombie run(s)`)
        } else if (res.aborted) {
          ctx.get?.('logger')?.warn?.(`[dsh-tooldeck:health] reclaim skipped: ${res.aborted}`)
        }
      } catch (error) {
        ctx.get?.('logger')?.warn?.('[dsh-tooldeck:health] reclaim error:', error)
      }
    }
    const startup = setTimeout(() => {
      runReclaim()
      sweep = setInterval(runReclaim, config.sweepIntervalMs)
      if (sweep?.unref) sweep.unref()
    }, config.startupDelayMs)
    if (startup?.unref) startup.unref()
    let sweep = null

    const cleanup = () => {
      try { clearTimeout(startup) } catch {}
      try { if (sweep) clearInterval(sweep) } catch {}
    }
    try {
      if (typeof ctx.effect === 'function') ctx.effect(cleanup, 'dsh-tooldeck.health.timers')
      else if (typeof ctx.dispose === 'function') ctx.dispose(cleanup)
    } catch {}
  }

  return { config, installed: Boolean(registry) }
}

export { resolveConfig, createTools, reclaimStaleRuns, readSkillLedgers }
