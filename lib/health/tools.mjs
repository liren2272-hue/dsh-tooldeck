import { collectHealth, formatReport, healthSummaryPath } from './report.mjs'
import { resolveConfig } from './config.mjs'

export const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    ok: { type: 'boolean' },
    kind: { type: 'string' },
    data: { type: ['object', 'null'] },
  },
  required: ['text', 'ok', 'kind'],
  additionalProperties: false,
}

export function renderText(_args, value) {
  return [{ type: 'text', text: String(value?.text ?? '') }]
}

/**
 * 注册单个工具 dsh_health。
 * 工具默认只读（action=check）；只有显式 action=reclaim 才写盘（回收僵尸 run）。
 * 执行失败绝不抛：兜底 {ok:false, kind:'error', text}。
 */
export function createTools(pluginConfig) {
  const tool = {
    name: 'dsh_health',
    description: 'DSH 一键健康体检：技能账本（evals/ledger 体积、僵尸 run、drafting 卡死、busy 门控）、' +
      '宿主 CPU 增量采样、evolution 开关、接线与升级回归、GUI 端口多开、重启速率。' +
      'action=check 只读；action=reclaim 把「盘上 running 且已超时」的僵尸 run 落成 interrupted（写 ~/.mnemon/skills/evals.json）。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['check', 'reclaim'] },
        sampleMs: { type: 'number', description: 'CPU 增量采样窗口毫秒，默认 3000' },
        guiPort: { type: 'number', description: '显式指定 GUI 端口（默认自动探测）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: { schema: OUTPUT_SCHEMA, render: renderText },
    async execute(args = {}, _exec) {
      const config = resolveConfig(pluginConfig, {})
      try {
        const action = args?.action === 'reclaim' ? 'reclaim' : 'check'
        const report = await collectHealth(config, {
          reclaim: action === 'reclaim',
          sampleMs: typeof args?.sampleMs === 'number' && args.sampleMs > 0 ? args.sampleMs : 3000,
          portOverride: typeof args?.guiPort === 'number' && args.guiPort > 0 ? args.guiPort : undefined,
        })
        const text = formatReport(report)
        return {
          ok: true,
          kind: 'report',
          text,
          data: {
            verdict: report.verdict,
            bad: report.bad,
            warn: report.warn,
            busy: report.busy,
            guiPort: report.guiPort,
            reclaim: report.reclaim,
          },
        }
      } catch (error) {
        return { ok: false, kind: 'error', text: `dsh_health 执行失败：${String(error?.message ?? error)}`, data: null }
      }
    },
  }
  return tool
}
