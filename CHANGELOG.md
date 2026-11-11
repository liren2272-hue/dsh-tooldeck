# CHANGELOG

## [1.3.1] — 2026-11-11

### 变更
- **工作区整理：扫描与隔离按钮合一**。移除独立的只读「扫描散落文件（只读）」（`workspace:audit`）按钮，
  「扫描 + 隔离」合并为一个按钮 `workspace:clean`（标题「扫描并隔离散落文件（可回退）」）：
  一次点击完成扫描 + 同盘隔离移入 `.quarantine/<时间戳>/`，结果面板置顶显示隔离结果、
  检测清单折叠在下方。工作区大类由 3 个按钮收敛为 2 个（+「清空隔离区（真删）」）。
- `scanStrays()` / `auditStrays()` 仍导出，供程序化只读扫描与测试，只是不再单列成卡片按钮。
- 同步更新 README、package.json description 与本 CHANGELOG。

## [1.3.0] — 2026-11-10

### 新增
- **「扫描散落文件（只读）→ 隔离散落文件（可回退）→ 清空隔离区（真删）」三步闭环**：
  - `workspace:audit`（新）：只读列出散落文件（含大小/时间），不写盘、不移动；`data.readOnly=true`。
  - `workspace:clean`：把清单里的散落文件同盘 `renameSync` 移入 `.quarantine/<时间戳>/<原相对路径>`，
    保留目录结构，可原路 `mv` 回退，不删除。
  - `workspace:purge-quarantine`：仅此一条真删，`danger:true`，只清 `.quarantine/` 内容。

### 变更（判定口径：不误伤目录与隐藏文件）
- 默认**目录一律保护**：工作区根一级目录不再进散落清单；`includeRootDirs: true` 才恢复旧口径。
- 隐藏文件/目录（`.` 开头）始终不进清单；`sessions/INDEX.md` 与会话根 `README.md` 仍白名单。
- 会话文件夹 1:1 复合能力**默认关闭**（`quarantineStrays(ws, env, { moveOrphanSessions: true })`
  才启用），默认不搬任何会话文件夹；`data.orphanScan` 为 `null`。

### 测试
- `test/workspace-sessions.test.mjs` 新增 2 例：三步闭环（只读不动盘 → 隔离可回退 → purge 才真删）与
  「目录保护：默认不动任何会话文件夹」；原 1:1 用例显式传 `moveOrphanSessions: true`。

## [1.2.0] — 2026-11-09

### 新增
- 「整理工作区」按钮（`workspace:clean`）**复合**「session 文件夹 ↔ 会话一一对应」能力，
  **不新增按钮**：原按钮在扫描并隔离散落文件/目录之外，再判定 `sessions/` 下每个一级文件夹
  是否有对应会话，把「多余」文件夹整体移入同一 `.quarantine/<时间戳>/sessions/<folder>/`
  （同盘改名，可回退，与散落项共用隔离区）。
- 新增自包含判定模块 `lib/actions/session-mapping.mjs`（仅 node: 内置模块）：
  - 权威口径用 `workspace.json` 的 `tables.workspaces[*].sessionIds − global.archivedSessionIds`
    得到活跃会话；**不用运行时 `sessions.list()`**（含归档与 subagent，会放大活跃集）。
  - 结合 host 会话存储目录与 `sessions/.meta/*.json` 构造已知短 id 集合，再用
    `.meta.folder ↔ .meta.id` 反查归属；名字短 id 匹配失败不草率判「无对应会话」。
  - 多重硬保护：有 live `.meta` 的在用会话、`.meta.id` 命中已登记会话、短 id 命中任意已知会话、
    历史命名（`_sessio`，当年 shortId 未剥 `session-` 前缀）、隐藏目录一律保护；
    registry 缺失/为空或 `.meta` 不可读时 `gateOk=false`，整轮 no-op，一个文件夹都不动。
  - 绝不用 `process.cwd()` 推导当前会话（实测宿主进程 cwd ≠ 会话目录）。
- 结果文本沿用「检测清单 + 隔离结果」双分区（`data.scanText` / `data.actionText`）：
  清单里含逐目录 保护/多余 判定及原因，结论里分别统计散落项与多余会话文件夹的移动数。
  属于多余会话文件夹根的散落项不再单独搬（整个文件夹整体移走），避免双搬/竞态。

### 说明
- 隔离一律同盘 `renameSync` 进隔离区，不删除；「清空隔离区」才物理删除，随时可原路找回。
- 回归测试 `test/workspace-sessions.test.mjs`（node:test）含负向对照夹具
  `test/fixtures/workspace.before.mjs`：未修复原版不处理会话文件夹，此断言在原版上必 FAIL、
  在新版上 PASS，证明特性确由本次复合引入。

## [1.1.1] — 2026-11-07

### 修复
- **「清空隔离区」删除报错删不掉**：隔离区里若有 git 仓库残留（`.git/objects/pack/pack-*.pack/.idx/.rev`），
  这些文件被 git 标记为只读属性，旧版直接 `rmSync(recursive,force)` 遇到只读文件抛 `EPERM`，
  导致整批目录删不掉。现改为：先递归清只读属性（目录 `0o777`、文件 `0o666`，软链跳过不跟随）再删除；
  删除时若仍遇 `EPERM/EACCES/EBUSY`，清只读后重试一次。结果文本会提示清除了多少个只读文件。
- **结果面板清除日志被检测日志挡住**：旧版把「检测清单 + 隔离/清除结果」塞进同一个 `<pre>`，
  长检测表把真正关心的清除结果挤出视口。现拆成两个分区——**清除/隔离结果置顶常显**，
  检测清单折叠成可展开的 `<details>`（点开查看完整列表），互不遮挡；无分区数据时回退旧版单块展示。

### 说明
- 两处修复均针对 v1.1.0 引入的「查找插件尸体 / 清空隔离区」流程，已通过真实隔离区（含 27 个只读
  git pack 文件、2 个批次共 2188 个文件）真删验收：`removed:2 clearedReadOnly:27 errors:[]`。

## [1.1.0] — 2026-11-07

### 新增
- 「工作区整理」新增动作 **查找插件尸体**（`workspace:find-corpses`）与核心模块 `lib/actions/corpses.mjs`。
  - 扫描 7 类未安装插件残留：市场发现兼容性缓存（`discovery-*.json`）、状态文件里的未装引用、
    `.bak` 配置备份、临时/调试残留、孤儿插件数据目录、未安装插件副本、悬空插件软链。
  - 状态文件（`.dsh-market/state.json`、`dsh-plugin-categories/state.json`、`compatibility.json`）
    不整文件搬走，改为「原地剔除未装引用并保留 BOM/结构/已装项」，原始文件先备份进隔离区。
  - 整文件/目录类尸体整体移入 `<workspace>/.quarantine/<时间戳>-corpses/`，跨盘用 `cpSync + rmSync`
    （不依赖同盘 rename），并写 `manifest.json` 回退清单。
  - 与现有「清空隔离区」按钮共用隔离区：查找 = 隔离，清空隔离区 = 物理删除（即「删除尸体」）。
- 根因：桌面端/市场插件会在每次启动时把未安装插件名重新写回状态文件，导致清理后仍反复出现；
  本动作可随时重跑，扫描器兼容「发现缓存存在/不存在」「状态引用已清/又重生」两种状态。

### 说明
- 所有路径经 `os.homedir()` 动态定位，不写死账号路径；模块自包含，仅用 node: 内置模块。
- 已安装插件及其运行配置一律不动；单条失败只记进 skipped，不抛回宿主。

## [1.0.0] — 初始版本
- 工具台面板：健康体检、回收僵尸 Run、工作区散落文件隔离与清空隔离区。
