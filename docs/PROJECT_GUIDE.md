# BlockCraft 使用手册

本手册配合界面截图说明常用操作。截图已裁去浏览器顶部区域，并遮住画面中的公网 IP；局域网地址和其他界面信息保留。

## 1. 总览与主题

总览页同时展示主机资源、面板状态、FRP 通道和所有世界。点击顶部“主题”可在浅色、深色和 Minecraft 绿主题间切换，选择会保存在浏览器。

| 浅色主题 | 深色主题 | Minecraft 绿主题 |
|---|---|---|
| ![浅色主题](assets/screenshots/02-overview-theme-light.jpg) | ![深色主题](assets/screenshots/03-overview-theme-dark.jpg) | ![Minecraft 绿主题](assets/screenshots/04-overview-theme-green.jpg) |

世界卡片上的“显示端口”可复制本地或公网连接地址；“配置”“控制台”“备份与回退”“MOD 管理”“玩家管理”分别打开对应页面。新建世界和导入整合包从页面右上方开始。

![总览中的世界卡片](assets/screenshots/01-overview-stopped.jpg)

## 2. 安装与启动

### Windows 桌面版

1. 下载并完整解压 Windows x64 ZIP 到可写目录。
2. 双击 `BlockCraft.exe`，首次启动等待面板准备完成后会打开浏览器。
3. 后续可从系统托盘打开面板或仅重启面板。安全退出会先停止世界、FRP 和面板服务，再关闭启动器。

### Ubuntu 桌面版或服务器

```bash
git clone https://github.com/yumo666666/blockcraft.git
cd blockcraft
bash bin/ubuntu.sh
```

面板启动后，按终端给出的地址和登录令牌进入。Ubuntu 桌面环境可从浏览器访问；服务器环境通过 SSH 终端提示的地址远程访问。需要长期运行时可安装 systemd 服务：

```bash
sudo bash bin/install-systemd.sh
sudo systemctl status blockcraft
sudo journalctl -u blockcraft -f
```

安全停止服务：

```bash
sudo systemctl stop blockcraft
```

systemd 会等待创建/导入任务结束，再停止世界、FRP 和面板。不要直接结束 Java 或 BlockCraft 进程，以免存档未完成写入。

### Docker

```bash
git clone https://github.com/yumo666666/blockcraft.git
cd blockcraft
docker compose up -d
```

面板令牌保存在 `data/panel.json`。请按 `docker-compose.yml` 中的端口设置开放面板和 Minecraft 游戏端口。

## 3. 新建世界

依次填写名称、Minecraft 版本与加载器、世界参数和性能选项，最后确认创建。创建完成后可选择立即启动。

![新建世界向导](assets/screenshots/15-create-world.jpg)

配置页支持种子、游戏模式、难度、PVP、允许飞行、结构和生物生成等选项；性能部分可设内存、视距、模拟距离和 JVM 参数。

![世界基本设置](assets/screenshots/06-world-config-basic.jpg)

![世界性能设置](assets/screenshots/07-world-config-performance.jpg)

![世界网络设置](assets/screenshots/08-world-config-network.jpg)

![游戏规则](assets/screenshots/09-world-config-rules.jpg)

更改游戏端口前先停止世界。启用 RCON 等敏感功能时，不要把管理密码发布给玩家，也不要把 RCON 端口映射到公网。

![显示与复制端口](assets/screenshots/05-world-ports.jpg)

## 4. 导入整合包

1. 在设置页填写并保存 CurseForge API Key。新建普通世界不需要 API Key。
2. 返回“导入整合包”，上传 `.zip` 或 `.mrpack`，或者选择已放入 `data/store/packs/` 的压缩包。
3. 核对 Minecraft 版本、加载器、建议内存与目标世界名称，再开始导入。
4. 如果有文件因平台限制、缺少兼容版本或网络问题未能自动安装，查看下载日志中的文件名和项目 ID，再按提示补齐。

![缺少 API Key 时的导入提示](assets/screenshots/16-import-api-key-required.jpg)

![选择整合包和导入参数](assets/screenshots/17-import-pack.jpg)

## 5. 控制台、MOD 和玩家

控制台可以查看实时服务端日志、筛选关键词、输入命令并调用快捷命令。自动滚动开关控制日志是否跟随末尾。

![控制台快捷命令](assets/screenshots/10-console-commands.jpg)

![控制台日志与命令输入](assets/screenshots/11-console.jpg)

MOD 管理页按来源、状态和名称筛选；运行中的世界会限制可能破坏服务端状态的修改。

![MOD 管理](assets/screenshots/12-mod-manager.jpg)

玩家管理显示在线玩家与已知玩家，可设置管理员、白名单、封禁或更换皮肤。皮肤卡片会先显示已缓存的动图预览；浏览器准备好实时 3D 模型后再切换到可用鼠标拖动的模型，减少空白等待。

![在线和已知玩家、公共皮肤池](assets/screenshots/13-player-management.jpg)

<video controls preload="metadata" width="100%">
  <source src="assets/skin-switch.mp4" type="video/mp4">
  您的浏览器不支持内嵌视频，请<a href="assets/skin-switch.mp4">下载皮肤切换演示</a>。
</video>

[打开或下载皮肤切换演示视频](assets/skin-switch.mp4)（已裁掉设备状态栏和浏览器顶部栏）

## 6. FRP 远程连接

面板通道和世界通道是独立的 FRP 连接。填写 frps 地址、端口、token 和面板公网端口后保存并重载；世界端口由面板按设置的范围分配。

![FRP 快捷设置](assets/screenshots/14-frp-quick-settings.jpg)

分享给玩家时使用世界卡片“显示端口”里的公网地址。面板远程端口用于打开管理网页，不是 Minecraft 游戏端口；RCON 也不应暴露到公网。

## 7. 复制世界

“复制为新世界”会复制 MOD 与服务端配置，并创建独立的新世界。打开“连存档一起复制”时会将地图和世界内玩家存档数据一起复制；关闭时只复制 MOD/配置并生成新的地图。

![选择是否复制存档](assets/screenshots/18-copy-world-save-option.jpg)

复制后还可以调整新世界名称、种子、模式、难度、飞行与自启等设置。端口、RCON 密码和运行日志会重新生成或保持独立。

![复制世界的参数](assets/screenshots/19-copy-world-settings.jpg)

## 8. 备份、回退与换机迁移

1. 打开世界的“备份与回退”，停止世界后创建备份。
2. 点某条备份的“下载”将 BlockCraft 导出的 ZIP 保存到本地。
3. 在另一台 BlockCraft 上创建版本和加载器相同的世界，打开备份页，上传 ZIP。
4. 校验通过后点击“回退”恢复存档。迁移前确认 Minecraft 版本、加载器和 MOD 与目标世界相同。

![备份下载和 ZIP 上传](assets/screenshots/23-backups.jpg)

备份 ZIP 包含世界存档目录，其中的 `playerdata/`、`stats/`、`advancements/` 等玩家世界数据会随存档一起迁移；它不包含 MOD、服务端配置、白名单/管理员/封禁名单或 Java。换机时应另行准备相同版本和加载器，并重新导入对应 MOD。备份页只接受 BlockCraft 导出的备份 ZIP。

## 9. 事件、设置和相关网站

事件日志汇总各世界的启动、就绪、关闭和崩溃记录，可开启自动滚动。

![事件日志](assets/screenshots/20-events-log.jpg)

设置页可配置 CurseForge API Key、FRP、端口范围、并行世界数、内存预算和存储清理策略。API Key 保存在服务端数据目录，不要截图或分享包含密钥的配置文件。

![面板设置](assets/screenshots/21-panel-settings.jpg)

“相关网站”提供 CurseForge、Modrinth、Minecraft Wiki、NameMC、SkinsRestorer 和 MineSkin 等入口。

![相关网站](assets/screenshots/22-resource-links.jpg)

## 10. 安全关闭 BlockCraft

点击托盘里的“停止所有世界并退出”后会先出现配色与 BlockCraft 界面一致的确认框。点“否”、按 `N`、按 `Esc` 或点右上角关闭符号都会取消退出；默认焦点是“否”。

![BlockCraft 深绿关闭确认界面](assets/shutdown-confirm.svg)

确认后，启动器会先等待正在创建/导入的任务结束，再安全停止所有 Minecraft 世界，之后关闭世界 FRP、面板 FRP、面板服务，最后退出 BlockCraft。进度页面不能关闭，也不会强制置顶；请等待页面自行退出，不要从任务管理器结束进程。

![安全关闭进度页面](assets/screenshots/24-safe-shutdown.jpg)

## 11. 项目目录

```text
server/src/
  routes/       HTTP API 路由
  services/     世界、备份、MOD、玩家、FRP、下载与配置服务
  core/         配置、目录、日志和公共类型
  launcher/     Minecraft 版本、Java 与服务端安装逻辑
web/src/
  pages/        总览、创建/导入、控制台、备份、MOD、玩家、设置与事件页面
  components/   世界卡片、表单、弹窗和共享组件
  router.ts     页面路由
bin/            Ubuntu/Linux 启停、看门狗和 systemd 脚本
packaging/windows/
                Windows 启动器、托盘、安全关闭窗口与 Windows ZIP 构建
```

运行数据不入 Git：`data/` 保存面板配置、日志、下载缓存与 Java；`instances/<world-id>/` 保存对应世界的服务端文件、配置、存档和备份。

## 12. 开发与构建

要求 Node.js ≥ 22.6 与 pnpm：

```bash
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm build
corepack pnpm dev
```

Ubuntu 启动脚本会使用项目目录内的 Node.js，并在需要时执行前端构建。构建 Windows x64 发布 ZIP 还需要 Go：

```bash
packaging/windows/build.sh
```

产物位于 `dist-release/BlockCraft-Windows-x64.zip`。
