/**
 * session 文件夹 ↔ 会话「一一对应」判定（供 workspace:clean 复合使用）。
 *
 * 权威口径：workspace.json 的 tables.workspaces[*].sessionIds − global.archivedSessionIds = 活跃会话。
 * 绝不用运行时 sessions.list()（含归档与 subagent，会放大活跃集、把孤儿认成在用）。
 *
 * 判定某个 sessions/ 一级目录是否「多余」用多重保护，宁可漏报不可误伤：
 *  - 该目录有 live .meta 记录（archivedAt<=0）→ 保护（新建会话即时生效，不依赖 cwd）。
 *  - 该目录的 .meta.id 命中已登记会话（含已归档）→ 保护。
 *  - 目录名里的短 id 命中任意已知会话（registry / host 会话存储 / .meta）→ 保护。
 *  - 活跃会话集或 .meta 数据源不可用 → 整轮 no-op，一个都不判多余。
 *  - 隐藏目录（.meta / .trash / .xxx）与 sessions/ 根文件一律不在此处理。
 *
 * 历史命名：早期文件夹名以 _sessio 结尾（当年 shortId 未剥 session- 前缀），
 * 这类名字短 id 不可靠，保守保护，改由 .meta.folder ↔ .meta.id 反查归属。
 *
 * 模块自包含，仅用 node: 内置模块；源码不含任何反斜杠转义，便于脚本化维护。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/** 归一化会话 id：去 session- 前缀、去所有横杠、小写。 */
export function normId(id) {
  return String(id ?? '').replace(/^session-/i, '').replace(/-/g, '').toLowerCase()
}

/** 短 id = 归一化后的前 6 位。 */
export function shortId(id) {
  return normId(id).slice(0, 6)
}

/** 从 YYYY-MM-DD_HHMM_<suffix> 命名的文件夹里取短 id；非会话命名或历史 _sessio 返回 null。 */
export function folderShortId(name) {
  const m = /^([0-9]{4}-[0-9]{2}-[0-9]{2})_([0-9]{4})_([A-Za-z0-9]+)$/.exec(name)
  if (!m) return null
  const suffix = m[3].toLowerCase()
  if (suffix === 'sessio') return null
  return suffix.slice(0, 6)
}

/** 历史命名（当年 shortId 没剥 session- 前缀）：短 id 不可靠，保守保护。 */
export function isHistoricalFolder(name) {
  return /^([0-9]{4}-[0-9]{2}-[0-9]{2})_([0-9]{4})_sessio$/i.test(name)
}

/**
 * 内部记忆 / 后台任务会话（Mnemon worker）判定。
 * 真实 GUI 对话恒为 session-<uuid>；Mnemon 内部任务为 mnemon-task-v1-* / mnemon-run-v1-*。
 * 这类会话不是「对话」，不该在 sessions/ 下拥有自己的文件夹，也不参与 1:1 对应。
 * 用 normId() 兼容「原始 id」与「readMetaRecords 已归一化的 id」（normId 幂等），
 * 且只认 mnemon-task- / mnemon-run- 前缀，绝不误伤 session-* / 裸 uuid / session-mnemon-notes。
 */
export function isInternalSessionId(id) {
  return /^mnemon(?:task|run)v\d/i.test(normId(id))
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/**
 * 读 ~/.dsh/storages/workspace.json。
 * 保守取「所有 workspace 的 sessionIds 并集」而非按 path 精确匹配：多 workspace 时至多多保护，
 * 不会误删；workspace.json 缺失/解析失败/无活跃会话时 gateOk=false，调用方整轮 no-op。
 */
export function readSessionRegistry(registryPath, fsImpl = fs) {
  const result = {
    registeredIds: new Set(),
    activeIds: new Set(),
    archivedIds: new Set(),
    gateOk: false,
    error: null,
  }
  let raw
  try {
    raw = fsImpl.readFileSync(registryPath, 'utf8')
  } catch (error) {
    result.error = String(error && error.message ? error.message : error)
    return result
  }
  let json
  try {
    json = JSON.parse(stripBom(raw))
  } catch (error) {
    result.error = 'workspace.json 解析失败：' + String(error && error.message ? error.message : error)
    return result
  }
  const archivedArr = json && json.global && Array.isArray(json.global.archivedSessionIds)
    ? json.global.archivedSessionIds
    : []
  for (const id of archivedArr) result.archivedIds.add(normId(id))
  const workspaces = json && json.tables && json.tables.workspaces
    ? Object.values(json.tables.workspaces)
    : []
  for (const w of workspaces) {
    const ids = w && Array.isArray(w.sessionIds) ? w.sessionIds : []
    for (const id of ids) result.registeredIds.add(normId(id))
  }
  // 归档会话可能已从 sessionIds 移除，但绝不能因此把它的文件夹判成孤儿。
  for (const id of result.archivedIds) result.registeredIds.add(id)
  for (const id of result.registeredIds) {
    if (!result.archivedIds.has(id)) result.activeIds.add(id)
  }
  result.gateOk = result.registeredIds.size >= 1 && result.activeIds.size >= 1
  return result
}

/** host 会话存储目录下所有子目录名 → 短 id 集合（兼容 session-<uuid> / <uuid> 两种布局，再下探一层）。 */
export function collectHostShortIds(hostSessionsDir, fsImpl = fs) {
  const out = new Set()
  let entries
  try {
    entries = fsImpl.readdirSync(hostSessionsDir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    out.add(shortId(e.name))
    let inner
    try {
      inner = fsImpl.readdirSync(path.join(hostSessionsDir, e.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e2 of inner) {
      if (e2.isDirectory()) out.add(shortId(e2.name))
    }
  }
  return out
}

/**
 * collectHostShortIds 的增强版：额外返回 readable，用于区分
 * 「宿主会话存储读不到（保持保守保护）」与「读到了但查不到该会话（正文已被删，可降级 orphan）」。
 */
export function collectHostShortIds2(hostSessionsDir, fsImpl = fs) {
  const out = new Set()
  let entries
  try {
    entries = fsImpl.readdirSync(hostSessionsDir, { withFileTypes: true })
  } catch {
    return { readable: false, shortIds: out }
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue
    out.add(shortId(e.name))
    let inner
    try {
      inner = fsImpl.readdirSync(path.join(hostSessionsDir, e.name), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e2 of inner) {
      if (e2.isDirectory()) out.add(shortId(e2.name))
    }
  }
  return { readable: true, shortIds: out }
}

/** 读 sessions/.meta/*.json → { metaByFolder:Map<folder,[{id,live}]>, metaShortIds:Set, error }。 */
export function readMetaRecords(metaDir, fsImpl = fs) {
  const metaByFolder = new Map()
  const metaShortIds = new Set()
  let error = null
  let entries
  try {
    entries = fsImpl.readdirSync(metaDir)
  } catch (e) {
    return { metaByFolder, metaShortIds, error: String(e && e.message ? e.message : e) }
  }
  for (const name of entries) {
    if (!name.endsWith('.json')) continue
    let rec
    try {
      rec = JSON.parse(stripBom(fsImpl.readFileSync(path.join(metaDir, name), 'utf8')))
    } catch {
      continue // 单条坏记录跳过，不影响整轮
    }
    const id = normId(rec && rec.id)
    if (id) metaShortIds.add(shortId(id))
    const folder = rec && typeof rec.folder === 'string' ? rec.folder : null
    if (!folder) continue
    const live = !(Number(rec.archivedAt ?? 0) > 0)
    if (!metaByFolder.has(folder)) metaByFolder.set(folder, [])
    metaByFolder.get(folder).push({ id, live })
  }
  return { metaByFolder, metaShortIds, error }
}

/** sessions/ 一级非隐藏目录清单（.meta / .trash / .xxx 与根文件都不算会话文件夹）。 */
export function listSessionFolders(sessionsDir, fsImpl = fs) {
  let entries
  try {
    entries = fsImpl.readdirSync(sessionsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    if (e.name.startsWith('.')) continue
    out.push(e.name)
  }
  return out.sort()
}

/**
 * 主入口：判定 sessions/ 下哪些一级目录「没有对应会话」（多余）。
 * env 可注入 { fs, home, registryPath, hostSessionsDir } 便于离线回归测试。
 * 返回 { orphans, protectedFolders, reasons, gateOk, meta }；gateOk=false 时 orphans 恒为空。
 */
export function scanOrphanSessionFolders(workspaceRoot, env = {}) {
  const fsImpl = env.fs ?? fs
  const home = env.home ?? os.homedir()
  const sessionsDir = path.join(workspaceRoot, 'sessions')
  const metaDir = path.join(sessionsDir, '.meta')
  const registryPath = env.registryPath ?? path.join(home, '.dsh', 'storages', 'workspace.json')
  const hostSessionsDir = env.hostSessionsDir ?? path.join(home, '.dsh', 'sessions')

  const reg = readSessionRegistry(registryPath, fsImpl)
  const hostInfo = collectHostShortIds2(hostSessionsDir, fsImpl)
  const hostShortIds = hostInfo.shortIds
  const hostReadable = hostInfo.readable
  const meta = readMetaRecords(metaDir, fsImpl)
  const knownShortIds = new Set()
  for (const id of reg.registeredIds) knownShortIds.add(shortId(id))
  for (const s of hostShortIds) knownShortIds.add(s)
  for (const s of meta.metaShortIds) knownShortIds.add(s)

  // 二级护栏：registry 与 .meta 两个数据源都可用才敢判「多余」；任一缺失整轮 no-op。
  const dataOk = reg.gateOk && meta.metaByFolder.size >= 1
  const folders = listSessionFolders(sessionsDir, fsImpl)
  const orphans = []
  const protectedFolders = []
  const reasons = []

  for (const folder of folders) {
    const metas = meta.metaByFolder.get(folder) || []
    const fShort = folderShortId(folder)
    let verdict
    let why
    if (!dataOk) {
      verdict = 'protect'
      why = '会话数据源不可用（registry 缺失/为空或 .meta 不可读），整轮 no-op 保护'
    } else if (
      metas.some((m) => m.id && isInternalSessionId(m.id)) &&
      !metas.some((m) => m.id && !isInternalSessionId(m.id))
    ) {
      // 内部记忆 / 后台任务会话（Mnemon worker）：不是 GUI 对话，不参与 1:1。
      // 精确按 .meta.id 命中，helper 只认 mnemon-task-/mnemon-run- 前缀；且要求该文件夹
      // 没有任何「非内部会话」的 .meta（防止竞态下同一文件夹混入真实对话记录时误删）。
      // 真实 session-* 对话、裸 uuid、归档会话一律不在此列，绝不误伤。
      verdict = 'orphan'
      why = '内部记忆/后台任务会话（mnemon-*），不是 GUI 对话，不参与 1:1'
    } else if (metas.some((m) => m.live)) {
      // live .meta 但 id 已不在 registry（registeredIds 含归档）：若宿主会话存储可读且查不到该会话目录，
      // 说明会话正文已被删除（registry 与宿主同步移除），只剩 live .meta + 空骨架 → 降级 orphan。
      // 护栏：宿主存储读不到（hostReadable=false）时绝不降级，保持保护（区分「读不到」与「确实删了」）。
      const deadLive = metas.find(
        (m) => m.live && m.id && !reg.registeredIds.has(m.id)
      )
      if (
        deadLive &&
        hostReadable &&
        !hostShortIds.has(shortId(deadLive.id))
      ) {
        verdict = 'orphan'
        why = 'live .meta 但会话已从 registry 与宿主会话存储中删除（正文已删，残留空骨架）'
      } else {
        verdict = 'protect'
        why = '有 live .meta 记录（在用会话）'
      }
    } else if (metas.some((m) => m.id && reg.registeredIds.has(m.id))) {
      verdict = 'protect'
      why = '.meta.id 命中已登记会话'
    } else if (fShort && knownShortIds.has(fShort)) {
      verdict = 'protect'
      why = '短 id ' + fShort + ' 命中已知会话'
    } else if (isHistoricalFolder(folder)) {
      verdict = 'protect'
      why = '历史命名（_sessio），短 id 不可靠，保守保护'
    } else {
      verdict = 'orphan'
      why = fShort
        ? '短 id ' + fShort + ' 不在任何已知会话中，且无 live/已登记 .meta'
        : '非会话命名，且无 .meta / 无登记会话'
    }
    if (verdict === 'protect') {
      protectedFolders.push({ folder, why })
    } else {
      const abs = path.join(sessionsDir, folder)
      let itemCount = 0
      let size = 0
      let mtime = 0
      try {
        const st = fsImpl.statSync(abs)
        mtime = st.mtimeMs
        itemCount = fsImpl.readdirSync(abs).length
      } catch {}
      orphans.push({ name: folder, abs, rel: 'sessions/' + folder + '/', isDir: true, itemCount, size, mtime, why })
    }
    reasons.push({ folder, verdict, why })
  }

  return {
    orphans,
    protectedFolders,
    reasons,
    gateOk: dataOk,
    meta: {
      workspaceRoot,
      foldersScanned: folders.length,
      registeredCount: reg.registeredIds.size,
      activeCount: reg.activeIds.size,
      knownShortCount: knownShortIds.size,
      hostReadable,
      metaRecordCount: meta.metaByFolder.size,
      registryError: reg.error,
      metaError: meta.error,
    },
  }
}
