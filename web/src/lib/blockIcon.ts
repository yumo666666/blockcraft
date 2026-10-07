/**
 * 面板图标：等距草方块（Minecraft 的经典草皮方块造型）。
 *
 * 手写成 SVG 而不是塞一张位图，原因有三：
 *   1) 任何尺寸都清晰（favicon 16px 到登录页 48px 共用一份）；
 *   2) 不引入二进制资源，仓库保持纯文本、可 diff；
 *   3) 不打包任何官方美术资源（那个图标是有版权的），这里只是"同款造型"的自绘版本。
 *
 * 三个面：顶面草绿、左侧亮土、右侧暗土；再叠几处噪点做出像素块的感觉。
 */
export const BLOCK_ICON_INNER = `
  <!-- 顶面（草） -->
  <path d="M16 3 L29 10.5 L16 18 L3 10.5 Z" fill="#7cbd52"/>
  <path d="M16 3 L29 10.5 L16 18 L3 10.5 Z" fill="url(#grassShade)"/>
  <!-- 左侧（土，受光） -->
  <path d="M3 10.5 L16 18 L16 32 L3 24.5 Z" fill="#9c6b45"/>
  <!-- 右侧（土，背光） -->
  <path d="M29 10.5 L29 24.5 L16 32 L16 18 Z" fill="#7a5133"/>
  <!-- 顶面边缘的一点草沿，让方块有厚度 -->
  <path d="M3 10.5 L16 18 L29 10.5 L29 12.2 L16 19.7 L3 12.2 Z" fill="#6aa843"/>
  <!-- 像素噪点 -->
  <g opacity="0.5">
    <rect x="7" y="14" width="2" height="2" fill="#8a5c3b"/>
    <rect x="12" y="21" width="2" height="2" fill="#8a5c3b"/>
    <rect x="5" y="19" width="2" height="2" fill="#b07c53"/>
    <rect x="11" y="26" width="2" height="2" fill="#6b4529"/>
    <rect x="20" y="16" width="2" height="2" fill="#8f5f3d"/>
    <rect x="24" y="21" width="2" height="2" fill="#6b4529"/>
    <rect x="19" y="26" width="2" height="2" fill="#8f5f3d"/>
    <rect x="10" y="9" width="2" height="2" fill="#8ec962"/>
    <rect x="18" y="6" width="2" height="2" fill="#5f9b3c"/>
    <rect x="22" y="12" width="2" height="2" fill="#8ec962"/>
    <rect x="6" y="7" width="2" height="2" fill="#5f9b3c"/>
    <rect x="14" y="13" width="2" height="2" fill="#5f9b3c"/>
  </g>
`;

/** 完整的 SVG（可直接内联进 Vue，也可作为 favicon 文件内容） */
export const BLOCK_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 35" width="32" height="35">
  <defs>
    <linearGradient id="grassShade" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#ffffff" stop-opacity="0.18"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.12"/>
    </linearGradient>
  </defs>
${BLOCK_ICON_INNER}
</svg>`;
