# BlockCraft · 多世界 Minecraft 管理面板
# 面板本身只需要 Node；但它要替世界拉起 Java 服务端，所以镜像里带上常用 JDK。
# 本机已装对应 Java 的话，不装这些也能跑（面板会自己探测 /usr/lib/jvm）。
FROM node:24-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production \
    BC_ROOT=/app \
    BC_DATA_DIR=/app/data \
    BC_INSTANCE_DIR=/app/instances

# Java 8/17/21：覆盖从 1.12.2 到 1.21 的绝大多数整合包
# （26.x 需要 Java 25，可以在设置页配置自备 JDK，或自行在镜像里补装）
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      openjdk-17-jre-headless \
      ca-certificates curl tar gzip procps \
 && rm -rf /var/lib/apt/lists/*

# 可选：把 21 也装上（Debian bookworm 有 openjdk-21-jre-headless 时）
RUN apt-get update \
 && (apt-get install -y --no-install-recommends openjdk-21-jre-headless || true) \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

WORKDIR /app

# 先装依赖，利用层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY server/package.json server/
COPY web/package.json web/
RUN pnpm install --frozen-lockfile --prod=false

# 再拷源码并构建前端
COPY . .
RUN pnpm -C web build && pnpm prune --prod

VOLUME ["/app/data", "/app/instances"]
EXPOSE 8081

# 面板自己管进程，不需要 init；停止信号会优雅退出（不会杀正在跑的世界）
CMD ["node", "--experimental-strip-types", "server/src/index.ts"]
