import { z } from 'zod';

const portSchema = z.union([z.number().int().min(0).max(65_535), z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(65_535))]);
const endpointSchema = z.object({
  value: z.string().optional(),
  host: z.string().optional(),
  port: portSchema.nullish(),
  https_port: portSchema.nullish(),
  is_active: z.boolean().optional()
}).passthrough();

function httpsUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) {
    throw new Error('组件入口必须是无凭据、查询参数或片段的 HTTPS 地址');
  }
  return url;
}

/** Core port 0 inherits the configured site's port, including for an explicit host. */
export function resolveComponentEndpoint(siteUrl: string, payload: unknown): string {
  const site = httpsUrl(siteUrl);
  const endpoint = endpointSchema.parse(payload);
  if (endpoint.is_active === false) throw new Error('Core 返回的组件入口已禁用');
  let target: URL;
  if (endpoint.value) {
    target = httpsUrl(endpoint.value);
    if (target.pathname !== '/') throw new Error('组件入口 value 必须是 HTTPS origin');
  } else {
    const host = endpoint.host || site.hostname;
    if (/[\s/@?#\\%]/.test(host)) throw new Error('Core 返回的组件主机地址不合法');
    const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
    target = httpsUrl(`https://${authority}`);
    if (target.port || target.pathname !== '/') throw new Error('组件 host 不得包含端口或路径');
    const port = endpoint.https_port ?? endpoint.port;
    if (port !== undefined && port !== null) target.port = port === 0 ? site.port : String(port);
    else if (!endpoint.host) target.port = site.port;
  }
  // The configured gateway prefix belongs to its origin, not to every component host.
  return `${target.origin}${target.origin === site.origin ? site.pathname.replace(/\/+$/, '') : ''}`;
}
