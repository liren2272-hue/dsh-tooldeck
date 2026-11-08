/**
 * 「查找插件尸体」动作（大类：workspace）。
 *
 * 背景：桌面端/市场插件会反复把「未安装插件」的名字写回各处状态文件与缓存里
 * （dsh-plugin-categories/state.json 每次重启都会重生一批），这就是用户抱怨
 * 「没装的插件尸体总在对话里被搜出来反复提及」的根因。
 *
 * 本模块自包含（只用 node: 内置模块），把「未安装插件尸体」定义收敛为 7 类：
 *   1) 市场发现兼容性缓存  discovery-*.json        —— 整文件搬入隔离区（可再生缓存）
 *   2) 配置备份           *.bak-* / *.bak          —— 整文件搬入隔离区
 *   3) 临时/调试残留      log.ndjson / pending-* / *.tmp-* / printed-build-keys.json
 *   4) 状态文件里的未装插件引用                     —— 不整文件搬（会丢已装项），
 *      先备份原件进隔离区，再「原地重写」剔除未装引用并保留 BOM/结构/已装项
 *       · .dsh-market/state.json          (groups[] / disabled[])
 *       · dsh-plugin-categories/state.json(categories[].packages[])
 *       · compatibility.json              (键形如 name@version，按 name 判装没装)
 *   5) 孤儿插件数据目录    ~/.dsh/ 与 ~/.dsh/cache/ 下对应未装插件名的目录
 *   6) 未安装插件副本      ~/Documents/dsh-plugins/ 下 package.json.name 未登记的目录
 *   7) 悬空插件软链        profile/node_modules 下 realpath 不存在的软链（删链接本身）
 *
 * 两步闭环（与现有「扫描并隔离散落文件 / 清空隔离区」完全同一套模型，用户已确认）：
 *   · workspace:find-corpses   一步「扫描 + 隔离」：列出清单并把整文件/目录类尸体
 *     移入 <workspace>/.quarantine/<时间戳>-corpses/（跨盘 cpSync + rmSync，可回退），
 *     状态类尸体原地剔除未装引用并把原始文件备份进同一隔离区。
 *   · workspace:purge-quarantine（现有按钮，不动）  物理删除隔离区内容 = 「删除尸体」。
 *
 * 尸体大多在 C:（~/.dsh、Documents），隔离区在 D:（工作区）→ fs.renameSync 会 EXDEV，
 * 因此一律走 copyFileSync/cpSync + rmSync，绝不依赖同盘改名。
 *
 * 宁可漏报不可误伤：状态文件只删「不在已装集合」的引用；目录类必须匹配「从状态文件/
 * 未装插件副本里提取出来的尸体名单」且不匹配任何已装插件名；明确的活数据目录有硬白名单。
 *
 * 所有路径经 os.homedir() 动态定位，不写死账号路径；全部文件操作 try/catch 兜底，
 * 单条失败只记进 skipped，绝不把异常抛回宿主。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const QUARANTINE_DIR_NAME = '.quarantine'

/** 明确不能碰的活数据/基础设施目录（小写）。孤儿目录扫描的双重保险之一。 */
const SAFE_DIRS = new Set([
  'profiles', 'sessions', 'cache', 'skills', 'skills-archive', 'skills-management',
  'storages', 'runtimes', 'dsh-runtimes', 'dsh-market', 'dsh-ops',
  'dsh-plugin-categories', 'experts', 'cline2api', 'cline2api-src', 'cpa',
  'go-cache', 'go-path', 'go-toolchain', 'attachments', 'wechat', 'dsh_wechat',
  'jet-hub', 'mobile-access', 'openai-gateway', 'workbuddy-vault',
  'desktop-restart', 'node_modules', 'sessions', 'dsh_wechat',
])

// ---------------------------------------------------------------------------
// 环境 / 工具
// ---------------------------------------------------------------------------

function resolveEnv(opts = {}) {
  return {
    fs: opts.fs ?? fs,
    home: opts.home ?? os.homedir(),
    workspaceRoot: opts.workspaceRoot ?? process.env.DSH_TOOLDECK_WORKSPACE ?? 'D:\\DSH Workspace',
  }
}

function fmtBytes(n) {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function safeName(s) {
  return String(s).replace(/[<>:"/\\|?*\s]/g, '_').slice(0, 80)
}

/** 读 JSON，保留 BOM、是否 pretty、是否有尾换行等信息（用于原地重写时保真）。 */
function readJson(fsx, p) {
  try {
    const raw = fsx.readFileSync(p)
    const bom = raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf
    const text = raw.toString('utf8').replace(/^\uFEFF/, '')
    return {
      j: JSON.parse(text),
      bom,
      pretty: /\n\s{2}"/.test(text),
      trailingNl: text.endsWith('\n'),
      text,
    }
  } catch {
    return null
  }
}

/** 已装集合 = 所有 profile 的 dependencies 键 ∪ dsh.profile.bundles（并集更保守）。 */
function collectInstalled(env) {
  const { fs: fsx, home } = env
  const installed = new Set()
  const profileDirs = []
  let entries = []
  try {
    entries = fsx.readdirSync(path.join(home, '.dsh', 'profiles'), { withFileTypes: true })
  } catch {
    return { installed, profileDirs }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const dir = path.join(home, '.dsh', 'profiles', e.name)
    let parsed
    try {
      parsed = JSON.parse(fsx.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      continue
    }
    profileDirs.push(dir)
    for (const k of Object.keys(parsed.dependencies ?? {})) installed.add(k)
    for (const b of (parsed.dsh?.profile?.bundles ?? [])) {
      if (typeof b === 'string') installed.add(b)
    }
  }
  return { installed, profileDirs }
}

/** 名字归一化：把一个包名/目录名展开成一组可比对的短名变体。 */
function nameVariants(n) {
  const low = String(n).toLowerCase()
  const base = low.includes('/') ? low.split('/').pop() : low
  const noPrefix = base.replace(/^dsh[-_]/, '')
  return [low, base, noPrefix, noPrefix.replace(/^dsh[-_]/, '')].filter(Boolean)
}

function expandNames(names) {
  const out = new Set()
  for (const n of names) for (const v of nameVariants(n)) out.add(v)
  return out
}

function stripVersion(n) {
  const at = String(n).lastIndexOf('@')
  return at > 0 ? String(n).slice(0, at) : String(n)
}

function lstatSafe(fsx, p) {
  try {
    return fsx.lstatSync(p)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 各类扫描
// ---------------------------------------------------------------------------

/** 未安装插件副本：Documents/dsh-plugins 下 package.json.name 未登记的目录。 */
function scanUninstalledPlugins(env, installed) {
  const { fs: fsx, home } = env
  const items = []
  const names = new Set()
  const root = path.join(home, 'Documents', 'dsh-plugins')
  let entries = []
  try {
    entries = fsx.readdirSync(root, { withFileTypes: true })
  } catch {
    return { items, names }
  }
  for (const e of entries) {
    if (!(e.isDirectory() || e.isSymbolicLink())) continue
    const dir = path.join(root, e.name)
    let parsed
    try {
      parsed = JSON.parse(fsx.readFileSync(path.join(dir, 'package.json'), 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      continue // 无 package.json：无法判定，保守跳过
    }
    const name = typeof parsed.name === 'string' ? parsed.name : null
    if (!name || installed.has(name)) continue
    const st = lstatSafe(fsx, dir)
    items.push({
      category: '未安装插件副本',
      disposition: 'move',
      abs: dir,
      display: name,
      size: 0,
      isDir: st?.isDirectory() ?? true,
      isSymlink: st?.isSymbolicLink() ?? false,
    })
    for (const v of nameVariants(name)) names.add(v)
  }
  return { items, names }
}

/** 三个状态文件里的未装插件引用（原地 prune，不整文件搬）。 */
function collectStateRefs(env, installed) {
  const { fs: fsx, home } = env
  const targets = []
  const corpseNames = new Set()
  const candidates = []
  for (const dir of env.profileDirs) {
    candidates.push({ abs: path.join(dir, '.dsh-market', 'state.json'), stateType: 'market' })
    candidates.push({ abs: path.join(dir, 'compatibility.json'), stateType: 'compat' })
  }
  candidates.push({
    abs: path.join(home, '.dsh', 'dsh-plugin-categories', 'state.json'),
    stateType: 'categories',
  })

  for (const c of candidates) {
    const r = readJson(fsx, c.abs)
    if (!r) continue
    const j = r.j
    const removeNames = []
    if (c.stateType === 'market') {
      if (j.groups && typeof j.groups === 'object') {
        for (const k of Object.keys(j.groups)) {
          if (Array.isArray(j.groups[k])) {
            for (const n of j.groups[k]) {
              if (typeof n === 'string' && !installed.has(n)) removeNames.push(n)
            }
          }
        }
      }
      if (Array.isArray(j.disabled)) {
        for (const n of j.disabled) {
          if (typeof n === 'string' && !installed.has(n)) removeNames.push(n)
        }
      } else if (j.disabled && typeof j.disabled === 'object') {
        for (const k of Object.keys(j.disabled)) {
          if (!installed.has(k)) removeNames.push(k)
        }
      }
    } else if (c.stateType === 'categories') {
      if (Array.isArray(j.categories)) {
        for (const cat of j.categories) {
          if (Array.isArray(cat?.packages)) {
            for (const n of cat.packages) {
              if (typeof n === 'string' && !installed.has(n)) removeNames.push(n)
            }
          }
        }
      }
    } else if (c.stateType === 'compat') {
      for (const k of Object.keys(j)) {
        const name = stripVersion(k)
        if (!installed.has(name)) removeNames.push(k)
      }
    }
    for (const n of removeNames) for (const v of nameVariants(stripVersion(n))) corpseNames.add(v)
    if (removeNames.length > 0) {
      targets.push({
        ...c,
        bom: r.bom,
        pretty: r.pretty,
        trailingNl: r.trailingNl,
        parsed: j,
        removeNames,
      })
    }
  }
  return { targets, corpseNames }
}

/** 整文件类：发现缓存 / 备份 / 临时残留。跳过 state.json、compatibility.json（state-ref 处理）。 */
function scanFileCorpses(env) {
  const { fs: fsx, home } = env
  const items = []
  const seen = new Set()
  const scanDirs = new Set()
  for (const dir of env.profileDirs) {
    scanDirs.add(dir)
    scanDirs.add(path.join(dir, '.dsh-market'))
  }
  scanDirs.add(path.join(home, '.dsh', 'dsh-market'))
  scanDirs.add(path.join(home, '.dsh', 'dsh-plugin-categories'))

  const add = (category, abs) => {
    if (seen.has(abs)) return
    seen.add(abs)
    const st = lstatSafe(fsx, abs)
    if (!st || !st.isFile()) return
    items.push({
      category,
      disposition: 'move',
      abs,
      display: path.basename(abs),
      size: st.size,
      isDir: false,
      isSymlink: false,
    })
  }

  for (const dir of scanDirs) {
    let entries
    try {
      entries = fsx.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isFile()) continue
      const name = e.name
      if (name === 'state.json' || name === 'compatibility.json') continue
      const abs = path.join(dir, name)
      if (/^discovery-.*\.json$/i.test(name)) {
        add('市场发现兼容性缓存', abs)
      } else if (/\.bak[-_.]/i.test(name) || /\.bak$/i.test(name)) {
        add('配置备份', abs)
      } else if (/^(log\.ndjson|pending-.*\.json|.*\.tmp-.*|printed-build-keys\.json)$/i.test(name)) {
        add('临时/调试残留', abs)
      }
    }
  }
  return items
}

/** 孤儿插件数据目录：~/.dsh/ 与 ~/.dsh/cache/ 下匹配尸体名单、且不匹配已装名的目录。 */
function scanOrphanDirs(env, installed, corpseNames) {
  const { fs: fsx, home } = env
  const items = []
  const corpseShort = expandNames(corpseNames)
  const liveShort = expandNames(installed)
  if (corpseShort.size === 0) return items
  const roots = [path.join(home, '.dsh', 'cache'), path.join(home, '.dsh')]
  for (const root of roots) {
    let entries
    try {
      entries = fsx.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!(e.isDirectory() || e.isSymbolicLink())) continue
      const name = e.name
      if (name.startsWith('.')) continue
      const low = name.toLowerCase()
      if (SAFE_DIRS.has(low)) continue
      if (/^(backup-|tmp-|temp-|dsh-runtimes)/i.test(name)) continue
      const variants = nameVariants(name)
      if (!variants.some((v) => corpseShort.has(v))) continue
      if (variants.some((v) => liveShort.has(v))) continue
      const abs = path.join(root, name)
      const st = lstatSafe(fsx, abs)
      items.push({
        category: '孤儿插件数据目录',
        disposition: 'move',
        abs,
        display: name,
        size: 0,
        isDir: st?.isDirectory() ?? true,
        isSymlink: st?.isSymbolicLink() ?? false,
      })
    }
  }
  // 同一目录可能被两个 root 命中（cache 是 .dsh 的子目录，但名字不同不会重复）；去重保险
  const seen = new Set()
  return items.filter((it) => (seen.has(it.abs) ? false : (seen.add(it.abs), true)))
}

/** 悬空插件软链：profile/node_modules（含一层 @scope）下 realpath 不存在的软链。 */
function scanDanglingLinks(env) {
  const { fs: fsx } = env
  const items = []
  for (const dir of env.profileDirs) {
    const nm = path.join(dir, 'node_modules')
    const scopes = [nm]
    try {
      for (const e of fsx.readdirSync(nm, { withFileTypes: true })) {
        if (e.isDirectory() && e.name.startsWith('@')) scopes.push(path.join(nm, e.name))
      }
    } catch {
      continue
    }
    for (const scope of scopes) {
      let entries
      try {
        entries = fsx.readdirSync(scope, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        if (!e.isSymbolicLink()) continue
        const p = path.join(scope, e.name)
        let target
        try {
          target = fsx.readlinkSync(p)
        } catch {
          continue
        }
        let exists = false
        try {
          fsx.realpathSync(p)
          exists = true
        } catch {
          exists = false
        }
        if (exists) continue
        items.push({
          category: '悬空插件软链',
          disposition: 'unlink',
          abs: p,
          display: scope === nm ? e.name : `${path.basename(scope)}/${e.name}`,
          symlinkTarget: target,
          size: 0,
          isDir: false,
          isSymlink: true,
        })
      }
    }
  }
  return items
}

// ---------------------------------------------------------------------------
// 只读扫描入口
// ---------------------------------------------------------------------------

/**
 * 扫描全部「未安装插件尸体」。只读，绝不改动任何文件。
 * opts 可注入 { fs, home, workspaceRoot } 供离线自测（造一个假 home，不碰真实数据）。
 */
export function scanCorpses(opts = {}) {
  const env = resolveEnv(opts)
  const { installed, profileDirs } = collectInstalled(env)
  env.profileDirs = profileDirs
  const items = []

  const un = scanUninstalledPlugins(env, installed)
  items.push(...un.items)
  const corpseNames = new Set(un.names)

  const state = collectStateRefs(env, installed)
  for (const n of state.corpseNames) corpseNames.add(n)
  for (const t of state.targets) {
    items.push({
      category: '状态文件里的未装插件引用',
      disposition: 'prune',
      abs: t.abs,
      display: `${path.basename(t.abs)} (${t.stateType})`,
      size: 0,
      isDir: false,
      isSymlink: false,
      stateType: t.stateType,
      bom: t.bom,
      pretty: t.pretty,
      trailingNl: t.trailingNl,
      parsed: t.parsed,
      removeNames: t.removeNames,
    })
  }

  items.push(...scanOrphanDirs(env, installed, corpseNames))
  items.push(...scanFileCorpses(env))
  items.push(...scanDanglingLinks(env))

  return { env, installed, profileDirs, items, corpseNames }
}

// ---------------------------------------------------------------------------
// 隔离：扫描 + 搬移/prune/unlink，一步完成；物理删除交给现有「清空隔离区」
// ---------------------------------------------------------------------------

function categoryKey(category) {
  const map = {
    '市场发现兼容性缓存': 'discovery',
    '配置备份': 'backup',
    '临时/调试残留': 'temp',
    '孤儿插件数据目录': 'orphan',
    '未安装插件副本': 'plugin',
    '悬空插件软链': 'link',
    '状态文件里的未装插件引用': 'state',
  }
  return map[category] ?? 'misc'
}

/** 原地剔除状态文件里的未装引用（改的是内存里的 j，写回由调用方做）。 */
function pruneInPlace(j, stateType, installed) {
  if (stateType === 'market') {
    if (j.groups && typeof j.groups === 'object') {
      for (const k of Object.keys(j.groups)) {
        if (Array.isArray(j.groups[k])) {
          j.groups[k] = j.groups[k].filter((n) => typeof n !== 'string' || installed.has(n))
        }
      }
    }
    if (Array.isArray(j.disabled)) {
      j.disabled = j.disabled.filter((n) => typeof n !== 'string' || installed.has(n))
    } else if (j.disabled && typeof j.disabled === 'object') {
      for (const k of Object.keys(j.disabled)) {
        if (!installed.has(k)) delete j.disabled[k]
      }
    }
  } else if (stateType === 'categories') {
    if (Array.isArray(j.categories)) {
      for (const c of j.categories) {
        if (Array.isArray(c?.packages)) {
          c.packages = c.packages.filter((n) => typeof n !== 'string' || installed.has(n))
        }
      }
    }
  } else if (stateType === 'compat') {
    for (const k of Object.keys(j)) {
      if (!installed.has(stripVersion(k))) delete j[k]
    }
  }
  return j
}

function formatScanTable(scan) {
  const lines = []
  const { env, installed, profileDirs, items } = scan
  lines.push(`家目录：${env.home}`)
  lines.push(`已登记 profile：${profileDirs.length} 个；已安装插件集合：${installed.size} 项`)
  if (items.length === 0) {
    lines.push('')
    lines.push('✅ 未发现未安装插件尸体（状态文件干净、无发现缓存/备份/孤儿目录/未装副本/悬空软链）。')
    return lines.join('\n')
  }
  const byCat = new Map()
  for (const it of items) {
    if (!byCat.has(it.category)) byCat.set(it.category, [])
    byCat.get(it.category).push(it)
  }
  const totalBytes = items.reduce((acc, it) => acc + (Number.isFinite(it.size) ? it.size : 0), 0)
  lines.push('')
  lines.push(`发现 ${items.length} 项未安装插件尸体（可搬移文件合计约 ${fmtBytes(totalBytes)}）：`)
  for (const [cat, list] of byCat) {
    lines.push(`  【${cat}】${list.length} 项`)
    const show = list.slice(0, 12)
    for (const it of show) {
      const extra = it.disposition === 'prune'
        ? ` → 剔除 ${it.removeNames.length} 个引用：${it.removeNames.slice(0, 6).join('、')}${it.removeNames.length > 6 ? '…' : ''}`
        : it.disposition === 'unlink'
          ? ` → 软链目标 ${it.symlinkTarget}`
          : (it.size ? ` — ${fmtBytes(it.size)}` : (it.isDir ? ' — 目录' : ''))
      lines.push(`    · ${it.display}${extra}`)
    }
    if (list.length > show.length) lines.push(`    · …另有 ${list.length - show.length} 项`)
  }
  return lines.join('\n')
}

function formatQuarantineResult(scan, result) {
  const { root, moved, pruned, unlinked, skipped } = result
  // 检测表与隔离结果分成两段：客户端会把「隔离结果」置顶常显、检测表折叠，
  // 避免长检测表把清除日志挤出可视区（旧版两者拼在一个 pre 里导致清除日志被挡住）。
  const lines = ['—— 隔离结果 ——']
  lines.push(`整体搬移 ${moved.length} 项；状态文件剔除 ${pruned.length} 处（原件已备份）；软链清理 ${unlinked.length} 项；跳过 ${skipped.length} 项。`)
  const rel = path.basename(root)
  lines.push(`隔离区：.quarantine/${rel}/  （含 manifest.json 回退清单）`)
  for (const p of pruned) {
    lines.push(`  · 重写 ${path.basename(p.from)}：移除 ${p.removed.length} 个未装引用 → ${p.removed.slice(0, 6).join('、')}${p.removed.length > 6 ? '…' : ''}（原件备份 ${p.backupRel}）`)
  }
  for (const l of unlinked) lines.push(`  · 移除悬空软链 ${path.basename(l.from)}（原指向 ${l.symlinkTarget}）`)
  for (const k of skipped) lines.push(`  ⚠ 跳过 ${k.abs}：${k.reason}`)
  lines.push('')
  lines.push('尸体已从原位置清出，但尚未物理删除。需要找回时按 manifest.json 里的 from/to 原路移回即可；')
  lines.push('确认清单无误后点「清空隔离区」才会真正删除（那一步才是「删除尸体」）。')
  const actionText = lines.join('\n')
  const scanText = formatScanTable(scan)
  return { actionText, scanText, text: `${scanText}\n\n${actionText}` }
}

/**
 * 一步「扫描 + 隔离」。返回 { ok, text, data }，绝不抛。
 * 隔离区直接落在 <workspace>/.quarantine/ 下，可被现有 workspace:purge-quarantine 一并清空。
 */
export function quarantineCorpses(workspaceRoot, opts = {}) {
  let scan
  try {
    scan = scanCorpses({ ...opts, workspaceRoot })
  } catch (error) {
    return { ok: false, text: `扫描失败：${String(error?.message ?? error)}`, data: null }
  }
  const { env, items } = scan
  const fsx = env.fs
  if (items.length === 0) {
    return {
      ok: true,
      text: formatScanTable(scan),
      data: { count: 0, moved: [], pruned: [], unlinked: [], skipped: [], quarantineRoot: null },
    }
  }

  const stamp = new Date().toISOString().replace(/[-:TZ]/g, '').slice(0, 14)
  let root = path.join(workspaceRoot, QUARANTINE_DIR_NAME, `${stamp}-corpses`)
  let seq = 1
  while (fsx.existsSync(root)) {
    root = path.join(workspaceRoot, QUARANTINE_DIR_NAME, `${stamp}-corpses-${seq++}`)
  }
  // 护栏：隔离根必须精确位于工作区 .quarantine 之下
  if (path.basename(path.dirname(root)) !== QUARANTINE_DIR_NAME) {
    return { ok: false, text: '内部错误：隔离区路径校验未通过，已拒绝操作。', data: null }
  }

  try {
    fsx.mkdirSync(root, { recursive: true })
  } catch (error) {
    return { ok: false, text: `无法创建隔离区：${String(error?.message ?? error)}`, data: null }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    workspaceRoot,
    home: env.home,
    note: '回退：move 类把 files/<...> 复制回 from；prune 类用 state-backup/<...> 覆盖回 from；unlink 类按 symlinkTarget 重建软链。',
    items: [],
  }
  const moved = []
  const pruned = []
  const unlinked = []
  const skipped = []

  items.forEach((it, idx) => {
    const n = String(idx).padStart(3, '0')
    try {
      if (it.disposition === 'prune') {
        const backupRel = `state-backup/${n}-${safeName(path.basename(it.abs))}`
        const backup = path.join(root, backupRel)
        fsx.mkdirSync(path.dirname(backup), { recursive: true })
        fsx.copyFileSync(it.abs, backup) // 原始 bytes（含 BOM）整体备份
        const j = pruneInPlace(it.parsed, it.stateType, scan.installed)
        const prefix = it.bom ? '\uFEFF' : ''
        const body = it.pretty ? JSON.stringify(j, null, 2) : JSON.stringify(j)
        const tail = it.trailingNl ? '\n' : ''
        fsx.writeFileSync(it.abs, prefix + body + tail, 'utf8')
        pruned.push({ from: it.abs, backupRel, removed: it.removeNames })
        manifest.items.push({ disposition: 'prune', category: it.category, from: it.abs, backupRel, removed: it.removeNames })
      } else if (it.disposition === 'unlink') {
        fsx.unlinkSync(it.abs) // 删链接本身，绝不递归
        unlinked.push({ from: it.abs, symlinkTarget: it.symlinkTarget })
        manifest.items.push({ disposition: 'unlink', category: it.category, from: it.abs, symlinkTarget: it.symlinkTarget })
      } else {
        const rel = `files/${n}-${categoryKey(it.category)}-${safeName(it.display)}`
        const dest = path.join(root, rel)
        fsx.mkdirSync(path.dirname(dest), { recursive: true })
        // 跨盘：cpSync（复制，不是 rename）+ rmSync（删源）；dereference:false 保留软链语义
        fsx.cpSync(it.abs, dest, { recursive: true, dereference: false, force: true })
        if (!fsx.existsSync(dest)) throw new Error('复制后目标不存在，已保留源文件')
        fsx.rmSync(it.abs, { recursive: true, force: true })
        moved.push({ from: it.abs, to: rel })
        manifest.items.push({ disposition: 'move', category: it.category, from: it.abs, to: rel })
      }
    } catch (error) {
      skipped.push({ abs: it.abs, reason: String(error?.message ?? error) })
    }
  })

  try {
    fsx.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  } catch (error) {
    skipped.push({ abs: path.join(root, 'manifest.json'), reason: String(error?.message ?? error) })
  }

  const result = { root, moved, pruned, unlinked, skipped }
  // formatQuarantineResult 现返回 {actionText,scanText,text}：text 供复制/兜底，另两段进 data 供客户端分区渲染
  const rendered = formatQuarantineResult(scan, result)
  return {
    ok: skipped.length === 0,
    text: rendered.text,
    data: {
      count: items.length,
      quarantineRoot: root,
      actionText: rendered.actionText,
      scanText: rendered.scanText,
      moved,
      pruned,
      unlinked,
      skipped,
      manifest,
    },
  }
}

/** 生成要挂进 registry 的动作；resolveWorkspace 由 workspace.mjs 传入（避免重复实现）。 */
export function createCorpseActions(resolveWorkspace) {
  return [
    {
      id: 'workspace:find-corpses',
      group: 'workspace',
      title: '查找插件尸体',
      description:
        '扫描「未安装插件」的残留：市场发现兼容性缓存、状态文件里的未装引用、.bak 备份、临时残留、孤儿数据目录、未装插件副本、悬空软链。' +
        '输出清单并把整文件/目录类尸体整体移入 .quarantine/<时间戳>-corpses/（跨盘复制+删源，可回退），状态文件则原地剔除未装引用并备份原件。' +
        '确认清单无误后点「清空隔离区」才会物理删除（即「删除尸体」）。已安装插件及其运行配置一律不动。',
      icon: '🔍',
      danger: false,
      kind: 'action',
      handler: async (params = {}) => quarantineCorpses(resolveWorkspace(params)),
    },
  ]
}
