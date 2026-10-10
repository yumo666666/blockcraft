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

![BlockCraft 深绿色安全关闭二次确认窗口](assets/shutdown-confirm.svg)

确认后，启动器会先等待正在创建/导入的任务结束，再安全停止所有 Minecraft 世界，之后关闭世界 FRP、面板 FRP、面板服务，最后退出 BlockCraft。进度页面不能关闭，也不会强制置顶；请等待页面自行退出，不要从任务管理器结束进程。

![安全关闭进度页面](assets/screenshots/24-safe-shutdown.jpg)

## 11. 项目目录

下面分开说明 GitHub 上的源码目录和运行后产生的目录。BlockCraft 的 Node.js 后端位于根目录 `server/`；每个世界对应的 Minecraft 服务端位于 `instances/<世界ID>/server/`。

### 仓库源码

```text
BlockCraft/
├─ .github/workflows/            ci.yml、release-windows.yml
├─ bin/                          ubuntu.sh、start.sh、stop.sh、boot.sh、proc-find.sh、systemd 脚本
├─ docs/
│  ├─ PROJECT_GUIDE.md           本使用手册
│  └─ assets/
│     ├─ screenshots/            总览、世界设置、控制台、MOD、玩家、FRP 等操作截图
│     ├─ shutdown-confirm.svg    深绿色退出二次确认窗口图
│     └─ skin-switch.mp4         皮肤切换演示
├─ packaging/windows/            Windows GUI 启动器与发布包
│  ├─ main_windows.go            Windows 托盘/启动器入口
│  ├─ shutdown_confirm_windows.go / shutdown_dialog_windows.go
│  ├─ panel_api.go / portable_paths.go
│  ├─ *_test.go                  Windows 启动器相关测试
│  ├─ blockcraft.ico             Windows 图标
│  └─ build.sh、go.mod、go.sum   构建脚本与 Go 依赖
├─ server/
│  ├─ src/
│  │  ├─ core/                    paths、fsx、日志、会话、NBT、错误、锁、Minecraft ping 等基础模块
│  │  ├─ launcher/index.ts        Minecraft/加载器/JDK 安装与启动参数
│  │  ├─ java/                    Forge 安装辅助 Java 源码
│  │  ├─ routes/                  backups、console、frp、instances、mods、packs、players、system API
│  │  ├─ services/                世界、安装、进程、备份、MOD、整合包、玩家、FRP、皮肤、JDK 等业务
│  │  ├─ types/                   第三方库补充类型声明
│  │  ├─ config.ts                面板配置读写与默认值
│  │  ├─ index.ts                 面板 HTTP 服务入口
│  │  ├─ types.ts                 后端共享数据类型
│  │  └─ watchdog.ts              面板进程看门狗
│  ├─ test/                      后端、启动器和整合包处理测试
│  ├─ package.json               后端依赖与命令
│  └─ tsconfig.json              TypeScript 配置
├─ tools/                        辅助工具（例如 Minecraft ping 检查）
├─ web/
│  ├─ public/                    网页静态资源与图标
│  ├─ src/
│  │  ├─ __tests__/              前端组件与功能测试
│  │  ├─ components/             弹窗、表单、状态标记、世界卡片等共享组件
│  │  ├─ lib/                    API、类型、主题、格式化、公告与命令辅助代码
│  │  ├─ pages/                  Overview、Wizard、Console、Backups、Mods、Players、Settings、Events 等页面
│  │  ├─ styles/                 全局样式
│  │  ├─ App.vue                 应用外壳与导航
│  │  └─ router.ts               页面路由
│  ├─ dist/                      前端构建产物，运行时由构建生成
│  ├─ index.html                 网页入口 HTML
│  ├─ package.json               前端依赖与命令
│  ├─ vite.config.ts             Vite 构建配置
│  ├─ vitest.config.ts           前端测试配置
│  └─ tsconfig.json              TypeScript 配置
├─ .dockerignore / .editorconfig  Docker 忽略规则与编辑器格式约定
├─ .gitignore                    Git 忽略规则
├─ CHANGELOG.md                  版本更新记录
├─ CONTRIBUTING.md               开发贡献说明
├─ Dockerfile                    Docker 镜像构建配置
├─ docker-compose.yml            Docker 部署配置
├─ LICENSE                       开源许可证
├─ README.md                     GitHub 项目主页说明
├─ package.json                  工作区命令与根依赖
├─ pnpm-lock.yaml                锁定的依赖版本
└─ pnpm-workspace.yaml           pnpm 工作区定义
```

`node_modules/`、`web/dist/`、`data/`、`instances/` 和发布包 `dist-release/` 由本机安装或构建生成；源码仓库跟踪构建配置与源文件。

### 运行数据：面板设置、缓存和日志

默认情况下，数据目录位于项目根目录的 `data/`。Windows ZIP 版也会把它放在 `BlockCraft.exe` 旁边；Linux/Docker 还可以通过环境变量把数据目录和世界目录放到其他磁盘。

```text
data/
├─ panel.json                 面板、登录令牌、FRP、端口范围、API Key 等设置（敏感）
├─ panel.json.bak             设置文件的上一份备份，存在时才会出现
├─ sessions.json              登录会话
├─ ports.json                 已分配的本地游戏/RCON 端口与 FRP 端口
├─ mods-cache.json            MOD 来源查询缓存
├─ players-cache.json         玩家资料缓存
├─ skin-bindings.json         玩家与皮肤绑定信息（使用相关功能后可能出现）
├─ skin-pool.json             公共皮肤池索引
├─ skins/                     皮肤图片及预览缓存
├─ skin-pool/                 公共皮肤图片、预览和动图
├─ skin-assignments/          发给各世界皮肤插件使用的图片
├─ frpc-panel.toml            面板 FRP 客户端配置
├─ frpc-worlds.toml           世界 FRP 客户端配置
├─ jobs/                      创建、导入等后台任务记录
├─ jdk/                       BlockCraft 下载的 Temurin Java 运行环境
├─ logs/
│  ├─ panel.log               面板运行日志
│  ├─ events.jsonl             世界启动、就绪、关闭与崩溃事件
│  ├─ audit.jsonl              管理操作审计记录
│  ├─ panel.out / boot.log     Linux 启动输出（依启动方式而异）
│  └─ watchdog*.log            看门狗日志（启用时产生）
└─ store/                     下载与导入缓存
   ├─ packs/                  上传的整合包压缩文件
   ├─ versions/               Minecraft 版本清单缓存
   ├─ vanilla/                原版服务端下载缓存
   ├─ paper/ / fabric/        Paper/Fabric 安装缓存
   ├─ forge/ / neoforge/      Forge/NeoForge 安装缓存
   └─ mods-upload/            网页上传 MOD 的临时处理目录
```

不是每个文件夹一开始都会有：例如没用皮肤池时不会有皮肤缓存，没启用 FRP 时也可能没有 FRP 配置文件。不要公开 `panel.json`、FRP TOML 或日志中的令牌、密码和公网地址。

### 世界实例：每个世界各自一份

`instances/` 下每个直接子目录代表一个世界。目录 ID 一般由英文世界名称转换而来，例如 `World 1` 通常生成 `world_1`，`Cozy Zen` 通常生成 `cozy_zen`；卡片上的显示名称仍保存在配置里。

```text
instances/
├─ .trash/                         面板删除世界时暂存的回收站内容
└─ world_1/                        示例世界 ID；假设创建时名称为 World 1
   ├─ config.json                  世界配置：版本、加载器、内存、端口、种子等
   ├─ config.json.bak              世界配置上一份副本（存在时）
   ├─ state.json                   面板保存的启动/停止状态等运行状态
   ├─ state.json.bak               状态文件上一份副本（存在时）
   ├─ server.pid                   世界运行时的进程标识（运行时生成）
   ├─ .stop-intent                 优雅停止期间的临时标记
   ├─ logs/
   │  ├─ server.out                服务端标准输出与错误输出
   │  └─ console.log               控制台命令与日志记录
   ├─ backups/
   │  ├─ index.json                备份列表、校验值、存档目录等索引
   │  ├─ *.zip                     BlockCraft 导出的世界存档备份
   │  └─ .tmp/                     创建/上传备份时的临时文件
   └─ server/                      Minecraft 服务端工作目录
      ├─ server.properties         服务端属性，面板会同步维护受管选项
      ├─ eula.txt                  Minecraft EULA 接受状态
      ├─ user_jvm_args.txt         JVM 参数；部分加载器启动方式会使用
      ├─ ops.json                  管理员名单
      ├─ whitelist.json            白名单
      ├─ banned-players.json       封禁玩家名单
      ├─ banned-ips.json           封禁 IP 名单（使用后可能出现）
      ├─ usercache.json            最近识别的玩家资料
      ├─ minecraft_server.jar      原版服务端文件（原版加载器组合时可能出现）
      ├─ server.jar / paper.jar    加载器对应的服务端文件（具体名称依加载器而异）
      ├─ run.sh / run.bat           Forge 等安装器生成的启动脚本（可能出现）
      ├─ mods/                     Forge/Fabric/NeoForge 服务端 MOD（相应加载器需要时）
      ├─ client-mods/               整合包客户端专用文件的留存位置（需要时出现）
      ├─ plugins/                  Paper 等插件端的插件（安装插件后出现）
      ├─ config/                   加载器和 MOD 的配置
      ├─ defaultconfigs/           MOD 默认配置（整合包可能附带）
      ├─ kubejs/ / scripts/        整合包脚本（整合包可能附带）
      ├─ resourcepacks/            整合包资源包文件
      ├─ client-files/shaderpacks/ 客户端光影文件，不在服务端加载
      ├─ libraries/ / versions/    Forge 等加载器下载的库与版本信息
      ├─ .pack-downloads/          整合包下载过程中的临时文件（处理期间可能出现）
      ├─ logs/                     Minecraft 服务端日志，如 latest.log
      ├─ crash-reports/            服务端崩溃报告
      └─ world/                    默认存档目录；名称受 server.properties 的 level-name 控制
```

### “世界 1”的存档目录里有什么

上面 `server/world/` 是默认示例。若 `level-name` 被改成 `survival`，存档就会是 `server/survival/`。世界刚创建时许多文件还不存在；启动并生成地形后通常会逐步出现：

```text
server/world/                     （也可能是其他 level-name）
├─ level.dat                      世界基本信息、种子和游戏规则
├─ level.dat_old                  上一份世界元数据副本（可能出现）
├─ session.lock                   服务端运行时锁文件
├─ region/                        主世界区块地形文件（*.mca）
├─ entities/                      主世界实体区块数据
├─ poi/                           兴趣点数据，例如村民工作站
├─ playerdata/                    玩家 UUID 存档：背包、位置、经验等
├─ stats/                         玩家统计数据
├─ advancements/                  玩家进度/成就
├─ data/                          地图、计分板等世界级数据
├─ datapacks/                     这个世界加载的数据包
├─ DIM-1/                         下界维度数据（依版本而定）
├─ DIM1/                           末地维度数据（依版本而定）
└─ dimensions/                    模组或新格式的额外维度（有相关内容时）
```

`region/`、`playerdata/`、维度目录和其他内容会随 Minecraft 版本、加载器及模组变化。备份页将整个存档目录打包为 ZIP；MOD、`server.properties`、白名单和管理员名单保存在服务端目录的其他位置，不会进入这个 ZIP。迁移时要另行准备相同版本、加载器与 MOD。

注意区分两类玩家相关文件：`server/ops.json`、`whitelist.json`、`banned-players.json` 是服务端权限/名单；`world/playerdata/`、`stats/` 和 `advancements/` 是玩家在这个世界里的角色存档。它们位于不同位置，因此世界备份包含后者，不包含前者。

如果通过“接管已有服务端目录”添加世界，`instances/<id>/server` 可能是指向外部服务端目录的符号链接；真实服务端文件仍留在原位置。复制或迁移时应确认外部目录也一起保留。

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
