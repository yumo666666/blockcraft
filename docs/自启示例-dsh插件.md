# 示例：把面板挂到 DSH 的启动钩子上

这份文档是**给 DSH 容器环境**的参考实现（普通 Linux 用 `crontab @reboot` 或 systemd 就行）。
本项目的开发机就是这样接的，实测可用。

## 链路

```
DSH App 启动 → 执行 dsh web → 加载 web profile 插件 → dsh-blockcraft-boot 的 apply()
  → /root/mcpanel-v2/bin/boot.sh
      ├─ 面板（总是自启，面板自己把两条 FRP 通道拉起来）
      └─ 看门狗（60 秒巡检：面板保活 / FRP 通道保活 / autostart 的世界拉起 / 卡住自愈）
```

proot 容器里没有 systemd / init，所有进程都挂在 DSH App 下（App 一退全没），
所以「开机自启」只能挂在 App 的启动链上，而 `dsh web` 的 profile 插件是本环境唯一的官方钩子。

## 插件三件套

`/root/dsh-blockcraft-boot/package.json`：

```json
{
  "name": "dsh-blockcraft-boot",
  "version": "2.0.0",
  "type": "module",
  "main": "index.js",
  "exports": {
    ".": "./index.js",
    "./package.json": "./package.json",
    "./cordis.patch.yml": "./cordis.patch.yml"
  },
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

`/root/dsh-blockcraft-boot/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-blockcraft-boot
      name: dsh-blockcraft-boot
```

`/root/dsh-blockcraft-boot/index.js`：只负责「点火」，把幂等脚本 detached 出去，
绝不阻塞 DSH 启动，自身异常也不能影响 GUI。

```js
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const SCRIPT = '/root/mcpanel-v2/bin/boot.sh';

export function apply() {
  try {
    if (!existsSync(SCRIPT)) return;
    const child = spawn('/bin/bash', ['-c', `nice -n 10 ${SCRIPT}`], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, PATH: `/usr/local/bin:${process.env.PATH ?? ''}` },
    });
    child.unref();
  } catch {
    /* 点火失败不影响 DSH 主进程；boot.sh 会把失败写进 data/logs/panel.out */
  }
}
```

## 注册

在 `/root/.dsh/profiles/web/package.json` 里两处都要加（**注意 `bundles` 必须就地改数组**，
把列表重新赋值给局部变量是不会写进 JSON 的 —— 这个坑我踩过）：

```jsonc
{
  "dependencies": { "dsh-blockcraft-boot": "link:/root/dsh-blockcraft-boot" },
  "dsh": { "profile": { "bundles": [ /* … */ "dsh-blockcraft-boot" ] } }
}
```

然后 `pnpm install`（让 `link:` 生效）。`profile.patchReload` 是 `startup`，
所以**下次 DSH App 启动时生效**。

## 验证方式

不必真重启 App，直接调用插件的 `apply()` 就等价于启动链做的事：

```bash
# 1) 先把面板与看门狗全杀掉，模拟 App 重启后进程消失
kill $(bin/proc-find.sh node "server/src/index.ts")
kill $(bin/proc-find.sh node "server/src/watchdog.ts")

# 2) 触发一次（等价于 dsh web 启动时加载插件）
node -e "import('/root/.dsh/profiles/web/node_modules/dsh-blockcraft-boot/index.js').then(m=>m.apply())"

# 3) 应当看到面板、看门狗、两条 frpc 通道都回来了；再触发一次不应该出现重复进程
bin/proc-find.sh node "server/src/index.ts" | wc -l   # 1
bin/proc-find.sh node "server/src/watchdog.ts" | wc -l # 1
```
