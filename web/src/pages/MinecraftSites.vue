<script setup lang="ts">
defineOptions({ name: 'MinecraftSites' });

const sites = [
  {
    name: 'CurseForge',
    category: '整合包与内容',
    url: 'https://www.curseforge.com/minecraft',
    description: '大型 Minecraft 内容平台，适合查找热门整合包和社区作品。',
    contents: ['MOD 与整合包', '地图与世界', '资源包、光影与插件'],
    icon: '🧰',
  },
  {
    name: 'Modrinth',
    category: 'MOD 与整合包',
    url: 'https://modrinth.com/',
    description: '以开放 API 和快速检索见长的 Minecraft 创作平台。',
    contents: ['MOD 与整合包', '插件、数据包', '资源包与光影'],
    icon: '🧩',
  },
  {
    name: 'MinecraftSkins / mcskins.org',
    category: '皮肤',
    url: 'https://mcskins.org/',
    description: '浏览和查找玩家皮肤，也可以在线编辑或上传皮肤图片。',
    contents: ['玩家皮肤库', '皮肤编辑器', '皮肤预览与下载'],
    icon: '👕',
  },
  {
    name: 'NameMC',
    category: '玩家与皮肤',
    url: 'https://namemc.com/',
    description: '查询 Minecraft 玩家资料、皮肤、披风和服务器列表。',
    contents: ['玩家名称与资料', '皮肤和披风', '服务器目录'],
    icon: '🧑',
  },
  {
    name: 'SkinRestorer',
    category: '服务端工具',
    url: 'https://skinsrestorer.net/',
    description: '为支持的服务端提供玩家皮肤管理，包含安装说明和配置文档。',
    contents: ['插件与模组文档', '离线服皮肤设置', '命令和常见问题'],
    icon: '🛠️',
  },
  {
    name: 'MineSkin',
    category: '皮肤签名',
    url: 'https://mineskin.org/',
    description: '为自定义皮肤生成 Minecraft 可用的签名纹理数据。',
    contents: ['上传皮肤并签名', '纹理数据 API', '服务端集成说明'],
    icon: '🔏',
  },
  {
    name: 'Minecraft Wiki',
    category: '游戏资料',
    url: 'https://minecraft.wiki/',
    description: '社区维护的 Minecraft 百科，适合查方块、机制和版本变化。',
    contents: ['合成与物品资料', '游戏机制', '版本更新说明'],
    icon: '📚',
  },
];
</script>

<template>
  <main class="page col gap-4 websites-page">
    <div class="websites-intro">
      <div class="eyebrow">MINECRAFT LINKS</div>
      <h1>我的世界相关网站</h1>
      <p class="text-3">常用的整合包、MOD、皮肤和游戏资料网站，点击卡片会在新标签页打开。</p>
    </div>

    <section class="websites-grid" aria-label="Minecraft 网站列表">
      <article v-for="site in sites" :key="site.name" class="card website-card">
        <div class="website-card-head">
          <span class="website-icon" aria-hidden="true">{{ site.icon }}</span>
          <span class="badge badge-outline">{{ site.category }}</span>
        </div>
        <h2>{{ site.name }}</h2>
        <p class="text-3 website-description">{{ site.description }}</p>
        <div class="website-contents">
          <strong>网站内容</strong>
          <ul>
            <li v-for="item in site.contents" :key="item">{{ item }}</li>
          </ul>
        </div>
        <a class="btn btn-soft website-link" :href="site.url" target="_blank" rel="noopener noreferrer">
          打开网站 <span aria-hidden="true">↗</span>
        </a>
      </article>
    </section>
  </main>
</template>

<style scoped>
.websites-page { padding-top: clamp(18px, 3vh, 34px); }
.websites-intro { display: grid; gap: 7px; }
.websites-intro h1, .websites-intro p { margin: 0; }
.eyebrow { color: var(--accent); font-size: 11px; font-weight: 750; letter-spacing: .14em; }
.websites-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 270px), 1fr)); gap: var(--sp-4); align-items: stretch; }
.website-card { display: flex; flex-direction: column; gap: 12px; padding: var(--sp-4); min-width: 0; }
.website-card-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.website-icon { display: grid; place-items: center; width: 42px; height: 42px; border-radius: 13px; background: var(--accent-soft); font-size: 22px; }
.website-card h2 { margin: 0; font-size: 17px; overflow-wrap: anywhere; }
.website-description { min-height: 42px; margin: 0; line-height: 1.55; }
.website-contents { padding-top: 11px; border-top: 1px solid var(--border); }
.website-contents strong { font-size: 12px; }
.website-contents ul { display: grid; gap: 5px; margin: 8px 0 0; padding-left: 18px; color: var(--text-3); font-size: 12px; }
.website-link { justify-content: space-between; margin-top: auto; text-decoration: none; }
</style>
