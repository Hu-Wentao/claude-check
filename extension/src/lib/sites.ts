export interface SiteEntry {
  host: string;
  includeSubdomains: boolean;
  suggested?: boolean;
}

const MULTI_PART_TLDS = new Set([
  'co.uk',
  'org.uk',
  'ac.uk',
  'gov.uk',
  'co.jp',
  'com.au',
  'net.au',
  'org.au',
  'co.nz',
  'com.br',
  'com.mx',
  'co.kr',
  'com.tr',
  'com.hk',
  'com.sg',
  'com.tw',
  'com.cn',
  'net.cn',
  'org.cn',
]);

export type SiteParse = { ok: true; host: string } | { ok: false };

/** Accept a concrete https origin. Reject wildcards, bare TLDs, and non-https URLs. */
export function parseSiteInput(raw: string): SiteParse {
  let text = raw.trim();
  if (!text || /[\s*]/.test(text) || /all_urls/i.test(text)) return { ok: false };
  if (!/^https?:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== 'https:') return { ok: false };
  if (url.username || url.password) return { ok: false };
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host || host.includes('*') || host.startsWith('.')) return { ok: false };
  if (!/^[a-z0-9.-]+$/.test(host)) return { ok: false };
  const labels = host.split('.');
  if (labels.length < 2 || labels.some((label) => !label || label.length > 63)) return { ok: false };
  if (MULTI_PART_TLDS.has(host)) return { ok: false };
  return { ok: true, host };
}

export function isLocalHost(host: string): boolean {
  return host === 'localhost' || host === '127.0.0.1';
}

export function originPatterns(site: SiteEntry): string[] {
  const scheme = isLocalHost(site.host) ? 'http' : 'https';
  const patterns = [`${scheme}://${site.host}/*`];
  if (site.includeSubdomains) patterns.push(`${scheme}://*.${site.host}/*`);
  return patterns;
}

export function exactHostRegex(site: SiteEntry): string {
  const scheme = isLocalHost(site.host) ? 'http' : 'https';
  const host = site.host.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${scheme}://${host}(?::[0-9]+)?(?:[/?#].*)?$`;
}

/** Origins safe to pass to permissions.request. The catch-all optional pattern is never requested. */
export function requestablePatterns(sites: SiteEntry[], skipRequiredLocal: boolean): string[] {
  const out: string[] = [];
  for (const site of sites) {
    for (const pattern of originPatterns(site)) {
      if (pattern === 'https://*/*' || pattern === 'http://*/*' || pattern === '<all_urls>') continue;
      if (skipRequiredLocal && /^http:\/\/(\*\.)?(localhost|127\.0\.0\.1)\//.test(pattern)) continue;
      if (!out.includes(pattern)) out.push(pattern);
    }
  }
  return out;
}

export function urlMatchesSite(url: string, sites: SiteEntry[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase();
  const scheme = parsed.protocol.replace(':', '');
  return sites.some((site) => {
    const expected = isLocalHost(site.host) ? 'http' : 'https';
    if (scheme !== expected) return false;
    if (host === site.host) return true;
    return site.includeSubdomains && host.endsWith(`.${site.host}`);
  });
}
