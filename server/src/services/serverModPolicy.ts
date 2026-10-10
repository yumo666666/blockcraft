/** CurseForge labels are useful, but a few upstream projects omit a Server tag. */
export type CurseForgeFileEnvironment = {
  modId?: number;
  projectId?: number;
  gameVersions?: string[];
};

// Sodium Extras is a client rendering add-on. Its CurseForge files omit the
// Client tag even though they crash during dedicated-server initialization.
const KNOWN_CLIENT_ONLY_CURSEFORGE_PROJECTS = new Set([558905]);

export function curseForgeClientOnlyReason(file: CurseForgeFileEnvironment): string | null {
  const environments = new Set((file.gameVersions ?? []).map((value) => value.toLowerCase()));
  if (environments.has('client') && !environments.has('server')) {
    return 'CurseForge 将此文件标记为仅客户端';
  }
  if (KNOWN_CLIENT_ONLY_CURSEFORGE_PROJECTS.has(file.projectId ?? file.modId ?? -1)) {
    return '此客户端渲染附属模组未声明服务器兼容性';
  }
  return null;
}

export function fabricClientOnlyReason(metadataText: string): string | null {
  try {
    const metadata = JSON.parse(metadataText) as { environment?: unknown };
    return typeof metadata.environment === 'string' && metadata.environment.toLowerCase() === 'client'
      ? 'Fabric 元数据将此模组标记为 environment=client'
      : null;
  } catch {
    return null;
  }
}

export function forgeClientOnlyReason(metadataText: string): string | null {
  const modSections: string[][] = [];
  let current: string[] | null = null;
  for (const line of metadataText.split(/\r?\n/)) {
    if (/^\s*\[\[mods\]\]\s*$/i.test(line)) {
      if (current) modSections.push(current);
      current = [];
    } else if (/^\s*\[\[/.test(line) || /^\s*\[[^[]/.test(line)) {
      if (current) modSections.push(current);
      current = null;
    } else if (current) {
      current.push(line);
    }
  }
  if (current) modSections.push(current);
  if (!modSections.length) return null;

  const allClientOnly = modSections.every((lines) => {
    const side = lines.join('\n').match(/^\s*side\s*=\s*["']([^"']+)["']/im)?.[1];
    return side?.toUpperCase() === 'CLIENT';
  });
  return allClientOnly ? 'Forge 元数据将此模组标记为 side=CLIENT' : null;
}
