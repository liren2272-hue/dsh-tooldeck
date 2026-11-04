import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const execFileAsync = promisify(execFile)

// 解析真实 PowerShell 路径。注意：COMSPEC 指向 cmd.exe，绝不能用作 powershell 解释器。
function resolvePowershell() {
  const candidates = [
    'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'C:\\Windows\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe',
  ]
  for (const c of candidates) {
    try { if (existsSync(c)) return c } catch {}
  }
  return 'powershell.exe' // 退回 PATH（极少触发）
}
const POWERSHELL = resolvePowershell()

/** 所有 PowerShell 探测统一走这里：脚本用 -Command，单引号包裹，绝不内联变量展开。 */
async function ps(script, timeoutMs = 15000) {
  const { stdout } = await execFileAsync(
    POWERSHELL,
    ['-NoProfile', '-NonInteractive', '-Command', script],
    { windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
  )
  return stdout
}

export async function listProcesses() {
  const out = await ps(
    "Get-Process | Select-Object Id,ProcessName,CPU | ForEach-Object { \"$($_.Id)`t$($_.ProcessName)`t$($_.CPU)\" }",
  )
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [id, name, cpu] = line.split('\t')
      return { id: Number(id), name, cpu: Number(cpu) || 0 }
    })
}

export async function listListeners() {
  const out = await ps(
    "Get-NetTCPConnection -State Listen | Select-Object LocalPort,LocalAddress,OwningProcess | ForEach-Object { \"$($_.LocalPort)`t$($_.LocalAddress)`t$($_.OwningProcess)\" }",
  )
  return out
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localPort, localAddress, owningProcess] = line.split('\t')
      return { localPort: Number(localPort), localAddress, owningProcess: Number(owningProcess) }
    })
}

export async function sampleCpuDelta(pid, sampleMs = 3000) {
  const before = await ps(
    `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){$p.CPU}`,
  )
  const b = Number(before.trim()) || 0
  await new Promise((r) => setTimeout(r, sampleMs))
  const after = await ps(
    `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($p){$p.CPU}`,
  )
  const a = Number(after.trim()) || 0
  const cores = require('node:os').cpus().length || 1
  const deltaPct = ((a - b) / (sampleMs / 1000)) / cores * 100
  return { deltaPct: Math.max(0, deltaPct), error: null }
}

export function countConnections(port) {
  if (!port) return 0
  try {
    const out = require('node:child_process').execFileSync(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-Command',
        `(@(Get-NetTCPConnection -State Established | Where-Object { $_.LocalPort -eq ${port} })).Count`],
      { windowsHide: true, timeout: 10000, encoding: 'utf8' },
    )
    return Number(out.trim()) || 0
  } catch {
    return 0
  }
}

export async function probeHttp(port, path = '/') {
  if (!port) return { ok: false, status: 0, error: 'no port' }
  try {
    const out = await ps(
      `(Invoke-WebRequest -Uri \"http://127.0.0.1:${port}${path}\" -TimeoutSec 3 -UseBasicParsing -ErrorAction SilentlyContinue).StatusCode`,
    )
    const status = Number(out.trim())
    return { ok: status > 0 && status < 400, status, error: null }
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message ?? error) }
  }
}

export function readEvolutionFlag(profileDir) {
  const flagFile = join(profileDir, 'evolution.flag')
  try {
    if (!existsSync(flagFile)) return { flag: false, error: null }
    const text = readFileSync(flagFile, 'utf8').trim()
    return { flag: text === '1' || text.toLowerCase() === 'true', error: null }
  } catch (error) {
    return { flag: null, error: String(error?.message ?? error) }
  }
}

export function readPluginWiring(profileDir) {
  try {
    const pkgPath = join(profileDir, 'package.json')
    if (!existsSync(pkgPath)) return { ok: false, error: 'package.json missing' }
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    const bundles = pkg?.dsh?.profile?.bundles ?? []
    const ok = bundles.includes('@local/dsh-tooldeck')
    return { ok, bundles, error: null }
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) }
  }
}

export function countRestarts(profileDir) {
  try {
    const logDir = join(profileDir, 'logs')
    if (!existsSync(logDir)) return { perHour: 0, windowH: 0, error: 'logs missing' }
    const files = readdirSync(logDir)
      .filter((f) => /\.log$/i.test(f))
      .map((f) => {
        try { return { f, mtime: statSync(join(logDir, f)).mtimeMs } } catch { return null }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtime - b.mtime)
    if (files.length < 2) return { perHour: 0, windowH: 0, error: null }
    const spanMs = files[files.length - 1].mtime - files[0].mtime
    const windowH = spanMs / 3600000
    return { perHour: windowH > 0 ? files.length / windowH : 0, windowH, error: null }
  } catch (error) {
    return { perHour: 0, windowH: 0, error: String(error?.message ?? error) }
  }
}

export function countSessionDirs(profileDir) {
  try {
    const sessionsDir = join(profileDir, 'sessions')
    if (!existsSync(sessionsDir)) return { count: 0, error: null }
    const count = readdirSync(sessionsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).length
    return { count, error: null }
  } catch (error) {
    return { count: 0, error: String(error?.message ?? error) }
  }
}
