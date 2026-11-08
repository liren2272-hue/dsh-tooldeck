/**
 * 工作区整理动作（大类：workspace）。
 *
 * 目标：清除工作区里「没有正确归类」的散落文件/目录（既不能多也不能少地守住布局规则：
 * 新文件只能落在 sessions/<会话>/ 的六个归类目录里；工作区一级目录必须干净——
 * 除 sessions/ 外不应再有任何一级目录，也不允许文件直接躺在工作区根或会话目录根）。
 *
 * 两步闭环（保守可回退）：
 *  1) workspace:clean          一步「扫描 + 隔离」：列出散落文件/目录清单（含大小/时间），
 *                              并同盘改名移入 <workspace>/.quarantine/<时间戳>/，保留相对路径；
 *                              目录整体搬移，随时可原样移回，不是删除。
 *  2) workspace:purge-quarantine  清空隔离区（danger）：确认无误后物理删除。
 *  scanStrays() 仍单独导出，供程序化只读扫描（卡片按钮不再单列审计步骤）。
 *
 * 保护规则（宁可漏报不可误伤）：
 *  - 隐藏文件/目录（名字以 . 开头）一律不碰：本机工具习惯把缓存放在根目录且多为隐藏
 *    （.curate-cache.json / .bsk / .dsh / .cc-safety-net / .quarantine 等），误移会破坏别的工具。
 *  - 工作区根：一级【目录】除 sessions/ 外全部视为散落（用户明确要求：一级目录必须干净，
 *    output/assets/data/src/tmp 等归类目录只允许存在于会话目录内部）；一级【文件】照旧为散落。
 *  - sessions/ 层：只认文件；白名单 INDEX.md。会话目录（子目录）本身绝不深入扫描——
 *    只检查每个会话目录【根】上的散落文件，白名单 README.md（dsh-session-folders 生成）。
 *  - 六个归类目录名（docs/src/data/assets/output/tmp）只存在于会话目录内，与既有布局规则一致。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createCorpseActions } from './corpses.mjs'

const DEFAULT_WORKSPACE = 'D:\\DSH Workspace'
const QUARANTINE_DIR_NAME = '.quarantine'

/** 会话目录根的布局规则里的归类目录（仅作展示/校验，不用于判断散落）。 */
const CATEGORY_DIRS = ['docs', 'src', 'data', 'assets', 'output', 'tmp']

/** sessions/ 根上允许的文件。 */
const SESSIONS_ROOT_WHITELIST = new Set(['INDEX.md'])
/** 会话目录根上允许的文件。 */
const SESSION_DIR_WHITELIST = new Set(['README.md'])
/** 工作区根一级【目录】豁免名单：只有 sessions/。其余一级目录（output/assets/data/src/tmp/...）一律算散落。 */
const WORKSPACE_DIR_WHITELIST = new Set(['sessions'])

function resolveWorkspace(params = {}) {
  // 优先级：动作参数 > 插件配置（tooldeck.config.workspaceRoot）> 默认。
  const root = String(params.workspaceRoot ?? process.env.DSH_TOOLDECK_WORKSPACE ?? DEFAULT_WORKSPACE)
  return path.win32.isAbsolute(root) || path.posix.isAbsolute(root) ? root : DEFAULT_WORKSPACE
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 扫一级目录，返回其中「非隐藏普通文件」清单（name/size/mtime）。目录与隐藏项跳过。 */
function scanLevel(dir, whitelist) {
  const out = []
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue // 隐藏一律保护
    if (whitelist.has(entry.name)) continue
    let stat
    try {
      stat = fs.statSync(path.join(dir, entry.name))
    } catch {
      continue // 外层列出、内层消失（竞态）：跳过本条
    }
    if (entry.isDirectory()) continue // 目录全部保护
    if (!entry.isFile()) continue // 链接等特殊项不碰
    out.push({ name: entry.name, size: stat.size, mtime: stat.mtimeMs })
  }
  return out
}

/** 全量扫描：工作区根（文件+一级目录）+ sessions/ 根 + 每个会话目录根。只读。 */
export function scanStrays(workspaceRoot) {
  const strays = []
  const meta = { workspaceRoot, sessionsScanned: 0, errors: [] }

  // 工作区根：一级文件与一级目录都算散落（目录除 sessions/ 外；隐藏项一律保护）。
  let rootEntries = []
  try {
    rootEntries = fs.readdirSync(workspaceRoot, { withFileTypes: true })
  } catch (error) {
    meta.errors.push(`无法读取工作区根：${String(error?.message ?? error)}`)
  }
  for (const entry of rootEntries) {
    if (entry.name.startsWith('.')) continue // 隐藏一律保护
    const abs = path.join(workspaceRoot, entry.name)
    let stat
    try {
      stat = fs.statSync(abs)
    } catch {
      continue // 外层列出、内层消失（竞态）：跳过本条
    }
    if (entry.isDirectory()) {
      if (WORKSPACE_DIR_WHITELIST.has(entry.name)) continue
      let itemCount = 0
      try { itemCount = fs.readdirSync(abs).length } catch {}
      strays.push({ abs, rel: `/${entry.name}/`, scope: 'workspace-root-dir', isDir: true, itemCount, size: stat.size, mtime: stat.mtimeMs })
      continue
    }
    if (entry.isFile()) {
      strays.push({ abs, rel: `/${entry.name}`, scope: 'workspace-root', isDir: false, size: stat.size, mtime: stat.mtimeMs })
    }
  }

  const sessionsDir = path.join(workspaceRoot, 'sessions')
  let sessionEntries = []
  try {
    sessionEntries = fs.readdirSync(sessionsDir, { withFileTypes: true })
  } catch (error) {
    meta.errors.push(`无法读取 sessions/：${String(error?.message ?? error)}`)
  }

  const filesAtSessionsLevel = scanLevel(sessionsDir, SESSIONS_ROOT_WHITELIST)
  for (const f of filesAtSessionsLevel) {
    strays.push({ abs: path.join(sessionsDir, f.name), rel: `sessions/${f.name}`, scope: 'sessions-root', ...f })
  }

  for (const entry of sessionEntries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue // .meta / .trash 保护
    meta.sessionsScanned += 1
    const sessionPath = path.join(sessionsDir, entry.name)
    const sessionFiles = scanLevel(sessionPath, SESSION_DIR_WHITELIST)
    for (const f of sessionFiles) {
      strays.push({
        abs: path.join(sessionPath, f.name),
        rel: `sessions/${entry.name}/${f.name}`,
        scope: 'session-root',
        session: entry.name,
        ...f,
      })
    }
  }

  return { strays, meta }
}

function formatStrayTable(strays, meta) {
  const lines = []
  lines.push(`工作区：${meta.workspaceRoot}`)
  lines.push(`扫描会话目录：${meta.sessionsScanned} 个`)
  if (meta.errors.length > 0) lines.push(`扫描告警：${meta.errors.join('；')}`)
  if (strays.length === 0) {
    lines.push('')
    lines.push('✅ 未发现散落文件/目录，布局干净（工作区一级目录只剩 sessions/）。')
    return lines.join('\n')
  }
  const fileBytes = strays.filter((s) => !s.isDir).reduce((acc, s) => acc + (s.size ?? 0), 0)
  const dirCount = strays.filter((s) => s.isDir).length
  lines.push('')
  lines.push(`发现 ${strays.length} 个散落项（文件共 ${fmtBytes(fileBytes)}${dirCount > 0 ? `；目录 ${dirCount} 个` : ''}）：`)
  for (const s of strays) {
    const when = s.mtime ? new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ') : '?'
    if (s.isDir) lines.push(`  · [${s.scope}] ${s.rel} — 目录（${s.itemCount ?? '?'} 项），${when}`)
    else lines.push(`  · [${s.scope}] ${s.rel} — ${fmtBytes(s.size)}，${when}`)
  }
  lines.push('')
  lines.push('处理去向：以上文件/目录已（或将被）整体移入 .quarantine/，可随时原路移回；确认无误后再点「清空隔离区」才会真正删除。')
  return lines.join('\n')
}

/** 一步「扫描 + 隔离」：同盘 rename 移入 <workspace>/.quarantine/<stamp>/<原相对路径>，绝不删除。 */
export function quarantineStrays(workspaceRoot) {
  const { strays, meta } = scanStrays(workspaceRoot)
  if (strays.length === 0) {
    return { ok: true, text: '扫描完成：没有发现散落文件/目录，布局已干净。', data: { count: 0, moved: [], skipped: [], meta } }
  }
  const stamp = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14)
  const quarantineRoot = path.join(workspaceRoot, QUARANTINE_DIR_NAME, stamp)
  const moved = []
  const skipped = []
  for (const s of strays) {
    const destRel = s.rel.replace(/^\/+/, '') // workspace 根文件 rel 以 / 开头
    const dest = path.join(quarantineRoot, destRel)
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      // 目标存在则加序号，绝不覆盖。
      let final = dest
      let i = 1
      while (fs.existsSync(final)) {
        final = `${dest}.${i++}`
      }
      fs.renameSync(s.abs, final)
      moved.push({ from: s.rel, to: path.relative(workspaceRoot, final), isDir: s.isDir === true })
    } catch (error) {
      skipped.push({ file: s.rel, reason: String(error?.message ?? error) })
    }
  }
  // 一次输出 = 扫描清单（隔离前状态）+ 隔离结果，两步合并。
  const lines = [formatStrayTable(strays, meta), '', '—— 隔离结果 ——', `移动 ${moved.length} 个，跳过 ${skipped.length} 个。`, `隔离区：${path.relative(workspaceRoot, quarantineRoot)}/`]
  for (const m of moved) lines.push(`  · ${m.from}${m.isDir ? '（目录）' : ''} → ${m.to}`)
  for (const k of skipped) lines.push(`  ⚠ 跳过 ${k.file}：${k.reason}`)
  if (moved.length > 0) lines.push('', '需要找回时从 .quarantine/ 原路径移回即可；确认无误后点「清空隔离区」物理删除。')
  return { ok: skipped.length === 0, text: lines.join('\n'), data: { count: strays.length, quarantineRoot, moved, skipped, meta } }
}

/** 递归清掉只读属性：git 写的 .pack/.idx/.rev 等带 FILE_ATTRIBUTE_READONLY，rmSync 直接删会抛 EPERM。 */
function clearReadOnly(p, counts) {
  let st
  try {
    st = fs.lstatSync(p)
  } catch {
    return // 已消失（并发/已删）忽略
  }
  if (st.isSymbolicLink()) return // 不跟随软链、也不改链接目标属性
  if (st.isDirectory()) {
    let entries = []
    try {
      entries = fs.readdirSync(p)
    } catch (error) {
      // 目录本身可能只读导致无法列，先给自身加写权限再重列一次
      try {
        fs.chmodSync(p, 0o777)
        entries = fs.readdirSync(p)
      } catch {
        counts.fallback += 1
        return
      }
    }
    for (const e of entries) clearReadOnly(path.join(p, e), counts)
    try {
      if (!(st.mode & 0o222)) {
        fs.chmodSync(p, 0o777)
        counts.cleared += 1
      }
    } catch {
      counts.fallback += 1
    }
    return
  }
  // 普通文件：只读才 chmod（避免无谓改写），失败计数由调用方 rmSync 的 EPERM 重试兜底
  try {
    if (!(st.mode & 0o222)) {
      fs.chmodSync(p, 0o666)
      counts.cleared += 1
    }
  } catch {
    counts.fallback += 1
  }
}

/** 单条删除，EPERM/EACCES/EBUSY 时先清只读再重试一次。 */
function rmEntry(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true })
    return true
  } catch (error) {
    const code = error?.code
    if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') return false
    try {
      clearReadOnly(target, { cleared: 0, fallback: 0 })
      fs.rmSync(target, { recursive: true, force: true })
      return true
    } catch {
      return false
    }
  }
}

/** 清空隔离区：只删 <workspace>/.quarantine/ 目录内部，路径护栏写死。 */
export function purgeQuarantine(workspaceRoot) {
  const quarantineDir = path.join(workspaceRoot, QUARANTINE_DIR_NAME)
  // 护栏：必须精确等于工作区下的 .quarantine，且真实存在、是目录。
  if (path.basename(quarantineDir) !== QUARANTINE_DIR_NAME) {
    return { ok: false, text: '内部错误：隔离区路径校验未通过，已拒绝删除。', data: null }
  }
  if (!fs.existsSync(quarantineDir)) {
    return { ok: true, text: '隔离区为空（.quarantine/ 不存在），无需清理。', data: { removed: 0 } }
  }
  const entries = fs.readdirSync(quarantineDir)
  // 预清一遍只读属性：git pack 文件带 FILE_ATTRIBUTE_READONLY，直接 rmSync 会 EPERM。
  const counts = { cleared: 0, fallback: 0 }
  for (const entry of entries) clearReadOnly(path.join(quarantineDir, entry), counts)
  let removed = 0
  const errors = []
  for (const entry of entries) {
    if (rmEntry(path.join(quarantineDir, entry))) removed += 1
    else errors.push(`${entry}: 删除失败（可能被占用或权限不足）`)
  }
  const lines = [`已清空隔离区：删除 ${removed} 个批次目录。`]
  if (counts.cleared > 0) lines.push(`（已清除 ${counts.cleared} 个只读文件的只读属性，多为 git 的 .pack/.idx 文件）`)
  if (errors.length > 0) lines.push(`⚠ 失败 ${errors.length} 个：${errors.join('；')}`)
  return {
    ok: errors.length === 0,
    text: lines.join('\n'),
    data: { removed, errors, quarantineDir, clearedReadOnly: counts.cleared },
  }
}

export const workspaceActions = [
  {
    id: 'workspace:clean',
    group: 'workspace',
    title: '扫描并隔离散落文件',
    description: '扫描工作区一级（除 sessions/ 与隐藏项外的文件与目录）+ sessions/ 根 + 各会话目录根上不符合布局规则的散落项，输出清单并同步整体移入 .quarantine/<时间戳>/（同盘改名，可回退）。',
    icon: '🧹',
    danger: false,
    kind: 'action',
    handler: async (params = {}) => quarantineStrays(resolveWorkspace(params)),
  },
  ...createCorpseActions(resolveWorkspace),
  {
    id: 'workspace:purge-quarantine',
    group: 'workspace',
    title: '清空隔离区',
    description: '物理删除 .quarantine/ 里的已隔离文件与目录。不可逆——请先跑「扫描并隔离散落文件」并确认清单里没有要保留的东西。',
    icon: '🗑',
    danger: true,
    kind: 'action',
    handler: async (params = {}) => purgeQuarantine(resolveWorkspace(params)),
  },
]

export const workspaceCategoryDirs = CATEGORY_DIRS
