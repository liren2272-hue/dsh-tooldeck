/**
 * 工作区整理动作（大类：workspace）。
 *
 * 目标：清除工作区里「没有正确归类」的散落【文件】：新文件只能落在 sessions/<会话>/ 的
 * 六个归类目录里，不允许文件直接躺在工作区根、sessions/ 根或会话目录根。
 *
 * 两步闭环（可回退 → 真删）：
 *  1) workspace:clean            一步「扫描 + 隔离」：列出散落文件清单（含大小/时间）并同盘改名移入
 *                                <workspace>/.quarantine/<时间戳>/，保留相对路径，随时可原路移回。
 *                                结果面板置顶显示隔离结果，检测清单折叠在下方（扫描与隔离合一，一个按钮）。
 *  2) workspace:purge-quarantine 单独真删（danger）：只删隔离区内容，需用户再次确认才点。
 *  scanStrays() / auditStrays() 仍单独导出，供程序化只读扫描（卡片不再单列只读按钮）。
 *
 *  会话文件夹 1:1 判定（session-mapping.mjs）默认随本动作启用：把「没有对应 GUI 对话」的
 *  多余文件夹（含 Mnemon 内部记忆/后台任务文件夹）一并同盘隔离进 .quarantine，可回退、绝不删除。
 *  真实 session-* 对话一律保护；可显式传 { moveOrphanSessions: false } 关闭该层判定。
 *
 * 保护规则（宁可漏报不可误伤）：
 *  - 隐藏文件/目录（名字以 . 开头）一律不碰：本机工具习惯把缓存放在根目录且多为隐藏
 *    （.curate-cache.json / .bsk / .dsh / .cc-safety-net / .quarantine 等），误移会破坏别的工具。
 *  - 【目录一律保护】：工作区根一级目录、sessions/ 下的会话目录本身都不进散落清单；
 *    只检查工作区根、sessions/ 根、每个会话目录【根】上的散落文件。
 *    （旧口径「除 sessions 外一级目录也必须干净」需显式传 includeRootDirs:true，默认关闭。）
 *  - sessions/ 层：只认文件；白名单 INDEX.md。会话目录（子目录）本身绝不深入扫描——
 *    只检查每个会话目录【根】上的散落文件，白名单 README.md（dsh-session-folders 生成）。
 *  - 六个归类目录名（docs/src/data/assets/output/tmp）只存在于会话目录内，与既有布局规则一致。
 */

import fs from 'node:fs'
import path from 'node:path'
import { createCorpseActions } from './corpses.mjs'
import { scanOrphanSessionFolders } from './session-mapping.mjs'

const DEFAULT_WORKSPACE = 'D:\\DSH Workspace'
const QUARANTINE_DIR_NAME = '.quarantine'

/** 会话目录根的布局规则里的归类目录（仅作展示/校验，不用于判断散落）。 */
const CATEGORY_DIRS = ['docs', 'src', 'data', 'assets', 'output', 'tmp']

/** sessions/ 根上允许的文件。 */
const SESSIONS_ROOT_WHITELIST = new Set(['INDEX.md'])
/** 会话目录根上允许的文件。 */
const SESSION_DIR_WHITELIST = new Set(['README.md'])
/** 工作区根一级【目录】豁免名单：sessions/ 永远豁免。 */
const WORKSPACE_DIR_WHITELIST = new Set(['sessions'])
/**
 * 目录默认一律保护（本次用户规则：判定不能误伤目录）。只有动作显式传 includeRootDirs:true
 * （对应「除 sessions 外一级目录也必须干净」的旧口径）才把根一级目录当散落。
 */
const DEFAULT_PROTECT_DIRS = true

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

/**
 * 全量扫描：工作区根 + sessions/ 根 + 每个会话目录根。只读，绝不写盘。
 * 默认目录一律不进清单（opts.protectDirs !== false）；隐藏项（. 开头）始终不进清单。
 */
export function scanStrays(workspaceRoot, opts = {}) {
  const strays = []
  const protectDirs = opts.protectDirs ?? DEFAULT_PROTECT_DIRS
  const meta = { workspaceRoot, sessionsScanned: 0, protectDirs, errors: [] }

  // 工作区根：一级文件算散落；目录默认保护（includeRootDirs 才当散落）；隐藏项一律保护。
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
      if (protectDirs) continue // 目录一律保护，不误伤
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
    lines.push('✅ 未发现散落文件，布局干净（目录与隐藏项一律保护，未写盘）。')
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
  lines.push('处理去向：以上文件已（或将被）整体移入 .quarantine/，可随时原路移回；确认无误后再点「清空隔离区」才会真正删除。')
  return lines.join('\n')
}

/** 把「多余 session 文件夹」清单格式化为检测清单文本（供结果面板折叠显示）。 */
function formatOrphanTable(map) {
  const lines = []
  lines.push(`session 文件夹 ↔ 会话 1:1 校验：扫描 ${map.meta.foldersScanned} 个一级目录`)
  lines.push(`数据源：已登记会话 ${map.meta.registeredCount} 个（活跃 ${map.meta.activeCount} 个），已知短 id ${map.meta.knownShortCount} 个，.meta 记录 ${map.meta.metaRecordCount} 条`)
  if (map.meta.registryError) lines.push(`  ⚠ workspace.json：${map.meta.registryError}`)
  if (map.meta.metaError) lines.push(`  ⚠ sessions/.meta：${map.meta.metaError}`)
  if (!map.gateOk) {
    lines.push('  ⚠ 会话数据源不可用或为空 → 整轮跳过 1:1 清理（保护所有会话文件夹，一个都不动）。')
    return lines.join('\n')
  }
  lines.push('')
  lines.push(`判定：保护 ${map.protectedFolders.length} 个；多余（无对应会话）${map.orphans.length} 个。`)
  for (const p of map.protectedFolders) lines.push(`  · 保护 ${p.folder}/ — ${p.why}`)
  for (const o of map.orphans) lines.push(`  · 多余 ${o.rel} — ${o.why}（${o.itemCount} 项）`)
  if (map.orphans.length === 0) lines.push('  ✅ session 文件夹与会话一一对应，没有多余文件夹。')
  return lines.join('\n')
}

/**
 * 第一步：只读盘点。列出散落文件清单（含大小/时间），不移动、不写盘。
 * 返回 data.readOnly = true 便于客户端/调用方断言「这一步没有副作用」。
 */
export function auditStrays(workspaceRoot, opts = {}) {
  const { strays, meta } = scanStrays(workspaceRoot, opts)
  const scanText = formatStrayTable(strays, meta)
  const actionText = strays.length === 0
    ? '只读盘点完成：没有散落文件，布局干净（未写盘、未移动任何文件）。'
    : `只读盘点完成：发现 ${strays.length} 个散落文件，尚未移动任何文件；确认清单后点「隔离散落文件」把它们同盘移入 .quarantine/（可回退）。`
  return {
    ok: true,
    text: scanText + '\n' + actionText,
    data: { count: strays.length, strays, meta, readOnly: true, actionText, scanText },
  }
}

/**
 * 把动作参数翻译成 quarantineStrays 的 opts。
 * GUI 按钮（客户端不带 params）默认启用会话文件夹 1:1 判定：
 *   moveOrphanSessions 默认 true —— 一次点击即保证对话↔文件夹 1:1；
 *   includeRootDirs 默认 false —— 一级目录仍按旧口径保护。
 * 显式传 moveOrphanSessions:false / includeRootDirs:true 可覆盖。
 * 注意：quarantineStrays 函数本身默认值不变（直接调用不传 opts 仍不搬目录），
 * 这样既让按钮默认做双层判定，又不影响程序化调用与既有用例。
 */
export function resolveCleanOpts(params = {}) {
  return {
    protectDirs: params.includeRootDirs !== true,
    moveOrphanSessions: params.moveOrphanSessions !== false,
  }
}

/** 一步「扫描 + 隔离」：同盘 rename 移入 <workspace>/.quarantine/<stamp>/<原相对路径>，绝不删除。 */
export function quarantineStrays(workspaceRoot, env = {}, opts = {}) {
  // opts 由 resolveCleanOpts() 统一给出：GUI 按钮默认 moveOrphanSessions=true（启用 1:1 复合判定），
  // 程序化直接调用本函数不传 opts 时沿用旧行为（只处理散落文件、目录不碰），互不干扰。
  // 显式传 opts.moveOrphanSessions === false 可关闭该层判定。
  const map = opts.moveOrphanSessions === true
    ? scanOrphanSessionFolders(workspaceRoot, env)
    : null
  // 只有数据源可用（gateOk）才认 1:1 判定结果；gateOk=false 时整轮 no-op，一个文件夹都不搬。
  const orphanNames = new Set(map && map.gateOk ? map.orphans.map((o) => o.name) : [])

  // 属于「多余会话文件夹」的散落项无需单独搬（整个文件夹会整体移走），避免双搬/竞态。
  const { strays: rawStrays, meta } = scanStrays(workspaceRoot, opts)
  const strays = rawStrays.filter((s) => {
    const m = /^sessions\/([^\/]+)\//.exec(s.rel)
    return !(m && orphanNames.has(m[1]))
  })
  const orphanItems = map && map.gateOk ? map.orphans : []
  const count = strays.length + orphanItems.length
  if (count === 0) {
    const scanText = [formatStrayTable(strays, meta), ...(map ? ['', formatOrphanTable(map)] : [])].join('\n')
    const actionText = '扫描完成：没有散落文件，无需隔离（目录与隐藏项一律保护，未移动任何文件）。'
    return {
      ok: true,
      text: scanText + '\n' + actionText,
      data: { count: 0, quarantineRoot: null, moved: [], skipped: [], meta, actionText, scanText, orphanScan: map },
    }
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
  // 多余的 session 文件夹：整体移入 .quarantine/<stamp>/sessions/<folder>/，同盘改名、可回退。
  for (const o of orphanItems) {
    const dest = path.join(quarantineRoot, 'sessions', o.name)
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      let final = dest
      let i = 1
      while (fs.existsSync(final)) {
        final = `${dest}.${i++}`
      }
      fs.renameSync(o.abs, final)
      moved.push({ from: o.rel, to: path.relative(workspaceRoot, final), isDir: true, orphanSession: true })
    } catch (error) {
      skipped.push({ file: o.rel, reason: String(error?.message ?? error) })
    }
  }
  // 一次输出 = 散落清单 + 1:1 判定清单（隔离前状态）+ 隔离结果，全部合并；
  // data.actionText / data.scanText 供客户端结果面板「置顶结论 + 折叠清单」双分区显示。
  const scanText = [formatStrayTable(strays, meta), ...(map ? ['', formatOrphanTable(map)] : [])].join('\n')
  const actionLines = [
    '—— 隔离结果 ——',
    `散落项移动 ${moved.filter((m) => !m.orphanSession).length} 个；多余 session 文件夹移动 ${moved.filter((m) => m.orphanSession).length} 个；跳过 ${skipped.length} 个。`,
    `隔离区：${path.relative(workspaceRoot, quarantineRoot)}/`,
  ]
  for (const m of moved) actionLines.push(`  · ${m.from}${m.orphanSession ? '（多余会话文件夹）' : m.isDir ? '（目录）' : ''} → ${m.to}`)
  for (const k of skipped) actionLines.push(`  ⚠ 跳过 ${k.file}：${k.reason}`)
  if (moved.length > 0) actionLines.push('', '需要找回时从 .quarantine/ 原路径移回即可；确认无误后点「清空隔离区」物理删除。')
  const actionText = actionLines.join('\n')
  const text = scanText + '\n' + actionText
  return {
    ok: skipped.length === 0,
    text,
    data: { count, quarantineRoot, moved, skipped, meta, actionText, scanText, orphanScan: map },
  }
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
    title: '整理工作区（散落文件 + 多余会话文件夹）',
    description: '一步「扫描 + 隔离」：① 扫描工作区根、sessions/ 根、每个会话目录根上不符合布局规则的文件（含大小/时间）；② 校验「对话 ↔ 会话文件夹 1:1」，把没有对应 GUI 对话的多余文件夹（含 Mnemon 内部记忆/后台任务文件夹）一并同盘改名移入 .quarantine/<时间戳>/，保留原相对路径、可原路移回，绝不删除。真实 session-* 对话与隐藏文件一律保护，数据源不可用时整轮不搬。结果置顶显示隔离结果，检测清单折叠在下方。',
    icon: '🧹',
    danger: false,
    kind: 'action',
    handler: async (params = {}) => quarantineStrays(resolveWorkspace(params), params.env ?? {}, resolveCleanOpts(params)),
  },
  ...createCorpseActions(resolveWorkspace),
  {
    id: 'workspace:purge-quarantine',
    group: 'workspace',
    title: '清空隔离区（真删）',
    description: '物理删除 .quarantine/ 里的已隔离文件与目录。不可逆——请先跑「整理工作区」核对清单并确认隔离区里没有要保留的东西。',
    icon: '🗑',
    danger: true,
    kind: 'action',
    handler: async (params = {}) => purgeQuarantine(resolveWorkspace(params)),
  },
]

export const workspaceCategoryDirs = CATEGORY_DIRS
