interface Brand {
  brand: string;
  version: string;
}

export interface UaPatchConfig {
  ua?: string;
  appVersion?: string;
  navPlatform?: string;
  vendor?: string;
  uaPlatform?: string;
  brands?: Brand[];
  fullVersionList?: Brand[];
  platformVersion?: string;
  architecture?: string;
  bitness?: string;
}

export interface UaScope {
  Navigator?: { prototype: object };
  navigator?: unknown;
  Object: typeof Object;
}

function defineGetter(proto: object, key: string, get: () => unknown): void {
  Object.defineProperty(proto, key, {
    configurable: true,
    enumerable: true,
    get,
  });
}

function copyBrands(list: Brand[] | undefined, freeze: (value: object) => object): Brand[] {
  return (list || []).map((item) => freeze({ brand: String(item.brand), version: String(item.version) }) as Brand);
}

function makeUaData(scope: UaScope, cfg: UaPatchConfig): object {
  const freeze = <T extends object>(value: T): T => scope.Object.freeze(value) as T;
  const brands = freeze(copyBrands(cfg.brands, (value) => scope.Object.freeze(value)));
  const fullVersionList = freeze(copyBrands(cfg.fullVersionList, (value) => scope.Object.freeze(value)));
  const platform = String(cfg.uaPlatform || '');
  const high = freeze({
    brands,
    fullVersionList,
    mobile: false as const,
    platform,
    platformVersion: String(cfg.platformVersion ?? ''),
    model: '',
    architecture: String(cfg.architecture || 'x86'),
    bitness: String(cfg.bitness || '64'),
    wow64: false as const,
  });
  return freeze({
    brands,
    mobile: false as const,
    platform,
    getHighEntropyValues() {
      return Promise.resolve(high);
    },
    toJSON() {
      return { brands, mobile: false, platform };
    },
  });
}

const KEYS = ['userAgent', 'appVersion', 'platform', 'vendor', 'userAgentData'];

export function installUserAgent(scope: UaScope, cfg: UaPatchConfig): void {
  const proto = scope.Navigator?.prototype;
  if (!proto || !cfg.ua) return;
  const nav = scope.navigator as unknown as Record<string, unknown> | undefined;
  if (nav) {
    for (const key of KEYS) {
      try {
        if (scope.Object.prototype.hasOwnProperty.call(nav, key)) delete nav[key];
      } catch {
        /* own data property is non-configurable */
      }
    }
  }
  const ua = cfg.ua;
  const appVersion = cfg.appVersion || ua.replace(/^Mozilla\//, '');
  const data = makeUaData(scope, cfg);
  defineGetter(proto, 'userAgent', () => ua);
  defineGetter(proto, 'appVersion', () => appVersion);
  defineGetter(proto, 'platform', () => cfg.navPlatform || '');
  defineGetter(proto, 'vendor', () => cfg.vendor || 'Google Inc.');
  defineGetter(proto, 'userAgentData', () => data);
}
