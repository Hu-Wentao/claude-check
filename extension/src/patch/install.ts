import { installFonts, type FontScope } from './fonts';
import {
  formatChromeDate,
  getOffsetMinutes,
  longTimeZoneName,
  wallFromInstant,
  wallToInstant,
  type TimeDeps,
  type Wall,
} from './time';
import { installUserAgent, type UaPatchConfig } from './ua';
import { installWebrtc, type WebrtcScope } from './webrtc';

export interface PatchConfig extends UaPatchConfig {
  tz?: string;
  lang?: string;
  langs?: string[];
  timezone?: number | boolean;
  timezoneOffset?: number | boolean;
  language?: number | boolean;
  intlLocale?: number | boolean;
  fonts?: number | boolean;
  webrtc?: number | boolean;
}

type AnyFn = (...args: any[]) => any;

export interface PatchScope {
  Date: DateConstructor;
  Intl: typeof Intl & Record<string, any>;
  Temporal?: { Now?: Record<string, AnyFn> };
  Navigator?: { prototype: object };
  navigator?: Navigator;
  Object: typeof Object;
  Number: NumberConstructor;
  String: StringConstructor;
  Symbol: typeof Symbol;
  Reflect: typeof Reflect;
  CanvasRenderingContext2D?: FontScope['CanvasRenderingContext2D'];
  OffscreenCanvasRenderingContext2D?: FontScope['OffscreenCanvasRenderingContext2D'];
  FontFaceSet?: FontScope['FontFaceSet'];
  RTCPeerConnection?: WebrtcScope['RTCPeerConnection'];
  webkitRTCPeerConnection?: WebrtcScope['webkitRTCPeerConnection'];
  RTCSessionDescription?: WebrtcScope['RTCSessionDescription'];
}

const INSTALLED = Symbol.for('slc.installed.9f3e2a7c');

function enabled(v: unknown): boolean {
  return v === true || v === 1;
}

function replaceMethod(proto: object, key: string, fn: AnyFn): void {
  Object.defineProperty(proto, key, {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function defineGetter(proto: object, key: string, get: () => unknown): void {
  Object.defineProperty(proto, key, {
    configurable: true,
    enumerable: true,
    get,
  });
}

/**
 * Install MAIN-world wrappers. `cfg` is the snapshot read from the temporary
 * global slot; callers delete that slot before page scripts run.
 * Repeated calls in the same realm do nothing.
 */
export function install(scope: PatchScope, cfg: PatchConfig | null | undefined): void {
  if (!cfg) return;
  if ((scope as unknown as Record<symbol, unknown>)[INSTALLED]) return;
  Object.defineProperty(scope, INSTALLED, { value: true, enumerable: false, writable: false, configurable: false });

  const tzOn = enabled(cfg.timezone);
  const offsetOn = enabled(cfg.timezoneOffset);
  const langOn = enabled(cfg.language);
  const intlOn = enabled(cfg.intlLocale);
  const timeZone = cfg.tz || 'America/Los_Angeles';
  const locale = cfg.lang || 'en-US';
  const langs = (cfg.langs && cfg.langs.length ? cfg.langs.slice() : [locale]).map(String);
  if (langs[0] !== locale) langs.unshift(locale);

  const OrigDate = scope.Date;
  const OrigDTF = scope.Intl.DateTimeFormat;
  const deps: TimeDeps = { Date: OrigDate, DateTimeFormat: OrigDTF };

  if (tzOn || intlOn) guard(() => wrapIntl(scope, deps, { tzOn, intlOn, timeZone, locale }));
  if (offsetOn) guard(() => wrapDate(scope, deps, timeZone, { tzOn, intlOn, locale }));
  else if (intlOn || tzOn) guard(() => wrapDateToLocaleOnly(scope, deps, { tzOn, intlOn, timeZone, locale }));
  if (intlOn) guard(() => wrapOtherToLocale(scope, locale));
  if (langOn) guard(() => wrapNavigator(scope, locale, langs));
  if (tzOn) guard(() => wrapTemporal(scope, timeZone));
  if (enabled(cfg.fonts)) guard(() => installFonts(scope));
  if (enabled(cfg.webrtc)) guard(() => installWebrtc(scope));
  if (cfg.ua) guard(() => installUserAgent(scope, cfg));
}

function guard(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error('slc', err);
  }
}

function wrapIntl(
  scope: PatchScope,
  deps: TimeDeps,
  opts: { tzOn: boolean; intlOn: boolean; timeZone: string; locale: string },
): void {
  const intl = scope.Intl as Record<string, AnyFn>;
  const names = [
    'DateTimeFormat',
    'NumberFormat',
    'Collator',
    'PluralRules',
    'RelativeTimeFormat',
    'ListFormat',
    'DisplayNames',
    'Segmenter',
    'DurationFormat',
  ];
  for (const name of names) {
    const Original = intl[name];
    if (typeof Original !== 'function') continue;
    const fillTz = name === 'DateTimeFormat' && opts.tzOn;
    const fillLocale = opts.intlOn;
    if (!fillTz && !fillLocale) continue;
    if (name === 'DateTimeFormat') {
      // Use the captured original so a later wrap cannot recurse.
      intl[name] = wrapCtor(deps.DateTimeFormat, scope, fillLocale ? opts.locale : null, fillTz ? opts.timeZone : null);
    } else {
      intl[name] = wrapCtor(Original, scope, fillLocale ? opts.locale : null, null);
    }
  }
}

function wrapCtor(Original: AnyFn, scope: PatchScope, locale: string | null, timeZone: string | null): AnyFn {
  function Wrapped(this: unknown, locales?: unknown, options?: unknown): unknown {
    let loc = locales;
    if (locale != null && locales === undefined) loc = locale;
    let opt = options;
    if (timeZone != null) {
      if (options == null) opt = { timeZone };
      else if (typeof options === 'object' && (options as { timeZone?: unknown }).timeZone == null) {
        opt = { ...(options as Record<string, unknown>), timeZone };
      }
    }
    const target = new.target || Original;
    return scope.Reflect.construct(Original, [loc, opt], target);
  }
  Wrapped.prototype = Original.prototype;
  Object.defineProperty(Wrapped, 'name', { value: Original.name, configurable: true });
  Object.defineProperty(Wrapped, 'length', { value: Original.length, configurable: true });
  const supported = (Original as { supportedLocalesOf?: AnyFn }).supportedLocalesOf;
  if (typeof supported === 'function') {
    Object.defineProperty(Wrapped, 'supportedLocalesOf', {
      value(locales?: unknown, options?: unknown) {
        return supported(locales, options);
      },
      writable: true,
      configurable: true,
    });
  }
  return Wrapped;
}

interface LocalGetters {
  getFullYear: (this: Date) => number;
  getMonth: (this: Date) => number;
  getDate: (this: Date) => number;
  getHours: (this: Date) => number;
  getMinutes: (this: Date) => number;
  getSeconds: (this: Date) => number;
  getMilliseconds: (this: Date) => number;
  getTime: (this: Date) => number;
}

function captureLocal(OrigDate: DateConstructor): LocalGetters {
  const p = OrigDate.prototype;
  return {
    getFullYear: p.getFullYear,
    getMonth: p.getMonth,
    getDate: p.getDate,
    getHours: p.getHours,
    getMinutes: p.getMinutes,
    getSeconds: p.getSeconds,
    getMilliseconds: p.getMilliseconds,
    getTime: p.getTime,
  };
}

function wrapDate(
  scope: PatchScope,
  deps: TimeDeps,
  timeZone: string,
  flags: { tzOn: boolean; intlOn: boolean; locale: string },
): void {
  const OrigDate = deps.Date;
  const proto = OrigDate.prototype;
  const local = captureLocal(OrigDate);
  const origSetTime = proto.setTime;
  const origToString = proto.toString;

  const read = (instant: number): Wall | null => wallFromInstant(instant, timeZone, deps);

  function component(this: Date, key: keyof Wall): number {
    const t = local.getTime.call(this);
    if (Number.isNaN(t)) return NaN;
    const wall = read(t);
    return wall ? (wall[key] as number) : NaN;
  }

  replaceMethod(proto, 'getFullYear', function (this: Date) {
    return component.call(this, 'y');
  });
  replaceMethod(proto, 'getMonth', function (this: Date) {
    return component.call(this, 'm');
  });
  replaceMethod(proto, 'getDate', function (this: Date) {
    return component.call(this, 'd');
  });
  replaceMethod(proto, 'getDay', function (this: Date) {
    return component.call(this, 'wd');
  });
  replaceMethod(proto, 'getHours', function (this: Date) {
    return component.call(this, 'h');
  });
  replaceMethod(proto, 'getMinutes', function (this: Date) {
    return component.call(this, 'mi');
  });
  replaceMethod(proto, 'getSeconds', function (this: Date) {
    return component.call(this, 's');
  });
  replaceMethod(proto, 'getTimezoneOffset', function (this: Date) {
    const t = local.getTime.call(this);
    if (Number.isNaN(t)) return NaN;
    return getOffsetMinutes(t, timeZone, deps);
  });

  function write(this: Date, nanMode: 'nan' | 'epoch', mutate: (wall: Wall) => void): number {
    let t = local.getTime.call(this);
    if (Number.isNaN(t)) {
      if (nanMode === 'nan') return NaN;
      t = 0;
    }
    const wall = read(t);
    if (!wall) return NaN;
    mutate(wall);
    const next = wallToInstant(wall.y, wall.m, wall.d, wall.h, wall.mi, wall.s, wall.ms, timeZone, deps);
    return origSetTime.call(this, next);
  }

  const num = (v: unknown) => Number(v);

  replaceMethod(proto, 'setFullYear', function (this: Date, y: unknown, m?: unknown, d?: unknown) {
    const argc = arguments.length;
    return write.call(this, 'epoch', (wall) => {
      wall.y = num(y);
      if (argc >= 2) wall.m = num(m);
      if (argc >= 3) wall.d = num(d);
    });
  });
  replaceMethod(proto, 'setMonth', function (this: Date, m: unknown, d?: unknown) {
    const argc = arguments.length;
    return write.call(this, 'epoch', (wall) => {
      wall.m = num(m);
      if (argc >= 2) wall.d = num(d);
    });
  });
  replaceMethod(proto, 'setDate', function (this: Date, d: unknown) {
    return write.call(this, 'epoch', (wall) => {
      wall.d = num(d);
    });
  });
  replaceMethod(proto, 'setHours', function (this: Date, h: unknown, mi?: unknown, s?: unknown, ms?: unknown) {
    const argc = arguments.length;
    return write.call(this, 'nan', (wall) => {
      if (argc >= 1) wall.h = num(h);
      if (argc >= 2) wall.mi = num(mi);
      if (argc >= 3) wall.s = num(s);
      if (argc >= 4) wall.ms = num(ms);
    });
  });
  replaceMethod(proto, 'setMinutes', function (this: Date, mi: unknown, s?: unknown, ms?: unknown) {
    const argc = arguments.length;
    return write.call(this, 'nan', (wall) => {
      if (argc >= 1) wall.mi = num(mi);
      if (argc >= 2) wall.s = num(s);
      if (argc >= 3) wall.ms = num(ms);
    });
  });
  replaceMethod(proto, 'setSeconds', function (this: Date, s: unknown, ms?: unknown) {
    const argc = arguments.length;
    return write.call(this, 'nan', (wall) => {
      if (argc >= 1) wall.s = num(s);
      if (argc >= 2) wall.ms = num(ms);
    });
  });

  function chromeParts(this: Date): { full: string; date: string; time: string } | null {
    const t = local.getTime.call(this);
    if (Number.isNaN(t)) return null;
    const wall = read(t);
    if (!wall) return null;
    const name = longTimeZoneName(t, timeZone, deps);
    const off = getOffsetMinutes(t, timeZone, deps);
    return formatChromeDate(wall, off, name);
  }

  replaceMethod(proto, 'toString', function (this: Date) {
    return chromeParts.call(this)?.full ?? origToString.call(this);
  });
  replaceMethod(proto, 'toDateString', function (this: Date) {
    return chromeParts.call(this)?.date ?? origToString.call(this).split(' ').slice(0, 4).join(' ');
  });
  replaceMethod(proto, 'toTimeString', function (this: Date) {
    const parts = chromeParts.call(this);
    if (!parts) return origToString.call(this);
    return parts.time;
  });

  wrapDateToLocale(proto, flags.tzOn, flags.intlOn, timeZone, flags.locale);

  const parse = (input: string) => parseDateString(input, timeZone, deps, OrigDate, local);

  function PatchedDate(this: unknown, ...args: unknown[]): unknown {
    if (!new.target) return scope.Reflect.construct(PatchedDate, [], PatchedDate).toString();
    if (args.length === 0) return scope.Reflect.construct(OrigDate, [], new.target);
    if (args.length === 1) {
      const value = args[0];
      if (typeof value === 'string') {
        return scope.Reflect.construct(OrigDate, [parse(value)], new.target);
      }
      return scope.Reflect.construct(OrigDate, [value], new.target);
    }
    const yRaw = Number(args[0]);
    const y = yRaw >= 0 && yRaw <= 99 ? yRaw + 1900 : yRaw;
    const m = Number(args[1]);
    const d = args.length >= 3 ? Number(args[2]) : 1;
    const h = args.length >= 4 ? Number(args[3]) : 0;
    const mi = args.length >= 5 ? Number(args[4]) : 0;
    const s = args.length >= 6 ? Number(args[5]) : 0;
    const ms = args.length >= 7 ? Number(args[6]) : 0;
    const instant = wallToInstant(y, m, d, h, mi, s, ms, timeZone, deps);
    return scope.Reflect.construct(OrigDate, [instant], new.target);
  }

  Object.defineProperty(PatchedDate, 'prototype', { value: proto, writable: false, configurable: false });
  Object.defineProperty(PatchedDate, 'name', { value: 'Date', configurable: true });
  Object.defineProperty(PatchedDate, 'length', { value: 7, configurable: true });
  Object.defineProperty(PatchedDate, 'parse', {
    value: (input: string) => parse(String(input)),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(PatchedDate, 'UTC', { value: OrigDate.UTC, writable: true, configurable: true });
  Object.defineProperty(PatchedDate, 'now', { value: OrigDate.now, writable: true, configurable: true });
  try {
    Object.defineProperty(proto, 'constructor', { value: PatchedDate, writable: true, configurable: true });
  } catch {
    /* prototype constructor is locked in this realm */
  }
  scope.Date = PatchedDate as unknown as DateConstructor;
}

function wrapDateToLocaleOnly(
  scope: PatchScope,
  deps: TimeDeps,
  flags: { tzOn: boolean; intlOn: boolean; timeZone: string; locale: string },
): void {
  wrapDateToLocale(deps.Date.prototype, flags.tzOn, flags.intlOn, flags.timeZone, flags.locale);
}

function wrapDateToLocale(
  proto: DatePrototype,
  tzOn: boolean,
  intlOn: boolean,
  timeZone: string,
  locale: string,
): void {
  for (const key of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString'] as const) {
    const orig = proto[key] as AnyFn;
    replaceMethod(proto, key, function (this: Date, locales?: unknown, options?: unknown) {
      let loc = locales;
      if (intlOn && locales === undefined) loc = locale;
      let opt = options;
      if (tzOn) {
        if (options == null) opt = { timeZone };
        else if (typeof options === 'object' && (options as { timeZone?: unknown }).timeZone == null) {
          opt = { ...(options as Record<string, unknown>), timeZone };
        }
      }
      if (loc === locales && opt === options) return orig.apply(this, [locales, options]);
      return orig.call(this, loc, opt);
    });
  }
}

type DatePrototype = DateConstructor['prototype'];

function wrapOtherToLocale(scope: PatchScope, locale: string): void {
  const pairs: Array<[object, string[]]> = [
    [scope.Number.prototype, ['toLocaleString']],
    [scope.String.prototype, ['toLocaleString', 'toLocaleLowerCase', 'toLocaleUpperCase']],
  ];
  for (const [proto, keys] of pairs) {
    for (const key of keys) {
      const orig = (proto as Record<string, AnyFn>)[key];
      if (typeof orig !== 'function') continue;
      replaceMethod(proto, key, function (this: unknown, locales?: unknown, ...rest: unknown[]) {
        if (locales !== undefined) return orig.apply(this, [locales, ...rest]);
        return orig.call(this, locale, ...rest);
      });
    }
  }
}

function wrapNavigator(scope: PatchScope, locale: string, langs: string[]): void {
  const proto = scope.Navigator?.prototype;
  if (!proto) return;
  const frozen = scope.Object.freeze(langs.slice());
  const nav = scope.navigator as unknown as Record<string, unknown> | undefined;
  if (nav) {
    for (const key of ['language', 'languages']) {
      try {
        if (scope.Object.prototype.hasOwnProperty.call(nav, key)) delete nav[key];
      } catch {
        /* own data property is non-configurable */
      }
    }
  }
  defineGetter(proto, 'language', () => locale);
  defineGetter(proto, 'languages', () => frozen);
}

function wrapTemporal(scope: PatchScope, timeZone: string): void {
  const Now = scope.Temporal?.Now;
  if (!Now) return;
  if (typeof Now.timeZoneId === 'function') {
    Now.timeZoneId = function timeZoneId() {
      return timeZone;
    };
  }
  for (const name of ['zonedDateTimeISO', 'plainDateTimeISO', 'plainDateISO', 'plainTimeISO']) {
    const orig = Now[name];
    if (typeof orig !== 'function') continue;
    Now[name] = function (this: unknown, tzLike?: unknown, ...rest: unknown[]) {
      const argc = arguments.length;
      if (argc === 0 || tzLike == null) return orig.call(Now, timeZone, ...rest);
      return orig.call(Now, tzLike, ...rest);
    };
  }
}

const ISO_RE =
  /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?)?)?(Z|([+-])(\d{2}):?(\d{2}))?$/;

function parseDateString(
  input: string,
  timeZone: string,
  deps: TimeDeps,
  OrigDate: DateConstructor,
  local: LocalGetters,
): number {
  const text = String(input).trim();
  const match = ISO_RE.exec(text);
  if (match) {
    const year = Number(match[1]);
    const month = match[2];
    const day = match[3];
    const hour = match[4];
    const hasZone = Boolean(match[8]);
    if (!hour || hasZone || !month || !day) return OrigDate.parse(text);
    const mo = Number(month);
    const dd = Number(day);
    const hh = Number(hour);
    const mi = Number(match[5]);
    const ss = match[6] ? Number(match[6]) : 0;
    const frac = match[7] ? Number(match[7].padEnd(3, '0')) : 0;
    if (mo < 1 || mo > 12 || dd < 1 || dd > 31 || hh > 23 || mi > 59 || ss > 59) return NaN;
    const probe = `${match[1]}-${month}-${day}T${hour}:${match[5]}:${String(ss).padStart(2, '0')}.${String(frac).padStart(3, '0')}Z`;
    if (Number.isNaN(OrigDate.parse(probe))) return NaN;
    return wallToInstant(year, mo - 1, dd, hh, mi, ss, frac, timeZone, deps);
  }
  if (/(?:Z|[+-]\d{2}:?\d{2}|\bGMT\b|\bUTC\b)/i.test(text)) return OrigDate.parse(text);
  const sys = OrigDate.parse(text);
  if (Number.isNaN(sys)) return NaN;
  const date = new OrigDate(sys);
  return wallToInstant(
    local.getFullYear.call(date),
    local.getMonth.call(date),
    local.getDate.call(date),
    local.getHours.call(date),
    local.getMinutes.call(date),
    local.getSeconds.call(date),
    local.getMilliseconds.call(date),
    timeZone,
    deps,
  );
}
