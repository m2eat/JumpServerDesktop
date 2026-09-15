import { getFonts } from 'font-list';

let cachedFonts: string[] | undefined;
let readInFlight: Promise<string[]> | undefined;

export function listInstalledFonts({ refresh = false }: { refresh?: boolean } = {}): Promise<string[]> {
  if (!refresh && cachedFonts) return Promise.resolve(cachedFonts);
  if (readInFlight) return readInFlight;

  readInFlight = getFonts({ disableQuoting: true }).then((fonts) => {
    if (!Array.isArray(fonts)) throw new Error('本机字体服务返回了无效数据');
    const seen = new Set<string>();
    for (const font of fonts) {
      if (typeof font !== 'string') throw new Error('本机字体服务返回了无效字体名称');
      const family = font.trim();
      if (family) seen.add(family);
    }
    const families = [...seen];
    if (families.length > 0) cachedFonts = families;
    return families;
  }).finally(() => {
    readInFlight = undefined;
  });
  return readInFlight;
}
