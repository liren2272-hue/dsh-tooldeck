/**
 * 工具台动作注册表（宿主侧，零依赖 @deepseek-ai/*）。
 *
 * 设计目标（用户核心要求：扩展性）：
 *  - 动作是「可插拔注册表」，不是写死的几个按钮。新增功能 = 挂一条 action，
 *    卡片零改动（从 GET /api/dsh-tooldeck/actions 拉列表自动渲染）。
 *  - 内置动作从 `./actions/*` 自举；运行时还接受别的插件经
 *    `ctx.tooldeck.register(action)` 注入（见 lib/index.mjs 的 provider）。
 *  - 每个 action 形态约定：`{ id, title, description, icon?, danger?, kind?, handler(params) }`
 *    handler 返回 `{ ok, text, data? }`，绝不抛（插件加载/运行阶段抛错会打死宿主）。
 */

const actions = new Map()
let registryReady = false

function register(action) {
  if (!action || typeof action.id !== 'string' || action.id.length === 0) return false
  if (typeof action.handler !== 'function') return false
  actions.set(action.id, {
    id: action.id,
    title: typeof action.title === 'string' ? action.title : action.id,
    description: typeof action.description === 'string' ? action.description : '',
    icon: typeof action.icon === 'string' ? action.icon : '',
    danger: action.danger === true,
    kind: typeof action.kind === 'string' ? action.kind : 'generic',
    group: typeof action.group === 'string' ? action.group : 'general',
    handler: action.handler,
  })
  return true
}

/** 仅导出「卡片要渲染的轻量描述」，绝不泄露 handler。 */
function list() {
  return [...actions.values()].map((action) => ({
    id: action.id,
    title: action.title,
    description: action.description,
    icon: action.icon,
    danger: action.danger === true,
    kind: action.kind,
    group: action.group,
  }))
}

/** 执行一条动作；返回 `{ ok, text, data? }`。handler 抛错被兜成 ok:false。 */
async function run(id, params = {}) {
  const action = actions.get(id)
  if (action === undefined) return { ok: false, text: `未知动作：${String(id)}`, data: null }
  try {
    const result = await action.handler(params)
    if (result && typeof result === 'object' && 'ok' in result) return result
    return { ok: true, text: String(result?.text ?? ''), data: result?.data ?? null }
  } catch (error) {
    return { ok: false, text: `动作 ${id} 执行失败：${String(error?.message ?? error)}`, data: null }
  }
}

/**
 * 自举内置动作。用静态 import 而非 readdir 动态加载，保证 tree-shake 友好、
 * node --check 能逐个覆盖，也无需自己写 ESM 扫描器。
 */
async function bootstrapBuiltins() {
  if (registryReady) return
  const [{ healthActions }, { workspaceActions }] = await Promise.all([import('./health.mjs'), import('./workspace.mjs')])
  for (const action of healthActions) register(action)
  for (const action of workspaceActions) register(action)
  registryReady = true
}

export const registry = {
  register,
  list,
  run,
  bootstrapBuiltins,
  get size() {
    return actions.size
  },
}
