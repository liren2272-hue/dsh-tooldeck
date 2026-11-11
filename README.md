# dsh-tooldeck

可扩展的「工具台」面板：把多个运维动作集中到设置 → 插件里，点击即运行。

## 工作区整理

两步闭环，扫描与隔离合为一个按钮（「扫描 + 隔离」一步到位，结果面板置顶显示隔离结果、检测清单折叠在下方）：

- **扫描并隔离散落文件（可回退）**：`workspace:clean`。一步完成：先扫描工作区根、`sessions/` 根、
  每个会话目录根上不符合布局规则的文件（含大小/时间），再同盘改名移入
  `.quarantine/<时间戳>/<原相对路径>`，保留目录结构，随时 `mv` 原路移回；不删除。
  （`scanStrays()` / `auditStrays()` 仍单独导出，供程序化只读扫描，不再单列只读按钮。）
- **清空隔离区（真删）**：`workspace:purge-quarantine`（danger）。只删 `.quarantine/` 内容，不可逆，
  需用户再次确认后才点。

判定口径（宁可漏报不可误伤）：
- **目录一律保护**：工作区根一级目录、`sessions/` 下的会话目录本身都不进清单、不搬移；
  只检查各层【根】上的散落文件。（旧口径「除 sessions 外一级目录也必须干净」需显式传
  `includeRootDirs: true`，默认关闭。）
- **隐藏文件/目录一律不碰**：`.bsk` / `.dsh` / `.cc-safety-net` / `.quarantine` / `.meta` / `.trash` 等。
- 白名单：`sessions/INDEX.md`、会话目录根 `README.md`。
- 会话文件夹 1:1 复合能力仍在（`lib/actions/session-mapping.mjs`），但默认关闭，需显式
  `moveOrphanSessions: true` 才启用；默认不搬任何会话文件夹。

- **查找插件尸体**：扫描「未安装插件」的残留——市场发现兼容性缓存、状态文件里的未装引用、`.bak` 备份、
  临时残留、孤儿数据目录、未装插件副本、悬空软链——输出清单并把整文件/目录类尸体整体移入
  `.quarantine/<时间戳>-corpses/`（跨盘复制+删源，可回退），状态文件则原地剔除未装引用并备份原件。
  桌面端/市场插件会反复把未装插件名写回状态文件，这就是「尸体总被搜出来反复提及」的根因。

新增动作只需在宿主侧注册一条 action（registry 驱动，卡片零改动）。

## 安装

```bash
dsh plugin --profile desktop add https://codeload.github.com/liren2272-hue/dsh-tooldeck/tar.gz/refs/tags/v1.0.0
```
