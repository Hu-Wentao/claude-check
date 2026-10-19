import { describe, expect, it } from 'vitest';
import { candidateExposesAddress, filterSdp, iceEventExposesAddress, installWebrtc } from '../src/patch/webrtc';

const host = 'candidate:1 1 udp 2122260223 192.168.1.10 53421 typ host generation 0';
const srflx = 'candidate:2 1 udp 1686052607 203.0.113.8 19302 typ srflx raddr 192.168.1.10 rport 53421';
const prflx = 'candidate:3 1 udp 41885439 2001:db8::1 54400 typ prflx raddr ::1 rport 54400';
const relay = 'candidate:4 1 udp 41885439 198.51.100.4 3478 typ relay raddr 192.168.1.10 rport 53421';
const mdns = 'candidate:5 1 udp 2122260223 a1b2c3d4-e5f6-7890-abcd-ef1234567890.local 53421 typ host generation 0';
const mdnsLeak = 'candidate:6 1 udp 2122260223 aaaa.local 53421 typ host raddr 10.0.0.8 rport 53421';

describe('webrtc candidate filter', () => {
  it('drops host, srflx, and prflx addresses and keeps relay, mDNS, and the end event', () => {
    expect(candidateExposesAddress(host)).toBe(true);
    expect(candidateExposesAddress(srflx)).toBe(true);
    expect(candidateExposesAddress(prflx)).toBe(true);
    expect(candidateExposesAddress(relay)).toBe(false);
    expect(candidateExposesAddress(mdns)).toBe(false);
    expect(candidateExposesAddress(mdnsLeak)).toBe(true);
    expect(candidateExposesAddress('')).toBe(false);
    expect(iceEventExposesAddress(null)).toBe(false);
    expect(iceEventExposesAddress({ candidate: null })).toBe(false);
    expect(iceEventExposesAddress({ candidate: { candidate: '' } })).toBe(false);
    expect(iceEventExposesAddress({ candidate: { candidate: host } })).toBe(true);

    const sdp = ['v=0', 'c=IN IP4 0.0.0.0', `a=${host}`, `a=${srflx}`, `a=${relay}`, `a=${mdns}`, 'a=end-of-candidates', ''].join('\r\n');
    const filtered = filterSdp(sdp);
    expect(filtered).not.toContain('192.168.1.10 53421 typ host');
    expect(filtered).not.toContain('203.0.113.8');
    expect(filtered).toContain('198.51.100.4');
    expect(filtered).toContain('raddr 192.168.1.10');
    expect(filtered).toContain('.local');
    expect(filtered).toContain('a=end-of-candidates');
    expect(filtered.endsWith('\r\n')).toBe(true);
    for (const line of filtered.split('\r\n')) {
      if (line.startsWith('a=candidate:')) expect(sdp).toContain(line);
    }
  });

  it('filters setter events, listeners, and returned SDP without inventing an address', () => {
    const events: string[] = [];
    function PC(this: { local?: { type: string; sdp: string } | null; handler?: (event: { candidate: { candidate: string } | null }) => void }) {
      this.local = null;
    }
    Object.defineProperty(PC.prototype, 'onicecandidate', {
      configurable: true,
      enumerable: true,
      get() {
        return this.handler || null;
      },
      set(fn) {
        this.handler = fn;
      },
    });
    Object.defineProperty(PC.prototype, 'localDescription', {
      configurable: true,
      get() {
        return this.local;
      },
    });
    PC.prototype.createOffer = function () {
      this.local = { type: 'offer', sdp: `v=0\r\na=${host}\r\na=${relay}\r\n` };
      return Promise.resolve(this.local);
    };
    PC.prototype.createAnswer = PC.prototype.createOffer;
    PC.prototype.addEventListener = function (type: string, listener: (event: unknown) => void) {
      this.listener = type === 'icecandidate' ? listener : null;
    };
    const scope = {
      RTCPeerConnection: PC,
      RTCSessionDescription: function Sdp(this: { type: string; sdp: string }, init: { type: string; sdp: string }) {
        this.type = init.type;
        this.sdp = init.sdp;
      },
      Reflect,
    };
    installWebrtc(scope as never);
    const pc = new scope.RTCPeerConnection() as {
      onicecandidate: ((event: { candidate: { candidate: string } | null }) => void) | null;
      localDescription: { sdp: string } | null;
      createOffer: () => Promise<{ sdp: string }>;
      addEventListener: (type: string, listener: (event: { candidate: { candidate: string } | null }) => void) => void;
      listener?: (event: { candidate: { candidate: string } | null }) => void;
    };
    pc.onicecandidate = (event) => {
      events.push(event.candidate?.candidate || 'end');
    };
    pc.onicecandidate?.({ candidate: { candidate: host } });
    pc.onicecandidate?.({ candidate: { candidate: mdns } });
    pc.onicecandidate?.({ candidate: null });
    pc.addEventListener('icecandidate', (event) => {
      events.push(`listen:${event.candidate?.candidate || 'end'}`);
    });
    pc.listener?.({ candidate: { candidate: srflx } });
    pc.listener?.({ candidate: { candidate: relay } });
    return pc.createOffer().then((offer) => {
      expect(events).toEqual([mdns, 'end', `listen:${relay}`]);
      expect(offer.sdp).not.toContain('192.168.1.10 53421 typ host');
      expect(offer.sdp).toContain('198.51.100.4');
      expect(offer.sdp).toContain('raddr 192.168.1.10');
      expect(pc.localDescription?.sdp).not.toContain('typ host');
      expect(offer.sdp).not.toContain('203.0.113.9');
    });
  });
});
