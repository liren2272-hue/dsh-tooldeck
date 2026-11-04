import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { readSkillLedgers, reclaimStaleRuns, ledgerFootprint, RECLAIM_ERROR } from './ledger.mjs'
import {
  listProcesses,
  listListeners,
  sampleCpuDelta,
  countConnections,
  probeHttp,
  readEvolutionFlag,
  readPluginWiring,
  countRestarts,
  countSessionDirs,
} from './probe.mjs'

export const THRESHOLDS = {
  evalsBytes: 5 * 1024 * 1024, // 5MiB
  ledgerBytes: 5 * 1024 * 1024,
  busyStaleRunning: 1, // 任何仍在 running 的僵尸 → bad
  guiMultiOpen: 2, // GUI 端口多开 ≥2 视为异常（正常应恰好 1）
  restartsPerHour: 6,
}

const FINDINGS = {
  zombieRuns: { title: '僵尸 Run（技能页 busy 根因）', weight: 'bad', check: (r) => r.runs.stale > 0 },
  busyFlag: { title: '技能页 busy 锁定', weight: 'bad', check: (r) => r.busy && r.runs.staleRunning > 0 },
  evalsBloat: { title: 'evals.json 体积', weight: 'warn', check: (r) => r.evals.bytes > THRESHOLDS.evalsBytes },
  ledgerBloat: { title: 'ledger.json 体积', weight: 'warn', check: (r) => r.ledger.bytes > THRESHOLDS.ledgerBytes },
  staleDrafting: { title: 'ledger 建议卡 drafting', weight: 'warn', check: (r) => r.runs.drafting > 0 },
  cpuHigh: { title: '宿主 CPU（增量采样）', weight: 'warn', check: (r) => r.cpu.deltaPct >= 10 },
  evolutionOn: { title: 'evolution 实验开关', weight: 'warn', check: (r) => r.evolution.flag === true },
  guiMultiOpen: { title: 'GUI 端口多开', weight: 'warn', check: (r) => r.gui.ports.length >= THRESHOLDS.guiMultiOpen },
  restartsHigh: { title: '宿主重启频率', weight: 'warn', check: (r) => r.restarts.perHour >= THRESHOLDS.restartsPerHour },
  wiringOk: { title: '插件接线', weight: 'warn', check: (r) => !r.wiring.ok },
  sessionDirs: { title: '会话目录数', weight: 'info', check: () => false },
}

let cachedSummaryPath = null
export function healthSummaryPath() {
  if (cachedSummaryPath) return cachedSummaryPath
  cachedSummaryPath = join(homedir(), '.dsh-health', 'report.txt')
  return cachedSummaryPath
}

/**
 * 纯函数体检（不写盘，reclaim=false）。失败项也进 findings.bad，绝不抛。
 */
export async function collectHealth(config, { reclaim = false, sampleMs = 3000, portOverride } = {}) {
  const now = Date.now()
  const findings = {}
  const bad = []
  const warn = []
  let busy = false

  // ① 技能账本
  const led = readSkillLedgers(config.skillsDir, { staleMs: config.staleRunMs, now })
  findings.zombieRuns = {
    title: FINDINGS.zombieRuns.title,
    weight: 'bad',
    detail: led.runs.stale > 0
      ? `${led.runs.stale} 个僵尸 run（盘上 running 且已超时 ${Math.round(config.staleRunMs / 60000)} 分钟）`
      : '无僵尸 run',
    hit: led.runs.stale > 0,
  }
  if (led.runs.stale > 0) bad.push(findings.zombieRuns)

  findings.busyFlag = {
    title: FINDINGS.busyFlag.title,
    weight: 'bad',
    detail: led.busy && led.runs.staleRunning > 0
      ? `busy 锁定：${led.runs.staleRunning} 个 run 仍显示 running（僵尸 ${led.runs.stale}）`
      : `busy=${led.busy}（staleRunning=${led.runs.staleRunning}）`,
    hit: led.busy && led.runs.staleRunning > 0,
  }
  if (findings.busyFlag.hit) bad.push(findings.busyFlag)
  busy = led.busy || led.runs.stale > 0

  findings.evalsBloat = {
    title: FINDINGS.evalsBloat.title,
    weight: 'warn',
    detail: `${(led.evals.bytes / 1024 / 1024).toFixed(2)} MiB`,
    hit: led.evals.bytes > THRESHOLDS.evalsBytes,
  }
  if (findings.evalsBloat.hit) warn.push(findings.evalsBloat)

  findings.ledgerBloat = {
    title: FINDINGS.ledgerBloat.title,
    weight: 'warn',
    detail: `${(led.ledger.bytes / 1024 / 1024).toFixed(2)} MiB`,
    hit: led.ledger.bytes > THRESHOLDS.ledgerBytes,
  }
  if (findings.ledgerBloat.hit) warn.push(findings.ledgerBloat)

  findings.staleDrafting = {
    title: FINDINGS.staleDrafting.title,
    weight: 'warn',
    detail: `${led.runs.drafting} 条建议卡 drafting（共 ${led.runs.suggestions} 条）`,
    hit: led.runs.drafting > 0,
  }
  if (findings.staleDrafting.hit) warn.push(findings.staleDrafting)

  // ② CPU 增量采样（PowerShell）
  let cpu = { deltaPct: 0, error: null }
  try {
    const procs = await listProcesses()
    const pid = pickHostPid(procs)
    if (pid) cpu = await sampleCpuDelta(pid, sampleMs)
  } catch (error) {
    cpu = { deltaPct: 0, error: String(error?.message ?? error) }
  }
  findings.cpuHigh = {
    title: FINDINGS.cpuHigh.title,
    weight: 'warn',
    detail: cpu.error ? `采样失败：${cpu.error}` : `Δ ${cpu.deltaPct.toFixed(1)}% / ${sampleMs}ms`,
    hit: !cpu.error && cpu.deltaPct >= 10,
  }
  if (findings.cpuHigh.hit) warn.push(findings.cpuHigh)

  // ③ evolution 开关
  const evo = readEvolutionFlag(config.profileDir)
  findings.evolutionOn = {
    title: FINDINGS.evolutionOn.title,
    weight: 'warn',
    detail: evo.flag === true ? '已开启（实验特性）' : evo.error ? `读取失败：${evo.error}` : '关闭',
    hit: evo.flag === true,
  }
  if (findings.evolutionOn.hit) warn.push(findings.evolutionOn)

  // ④ 插件接线
  const wiring = readPluginWiring(config.profileDir)
  findings.wiringOk = {
    title: FINDINGS.wiringOk.title,
    weight: 'warn',
    detail: wiring.ok ? 'dsh-tooldeck 已接入 bundles' : wiring.error || 'dsh-tooldeck 未出现在 bundles',
    hit: !wiring.ok,
  }
  if (findings.wiringOk.hit) warn.push(findings.wiringOk)

  // ⑤ GUI 端口
  let listeners = []
  try { listeners = await listListeners() } catch (error) {
    findings.guiMultiOpen = {
      title: FINDINGS.guiMultiOpen.title,
      weight: 'warn',
      detail: `监听器探测失败：${String(error?.message ?? error)}`,
      hit: false,
    }
  }
  const guiPorts = listeners.filter((l) => l.localPort >= 50000 && l.localPort <= 59999)
  findings.guiMultiOpen = {
    title: FINDINGS.guiMultiOpen.title,
    weight: 'warn',
    detail: `探测到 ${guiPorts.length} 个 GUI 端口：${guiPorts.map((p) => p.localPort).join(', ')}`,
    hit: guiPorts.length >= THRESHOLDS.guiMultiOpen,
  }
  if (findings.guiMultiOpen.hit) warn.push(findings.guiMultiOpen)

  // ⑥ 重启频率
  const restarts = countRestarts(config.profileDir)
  findings.restartsHigh = {
    title: FINDINGS.restartsHigh.title,
    weight: 'warn',
    detail: restarts.error ? `读取失败：${restarts.error}` : `约 ${restarts.perHour.toFixed(1)} 次/小时（近 ${restarts.windowH}h）`,
    hit: !restarts.error && restarts.perHour >= THRESHOLDS.restartsPerHour,
  }
  if (findings.restartsHigh.hit) warn.push(findings.restartsHigh)

  // ⑦ 会话目录
  const sessionDirs = countSessionDirs(config.profileDir)
  findings.sessionDirs = {
    title: FINDINGS.sessionDirs.title,
    weight: 'info',
    detail: sessionDirs.error ? `读取失败：${sessionDirs.error}` : `${sessionDirs.count} 个会话目录`,
    hit: false,
  }

  // ⑧ 连接数
  let conns = 0
  try { conns = countConnections(guiPorts[0]?.localPort) } catch {}

  // ⑨ 回收（若请求）
  let reclaimResult = null
  if (reclaim) {
    reclaimResult = reclaimStaleRuns(config.skillsDir, { staleMs: config.staleRunMs, now })
  }

  const verdict = bad.length > 0 ? 'bad' : warn.length > 0 ? 'warn' : 'ok'
  const report = {
    verdict,
    bad: bad.length,
    warn: warn.length,
    busy,
    guiPort: portOverride || guiPorts[0]?.localPort || 0,
    cpu,
    evolution: evo,
    wiring,
    gui: { ports: guiPorts.map((p) => p.localPort), connections: conns },
    restarts,
    runs: led.runs,
    evals: led.evals,
    ledger: led.ledger,
    ledgerFootprint: ledgerFootprint(config.skillsDir),
    findings: Object.values(findings),
    reclaim: reclaimResult,
    generatedAt: new Date(now).toISOString(),
  }
  return report
}

function pickHostPid(procs) {
  // 优先 dsh.exe / DeepSeek Harness / electron
  const names = ['dsh.exe', 'deepseek harness.exe', 'electron.exe']
  for (const n of names) {
    const hit = procs.find((p) => (p.name || '').toLowerCase() === n.toLowerCase())
    if (hit) return hit.id
  }
  return procs[0]?.id ?? null
}

export function formatReport(report) {
  const lines = []
  lines.push(`DSH 健康体检 · ${report.generatedAt}`)
  lines.push(`判定：${report.verdict === 'bad' ? '⚠ 异常' : report.verdict === 'warn' ? '△ 注意' : '✓ 正常'}`)
  lines.push(`bad=${report.bad} warn=${report.warn} busy=${report.busy}`)
  lines.push('')
  for (const f of report.findings) {
    const tag = f.weight === 'bad' ? 'BAD ' : f.weight === 'warn' ? 'WARN ' : 'INFO '
    lines.push(`[${tag}] ${f.title} — ${f.detail}`)
  }
  if (report.reclaim) {
    lines.push('')
    lines.push(`回收：${report.reclaim.wrote ? `已写盘，落成 ${report.reclaim.settled} 个僵尸 run` : report.reclaim.aborted ? `放弃（${report.reclaim.aborted}）` : `无需回收（${report.reclaim.settled} 个待回收）`}`)
  }
  lines.push('')
  lines.push(`CPU Δ ${report.cpu.deltaPct?.toFixed?.(1) ?? 0}% · GUI ${report.guiPort || '?'} · 会话目录 ${report.runsStaleHack ?? ''}`)
  return lines.join('\n')
}

/** 把体检报告落盘（供其它工具/公众号取用）。失败静默。 */
export function persistSummary(report) {
  try {
    const path = healthSummaryPath()
    const dir = path.replace(/[^/\\]+$/, '')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(path, formatReport(report), 'utf8')
    return { ok: true, path }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

export { RECLAIM_ERROR }
