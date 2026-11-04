import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const RECLAIM_ERROR =
  'run interrupted: the Host restarted while it was running (reconciled by dsh-health)'

/** 客户端显示层的 stale 折叠逻辑（与 dsh-mnemon 的 staleRun 同式）：running 且超时 → interrupted。 */
export function staleRun(run, nowMs, staleMs) {
  if (!run || run.status !== 'running') return run
  const started = Date.parse(run.startedAt ?? '')
  if (!Number.isFinite(started)) return { ...run, status: 'interrupted' }
  return nowMs - started > staleMs ? { ...run, status: 'interrupted' } : run
}

/** 显示口径下仍 running 的 run id 列表（决定 busy）。 */
export function staleRunningIds(runs, nowMs, staleMs) {
  const list = Array.isArray(runs) ? runs : []
  return list.filter((r) => staleRun(r, nowMs, staleMs)?.status === 'running').map((r) => r?.id).filter(Boolean)
}

function readJson(file) {
  try {
    if (!existsSync(file)) return { missing: true, error: null, stat: null, value: null }
    const stat = statSync(file)
    const text = readFileSync(file, 'utf8')
    let value = null
    try { value = JSON.parse(text) } catch (error) { return { missing: false, error, stat, value: null } }
    return { missing: false, error: null, stat, value }
  } catch (error) {
    return { missing: false, error, stat: null, value: null }
  }
}

/**
 * 读 ~/.mnemon/skills 的 evals.json + ledger.json。
 * 关键口径（m01128 修复）：
 *  - runs.staleRunning：显示层折叠后仍 running 的数量（决定技能页 busy）
 *  - runs.stale：盘上 status=running 且已超时、需要落成终态的僵尸数（驱动 reclaim / 体检 finding#1）
 */
export function readSkillLedgers(skillsDir, { staleMs, now = Date.now() } = {}) {
  const out = {
    evals: { missing: true, error: null, bytes: 0, mtimeMs: 0 },
    ledger: { missing: true, error: null, bytes: 0, mtimeMs: 0 },
    runs: { total: 0, raw: {}, display: {}, staleRunning: 0, stale: 0, oldestRunningAgeMs: 0, drafting: 0, suggestions: 0 },
    generation: null,
    runsRunning: 0,
    busy: false,
  }
  const evalsFile = join(skillsDir, 'evals.json')
  const ledgerFile = join(skillsDir, 'ledger.json')
  const e = readJson(evalsFile)
  if (!e.missing) {
    out.evals = { missing: false, error: e.error ? String(e.error?.message ?? e.error) : null, bytes: e.stat?.size ?? 0, mtimeMs: e.stat?.mtimeMs ?? 0 }
    const runs = Array.isArray(e.value?.runs) ? e.value.runs : []
    const raw = {}
    const display = {}
    let runningDisplayed = 0
    let staleCount = 0
    let oldest = 0
    for (const run of runs) {
      const from = run?.status ?? '?'
      const to = staleRun(run, now, staleMs)?.status ?? '?'
      raw[from] = (raw[from] ?? 0) + 1
      display[to] = (display[to] ?? 0) + 1
      if (run?.status === 'running') {
        if (to === 'running') runningDisplayed += 1
        else staleCount += 1
        const started = Date.parse(run?.startedAt ?? '')
        if (Number.isFinite(started)) oldest = Math.max(oldest, now - started)
      }
    }
    out.runs.total = runs.length
    out.runs.raw = raw
    out.runs.display = display
    out.runs.staleRunning = runningDisplayed
    out.runs.stale = staleCount
    out.runs.oldestRunningAgeMs = oldest
    out.runsRunning = runningDisplayed
    out.generation = e.value?.generation ?? null
  }
  const l = readJson(ledgerFile)
  if (!l.missing) {
    out.ledger = { missing: false, error: l.error ? String(l.error?.message ?? l.error) : null, bytes: l.stat?.size ?? 0, mtimeMs: l.stat?.mtimeMs ?? 0 }
    const suggestions = Array.isArray(l.value?.suggestions) ? l.value.suggestions : []
    out.runs.drafting = suggestions.filter((s) => s?.status === 'drafting').length
    out.runs.suggestions = suggestions.length
  }
  out.busy = out.runsRunning > 0 || out.runs.drafting > 0
  return out
}

/**
 * 把「盘上 running 且已超时」的 run 落成 interrupted（只改 status/finishedAt/error 三字段，
 * 不剪 run / 不剪 case —— 刻意绕开上游 saveEvals 的剪枝语义）。
 * 写盘前二次 statSync：mtimeMs 或 size 任一与读取时不同（别的进程刚写过）→ 放弃。
 * 文本用 `JSON.stringify(evals,null,2)+'\n'`（pretty JSON，与上游同式）。
 */
export function reclaimStaleRuns(skillsDir, { staleMs, now = Date.now(), dryRun = false, beforeCas } = {}) {
  const evalsFile = join(skillsDir, 'evals.json')
  const e = readJson(evalsFile)
  if (e.missing) return { settled: 0, totalRunning: 0, wrote: false, aborted: null, error: 'evals.json missing' }
  if (e.error) return { settled: 0, totalRunning: 0, wrote: false, aborted: null, error: `evals.json unreadable: ${e.error}` }
  const runs = Array.isArray(e.value?.runs) ? e.value.runs : []
  const targets = []
  let totalRunning = 0
  for (const run of runs) {
    if (run?.status !== 'running') continue
    totalRunning += 1
    if (staleRun(run, now, staleMs)?.status !== 'running') targets.push(run)
  }
  if (targets.length === 0) return { settled: 0, totalRunning, wrote: false, aborted: null, error: null }
  if (dryRun) return { settled: targets.length, totalRunning, wrote: false, aborted: null, error: null }

  if (beforeCas) {
    const verdict = beforeCas({ evalsFile })
    if (verdict?.aborted) return { settled: 0, totalRunning, wrote: false, aborted: verdict.reason ?? 'concurrent change detected', error: null }
  }

  // 写盘前二次 stat（CAS 放弃）
  try {
    const cur = statSync(evalsFile)
    if (cur.mtimeMs !== e.stat.mtimeMs || cur.size !== e.stat.size) {
      return { settled: 0, totalRunning, wrote: false, aborted: `evals.json changed concurrently (mtime/size differ)`, error: null }
    }
  } catch (error) {
    return { settled: 0, totalRunning, wrote: false, aborted: null, error: `re-stat failed: ${String(error?.message ?? error)}` }
  }

  const targetIds = new Set(targets.map((r) => r.id))
  const nextRuns = runs.map((run) =>
    targetIds.has(run.id) && run.status === 'running'
      ? { ...run, status: 'interrupted', finishedAt: new Date(now).toISOString(), error: RECLAIM_ERROR }
      : run,
  )
  const next = { ...e.value, runs: nextRuns }
  const text = `${JSON.stringify(next, null, 2)}\n`
  const tmp = `${evalsFile}.dsh-health.tmp`
  try {
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, evalsFile)
    return { settled: targets.length, totalRunning, wrote: true, aborted: null, error: null, bytes: Buffer.byteLength(text) }
  } catch (error) {
    try { rmSync(tmp, { force: true }) } catch {}
    return { settled: 0, totalRunning, wrote: false, aborted: null, error: `write failed: ${String(error?.message ?? error)}` }
  }
}

/** 账本目录足迹：文件大小 / 子目录文件数与字节。全部 try/catch，读不到就缺省。 */
export function ledgerFootprint(skillsDir) {
  const out = { files: {}, dirs: {} }
  for (const name of ['evals.json', 'ledger.json', 'preferences.json']) {
    try {
      const stat = statSync(join(skillsDir, name))
      out.files[name] = { bytes: stat.size, mtimeMs: stat.mtimeMs }
    } catch {}
  }
  for (const name of ['trajectories', 'versions', 'staging']) {
    const dir = join(skillsDir, name)
    try {
      let files = 0
      let bytes = 0
      walkFiles(dir, (p) => {
        try { const s = statSync(p); if (s.isFile()) { files += 1; bytes += s.size } } catch {}
      })
      out.dirs[name] = { files, bytes }
    } catch {
      out.dirs[name] = { files: 0, bytes: 0 }
    }
  }
  return out
}

function walkFiles(dir, onFile) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) walkFiles(p, onFile)
    else onFile(p)
  }
}
