import { createTools } from '../health/tools.mjs'
import { resolveConfig } from '../health/config.mjs'

// 直接相对导入（合并后 dsh_health 工具已在同包内），不再跨插件 require.resolve。
async function runHealth(action, overrides = {}) {
  const config = resolveConfig({}, overrides)
  const tools = createTools(config)
  return tools.execute({ action })
}

export const healthActions = [
  {
    id: 'dsh-health:check',
    group: 'health',
    title: 'DSH 健康体检',
    description: '检查僵尸 Run、技能页 busy、账本体积、CPU、GUI 端口等，输出健康报告。',
    icon: '🩺',
    danger: false,
    kind: 'report',
    handler: async () => runHealth('check'),
  },
  {
    id: 'dsh-health:reclaim',
    group: 'health',
    title: '回收僵尸 Run',
    description: '把盘上 status=running 且已超时的僵尸 run 落成 interrupted，解除技能页 busy 卡死。',
    icon: '🧹',
    danger: true,
    kind: 'report',
    handler: async () => runHealth('reclaim'),
  },
]
