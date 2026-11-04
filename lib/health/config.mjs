import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PLUGIN_VERSION = '0.1.0'
export const OVERRIDE_FILE = join(homedir(), '.dsh-health', 'config.json')

export const DEFAULTS = {
  skillsDir: join(homedir(), '.mnemon', 'skills'),
  profileDir: join(homedir(), '.dsh', 'profiles', 'desktop'),
  guiPort: 0,
  staleRunMs: 45 * 60 * 1000,
  startupDelayMs: 20 * 1000,
  sweepIntervalMs: 6 * 60 * 60 * 1000,
  autoReclaim: true,
  casSkewMs: 250,
}

function numberOf(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

function readOverrideFile() {
  try {
    if (!existsSync(OVERRIDE_FILE)) return {}
    const parsed = JSON.parse(readFileSync(OVERRIDE_FILE, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 配置三层：DEFAULTS ← ~/.dsh-health/config.json ← 插件 config ← 显式 overrides。
 * 任何一层坏掉都只回落默认，绝不抛 —— 插件加载阶段抛错会打死宿主。
 */
export function resolveConfig(config = {}, overrides = {}) {
  const merged = { ...DEFAULTS, ...readOverrideFile(), ...(config ?? {}), ...(overrides ?? {}) }
  for (const key of ['staleRunMs', 'startupDelayMs', 'sweepIntervalMs', 'casSkewMs', 'guiPort']) {
    merged[key] = numberOf(merged[key], DEFAULTS[key])
  }
  merged.autoReclaim = merged.autoReclaim !== false
  if (typeof merged.skillsDir !== 'string' || merged.skillsDir.length === 0) merged.skillsDir = DEFAULTS.skillsDir
  if (typeof merged.profileDir !== 'string' || merged.profileDir.length === 0) merged.profileDir = DEFAULTS.profileDir
  return merged
}
