type AnyFn = (...args: any[]) => any;

export interface IceCandidateLike {
  candidate?: string;
}

export interface IceEventLike {
  candidate?: IceCandidateLike | null;
}

export interface SdpLike {
  type?: string;
  sdp?: string;
}

export interface WebrtcScope {
  RTCPeerConnection?: AnyFn;
  webkitRTCPeerConnection?: AnyFn;
  RTCSessionDescription?: new (init: { type: string; sdp: string }) => unknown;
  Reflect?: typeof Reflect;
}

const WRAPPED = Symbol.for('slc.webrtc.9f3e2a7c');

function isIpv4(addr: string): boolean {
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(addr)) return false;
  return addr.split('.').every((part) => Number(part) <= 255);
}

function isIpv6(addr: string): boolean {
  if (!addr.includes(':') || !/^[0-9a-fA-F:]+$/.test(addr)) return false;
  const halves = addr.split('::');
  if (halves.length > 2) return false;
  const groups = (half: string) => (half ? half.split(':').filter((part) => part.length > 0).length : 0);
  if (halves.length === 2) return groups(halves[0] || '') + groups(halves[1] || '') <= 7;
  return addr.split(':').length === 8;
}

export function isIpAddress(addr: string): boolean {
  return isIpv4(addr) || isIpv6(addr);
}

export function parseCandidate(line: string): { addr: string; typ: string } | null {
  const text = line.trim().replace(/^a=/i, '');
  const match = /^candidate:\S+ \d+ \S+ \d+ (\S+) \d+ typ (\S+)/i.exec(text);
  if (!match) return null;
  return { addr: match[1] || '', typ: (match[2] || '').toLowerCase() };
}

function tailHasIp(line: string): boolean {
  const idx = line.toLowerCase().indexOf(' typ ');
  const tail = idx >= 0 ? line.slice(idx + 5).replace(/^(host|srflx|prflx|relay)\b/i, '') : line;
  if (/(?:^|[^0-9])(\d{1,3}(?:\.\d{1,3}){3})(?![0-9])/.test(tail)) return true;
  return /[0-9a-fA-F]{0,4}::|[0-9a-fA-F]+:[0-9a-fA-F]+:/.test(tail);
}

/** True when a host, srflx, or prflx candidate exposes an IP. Relay and bare mDNS stay. */
export function candidateExposesAddress(line: string): boolean {
  if (!line) return false;
  const parsed = parseCandidate(line);
  if (!parsed) return false;
  if (parsed.typ === 'relay') return false;
  if (parsed.typ !== 'host' && parsed.typ !== 'srflx' && parsed.typ !== 'prflx') return false;
  if (isIpAddress(parsed.addr)) return true;
  if (parsed.addr.endsWith('.local')) return tailHasIp(line);
  return false;
}

export function iceEventExposesAddress(event: IceEventLike | null | undefined): boolean {
  if (!event || !event.candidate) return false;
  const line = event.candidate.candidate;
  if (!line) return false;
  return candidateExposesAddress(line);
}

export function filterSdp(sdp: string): string {
  if (!sdp) return sdp;
  const newline = sdp.includes('\r\n') ? '\r\n' : '\n';
  const parts = sdp.split(/\r?\n/);
  const kept = parts.filter((line) => {
    if (!/^a=candidate:/i.test(line) && !/^candidate:/i.test(line)) return true;
    return !candidateExposesAddress(line);
  });
  if (kept.length === parts.length) return sdp;
  return kept.join(newline);
}

function filterDescription(value: SdpLike | null | undefined, RTCSessionDescription: WebrtcScope['RTCSessionDescription']): SdpLike | null | undefined {
  if (!value || typeof value.sdp !== 'string') return value;
  const sdp = filterSdp(value.sdp);
  if (sdp === value.sdp) return value;
  const type = value.type || 'offer';
  if (typeof RTCSessionDescription === 'function') {
    try {
      return new RTCSessionDescription({ type, sdp }) as SdpLike;
    } catch {
      /* plain object still exposes .sdp */
    }
  }
  return { type, sdp };
}

function replaceMethod(proto: object, key: string, fn: AnyFn): void {
  Object.defineProperty(proto, key, {
    value: fn,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

function wrapIceSetter(proto: object): void {
  const current = Object.getOwnPropertyDescriptor(proto, 'onicecandidate');
  const store = new WeakMap<object, unknown>();
  Object.defineProperty(proto, 'onicecandidate', {
    configurable: true,
    enumerable: current?.enumerable ?? true,
    get() {
      if (current?.get) return current.get.call(this);
      return store.get(this) ?? null;
    },
    set(handler: unknown) {
      const wrapped =
        typeof handler === 'function'
          ? function (this: unknown, event: IceEventLike) {
              try {
                if (iceEventExposesAddress(event)) return;
              } catch {
                /* deliver the original event if the filter itself fails */
              }
              return handler.call(this, event);
            }
          : handler;
      if (current?.set) current.set.call(this, wrapped);
      else store.set(this, wrapped);
    },
  });
}

function wrapAddListener(proto: object): void {
  const origAdd = (proto as { addEventListener?: AnyFn }).addEventListener;
  const origRemove = (proto as { removeEventListener?: AnyFn }).removeEventListener;
  if (typeof origAdd !== 'function') return;
  const map = new WeakMap<object, object>();
  const wrap = (listener: unknown) => {
    if (!listener || (typeof listener !== 'function' && typeof (listener as { handleEvent?: unknown }).handleEvent !== 'function')) {
      return listener;
    }
    const cached = map.get(listener as object);
    if (cached) return cached;
    const wrapped =
      typeof listener === 'function'
        ? function (this: unknown, event: IceEventLike) {
            try {
              if (iceEventExposesAddress(event)) return;
            } catch {
              /* deliver */
            }
            return listener.call(this, event);
          }
        : {
            handleEvent(event: IceEventLike) {
              try {
                if (iceEventExposesAddress(event)) return;
              } catch {
                /* deliver */
              }
              return (listener as { handleEvent: AnyFn }).handleEvent(event);
            },
          };
    map.set(listener as object, wrapped as object);
    return wrapped;
  };
  replaceMethod(proto, 'addEventListener', function (this: unknown, type: string, listener: unknown, options?: unknown) {
    if (type === 'icecandidate') return origAdd.call(this, type, wrap(listener), options);
    return origAdd.call(this, type, listener, options);
  });
  if (typeof origRemove === 'function') {
    replaceMethod(proto, 'removeEventListener', function (this: unknown, type: string, listener: unknown, options?: unknown) {
      if (type === 'icecandidate' && listener && map.has(listener as object)) {
        return origRemove.call(this, type, map.get(listener as object), options);
      }
      return origRemove.call(this, type, listener, options);
    });
  }
}

function wrapSdpMethod(proto: object, key: 'createOffer' | 'createAnswer', RTCSessionDescription: WebrtcScope['RTCSessionDescription']): void {
  const orig = (proto as Record<string, AnyFn | undefined>)[key];
  if (typeof orig !== 'function') return;
  const clean = (desc: SdpLike) => {
    try {
      return filterDescription(desc, RTCSessionDescription);
    } catch {
      return desc;
    }
  };
  replaceMethod(proto, key, function (this: unknown, ...args: unknown[]) {
    if (typeof args[0] === 'function') {
      const success = args[0] as AnyFn;
      args[0] = (desc: SdpLike) => success(clean(desc));
      return orig.apply(this, args);
    }
    const result = orig.apply(this, args);
    if (result && typeof (result as Promise<SdpLike>).then === 'function') {
      return (result as Promise<SdpLike>).then((desc) => clean(desc));
    }
    return result;
  });
}

function wrapDescriptions(proto: object, RTCSessionDescription: WebrtcScope['RTCSessionDescription']): void {
  for (const key of ['localDescription', 'currentLocalDescription', 'pendingLocalDescription']) {
    const current = Object.getOwnPropertyDescriptor(proto, key);
    if (!current?.get) continue;
    const orig = current.get;
    try {
      Object.defineProperty(proto, key, {
        configurable: true,
        enumerable: current.enumerable ?? true,
        get() {
          const value = orig.call(this) as SdpLike | null;
          try {
            return filterDescription(value, RTCSessionDescription);
          } catch {
            return value;
          }
        },
      });
    } catch {
      /* the descriptor is not configurable in this realm */
    }
  }
}

function patchPrototype(proto: object, scope: WebrtcScope): void {
  if (!proto || (proto as Record<symbol, unknown>)[WRAPPED]) return;
  Object.defineProperty(proto, WRAPPED, { value: true, enumerable: false });
  wrapIceSetter(proto);
  wrapAddListener(proto);
  wrapSdpMethod(proto, 'createOffer', scope.RTCSessionDescription);
  wrapSdpMethod(proto, 'createAnswer', scope.RTCSessionDescription);
  wrapDescriptions(proto, scope.RTCSessionDescription);
}

function replaceConstructor(scope: WebrtcScope, name: 'RTCPeerConnection' | 'webkitRTCPeerConnection', Original: AnyFn): void {
  function Patched(this: unknown, ...args: unknown[]) {
    const reflect = scope.Reflect;
    const target = new.target && new.target !== Patched ? new.target : Original;
    if (reflect) return reflect.construct(Original, args, target);
    const Ctor = Original as unknown as new (...args: unknown[]) => unknown;
    return new Ctor(...args);
  }
  Patched.prototype = Original.prototype;
  try {
    Object.defineProperty(Patched, 'name', { value: Original.name || name, configurable: true });
  } catch {
    /* ignore */
  }
  for (const key of Object.getOwnPropertyNames(Original)) {
    if (key === 'prototype' || key === 'length' || key === 'name') continue;
    const desc = Object.getOwnPropertyDescriptor(Original, key);
    if (!desc) continue;
    try {
      Object.defineProperty(Patched, key, desc);
    } catch {
      /* static property is not redefinable */
    }
  }
  try {
    scope[name] = Patched as unknown as AnyFn;
  } catch {
    /* the global binding is read-only; prototype patches still apply */
  }
}

export function installWebrtc(scope: WebrtcScope): void {
  const seen = new Set<AnyFn>();
  for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection'] as const) {
    const Original = scope[name];
    if (typeof Original !== 'function' || seen.has(Original)) continue;
    seen.add(Original);
    try {
      patchPrototype(Original.prototype, scope);
    } catch {
      /* keep going so the other constructor can still be patched */
    }
    replaceConstructor(scope, name, Original);
  }
}
