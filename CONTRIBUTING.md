# 参与开发

## 开发环境

需要 **Node.js ≥ 22.6**（用到原生 TypeScript 类型剥离，后端不需要编译步骤）与 pnpm。

```bash
pnpm install
pnpm dev        # 后端 8081 + Vite 5173（Vite 会把 /api 代理到后端）
```

第一次启动会生成 `data/panel.json`，用里面的 `panel.token` 登录。

## 提交前

```bash
pnpm typecheck   # 前后端都必须 0 错误
pnpm build       # 前端要能构建
pnpm test        # 纯逻辑测试；有面板在跑时会额外跑页面渲染测试
```

页面渲染测试需要面板在跑，用法：

```bash
BC_TOKEN=$(node -e "console.log(require('./data/panel.json').panel.token)") pnpm test
```

## 代码约定

这些不是洁癖，都是踩出来的：

1. **不写 `enum` / `namespace` / 构造函数参数属性 / 装饰器** —— Node 的类型剥离不支持，运行时会直接报错。
   本地 import 一律带 `.ts` 后缀。
2. **只用纯 JS 依赖**。不要引入需要 node-gyp 编译的包：多数用户跑在手机、树莓派或精简容器里，没有编译链。
3. **所有写盘走「临时文件 → `fs.rename` 原子替换」**。半成品文件比没有文件更危险（备份那条尤其）。
4. **列目录不要用 `dirent.isFile()`**，用 `fs.statSync`。有些文件系统（含 f2fs）会把多链接文件报成 `DT_LNK`，
   依赖它会让 MOD 全部「消失」。
5. **不要用 shell 去读写文件**（`mv`、重定向、`find -type f`）。这台机器上 `mv` 覆盖文件会误删其他硬链接；
   进程管理也别依赖 `ps`，用 `/proc` 里能拿到的信息，并且注意容器里 Node 的 `comm` 可能是 `MainThread` 而不是 `node`。
6. **重活不要挡住事件循环**：GB 级目录扫描、`spawnSync` 调外部命令都要异步化或缓存，
   否则面板会短时间不响应，看门狗会误判它挂了。
7. **注释与日志用中文**，面向使用者的文案也要说人话（错误信息里写清楚「怎么办」，而不只是「失败了」）。

## 加一个加载器

只需要动两处：

- `server/src/launcher/index.ts`：加启动命令与产物校验
- `server/src/services/installService.ts`：加下载/安装逻辑（以及 `versionsService.ts` 里的版本列表）

## 改前端

视觉一律从 `web/src/styles/base.css` 取（颜色、间距、圆角、组件类都在那里）。
不要自己发明样式，也不要在页面里写大段 scoped CSS —— 风格统一靠这一条撑。
