// Exchange calendars on the real world clock. Every time is wall-clock time in the exchange's IANA zone,
// converted through Intl, so daylight saving moves the session with the exchange and never with UTC.
// Holidays and early closes come from each exchange's published calendar (docs/realtime.md lists the
// sources); provider calendars synced into rt_calendar override them day by day.

export type ExchangeId = 'US' | 'LSE' | 'XETRA' | 'EURONEXT' | 'TSE' | 'HKEX' | 'SSE' | 'TSX' | 'ASX';
export type MarketState = 'pre' | 'open' | 'break' | 'post' | 'closed' | 'holiday';

export interface ExchangeDef {
  id: ExchangeId;
  name: string;
  tz: string;
  /** Listing venues (MIC) that trade on this calendar. */
  mics: string[];
  open: string;
  close: string;
  /** Midday pause (Tokyo, Shanghai). */
  lunch?: [string, string];
  /** Extended sessions the simulation trades in (limit orders only). */
  pre?: string;
  post?: string;
  holidays: Record<string, string>;
  early: Record<string, string>;
  /** Last year whose holidays are published here. Later dates are weekday-only guesses and say so. */
  knownThrough: number;
  /** Dates from the exchange's own page (true) or from general knowledge that still needs checking. */
  verified: boolean;
}

const h = (list: string) => Object.fromEntries(list.split(',').map((e) => e.trim().split(' ')).map(([d, ...n]) => [d!, n.join(' ')]));
const e = (list: string) => Object.fromEntries(list.split(',').map((x) => x.trim().split(' ') as [string, string]));

export const EXCHANGES: Record<ExchangeId, ExchangeDef> = {
  US: {
    id: 'US', name: 'NYSE / Nasdaq', tz: 'America/New_York', mics: ['XNYS', 'XNAS', 'XNGS', 'XNMS', 'XNCM', 'XASE', 'ARCX', 'BATS', 'IEXG'],
    open: '09:30', close: '16:00', pre: '04:00', post: '20:00', knownThrough: 2027, verified: true,
    holidays: h(`2026-01-01 New Year's Day, 2026-01-19 Martin Luther King Jr. Day, 2026-02-16 Washington's Birthday, 2026-04-03 Good Friday,
      2026-05-25 Memorial Day, 2026-06-19 Juneteenth, 2026-07-03 Independence Day, 2026-09-07 Labor Day, 2026-11-26 Thanksgiving, 2026-12-25 Christmas,
      2027-01-01 New Year's Day, 2027-01-18 Martin Luther King Jr. Day, 2027-02-15 Washington's Birthday, 2027-03-26 Good Friday, 2027-05-31 Memorial Day,
      2027-06-18 Juneteenth, 2027-07-05 Independence Day, 2027-09-06 Labor Day, 2027-11-25 Thanksgiving, 2027-12-24 Christmas`),
    early: e('2026-11-27 13:00, 2026-12-24 13:00, 2027-11-26 13:00'),
  },
  TSX: {
    id: 'TSX', name: 'Toronto Stock Exchange', tz: 'America/Toronto', mics: ['XTSE', 'XTSX'], open: '09:30', close: '16:00', knownThrough: 2027, verified: true,
    holidays: h(`2026-01-01 New Year's Day, 2026-02-16 Family Day, 2026-04-03 Good Friday, 2026-05-18 Victoria Day, 2026-07-01 Canada Day,
      2026-08-03 Civic Holiday, 2026-09-07 Labour Day, 2026-10-12 Thanksgiving, 2026-12-25 Christmas, 2026-12-28 Boxing Day,
      2027-01-01 New Year's Day, 2027-02-15 Family Day, 2027-03-26 Good Friday, 2027-05-24 Victoria Day, 2027-07-01 Canada Day, 2027-08-02 Civic Holiday,
      2027-09-06 Labour Day, 2027-10-11 Thanksgiving, 2027-12-27 Christmas, 2027-12-28 Boxing Day`),
    early: e('2026-12-24 13:00, 2027-12-24 13:00'),
  },
  LSE: {
    id: 'LSE', name: 'London Stock Exchange', tz: 'Europe/London', mics: ['XLON'], open: '08:00', close: '16:30', knownThrough: 2027, verified: true,
    holidays: h(`2026-01-01 New Year's Day, 2026-04-03 Good Friday, 2026-04-06 Easter Monday, 2026-05-04 Early May bank holiday, 2026-05-25 Spring bank holiday,
      2026-08-31 Summer bank holiday, 2026-12-25 Christmas, 2026-12-28 Boxing Day, 2027-01-01 New Year's Day, 2027-03-26 Good Friday, 2027-03-29 Easter Monday,
      2027-05-03 Early May bank holiday, 2027-05-31 Spring bank holiday, 2027-08-30 Summer bank holiday, 2027-12-27 Christmas, 2027-12-28 Boxing Day`),
    early: e('2026-12-24 12:30, 2026-12-31 12:30, 2027-12-24 12:30, 2027-12-31 12:30'),
  },
  XETRA: {
    id: 'XETRA', name: 'Xetra', tz: 'Europe/Berlin', mics: ['XETR', 'XFRA'], open: '09:00', close: '17:30', knownThrough: 2027, verified: false,
    holidays: h(`2026-01-01 New Year's Day, 2026-04-03 Good Friday, 2026-04-06 Easter Monday, 2026-05-01 Labour Day, 2026-12-24 Christmas Eve,
      2026-12-25 Christmas, 2026-12-31 New Year's Eve, 2027-01-01 New Year's Day, 2027-03-26 Good Friday, 2027-03-29 Easter Monday, 2027-12-24 Christmas Eve,
      2027-12-31 New Year's Eve`),
    early: {},
  },
  EURONEXT: {
    id: 'EURONEXT', name: 'Euronext', tz: 'Europe/Paris', mics: ['XPAR', 'XAMS', 'XBRU', 'XLIS'], open: '09:00', close: '17:30', knownThrough: 2027, verified: false,
    holidays: h(`2026-01-01 New Year's Day, 2026-04-03 Good Friday, 2026-04-06 Easter Monday, 2026-05-01 Labour Day, 2026-12-25 Christmas,
      2027-01-01 New Year's Day, 2027-03-26 Good Friday, 2027-03-29 Easter Monday`),
    early: e('2026-12-24 14:05, 2026-12-31 14:05, 2027-12-24 14:05, 2027-12-31 14:05'),
  },
  TSE: {
    id: 'TSE', name: 'Tokyo Stock Exchange', tz: 'Asia/Tokyo', mics: ['XJPX', 'XTKS'], open: '09:00', close: '15:30', lunch: ['11:30', '12:30'], knownThrough: 2027, verified: true,
    holidays: h(`2026-01-01 New Year's Day, 2026-01-02 Market holiday, 2026-01-12 Coming of Age Day, 2026-02-11 National Foundation Day, 2026-02-23 Emperor's Birthday,
      2026-03-20 Vernal Equinox Day, 2026-04-29 Showa Day, 2026-05-04 Greenery Day, 2026-05-05 Children's Day, 2026-05-06 Constitution Day, 2026-07-20 Marine Day,
      2026-08-11 Mountain Day, 2026-09-21 Respect for the Aged Day, 2026-09-22 Citizens' Holiday, 2026-09-23 Autumnal Equinox Day, 2026-10-12 Sports Day,
      2026-11-03 Culture Day, 2026-11-23 Labor Thanksgiving Day, 2026-12-31 Market holiday, 2027-01-01 New Year's Day, 2027-01-11 Coming of Age Day,
      2027-02-11 National Foundation Day, 2027-02-23 Emperor's Birthday, 2027-03-22 Vernal Equinox Day, 2027-04-29 Showa Day, 2027-05-03 Constitution Day,
      2027-05-04 Greenery Day, 2027-05-05 Children's Day, 2027-07-19 Marine Day, 2027-08-11 Mountain Day, 2027-09-20 Respect for the Aged Day,
      2027-09-23 Autumnal Equinox Day, 2027-10-11 Sports Day, 2027-11-03 Culture Day, 2027-11-23 Labor Thanksgiving Day, 2027-12-31 Market holiday`),
    early: {},
  },
  HKEX: {
    // Continuous trading 09:30 to 16:00: the old lunch break is now the extended morning session.
    id: 'HKEX', name: 'Hong Kong Exchange', tz: 'Asia/Hong_Kong', mics: ['XHKG'], open: '09:30', close: '16:00', knownThrough: 2026, verified: true,
    holidays: h(`2026-01-01 New Year's Day, 2026-02-17 Lunar New Year, 2026-02-18 Lunar New Year, 2026-02-19 Lunar New Year, 2026-04-03 Good Friday,
      2026-04-06 Day after Ching Ming, 2026-04-07 Day after Easter Monday, 2026-05-01 Labour Day, 2026-05-25 Day after Buddha's Birthday, 2026-06-19 Tuen Ng,
      2026-07-01 HKSAR Establishment Day, 2026-10-01 National Day, 2026-10-19 Day after Chung Yeung, 2026-12-25 Christmas`),
    early: e('2026-02-16 12:00, 2026-12-24 12:00, 2026-12-31 12:00'),
  },
  SSE: {
    id: 'SSE', name: 'Shanghai / Shenzhen', tz: 'Asia/Shanghai', mics: ['XSHG', 'XSHE'], open: '09:30', close: '15:00', lunch: ['11:30', '13:00'], knownThrough: 2026, verified: true,
    holidays: h(`2026-01-01 New Year, 2026-01-02 New Year, 2026-02-16 Spring Festival, 2026-02-17 Spring Festival, 2026-02-18 Spring Festival,
      2026-02-19 Spring Festival, 2026-02-20 Spring Festival, 2026-02-23 Spring Festival, 2026-04-06 Qingming, 2026-05-01 Labour Day, 2026-05-04 Labour Day,
      2026-05-05 Labour Day, 2026-06-19 Dragon Boat Festival, 2026-09-25 Mid-Autumn Festival, 2026-10-01 National Day, 2026-10-02 National Day,
      2026-10-05 National Day, 2026-10-06 National Day, 2026-10-07 National Day`),
    early: {},
  },
  ASX: {
    id: 'ASX', name: 'Australian Securities Exchange', tz: 'Australia/Sydney', mics: ['XASX'], open: '10:00', close: '16:00', knownThrough: 2027, verified: true,
    holidays: h(`2026-01-01 New Year's Day, 2026-01-26 Australia Day, 2026-04-03 Good Friday, 2026-04-06 Easter Monday, 2026-06-08 King's Birthday,
      2026-12-25 Christmas, 2026-12-28 Boxing Day, 2027-01-01 New Year's Day, 2027-01-26 Australia Day, 2027-03-26 Good Friday, 2027-03-29 Easter Monday,
      2027-06-14 King's Birthday, 2027-12-27 Christmas, 2027-12-28 Boxing Day`),
    early: e('2026-12-24 14:10, 2026-12-31 14:10, 2027-12-24 14:10, 2027-12-31 14:10'),
  },
};

const MIC_TO_EXCHANGE = new Map(Object.values(EXCHANGES).flatMap((x) => x.mics.map((m) => [m, x.id] as const)));
export const exchangeOfMic = (mic: string): ExchangeId | undefined => MIC_TO_EXCHANGE.get(mic);

/** A provider's day for an exchange: closed (both null) or open with its own hours. */
export interface CalendarOverride {
  open: string | null;
  close: string | null;
  source: string;
}
const overrides = new Map<string, CalendarOverride>();
export function setOverride(ex: ExchangeId, day: string, o: CalendarOverride | null) {
  if (o) overrides.set(`${ex}:${day}`, o);
  else overrides.delete(`${ex}:${day}`);
}

// ---------------------------------------------------------------- time zones

const partsFmt = new Map<string, Intl.DateTimeFormat>();
function fmt(tz: string) {
  let f = partsFmt.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short' });
    partsFmt.set(tz, f);
  }
  return f;
}

export interface Zoned {
  date: string;
  time: string;
  weekday: number;
  y: number;
  m: number;
  d: number;
  hh: number;
  mm: number;
  ss: number;
}
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function zoned(ms: number, tz: string): Zoned {
  const p = Object.fromEntries(fmt(tz).formatToParts(ms).map((x) => [x.type, x.value]));
  const [y, m, d, hh, mm, ss] = [+p.year!, +p.month!, +p.day!, +p.hour!, +p.minute!, +p.second!];
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${y}-${pad(m)}-${pad(d)}`, time: `${pad(hh)}:${pad(mm)}`, weekday: WEEKDAY[p.weekday!]!, y, m, d, hh, mm, ss };
}

/** Epoch ms of a wall-clock time in a zone. In a spring-forward gap it lands just after the gap. */
export function wallToUtc(date: string, time: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const want = Date.UTC(y, m - 1, d, hh, mm);
  let t = want;
  for (let i = 0; i < 3; i++) {
    const z = zoned(t, tz);
    const seen = Date.UTC(z.y, z.m - 1, z.d, z.hh, z.mm);
    if (seen === want) return t;
    t += want - seen;
  }
  return t;
}

export function addDays(date: string, n: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- sessions

export interface DaySessions {
  date: string;
  /** Epoch ms. */
  open: number;
  close: number;
  pre?: number;
  post?: number;
  lunch?: [number, number];
  early: boolean;
}

/** Why a calendar day does not trade, or null when it does. */
export function closedReason(ex: ExchangeDef, date: string): string | null {
  const o = overrides.get(`${ex.id}:${date}`);
  if (o) return o.open ? null : 'Holiday';
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0 || wd === 6) return 'Weekend';
  return ex.holidays[date] ?? null;
}

export function sessionsOn(ex: ExchangeDef, date: string): DaySessions | null {
  if (closedReason(ex, date)) return null;
  const o = overrides.get(`${ex.id}:${date}`);
  const close = o?.close ?? ex.early[date] ?? ex.close;
  const at = (t: string) => wallToUtc(date, t, ex.tz);
  const s: DaySessions = { date, open: at(o?.open ?? ex.open), close: at(close), early: close < ex.close };
  if (ex.pre) s.pre = at(ex.pre);
  // An early close ends the extended session with it (US early closes run after-hours to 17:00).
  if (ex.post) s.post = at(s.early ? '17:00' : ex.post);
  if (ex.lunch && ex.lunch[0] < close) s.lunch = [at(ex.lunch[0]), at(ex.lunch[1])];
  return s;
}

export interface ExchangeStatus {
  exchange: ExchangeId;
  name: string;
  tz: string;
  state: MarketState;
  /** Local date and time at the exchange. */
  localDate: string;
  localTime: string;
  /** The session the market is in, or the next one. */
  tradingDate: string;
  /** Epoch ms of the next regular open and of the end of the current regular session (null when closed). */
  nextOpen: number;
  closesAt: number | null;
  /** Epoch ms when the current state ends. */
  until: number;
  /** Why the market is shut today (Weekend, a holiday's name), when it is. */
  note: string | null;
  early: boolean;
  /** False when today is past the published calendar: holidays may be missing. */
  calendarKnown: boolean;
  verified: boolean;
}

export function nextSession(ex: ExchangeDef, fromDate: string): DaySessions {
  for (let i = 0; i < 30; i++) {
    const s = sessionsOn(ex, addDays(fromDate, i));
    if (s) return s;
  }
  throw new Error(`no session for ${ex.id} within 30 days of ${fromDate}`);
}

export function exchangeStatus(id: ExchangeId, now: number): ExchangeStatus {
  const ex = EXCHANGES[id];
  const z = zoned(now, ex.tz);
  const today = sessionsOn(ex, z.date);
  const base = { exchange: id, name: ex.name, tz: ex.tz, localDate: z.date, localTime: z.time, calendarKnown: z.y <= ex.knownThrough, verified: ex.verified };
  const upcoming = (from: string) => nextSession(ex, from);
  if (today) {
    const st = (state: MarketState, until: number, closesAt: number | null) => ({
      ...base, state, until, closesAt, tradingDate: today.date, nextOpen: now < today.open ? today.open : upcoming(addDays(z.date, 1)).open, note: null, early: today.early,
    });
    if (today.pre !== undefined && now >= today.pre && now < today.open) return st('pre', today.open, null);
    if (now >= today.open && now < today.close) {
      if (today.lunch && now >= today.lunch[0] && now < today.lunch[1]) return st('break', today.lunch[1], today.close);
      return st('open', today.lunch && now < today.lunch[0] ? today.lunch[0] : today.close, today.close);
    }
    if (today.post !== undefined && now >= today.close && now < today.post) return st('post', today.post, null);
  }
  const next = today && now < today.open ? today : upcoming(addDays(z.date, 1));
  const reason = closedReason(ex, z.date);
  return {
    ...base, state: reason && reason !== 'Weekend' ? 'holiday' : 'closed', tradingDate: next.date, nextOpen: next.open, closesAt: null,
    until: next.pre ?? next.open, note: reason, early: false,
  };
}

/** Whether an order may fill now: regular hours for everything, extended hours for limit orders where the exchange has them. */
export function tradable(state: MarketState, type: 'market' | 'limit', extendedHours: boolean): boolean {
  if (state === 'open') return true;
  return extendedHours && type === 'limit' && (state === 'pre' || state === 'post');
}
