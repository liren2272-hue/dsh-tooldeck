/**
 * 「整理工作区」补 Mnemon 记忆/后台任务文件夹的 1:1 判定 —— 回归测试。
 *
 * 运行：node --test test/workspace-mnemon.test.mjs
 *
 * 背景：Mnemon worker（mnemon-task-v1-* / mnemon-run-v1-*）既在宿主会话存储里有目录、
 * 又在 sessions/.meta 里留了 live 记录（archivedAt=0），旧版 1:1 判定两重保护都把它当成
 * 「在用会话」而保护，导致「整理工作区」清不掉它，对话↔文件夹无法一一对应。
 *
 * 本套件验证：
 *   - isInternalSessionId 精确命中 mnemon-task-/mnemon-run-，绝不误伤 session- 前缀会话 / 裸 uuid；
 *   - 新版把 mnemon 文件夹判 orphan，旧版（session-mapping.before.mjs）判 protect（负向对照真红）；
 *   - GUI 按钮（不带 params）默认启用 1:1，经 handler 端到端把 mnemon 文件夹可回退地隔离；
 *   - 现存真实对话文件夹、历史文件夹一律保护，隔离后做 1:1 对账；
 *   - gateOk=false / 同一文件夹混入真实对话 .meta 时整轮保守保护，绝不误删；
 *   - resolveCleanOpts 默认值与显式覆盖。
 *
 * 端到端全部在 os.tmpdir() 临时目录树上跑，绝不碰真实 D:\DSH Workspace。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { workspaceActions, resolveCleanOpts, quarantineStrays } from '../lib/actions/workspace.mjs'
import { isInternalSessionId, scanOrphanSessionFolders } from '../lib/actions/session-mapping.mjs'

function tmpdir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-tooldeck-mnemon-' + tag + '-'))
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
function stampDir(ws) {
  const qroot = path.join(ws, '.quarantine')
  const stamps = fs.readdirSync(qroot).filter((n) => /^\d{14}$/.test(n))
  assert.equal(stamps.length, 1, '应恰好生成 1 个时间戳隔离区')
  return path.join(qroot, stamps[0])
}

const REAL_1 = 'session-aaaa1111-0000-0000-0000-000000000000'
const REAL_2 = 'session-cccc3333-0000-0000-0000-000000000000'
const MNEMON_ID = 'mnemon-task-v1-116c59f0-3748-4ba4-95a0-b568db271bae'
const MNEMON_FOLDER = '2026-11-12_2305_mnemon'
const REAL_F_1 = '2026-11-09_0241_e16854'
const REAL_F_2 = '2026-11-10_0900_cccc33'
const HIST_F = '2026-10-01_0101_sessio'

/**
 * 受控夹具：2 个真实 GUI 对话 + 1 个 Mnemon 内部任务 + 1 个历史命名文件夹。
 * 关键点：Mnemon 任务在「宿主会话存储」里也有目录（这正是旧版误保护的根因），
 * 且 .meta 是 live（archivedAt=0），文件夹后缀 _mnemon 的短 id 也命中 mnemon。
 */
function buildMnemonFixture({ mixedMeta = false } = {}) {
  const ws = tmpdir('ws')
  const fx = tmpdir('fx')
  const regPath = path.join(fx, 'workspace.json')
  const hostDir = path.join(fx, 'sessions')

  writeJson(regPath, {
    global: { archivedSessionIds: ['session-bbbb2222-0000-0000-0000-000000000000'] },
    tables: { workspaces: { w1: { path: ws, sessionIds: [REAL_1, REAL_2] } } },
  })
  // 宿主会话存储：真实对话 + Mnemon 任务目录都在
  for (const id of [REAL_1, REAL_2, MNEMON_ID]) {
    fs.mkdirSync(path.join(hostDir, id), { recursive: true })
  }

  const sessions = path.join(ws, 'sessions')
  fs.mkdirSync(path.join(sessions, '.meta'), { recursive: true })
  writeJson(path.join(sessions, '.meta', 'real1.json'), { id: REAL_1, folder: REAL_F_1, archivedAt: 0 })
  writeJson(path.join(sessions, '.meta', 'real2.json'), { id: REAL_2, folder: REAL_F_2, archivedAt: 0 })
  writeJson(path.join(sessions, '.meta', 'arch1.json'), {
    id: 'bbbb2222-0000-0000-0000-000000000000', folder: '2026-10-01_0101_oldxxxx', archivedAt: 1700000000000,
  })
  writeJson(path.join(sessions, '.meta', 'mnemon.json'), {
    id: MNEMON_ID, folder: MNEMON_FOLDER, cwd: ws,
    createdAt: Date.now(), title: 'Mnemon · Skills', origin: '',
  })
  if (mixedMeta) {
    // 竞态：同一文件夹里又混入一条真实对话 .meta → 绝不能判 orphan（宁可漏报不可误伤）
    writeJson(path.join(sessions, '.meta', 'mnemon-mixed.json'), {
      id: REAL_1, folder: MNEMON_FOLDER, archivedAt: 0,
    })
  }

  put(path.join(sessions, REAL_F_1, 'README.md'), 'real 1')
  put(path.join(sessions, REAL_F_2, 'README.md'), 'real 2')
  put(path.join(sessions, MNEMON_FOLDER, 'README.md'), 'Mnemon · Skills')
  put(path.join(sessions, HIST_F, 'README.md'), 'old')
  put(path.join(sessions, 'INDEX.md'), '# index')
  put(path.join(ws, 'stray-root.txt'), 'stray') // 顺带验证「散落项 + 多余文件夹」双层同时生效

  return { ws, fx, env: { registryPath: regPath, hostSessionsDir: hostDir } }
}

// ---------------------------------------------------------------------------
// 1) isInternalSessionId 纯函数：只认 mnemon-task-/mnemon-run-，兼容归一化 id 与大小写
// ---------------------------------------------------------------------------
test('isInternalSessionId：精确命中 Mnemon worker，绝不误伤真实对话', () => {
  assert.equal(isInternalSessionId(MNEMON_ID), true)
  assert.equal(isInternalSessionId('mnemon-run-v1-c131d3a0'), true)
  assert.equal(isInternalSessionId('MNEMON-task-V2-deadbeef'), true, '大小写不敏感')
  // readMetaRecords 存的是 normId 后的 id（去横杠小写），helper 必须同样命中
  assert.equal(isInternalSessionId('mnemontaskv1116c59f037484ba495a0b568db271bae'), true, '兼容已归一化 id')
  assert.equal(isInternalSessionId('mnemonrunv1c131d3a0'), true)
  // 真实 GUI 对话、裸 uuid、名字里带 mnemon 字样的真实会话：一律不命中
  assert.equal(isInternalSessionId(REAL_1), false)
  assert.equal(isInternalSessionId('session-9a2865f4-48d1-47df-9127-8fe0b0c15f24'), false)
  assert.equal(isInternalSessionId('65c9321a-a68b-436e-b5ce-099dcd841c1b'), false, '裸 uuid 子会话不命中')
  assert.equal(isInternalSessionId('session-mnemon-notes'), false, '名字含 mnemon 但非前缀不命中')
  assert.equal(isInternalSessionId(''), false)
  assert.equal(isInternalSessionId(undefined), false)
})

// ---------------------------------------------------------------------------
// 2) resolveCleanOpts：GUI 点击不带 params 时默认启用 1:1；显式可覆盖
// ---------------------------------------------------------------------------
test('resolveCleanOpts：默认启用 1:1 判定，显式参数可覆盖', () => {
  assert.deepEqual(resolveCleanOpts(), { protectDirs: true, moveOrphanSessions: true })
  assert.deepEqual(resolveCleanOpts({ includeRootDirs: true }), { protectDirs: false, moveOrphanSessions: true })
  assert.deepEqual(resolveCleanOpts({ moveOrphanSessions: false }), { protectDirs: true, moveOrphanSessions: false })
  assert.deepEqual(
    resolveCleanOpts({ includeRootDirs: true, moveOrphanSessions: false }),
    { protectDirs: false, moveOrphanSessions: false },
  )
})

// ---------------------------------------------------------------------------
// 3) 1:1 判定：mnemon 文件夹判 orphan，真实对话 / 历史命名一律保护 + 负向对照真红
// ---------------------------------------------------------------------------
test('1:1 判定：Mnemon 文件夹判多余；真实对话/历史仍保护；旧版误保护（负向对照）', async () => {
  const a = buildMnemonFixture()
  const b = buildMnemonFixture()
  try {
    const r = scanOrphanSessionFolders(a.ws, a.env)
    assert.equal(r.gateOk, true, '数据源可用才敢判')
    const orphanNames = r.orphans.map((o) => o.name)
    assert.ok(orphanNames.includes(MNEMON_FOLDER), 'Mnemon 文件夹应判 orphan')
    assert.equal(orphanNames.includes(REAL_F_1), false, '真实对话 1 绝不判多余')
    assert.equal(orphanNames.includes(REAL_F_2), false, '真实对话 2 绝不判多余')
    assert.equal(orphanNames.includes(HIST_F), false, '历史命名绝不判多余')
    const mnemonReason = r.reasons.find((x) => x.folder === MNEMON_FOLDER)
    assert.equal(mnemonReason.verdict, 'orphan')
    assert.match(mnemonReason.why, /内部记忆|mnemon/i)

    // 负向对照：未修复原版把 live .meta 一律保护 → Mnemon 文件夹进不了多余栏
    const before = await import('./fixtures/session-mapping.before.mjs')
    const rBefore = before.scanOrphanSessionFolders(b.ws, b.env)
    const oldVerdict = rBefore.reasons.find((x) => x.folder === MNEMON_FOLDER)
    assert.equal(oldVerdict.verdict, 'protect',
      '旧版应把 Mnemon live .meta 误判为 protect —— 若失败说明夹具不是旧版')
    assert.ok(!rBefore.orphans.some((o) => o.name === MNEMON_FOLDER),
      '旧版 orphans 里没有 Mnemon 文件夹（这正是要修的 bug）')
  } finally {
    rmrf(a.ws); rmrf(a.fx); rmrf(b.ws); rmrf(b.fx)
  }
})

// ---------------------------------------------------------------------------
// 4) 端到端：模拟 GUI 点击（不带 moveOrphanSessions）→ 默认启用 1:1、隔离 mnemon、1:1 对账
// ---------------------------------------------------------------------------
test('端到端（GUI 按钮路径）：默认隔离 Mnemon 文件夹、真实对话原地不动、可回退、1:1 对账', async () => {
  const { ws, fx, env } = buildMnemonFixture()
  try {
    const clean = workspaceActions.find((a) => a.id === 'workspace:clean')
    assert.ok(clean, 'workspace:clean 动作存在')
    assert.match(clean.title, /多余会话文件夹/, '卡片标题应说明会整理多余会话文件夹')
    assert.match(clean.description, /1:1/, '卡片说明应含 1:1 判定')

    // 关键：模拟 GUI 点击 —— 只注入离线 env/workspaceRoot，不传 moveOrphanSessions
    // （客户端 lib/client/index.js 的 onClick 就是 runAction(action.id)，不带 params）。
    const result = await clean.handler({ workspaceRoot: ws, env })
    assert.equal(result.ok, true)
    assert.ok(result.data.orphanScan, 'GUI 默认应启用 1:1 判定（orphanScan 非 null）')
    assert.equal(result.data.orphanScan.gateOk, true)

    const q = stampDir(ws)
    // ① Mnemon 文件夹整体移入隔离区（可回退）
    assert.ok(fs.existsSync(path.join(q, 'sessions', MNEMON_FOLDER, 'README.md')),
      'Mnemon 文件夹应整体进入 .quarantine/<stamp>/sessions/')
    assert.equal(fs.existsSync(path.join(ws, 'sessions', MNEMON_FOLDER)), false,
      'live 树里不应再有 Mnemon 文件夹')
    const movedMnemon = result.data.moved.find((m) => m.orphanSession === true)
    assert.ok(movedMnemon, 'moved 里应有 orphanSession 记录')
    // ② 散落项也一并隔离（双层同时生效）
    assert.ok(fs.existsSync(path.join(q, 'stray-root.txt')), '根散落项也应隔离')
    // ③ 真实对话 / 历史文件夹原地不动（绝不误删）
    for (const keep of [REAL_F_1, REAL_F_2, HIST_F]) {
      assert.ok(fs.existsSync(path.join(ws, 'sessions', keep, 'README.md')),
        '保护：' + keep + ' 仍在原位')
    }

    // ④ 1:1 对账：清理后 live 一级目录 = 2 个真实对话 + 1 个历史保护；每个活跃会话都有对应文件夹
    const liveFolders = fs.readdirSync(path.join(ws, 'sessions'), { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name).sort()
    const protectedNames = result.data.orphanScan.protectedFolders.map((p) => p.folder).sort()
    assert.deepEqual(liveFolders, protectedNames, '清理后 live 目录恰好 = 被保护的文件夹，无多余')
    assert.equal(liveFolders.includes(MNEMON_FOLDER), false)
    assert.equal(liveFolders.includes(REAL_F_1), true)
    assert.equal(liveFolders.includes(REAL_F_2), true)

    // ⑤ 可回退：原路移回能成功（隔离是同盘 rename，不是删除）
    fs.renameSync(path.join(q, 'sessions', MNEMON_FOLDER), path.join(ws, 'sessions', MNEMON_FOLDER))
    assert.ok(fs.existsSync(path.join(ws, 'sessions', MNEMON_FOLDER, 'README.md')),
      '隔离可原路移回')

    // ⑥ 幂等：再判一次（此时 mnemon 文件夹已回原位）仍只把它判 orphan，真实对话仍保护
    const r2 = scanOrphanSessionFolders(ws, env)
    assert.ok(r2.orphans.some((o) => o.name === MNEMON_FOLDER))
    assert.ok(!r2.orphans.some((o) => o.name === REAL_F_1 || o.name === REAL_F_2))
  } finally {
    rmrf(ws); rmrf(fx)
  }
})

// ---------------------------------------------------------------------------
// 5) 护栏：gateOk=false 整轮 no-op，一个会话文件夹都不搬
// ---------------------------------------------------------------------------
test('护栏：registry 缺失 → 整轮 no-op，Mnemon 与真实对话文件夹都不动', async () => {
  const { ws, fx, env } = buildMnemonFixture()
  const badEnv = { registryPath: path.join(fx, 'NO-SUCH.json'), hostSessionsDir: env.hostSessionsDir }
  try {
    const clean = workspaceActions.find((a) => a.id === 'workspace:clean')
    const result = await clean.handler({ workspaceRoot: ws, env: badEnv })
    assert.equal(result.data.orphanScan.gateOk, false)
    const orphanMoves = result.data.moved.filter((m) => m.orphanSession === true)
    assert.equal(orphanMoves.length, 0, '数据源不可用时一个会话文件夹都不搬')
    for (const keep of [REAL_F_1, REAL_F_2, HIST_F, MNEMON_FOLDER]) {
      assert.ok(fs.existsSync(path.join(ws, 'sessions', keep)), 'no-op 保护：' + keep)
    }
  } finally {
    rmrf(ws); rmrf(fx)
  }
})

// ---------------------------------------------------------------------------
// 6) 护栏：同一文件夹混入真实对话 .meta 时绝不判 orphan（宁可漏报不可误伤）
// ---------------------------------------------------------------------------
test('护栏：Mnemon 文件夹混入真实对话 .meta → 保守保护，绝不误删', () => {
  const { ws, fx, env } = buildMnemonFixture({ mixedMeta: true })
  try {
    const r = scanOrphanSessionFolders(ws, env)
    assert.equal(r.gateOk, true)
    assert.ok(!r.orphans.some((o) => o.name === MNEMON_FOLDER),
      '存在非内部会话 .meta 时不得把该文件夹判多余')
    const v = r.reasons.find((x) => x.folder === MNEMON_FOLDER)
    assert.equal(v.verdict, 'protect')
    assert.ok(!r.orphans.some((o) => o.name === REAL_F_1 || o.name === REAL_F_2))
  } finally {
    rmrf(ws); rmrf(fx)
  }
})

// ---------------------------------------------------------------------------
// 7) 显式关闭：quarantineStrays 函数默认不搬目录（保护程序化调用与既有用例）
// ---------------------------------------------------------------------------
test('兼容：quarantineStrays 直接调用不传 opts 仍不搬任何会话文件夹', () => {
  const { ws, fx, env } = buildMnemonFixture()
  try {
    const r = quarantineStrays(ws, env)
    assert.equal(r.data.orphanScan, null, '函数默认值不变：不传 opts 不做 1:1 判定')
    for (const keep of [REAL_F_1, REAL_F_2, HIST_F, MNEMON_FOLDER]) {
      assert.ok(fs.existsSync(path.join(ws, 'sessions', keep)), '默认不搬：' + keep)
    }
  } finally {
    rmrf(ws); rmrf(fx)
  }
})
