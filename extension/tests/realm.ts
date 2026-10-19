import vm from 'node:vm';
import { install, type PatchConfig } from '../src/patch/install';

export function boot(cfg: PatchConfig | null | undefined) {
  const context = vm.createContext({ console });
  vm.runInContext(
    `
    function Navigator() {}
    Object.defineProperty(Navigator.prototype, 'language', {
      configurable: true,
      enumerable: true,
      get() { return 'zh-CN'; },
    });
    Object.defineProperty(Navigator.prototype, 'languages', {
      configurable: true,
      enumerable: true,
      get() { return Object.freeze(['zh-CN', 'zh', 'en']); },
    });
    this.Navigator = Navigator;
    this.navigator = new Navigator();
    this.Temporal = { Now: {
      timeZoneId() { return 'Asia/Shanghai'; },
      zonedDateTimeISO(tz) { return 'zoned:' + String(tz); },
      plainDateTimeISO(tz) { return 'pdt:' + String(tz); },
      plainDateISO(tz) { return 'pd:' + String(tz); },
      plainTimeISO(tz) { return 'pt:' + String(tz); },
    }};
    `,
    context,
  );
  const scope = vm.runInContext('globalThis', context) as Parameters<typeof install>[0];
  install(scope, cfg);
  return {
    scope,
    run<T>(code: string): T {
      return vm.runInContext(code, context) as T;
    },
  };
}
