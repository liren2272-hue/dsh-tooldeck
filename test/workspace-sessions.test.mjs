/**
 * workspace:clean 复合「session 文件夹 ↔ 会话一一对应」回归测试。
 *
 * 运行：node --test test/workspace-sessions.test.mjs
 *
 * 负向对照：test/fixtures/workspace.before.mjs 是未修复原版（仅 import 路径不同），
 * 「多余 session 文件夹被整体移入隔离区」这条断言在它上面必须 FAIL、在新版上 PASS。
 * 端到端隔离在 os.tmpdir() 的临时目录树上跑，绝不碰真实 D:\DSH Workspace。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { quarantineStrays, auditStrays, purgeQuarantine } from '../lib/actions/workspace.mjs'
import {
  normId, shortId, folderShortId, isHistoricalFolder, scanOrphanSessionFolders,
} from '../lib/actions/session-mapping.mjs'
import { quarantineStrays as beforeQuarantine } from './fixtures/workspace.before.mjs'

const NODE = process.execPath // 仅用于打印，测试本身用当前 node

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tooldeck-' + tag + '-'))
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, JSON.stringify(obj))
}
function put(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, content)
}
function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true, maxRetries: 3 })
}

/**
 * 构造一个「确定夹具」工作区 + 外部 fixture 根（registry / host 会话存储放工作区之外，
 * 否则会被 scanStrays 当成工作区一级散落目录）。
 * 返回 { ws, env }；env 注入 registryPath / hostSessionsDir。
 */
function buildFixture() {
  const ws = tmpdir('ws')
  const fx = tmpdir('fx')
  const regPath = path.join(fx, 'workspace.json')
  const hostDir = path.join(fx, 'sessions')

  // registry：1 个活跃会话 + 1 个归档会话
  writeJson(regPath, {
    global: { archivedSessionIds: ['session-bbbb2222-0000-0000-0000-000000000000'] },
    tables: {
      workspaces: {
        w1: {
          path: ws,
          sessionIds: ['session-aaaa1111-0000-0000-0000-000000000000'],
        },
      },
    },
  })
  fs.mkdirSync(path.join(hostDir, 'session-aaaa1111-0000-0000-0000-000000000000'), { recursive: true })

  const sessions = path.join(ws, 'sessions')
  fs.mkdirSync(path.join(sessions, '.meta'), { recursive: true })
  // live .meta：folder 名与 id 短 id 故意不一致，验证「靠 .meta.folder 反查」而非短 id。
  writeJson(path.join(sessions, '.meta', 'live1.json'), {
    id: 'session-aaaa1111-0000-0000-0000-000000000000',
    folder: '2026-11-09_0241_e16854',
    archivedAt: 0,
  })
  writeJson(path.join(sessions, '.meta', 'arch1.json'), {
    id: 'bbbb2222-0000-0000-0000-000000000000',
    folder: '2026-10-01_0101_oldxxxx',
    archivedAt: 1700000000000,
  })

  // ① 活跃会话文件夹（有 live .meta）→ 必须保护
  put(path.join(sessions, '2026-11-09_0241_e16854', 'docs', 'keep.md'), 'keep')
  put(path.join(sessions, '2026-11-09_0241_e16854', 'README.md'), 'session readme')

  // ② 多余会话文件夹 A：会话格式名，短 id 不在任何已知会话 → 应整体隔离
  put(path.join(sessions, '2026-10-27_2239_f71dd3', 'tmp', 'junk.js'), 'junk')
  put(path.join(sessions, '2026-10-27_2239_f71dd3', 'README.md'), 'orphan readme')

  // ③ 多余会话文件夹 B：非会话命名，根的 probe.mjs 是 session-root 散落 → 随整个文件夹走，不能双搬
  put(path.join(sessions, 'skill-slim', 'probe.mjs'), 'probe')

  // ④ 历史命名 _sessio → 保守保护（放白名单 README.md，避免它变成会话根散落干扰计数）
  put(path.join(sessions, '2026-10-01_0101_sessio', 'README.md'), 'old')

  // sessions/ 根白名单文件 + 工作区根散落文件
  put(path.join(sessions, 'INDEX.md'), '# index')
  put(path.join(ws, 'stray-root.txt'), 'stray')

  return { ws, fx, env: { registryPath: regPath, hostSessionsDir: hostDir } }
}

/** 在隔离区里找唯一的 stamp 目录。 */
function quarantineStampDir(ws) {
  const qroot = path.join(ws, '.quarantine')
  const stamps = fs.readdirSync(qroot).filter((n) => /^\d{14}$/.test(n))
  assert.equal(stamps.length, 1, '应恰好生成 1 个时间戳隔离区')
  return path.join(qroot, stamps[0])
}

// ---------------------------------------------------------------------------
// 1) 判定模块纯函数
// ---------------------------------------------------------------------------
test('纯函数：normId / shortId / folderShortId / isHistoricalFolder', () => {
  assert.equal(normId('session-AB12-34CD'), 'ab1234cd')
  assert.equal(normId(''), '')
  assert.equal(shortId('session-e1685440-0000-0000-0000-000000000000'), 'e16854')
  assert.equal(folderShortId('2026-11-09_0241_e16854'), 'e16854')
  assert.equal(folderShortId('2026-10-01_0101_sessio'), null, '_sessio 历史命名短 id 不可靠，返回 null')
  assert.equal(folderShortId('skill-slim'), null)
  assert.equal(folderShortId('mnemon-run-v1-95d73394'), null)
  assert.equal(isHistoricalFolder('2026-10-01_0101_sessio'), true)
  assert.equal(isHistoricalFolder('2026-10-01_0101_abcdef'), false)
})

// ---------------------------------------------------------------------------
// 2) scanOrphanSessionFolders：gateOk=true 时正确分类 + 硬保护
// ---------------------------------------------------------------------------
test('1:1 判定：活跃会话/历史命名保护，多余文件夹识别，隐藏目录排除', () => {
  const { ws, fx, env } = buildFixture()
  try {
    const r = scanOrphanSessionFolders(ws, env)
    assert.equal(r.gateOk, true, '数据源可用，应放行 1:1 判定')
    assert.equal(r.meta.foldersScanned, 4, '只数 4 个非隐藏一级目录，排除 .meta')
    const orphanNames = r.orphans.map((o) => o.name).sort()
    assert.deepEqual(orphanNames, ['2026-10-27_2239_f71dd3', 'skill-slim'])
    const protectNames = r.protectedFolders.map((p) => p.folder).sort()
    assert.deepEqual(protectNames, ['2026-10-01_0101_sessio', '2026-11-09_0241_e16854'])
    // 活跃会话靠 live .meta 保护（folder 名短 id 与 id 短 id 故意不同）
    const liveProtect = r.protectedFolders.find((p) => p.folder === '2026-11-09_0241_e16854')
    assert.match(liveProtect.why, /live \.meta/)
    const hist = r.protectedFolders.find((p) => p.folder === '2026-10-01_0101_sessio')
    assert.match(hist.why, /历史命名/)
  } finally {
    rmrf(ws); rmrf(fx)
  }
})

// ---------------------------------------------------------------------------
// 3) 硬护栏：数据源不可用 → 整轮 no-op，一个文件夹都不判多余
// ---------------------------------------------------------------------------
test('护栏：registry 缺失 → orphans 恒空、quarantineStrays 不搬任何会话文件夹', () => {
  const { ws, fx, env } = buildFixture()
  const badEnv = { registryPath: path.join(fx, 'DOES-NOT-EXIST.json'), hostSessionsDir: env.hostSessionsDir }
  try {
    const r = scanOrphanSessionFolders(ws, badEnv)
    assert.equal(r.gateOk, false)
    assert.equal(r.orphans.length, 0, '数据源不可用，宁可留垃圾也不动活跃会话文件夹')
    assert.equal(r.protectedFolders.length, 4)

    // 清掉散落文件，确保 count 只可能来自会话文件夹 → 应为 0（无需隔离）
    fs.rmSync(path.join(ws, 'stray-root.txt'))
    fs.rmSync(path.join(ws, 'sessions', 'skill-slim', 'probe.mjs'))
    const result = quarantineStrays(ws, badEnv, { moveOrphanSessions: true })
    assert.equal(result.ok, true)
    assert.equal(result.data.moved.length, 0, '护栏生效时一个文件夹都不搬')
    assert.match(result.data.scanText, /整轮跳过 1:1 清理/)
    for (const name of ['2026-11-09_0241_e16854', '2026-10-27_2239_f71dd3', 'skill-slim', '2026-10-01_0101_sessio']) {
      assert.ok(fs.existsSync(path.join(ws, 'sessions', name)), '保护：' + name + ' 仍在原位')
    }
  } finally {
    rmrf(ws); rmrf(fx)
  }
})

// ---------------------------------------------------------------------------
// 4) 端到端：新版 quarantineStrays 把散落项 + 多余会话文件夹一起隔离
// ---------------------------------------------------------------------------
test('端到端：散落项与多余 session 文件夹一起进入同一隔离区，可回退、双分区文本', () => {
  const { ws, fx, env } = buildFixture()
  try {
    const result = quarantineStrays(ws, env, { moveOrphanSessions: true })
    assert.equal(result.ok, true, '无跳过')
    assert.equal(result.data.count, 3, '1 个散落文件 + 2 个多余文件夹')

    const q = quarantineStampDir(ws)
    // 散落文件
    assert.ok(fs.existsSync(path.join(q, 'stray-root.txt')), '工作区根散落文件进隔离区')
    assert.ok(!fs.existsSync(path.join(ws, 'stray-root.txt')))
    // 两个多余文件夹整体进 sessions/
    for (const name of ['2026-10-27_2239_f71dd3', 'skill-slim']) {
      assert.ok(fs.existsSync(path.join(q, 'sessions', name)), '多余文件夹整体进隔离区：' + name)
      assert.ok(!fs.existsSync(path.join(ws, 'sessions', name)), '原位置已移走：' + name)
    }
    // 整体搬移带上了子内容（不是只搬根文件）
    assert.ok(fs.existsSync(path.join(q, 'sessions', '2026-10-27_2239_f71dd3', 'tmp', 'junk.js')))
    assert.ok(fs.existsSync(path.join(q, 'sessions', 'skill-slim', 'probe.mjs')))
    // 避免双搬：moved 里没有单独搬 skill-slim/probe.mjs 的条目
    assert.ok(!result.data.moved.some((m) => m.from === 'sessions/skill-slim/probe.mjs'), '不能既整体搬又单独搬根散落文件')
    // 活跃/历史文件夹原地不动
    for (const name of ['2026-11-09_0241_e16854', '2026-10-01_0101_sessio']) {
      assert.ok(fs.existsSync(path.join(ws, 'sessions', name)), '保护：' + name + ' 未被搬走')
    }
    // 双分区文本（客户端结果面板置顶结论 + 折叠清单）
    assert.match(result.data.actionText, /多余 session 文件夹移动 2 个/)
    assert.match(result.data.scanText, /1:1 校验/)
    assert.match(result.data.scanText, /保护 2 个；多余（无对应会话）2 个/)
    assert.equal(result.text, result.data.scanText + '\n' + result.data.actionText)
  } finally {
    rmrf(ws); rmrf(fx)
  }
})

// ---------------------------------------------------------------------------
// 5) 负向对照：未修复原版必须 FAIL「多余会话文件夹被隔离」这条断言
// ---------------------------------------------------------------------------
test('负向对照：原版 quarantineStrays 不处理 session 文件夹（此特性由本次复合引入）', () => {
  const { ws, fx, env } = buildFixture()
  try {
    // 原版不读 registry/.meta，也不用 env；在同样的夹具上跑。
    const result = beforeQuarantine(ws)
    assert.equal(result.ok, true)
    const q = quarantineStampDir(ws)
    assert.ok(fs.existsSync(path.join(q, 'stray-root.txt')), '原版仍会搬散落文件')
    // 关键：原版【不会】把多余会话文件夹整体搬进 sessions/
    const orphanMovedWhole = fs.existsSync(path.join(q, 'sessions', '2026-10-27_2239_f71dd3'))
    assert.equal(orphanMovedWhole, false,
      '未修复原版不应搬多余会话文件夹 —— 若此断言失败说明夹具不是原版')
    // 而新版在同样夹具上应为 true（上面第 4 条已断言）。这里显式做 A/B：
    const ws2 = tmpdir('ws-neg')
    const fx2 = tmpdir('fx-neg')
    // 复用同一 fixture 结构（重建一份，因 ws 已被原版改动）
    const env2 = { registryPath: path.join(fx2, 'workspace.json'), hostSessionsDir: path.join(fx2, 'sessions') }
    writeJson(env2.registryPath, {
      global: { archivedSessionIds: ['session-bbbb2222-0000-0000-0000-000000000000'] },
      tables: { workspaces: { w1: { path: ws2, sessionIds: ['session-aaaa1111-0000-0000-0000-000000000000'] } } },
    })
    fs.mkdirSync(path.join(env2.hostSessionsDir, 'session-aaaa1111-0000-0000-0000-000000000000'), { recursive: true })
    fs.mkdirSync(path.join(ws2, 'sessions', '.meta'), { recursive: true })
    writeJson(path.join(ws2, 'sessions', '.meta', 'live1.json'), {
      id: 'session-aaaa1111-0000-0000-0000-000000000000', folder: '2026-11-09_0241_e16854', archivedAt: 0,
    })
    put(path.join(ws2, 'sessions', '2026-11-09_0241_e16854', 'README.md'), 'x')
    put(path.join(ws2, 'sessions', '2026-10-27_2239_f71dd3', 'junk.txt'), 'x')
    put(path.join(ws2, 'stray.txt'), 'x')
    const newResult = quarantineStrays(ws2, env2, { moveOrphanSessions: true })
    const q2 = quarantineStampDir(ws2)
    assert.equal(fs.existsSync(path.join(q2, 'sessions', '2026-10-27_2239_f71dd3')), true,
      '新版必须搬多余会话文件夹 —— 负向对照要真红：原版 false / 新版 true')
    assert.equal(newResult.ok, true)
    rmrf(ws2); rmrf(fx2)
  } finally {
    rmrf(ws); rmrf(fx)
  }
})

// ---------------------------------------------------------------------------
// 6) 三步闭环：只读审计不动盘、目录/隐藏项不误伤、隔离可回退、purge 才真删
// ---------------------------------------------------------------------------
test('三步：audit 只读 → quarantineStrays 可回退 → purgeQuarantine 才真删', () => {
  const ws = tmpdir('three')
  try {
    const sessions = path.join(ws, 'sessions')
    put(path.join(sessions, '.meta', 'keep.json'), '{}')
    put(path.join(sessions, 'INDEX.md'), '# index')
    put(path.join(ws, 'loose.txt'), 'loose')
    put(path.join(ws, 'err.txt'), 'err')
    // 目录与隐藏项：一律保护
    put(path.join(ws, 'assets', 'a.png'), 'x')
    put(path.join(ws, 'output', 'r.docx'), 'x')
    put(path.join(ws, '.curate-cache.json'), '{}')
    put(path.join(ws, '.bsk', 'x'), 'x')
    put(path.join(sessions, 'sessA', 'stray.log'), 'stray')
    put(path.join(sessions, 'sessA', 'README.md'), 'ok')

    const audit = auditStrays(ws)
    assert.equal(audit.ok, true)
    assert.equal(audit.data.readOnly, true)
    assert.deepEqual(
      audit.data.strays.map((s) => s.rel).sort(),
      ['/err.txt', '/loose.txt', 'sessions/sessA/stray.log'].sort(),
    )
    // 只读：文件仍在原位，隔离区未创建
    assert.ok(fs.existsSync(path.join(ws, 'loose.txt')))
    assert.equal(fs.existsSync(path.join(ws, '.quarantine')), false)
    assert.match(audit.data.actionText, /只读盘点完成/)

    const clean = quarantineStrays(ws)
    assert.equal(clean.ok, true)
    assert.equal(clean.data.count, 3)
    const q = quarantineStampDir(ws)
    assert.ok(fs.existsSync(path.join(q, 'loose.txt')))
    assert.ok(fs.existsSync(path.join(q, 'err.txt')))
    assert.ok(fs.existsSync(path.join(q, 'sessions', 'sessA', 'stray.log')))
    // 目录、隐藏项、白名单原地不动
    for (const keep of [
      'assets/a.png', 'output/r.docx', '.curate-cache.json', '.bsk/x',
      'sessions/INDEX.md', 'sessions/.meta/keep.json', 'sessions/sessA/README.md',
    ]) {
      assert.ok(fs.existsSync(path.join(ws, keep)), '保护：' + keep)
    }
    assert.ok(fs.existsSync(path.join(sessions, 'sessA')), '会话文件夹不搬')
    assert.match(clean.data.actionText, /散落项移动 3 个；多余 session 文件夹移动 0 个/)

    // 可回退：原路移回
    fs.renameSync(path.join(q, 'loose.txt'), path.join(ws, 'loose.txt'))
    assert.ok(fs.existsSync(path.join(ws, 'loose.txt')))

    // 真删只发生在 purge
    const purge = purgeQuarantine(ws)
    assert.equal(purge.ok, true)
    assert.equal(purge.data.removed, 1)
    assert.equal(fs.readdirSync(path.join(ws, '.quarantine')).length, 0)
  } finally {
    rmrf(ws)
  }
})

// ---------------------------------------------------------------------------
// 7) 目录保护：默认既不判也不搬会话文件夹（1:1 复合需显式 moveOrphanSessions）
// ---------------------------------------------------------------------------
test('目录保护：默认不动任何会话文件夹', () => {
  const { ws, fx, env } = buildFixture()
  try {
    const r = quarantineStrays(ws, env)
    assert.equal(r.ok, true)
    assert.equal(r.data.orphanScan, null, '默认不做 1:1 判定')
    for (const name of ['2026-10-27_2239_f71dd3', 'skill-slim', '2026-11-09_0241_e16854', '2026-10-01_0101_sessio']) {
      assert.ok(fs.existsSync(path.join(ws, 'sessions', name)), '会话文件夹一律不搬：' + name)
    }
    assert.ok(fs.existsSync(path.join(quarantineStampDir(ws), 'sessions', 'skill-slim', 'probe.mjs')))
  } finally {
    rmrf(ws); rmrf(fx)
  }
})
