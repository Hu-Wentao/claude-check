import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { getOffsetMinutes } from '../src/patch/time';
import { install } from '../src/patch/install';
import { boot } from './realm';

const deps = { Date, DateTimeFormat: Intl.DateTimeFormat };

function native(timeZone: string, expression: string): unknown {
  const res = spawnSync(process.execPath, ['-e', `process.stdout.write(JSON.stringify(${expression}))`], {
    env: { ...process.env, TZ: timeZone },
    encoding: 'utf8',
  });
  if (res.status !== 0) throw new Error(res.stderr || `${timeZone} failed`);
  return JSON.parse(res.stdout);
}

const laCfg = {
  tz: 'America/Los_Angeles',
  lang: 'en-US',
  langs: ['en-US', 'en'],
  timezone: 1 as const,
  timezoneOffset: 1 as const,
  language: 1 as const,
  intlLocale: 1 as const,
};

describe('timezone engine', () => {
  it('Los Angeles January and July offsets differ by 60 minutes', () => {
    const jan = getOffsetMinutes(Date.parse('2026-01-15T20:00:00Z'), 'America/Los_Angeles', deps);
    const jul = getOffsetMinutes(Date.parse('2026-07-15T19:00:00Z'), 'America/Los_Angeles', deps);
    expect(jan).toBe(480);
    expect(jul).toBe(420);
    expect(jan - jul).toBe(60);
    expect(getOffsetMinutes(Date.parse('2026-01-15T06:30:00Z'), 'Asia/Kolkata', deps)).toBe(-330);
  });

  it('matches V8 across DST gaps and overlaps', () => {
    const cases: Array<[string, string, string]> = [
      ['America/Los_Angeles', 'new Date(2026,0,15,12,0,0)', '2026-01-15T20:00:00.000Z'],
      ['America/Los_Angeles', 'new Date(2026,6,15,12,0,0)', '2026-07-15T19:00:00.000Z'],
      ['America/Los_Angeles', 'new Date(2026,2,8,2,30)', '2026-03-08T10:30:00.000Z'],
      ['America/Los_Angeles', 'new Date(2026,2,8,2,0)', '2026-03-08T10:00:00.000Z'],
      ['America/Los_Angeles', 'new Date(2026,10,1,1,30)', '2026-11-01T08:30:00.000Z'],
      ['America/New_York', 'new Date(2026,2,8,2,30)', '2026-03-08T07:30:00.000Z'],
      ['Europe/London', 'new Date(2026,2,29,1,30)', '2026-03-29T01:30:00.000Z'],
      ['Europe/London', 'new Date(2026,2,29,2,30)', '2026-03-29T01:30:00.000Z'],
      ['Europe/London', 'new Date(2026,9,25,1,30)', '2026-10-25T00:30:00.000Z'],
      ['Australia/Sydney', 'new Date(2026,9,4,2,30)', '2026-10-03T16:30:00.000Z'],
      ['Australia/Sydney', 'new Date(2026,3,5,2,30)', '2026-04-04T15:30:00.000Z'],
      ['Asia/Kolkata', 'new Date(2026,0,15,12,0,0)', '2026-01-15T06:30:00.000Z'],
    ];
    for (const [zone, expr, iso] of cases) {
      expect(native(zone, `${expr}.toISOString()`)).toBe(iso);
      const realm = boot({ ...laCfg, tz: zone, langs: ['en-US', 'en'] });
      expect(realm.run(`${expr}.toISOString()`)).toBe(iso);
      expect(realm.run(`${expr}.toString()`)).toBe(native(zone, `${expr}.toString()`));
      expect(realm.run(`${expr}.getTimezoneOffset()`)).toBe(native(zone, `${expr}.getTimezoneOffset()`));
      expect(realm.run(`${expr}.getHours()`)).toBe(native(zone, `${expr}.getHours()`));
    }
  });
});

describe('installed Date and Intl', () => {
  const realm = boot(laCfg);

  it('reports the Los Angeles offset and keeps UTC methods', () => {
    expect(realm.run('new Date(2026,0,15,12,0,0).getTimezoneOffset()')).toBe(480);
    expect(realm.run('new Date(2026,6,15,12,0,0).getTimezoneOffset()')).toBe(420);
    const stamp = Date.UTC(2026, 0, 15, 20, 30, 0);
    expect(realm.run(`(() => { const d = new Date(${stamp}); return [d.toISOString(), d.getUTCHours(), d.getTime(), Date.UTC(2026,0,15), d.getHours()]; })()`)).toEqual([
      '2026-01-15T20:30:00.000Z',
      20,
      stamp,
      Date.UTC(2026, 0, 15),
      12,
    ]);
  });

  it('keeps getHours aligned with Intl formatToParts', () => {
    const aligned = realm.run<boolean>(`
      (() => {
        const samples = [new Date(2026,0,15,0,0,0), new Date(2026,6,15,15,30,0), new Date(2026,9,19,3,0,0)];
        return samples.every((d) => {
          const parts = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
          const hour = Number(parts.find((part) => part.type === 'hour').value);
          const minute = Number(parts.find((part) => part.type === 'minute').value);
          return hour === d.getHours() && minute === d.getMinutes();
        });
      })()
    `);
    expect(aligned).toBe(true);
    expect(realm.run(`Intl.DateTimeFormat().resolvedOptions().timeZone`)).toBe('America/Los_Angeles');
  });

  it('round-trips a local multi-argument constructor', () => {
    expect(
      realm.run(`(() => { const d = new Date(2026,6,15,12,30,45,7); return [d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds(), d.toISOString()]; })()`),
    ).toEqual([2026, 6, 15, 12, 30, 45, 7, '2026-07-15T19:30:45.007Z']);
    expect(realm.run('new Date(99,0,1).getFullYear()')).toBe(1999);
    expect(realm.run('(() => { const d = new Date(2026,0,1); d.setFullYear(99); return d.getFullYear(); })()')).toBe(99);
    expect(realm.run('(() => { const d = new Date(2026,6,15,12,4,5); d.setHours(8); return [d.getHours(), d.getMinutes(), d.getSeconds()]; })()')).toEqual([8, 4, 5]);
    expect(realm.run('(() => { const d = new Date(2026,6,15,12,4,5); d.setHours(8, 9, 10, 11); return [d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]; })()')).toEqual([8, 9, 10, 11]);
    expect(realm.run('Number.isNaN(new Date(NaN).setHours(1))')).toBe(true);
    expect(realm.run('Number.isNaN(new Date(NaN).setFullYear(2026))')).toBe(false);
  });

  it('formats Chrome local strings', () => {
    expect(realm.run('new Date(2026,9,19,3,0,0).toString()')).toBe('Mon Oct 19 2026 03:00:00 GMT-0700 (Pacific Daylight Time)');
    expect(realm.run('new Date(2026,9,19,3,0,0).toDateString()')).toBe('Mon Oct 19 2026');
    expect(realm.run('new Date(2026,9,19,3,0,0).toTimeString()')).toBe('03:00:00 GMT-0700 (Pacific Daylight Time)');
    expect(realm.run('new Date(2026,9,5,3,0,0).toString()')).toBe(native('America/Los_Angeles', 'new Date(2026,9,5,3,0,0).toString()'));
    expect(realm.run(`new Date(${Date.parse('2026-01-15T06:30:00Z')}).toString()`)).not.toContain('GMT+0530');
    const kolkata = boot({ ...laCfg, tz: 'Asia/Kolkata' });
    expect(kolkata.run('new Date(2026,0,15,12,0,0).toString()')).toBe('Thu Jan 15 2026 12:00:00 GMT+0530 (India Standard Time)');
  });

  it('does not expose an illegal local time on a DST boundary', () => {
    const bad = realm.run<string[]>(`
      (() => {
        const bad = [];
        function check(month, day) {
          for (let minutes = 0; minutes < 24 * 60; minutes += 10) {
            const h = Math.floor(minutes / 60);
            const mi = minutes % 60;
            const d = new Date(2026, month, day, h, mi, 0);
            const y = d.getFullYear();
            const m = d.getMonth();
            const dd = d.getDate();
            const hh = d.getHours();
            const mm = d.getMinutes();
            const ss = d.getSeconds();
            const again = new Date(y, m, dd, hh, mm, ss);
            if (again.getTime() !== d.getTime()) bad.push('round ' + month + ' ' + h + ':' + mi);
            const parts = new Intl.DateTimeFormat('en-US', {
              hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
            }).formatToParts(d);
            const map = {};
            for (const part of parts) if (part.type !== 'literal') map[part.type] = part.value;
            if (Number(map.hour) !== hh || Number(map.minute) !== mm || Number(map.day) !== dd || Number(map.year) !== y) {
              bad.push('parts ' + month + ' ' + h + ':' + mi + ' ' + JSON.stringify(map));
            }
          }
        }
        check(2, 8);
        check(10, 1);
        const gap = new Date(2026, 2, 8, 2, 30, 0);
        if (gap.getHours() === 2) bad.push('gap stayed at 02:30');
        return bad;
      })()
    `);
    expect(bad).toEqual([]);
  });

  it('parses local strings in the target zone and leaves absolute time alone', () => {
    expect(realm.run(`new Date('2026-10-19T03:00:00').toISOString()`)).toBe(native('America/Los_Angeles', `new Date('2026-10-19T03:00:00').toISOString()`));
    expect(realm.run(`new Date('October 19, 2026 03:00:00').toISOString()`)).toBe(native('America/Los_Angeles', `new Date('October 19, 2026 03:00:00').toISOString()`));
    expect(realm.run(`Date.parse('2026-10-19T03:00:00')`)).toBe(native('America/Los_Angeles', `Date.parse('2026-10-19T03:00:00')`));
    expect(realm.run(`new Date('2026-10-19T03:00:00Z').toISOString()`)).toBe('2026-10-19T03:00:00.000Z');
    expect(realm.run(`new Date('2026-10-19').toISOString()`)).toBe('2026-10-19T00:00:00.000Z');
    expect(realm.run(`Number.isNaN(Date.parse('2026-13-01T00:00:00'))`)).toBe(true);
  });

  it('fills omitted Intl locale and time zone without mutating options', () => {
    expect(realm.run(`(() => { const o = { hour: 'numeric' }; const fmt = new Intl.DateTimeFormat(undefined, o); return [fmt.resolvedOptions().timeZone, fmt.resolvedOptions().locale, o.timeZone || '']; })()`)).toEqual([
      'America/Los_Angeles',
      realm.run(`new Intl.DateTimeFormat('en-US').resolvedOptions().locale`),
      '',
    ]);
    expect(realm.run('new Intl.NumberFormat().resolvedOptions().locale')).toBe(realm.run(`new Intl.NumberFormat('en-US').resolvedOptions().locale`));
    expect(realm.run('new Date() instanceof Date')).toBe(true);
    expect(realm.run('new Intl.DateTimeFormat() instanceof Intl.DateTimeFormat')).toBe(true);
    expect(realm.run(`Array.isArray(Intl.DateTimeFormat.supportedLocalesOf('en'))`)).toBe(true);
    expect(realm.run('typeof Date()')).toBe('string');
    expect(realm.run(`Intl.DateTimeFormat().resolvedOptions().timeZone`)).toBe('America/Los_Angeles');
  });

  it('overrides navigator language and Temporal defaults', () => {
    expect(realm.run('navigator.language')).toBe('en-US');
    expect(realm.run('[...navigator.languages]')).toEqual(['en-US', 'en']);
    expect(realm.run('navigator.languages[0] === navigator.language')).toBe(true);
    expect(realm.run('Object.isFrozen(navigator.languages)')).toBe(true);
    expect(realm.run('Temporal.Now.timeZoneId()')).toBe('America/Los_Angeles');
    expect(realm.run('Temporal.Now.zonedDateTimeISO()')).toBe('zoned:America/Los_Angeles');
    expect(realm.run('Temporal.Now.zonedDateTimeISO(null)')).toBe('zoned:America/Los_Angeles');
    expect(realm.run(`Temporal.Now.plainDateISO('Europe/Paris')`)).toBe('pd:Europe/Paris');
    expect(realm.run('Temporal.Now.plainTimeISO()')).toBe('pt:America/Los_Angeles');
  });

  it('can enable the Intl zone without changing getTimezoneOffset', () => {
    const partial = boot({ ...laCfg, timezoneOffset: 0 });
    const sample = Date.UTC(2026, 6, 15, 19, 0, 0);
    expect(partial.run(`new Date(${sample}).getTimezoneOffset()`)).toBe(new Date(sample).getTimezoneOffset());
    expect(partial.run('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe('America/Los_Angeles');
    expect(partial.run(`new Intl.DateTimeFormat().resolvedOptions().locale`)).not.toBe('');
  });

  it('uses the locale for Number and String conversions', () => {
    const german = boot({
      tz: 'Europe/Berlin',
      lang: 'de-DE',
      langs: ['de-DE', 'de'],
      timezone: 0,
      timezoneOffset: 0,
      language: 0,
      intlLocale: 1,
    });
    expect(german.run('(1000).toLocaleString()')).toBe((1000).toLocaleString('de-DE'));
    expect(german.run(`'I'.toLocaleLowerCase()`)).toBe('i');
    const turkish = boot({ ...laCfg, lang: 'tr-TR', langs: ['tr-TR', 'tr'], timezone: 0, timezoneOffset: 0, language: 0 });
    expect(turkish.run(`'I'.toLocaleLowerCase()`)).toBe('I'.toLocaleLowerCase('tr-TR'));
  });

  it('does not install twice', () => {
    const once = boot(laCfg);
    install(once.scope, { ...laCfg, tz: 'Europe/Paris' });
    expect(once.run('Intl.DateTimeFormat().resolvedOptions().timeZone')).toBe('America/Los_Angeles');
    const names = once.run<string[]>('Object.getOwnPropertyNames(globalThis)');
    expect(names.filter((name) => /slc|9f3e2a/i.test(name))).toEqual([]);
  });
});
