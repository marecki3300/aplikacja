// AURIMIQ.ai — Backend
// Stack: Express + Groq (Llama) + Binance + Supabase + Stripe
// Deploy: Render.com

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import { google } from 'googleapis';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Clients ──────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || '');

// ── Middleware ────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50kb' }));

// ── Auth ──────────────────────────────────────────────────────
function decodeToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid token');
  const pad = parts[1].length % 4;
  const padded = pad ? parts[1] + '='.repeat(4 - pad) : parts[1];
  const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  if (!payload.sub) throw new Error('No user');
  return { id: payload.sub, email: payload.email || '' };
}

function auth(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = decodeToken(token); next(); }
  catch(e) { res.status(401).json({ error: e.message }); }
}

// ── Plan check ────────────────────────────────────────────────
// Darmowy plan: 5 zapytan powitalnych i koniec, bez odnawialnego limitu
// dziennego.
//
// Powod jest arytmetyczny, nie oszczednosciowy. Mediana konwersji freemium
// (RevenueCat 2026, 115 tys. aplikacji) to 2,1% w 35. dniu; przy twardym
// paywallu 10,7%. Przy 2,1% na 141 platnych abonentow trzeba ~6700 instalacji,
// przy 10,7% — ~1320. Piec razy mniejsza skala dystrybucji przy zerowym
// budzecie marketingowym decyduje o tym, czy plan jest wykonalny.
//
// Piec zapytan zostaje (WELCOME_BONUS), zeby uzytkownik zdazyl zobaczyc, czy
// produkt jest dobry — zero zapytan psuje oceny w sklepie i poczte pantoflowa.
// Powrot do starego modelu: FREE_LIMIT=1 w zmiennych srodowiskowych.
const FREE_LIMIT = process.env.FREE_LIMIT !== undefined ? Number(process.env.FREE_LIMIT) : 0;
const WELCOME_BONUS = 5;
// Limity przestawialne zmiennymi srodowiskowymi — zmiana progu nie wymaga
// deploya. Wartosci domyslne celowo takie jak dotad: obnizenie limitu to
// zmiana warunkow dla kogos, kto juz zaplacil, i jest decyzja biznesowa,
// nie techniczna.
//
// Kontekst do tej decyzji: przy 25 zapytaniach dziennie plan Lite kosztuje
// w skrajnym miesiacu ~34 zl, a przynosi 13,13 zl po VAT i prowizji Play.
// Realny uzytkownik zadaje 2-5 pytan dziennie, wiec problem jest teoretyczny
// do momentu, w ktorym przestanie byc.
//
// Ta sama arytmetyka dla Niemiec: Lite 5 EUR to 4,20 EUR po VAT 19% i 3,57 EUR
// po prowizji Play 15%. Przy 0,011-0,014 EUR za zapytanie Lite wychodzi na zero
// przy ~10 pytaniach dziennie, Pro (12 EUR, czyli 8,57 EUR netto) przy ~23.
// Niemiecki Lite jest wiec odrobine lepszy od polskiego, nie gorszy - problem
// nie jest krajem, tylko tym, ze prog 25/dzien lezy powyzej oplacalnosci.
//
// Lite zostaje bez zmian: przy realnym uzyciu zarabia, a obnizenie limitu
// komus, kto juz zaplacil, to zmiana warunkow, nie poprawka techniczna.
// Pro dostaje sufit, bo "bez limitu" znaczylo dotad rowniez brak sufitu
// kosztow - jedno konto pytajace 200 razy dziennie kosztuje ~70 EUR
// miesiecznie przy 8,57 EUR przychodu. To bezpiecznik przeciw automatom,
// a nie limit produktu: 200 to ponad czterdziestokrotnosc realnego uzycia.
// PRO_LIMIT=0 w srodowisku przywraca dawne zachowanie bez sufitu.
const PLAN_LIMITS = {
  free: FREE_LIMIT,
  lite: Number(process.env.LITE_LIMIT) || 25,
  pro: (function () {
    const raw = process.env.PRO_LIMIT;
    if (raw === undefined || raw === '') return 200;
    const n = Number(raw);
    if (n === 0) return Infinity;                   // swiadome zdjecie sufitu
    // Literowka w zmiennej srodowiskowej nie moze po cichu wylaczyc
    // bezpiecznika - przy niepoprawnej wartosci wracamy do domyslnej.
    return Number.isFinite(n) && n > 0 ? n : 200;
  })(),
};

// Komunikat dla Pro po przekroczeniu progu. Celowo NIE jest to zachieta do
// zakupu - uzytkownik ma juz najwyzszy plan, wiec upsell bylby absurdem.
const PRO_FAIR_USE = {
  pl: n => `Osiagnieto dzienny prog uczciwego uzytkowania (${n} zapytan). Odnowi sie jutro. Potrzebujesz wiecej - napisz na aurimiq@proton.me.`,
  en: n => `Fair-use daily threshold reached (${n} queries). It resets tomorrow. Need more? Write to aurimiq@proton.me.`,
  de: n => `Faire-Nutzung-Grenze fuer heute erreicht (${n} Anfragen). Sie wird morgen zurueckgesetzt. Mehr noetig? Schreiben Sie an aurimiq@proton.me.`,
};
function planLimit(plan) { return PLAN_LIMITS[plan] ?? FREE_LIMIT; }
function calcRemaining(plan, queries, totalEver) {
  if (plan === 'pro') return 999;
  if (plan === 'free' && totalEver < WELCOME_BONUS) return WELCOME_BONUS - totalEver;
  return Math.max(0, planLimit(plan) - queries);
}

async function checkPlan(req, res, next) {
  const { data } = await supabase
    .from('profiles')
    .select('plan, queries_today, last_query_date, total_queries_ever')
    .eq('id', req.user.id)
    .single();

  const today = new Date().toISOString().slice(0, 10);
  const queries = data?.last_query_date?.slice(0, 10) === today
    ? (data.queries_today || 0) : 0;
  const totalEver = data?.total_queries_ever || 0;

  req.plan = data?.plan || 'free';
  req.queries = queries;
  req.totalEver = totalEver;

  // Pro omijalo to sprawdzenie calkowicie, wiec PRO_LIMIT byl martwy.
  if (req.plan === 'pro') {
    const cap = planLimit('pro');
    if (Number.isFinite(cap) && queries >= cap) {
      const l = PRO_FAIR_USE[req.body?.lang] ? req.body.lang : 'en';
      return res.status(403).json({
        error: PRO_FAIR_USE[l](cap),
        upgrade: false,          // ma juz najwyzszy plan
        plan: 'pro'
      });
    }
    return next();
  }

  if (req.plan !== 'pro') {
    // welcome bonus — pierwsze 5 zapytań w życiu (tylko free)
    if (req.plan === 'free' && totalEver < WELCOME_BONUS) {
      return next();
    }
    if (queries >= planLimit(req.plan)) {
      return res.status(403).json({
        error: 'Daily limit reached',
        upgrade: true,
        plan: req.plan
      });
    }
  }
  next();
}

async function incQueries(userId) {
  const today = new Date().toISOString().slice(0, 10);
  try {
    await supabase.rpc('increment_queries', { user_id: userId, today });
  } catch(e) {}
  try {
    await supabase.rpc('increment_total_queries', { user_id: userId });
  } catch(e) {}
}

// ══════════════════════════════════════════════════════════════
// MARKET DATA — Binance (szybkie, bez limitu)
// ══════════════════════════════════════════════════════════════

// Cache 60 sekund
const cache = new Map();
// Trzymamy obietnice, nie wynik. Dzieki temu dwa rownolegle zapytania o ten
// sam klucz dziela jedno okraženie sieciowe zamiast strzelac dwa razy —
// wczesniej przy pytaniu o kryzys BTC leciał do Binance dwukrotnie, bo zaden
// z wywolan nie zdazyl jeszcze zapisac wyniku.
//
// TTL negatywny: pusty wynik (null) trzymamy 30 s, nie pelne TTL. Wczesniej
// jedna chwilowa odmowa Stooqa oslepiala surowce na piec minut — a wlasnie
// tak wygladal blad "nie mam ceny srebra" przy dzialajacej zakladce SUROWCE.
const NEG_TTL = 30000;
function cached(key, ttl, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < (hit.neg ? NEG_TTL : ttl)) return hit.p;
  // Bledu nie zapamietujemy — inaczej jedna chwilowa awaria zrodla
  // blokowalaby dane na caly TTL.
  const p = fn()
    .then(v => {
      if (v == null) {
        const e = cache.get(key);
        if (e && e.p === p) e.neg = true;
      }
      return v;
    })
    .catch(err => { cache.delete(key); throw err; });
  cache.set(key, { p, ts: now, neg: false });
  return p;
}

// Binance ticker — cena + zmiana 24h (z fallback na CoinGecko)
const COINGECKO_MAP = {
  'BTCUSDT': 'bitcoin', 'ETHUSDT': 'ethereum', 'SOLUSDT': 'solana',
  'XRPUSDT': 'ripple', 'BNBUSDT': 'binancecoin', 'ADAUSDT': 'cardano',
  'DOGEUSDT': 'dogecoin', 'AVAXUSDT': 'avalanche-2', 'DOTUSDT': 'polkadot',
  'LINKUSDT': 'chainlink',
};

// ── STOOQ — polskie akcje GPW, WIG20, darmowe bez klucza ──
const STOOQ_MAP = {
  'PKN.WA':'pkn','KGH.WA':'kgh','PKO.WA':'pko','CDR.WA':'cdr','LPP.WA':'lpp',
  'PEO.WA':'peo','PZU.WA':'pzu','ALE.WA':'ale','DNP.WA':'dnp','SPL.WA':'spl',
  'KRU.WA':'kru','MBK.WA':'mbk','OPL.WA':'opl','CPS.WA':'cps','JSW.WA':'jsw',
  'WIG20':'wig20','WIG':'wig',
};
// ── SUROWCE ──────────────────────────────────────────────────
//
// Alpha Vantage nie serwuje symboli spot ani kontraktow towarowych, wiec
// probujemy najpierw Stooqa (prawdziwe ceny surowca), a gdy odmowi — ETF-u,
// ktory sledzi ten sam instrument. ETF pokazuje inna wartosc bezwzgledna niz
// surowiec, dlatego jest wylacznie awaryjny i oznaczamy go w odpowiedzi.
// Yahoo trzyma kontrakty terminowe pod symbolami z sufiksem "=F" i nie wymaga
// klucza — to jedyne darmowe zrodlo prawdziwej ceny surowca poza Stooqiem.
// Kolejnosc: Stooq → Yahoo futures → ETF. ETF jest ostatni, bo pokazuje inna
// wartosc bezwzgledna niz surowiec i musi byc oznaczony jako proxy.
const COMMODITY_SOURCES = {
  XAUUSD: { stooq: 'xauusd', yahoo: 'GC=F', etf: 'GLD',  name: 'Gold'         },
  XAGUSD: { stooq: 'xagusd', yahoo: 'SI=F', etf: 'SLV',  name: 'Silver'       },
  XPTUSD: { stooq: 'xptusd', yahoo: 'PL=F', etf: 'PPLT', name: 'Platinum'     },
  XPDUSD: { stooq: 'xpdusd', yahoo: 'PA=F', etf: 'PALL', name: 'Palladium'    },
  USOIL:  { stooq: 'cl.f',   yahoo: 'CL=F', etf: 'USO',  name: 'Crude Oil WTI'},
  UKOIL:  { stooq: 'cb.f',   yahoo: 'BZ=F', etf: 'BNO',  name: 'Brent Crude'  },
  NATGAS: { stooq: 'ng.f',   yahoo: 'NG=F', etf: 'UNG',  name: 'Natural Gas'  },
  COPPER: { stooq: 'hg.f',   yahoo: 'HG=F', etf: 'CPER', name: 'Copper'       },
};

function fetchWithTimeout(url, opts = {}, ms = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(t));
}

async function getStooqQuote(symbol) {
  return cached(`stooq:${symbol}`, 300000, async () => {
    const stooqSym = STOOQ_MAP[symbol] || (symbol.endsWith('.WA') ? symbol.replace('.WA','').toLowerCase() : symbol.toLowerCase() + '.us');
    const now = new Date();
    const d2 = now.toISOString().slice(0,10).replace(/-/g,'');
    const d1 = new Date(now - 10*864e5).toISOString().slice(0,10).replace(/-/g,'');
    const r = await fetchWithTimeout(`https://stooq.com/q/d/l/?s=${stooqSym}&d1=${d1}&d2=${d2}&i=d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }
    }, 5000);
    if (!r.ok) return null;
    const csv = await r.text();
    const rows = csv.trim().split('\n').slice(1).filter(x => x.includes(','));
    if (rows.length < 2) return null;
    const last = rows[rows.length-1].split(',');
    const prev = rows[rows.length-2].split(',');
    const close = parseFloat(last[4]), prevClose = parseFloat(prev[4]);
    if (!isFinite(close) || !isFinite(prevClose)) return null;
    return {
      price: close,
      change24h: ((close - prevClose) / prevClose) * 100,
      volume24h: parseFloat(last[5]) || 0,
      source: 'Stooq/GPW'
    };
  });
}

// Wykres dzienny ze Stooqa — obsluguje i GPW, i surowce.
// Zwraca null zamiast rzucac, zeby wywolujacy mogl siegnac po zrodlo awaryjne.
async function getStooqChart(stooqSym, limit = 90) {
  return cached(`stooqchart:${stooqSym}:${limit}`, 300000, async () => {
    try {
      const now = new Date();
      const d2 = now.toISOString().slice(0, 10).replace(/-/g, '');
      // Z zapasem, bo weekendy i swieta nie maja notowan.
      const d1 = new Date(now - (limit + 40) * 864e5).toISOString().slice(0, 10).replace(/-/g, '');
      const r = await fetchWithTimeout(
        `https://stooq.com/q/d/l/?s=${stooqSym}&d1=${d1}&d2=${d2}&i=d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
        6000
      );
      if (!r.ok) return null;
      const csv = await r.text();
      // Przy nieznanym symbolu Stooq oddaje strone HTML albo "No data".
      if (!csv || csv.startsWith('<') || !csv.includes('Date')) return null;

      const rows = csv.trim().split('\n').slice(1).filter(x => x.includes(','));
      const klines = rows.map(line => {
        const [date, o, h, l, c, v] = line.split(',');
        return {
          t: new Date(date).getTime(),
          o: parseFloat(o), h: parseFloat(h),
          l: parseFloat(l), c: parseFloat(c),
          v: parseFloat(v) || 0,
        };
      }).filter(k => isFinite(k.c) && isFinite(k.t));

      return klines.length ? klines.slice(-limit) : null;
    } catch (e) {
      console.log(`Stooq chart ${stooqSym}: ${e.message}`);
      return null;
    }
  });
}

// Notowanie surowca — cena i zmiana dobowa, liczone z dwoch ostatnich swiec.
// buildContext nie mial zadnej obslugi surowcow, wiec na pytanie o srebro,
// platyne, rope czy miedz AI odpowiadalo bez jakiejkolwiek ceny.
//
// Zrodlo glowne: Stooq. Awaryjne: kontrakt terminowy z Yahoo, a dopiero na
// koncu ETF sledzacy surowiec.
//
// Ta kaskada istniala WYLACZNIE w /api/chart (zakladka SUROWCE), a
// getCommodityQuote — czyli sciezka, z ktorej korzysta AI — mialo sam Stooq.
// Stad rozjazd: zakladka pokazywala cene srebra, a czat odpowiadal, ze nie ma
// danych dla tego instrumentu.
async function getYahooQuote(symbol) {
  return cached(`yahoo:${symbol}`, 120000, async () => {
    try {
      const r = await fetchWithTimeout(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
        4000
      );
      if (!r.ok) return null;
      const d = await r.json();
      const meta = d?.chart?.result?.[0]?.meta;
      const price = meta?.regularMarketPrice;
      if (!isFinite(price)) return null;
      const prev = meta.chartPreviousClose || meta.previousClose || price;
      return {
        price,
        change24h: prev ? ((price - prev) / prev) * 100 : 0,
        source: 'Yahoo',
      };
    } catch (e) {
      console.log(`Yahoo ${symbol}: ${e.message}`);
      return null;
    }
  });
}

// Swiece dzienne z Yahoo — to samo zrodlo co getYahooQuote, tylko caly szereg.
// Uzywane jako drugi stopien dla wykresow surowcow, zeby zakladka SUROWCE nie
// spadala od razu na ETF (ktory ma inna wartosc bezwzgledna niz surowiec).
async function getYahooChart(symbol, limit = 90) {
  return cached(`yahoochart:${symbol}:${limit}`, 300000, async () => {
    try {
      const range = limit <= 90 ? '6mo' : '2y';
      const r = await fetchWithTimeout(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=${range}`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
        6000
      );
      if (!r.ok) return null;
      const d = await r.json();
      const res = d?.chart?.result?.[0];
      const ts = res?.timestamp;
      const q = res?.indicators?.quote?.[0];
      if (!Array.isArray(ts) || !q) return null;
      const klines = ts.map((t, i) => ({
        t: t * 1000,
        o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i],
        v: q.volume?.[i] || 0,
      })).filter(k => isFinite(k.c) && isFinite(k.t));
      return klines.length ? klines.slice(-limit) : null;
    } catch (e) {
      console.log(`Yahoo chart ${symbol}: ${e.message}`);
      return null;
    }
  });
}

async function getCommodityQuote(key) {
  const src = COMMODITY_SOURCES[key];
  if (!src) return null;

  // 1. Stooq — prawdziwa cena spot/kontraktu
  const klines = await getStooqChart(src.stooq, 5).catch(() => null);
  if (klines && klines.length >= 2) {
    const last = klines[klines.length - 1];
    const prev = klines[klines.length - 2];
    return {
      name: src.name,
      price: last.c,
      change24h: ((last.c - prev.c) / prev.c) * 100,
      source: 'Stooq',
      isProxy: false,
    };
  }

  // 2. Yahoo — kontrakt terminowy, nadal prawdziwa cena surowca
  if (src.yahoo) {
    const y = await getYahooQuote(src.yahoo).catch(() => null);
    if (y) {
      return {
        name: src.name,
        price: y.price,
        change24h: y.change24h,
        source: `Yahoo ${src.yahoo}`,
        isProxy: false,
      };
    }
  }

  // 3. ETF — inna wartosc bezwzgledna niz surowiec, wiec musi byc oznaczony
  if (src.etf) {
    const e = await getStockPrice(src.etf).catch(() => null);
    if (e) {
      return {
        name: src.name,
        price: e.price,
        change24h: e.change24h,
        source: `ETF ${src.etf} (proxy)`,
        isProxy: true,
      };
    }
  }

  return null;
}

// Wskazniki techniczne dla surowca — liczone z tych samych funkcji co krypto,
// tylko na swiecach ze Stooqa. Bez tego prompt TYPU A kazal modelowi podac
// RSI/SMA/MACD dla srebra czy zlota, a dane techniczne dostawalo wylacznie
// krypto (getTechnicals chodzi po getBinanceChart). Model albo zmyslal liczby,
// albo rozmywal odpowiedz ogolnikami.
async function getCommodityTechnicals(key) {
  const src = COMMODITY_SOURCES[key];
  if (!src) return null;
  return cached(`techcom:${key}`, 600000, async () => {
    const klines = await getStooqChart(src.stooq, 220).catch(() => null);
    if (!klines || klines.length < 60) return null;
    const closes = klines.map(k => k.c);
    const highs = klines.map(k => k.h).filter(isFinite);
    const lows = klines.map(k => k.l).filter(isFinite);
    const last = closes[closes.length - 1];
    const rsi = calcRSI(closes);
    const sma50 = calcSMA(closes, 50);
    const sma200 = calcSMA(closes, 200);
    const macd = calcMACD(closes);
    const w = [];
    if (rsi != null) w.push(`RSI(14): ${rsi.toFixed(1)} ${rsi > 70 ? '(wykupienie)' : rsi < 30 ? '(wyprzedanie)' : '(neutralnie)'}`);
    if (sma50 != null) w.push(`SMA50: $${sma50.toFixed(2)} (cena ${last > sma50 ? 'POWYŻEJ' : 'PONIŻEJ'})`);
    if (sma200 != null) w.push(`SMA200: $${sma200.toFixed(2)} (cena ${last > sma200 ? 'POWYŻEJ' : 'PONIŻEJ'})${sma50 != null ? (sma50 > sma200 ? ' | złoty krzyż' : ' | krzyż śmierci') : ''}`);
    if (macd != null) w.push(`MACD: ${macd >= 0 ? '+' : ''}${macd.toFixed(2)} (${macd >= 0 ? 'byczo' : 'niedźwiedzio'})`);
    if (highs.length >= 30 && lows.length >= 30) {
      w.push(`Opór 30d: $${Math.max(...highs.slice(-30)).toFixed(2)} | Wsparcie 30d: $${Math.min(...lows.slice(-30)).toFixed(2)}`);
    }
    return w.length ? w.join('\n') : null;
  });
}

// Slowa kluczowe w trzech jezykach → symbol surowca.
const COMMODITY_KEYWORDS = {
  XAUUSD: ['złot', 'zlot', 'gold', 'xau', 'uncj'],
  XAGUSD: ['srebr', 'silver', 'xag'],
  XPTUSD: ['platyn', 'platin', 'xpt'],
  XPDUSD: ['pallad', 'palladium', 'xpd'],
  COPPER: ['miedz', 'miedź', 'copper', 'kupfer'],
  USOIL:  ['ropa', 'ropy', 'oil', 'wti', 'öl', 'erdöl'],
  UKOIL:  ['brent'],
  NATGAS: ['gaz ziemn', 'gazu ziemn', 'natural gas', 'natgas', 'erdgas'],
};

// ── KURSY WALUT NBP (oficjalne, darmowe) — dla wymieniających waluty ──
async function getNbpRates() {
  return cached('nbp:tableA', 600000, async () => {
    const r = await fetchWithTimeout('https://api.nbp.pl/api/exchangerates/tables/A?format=json', {
      headers: { 'Accept': 'application/json' }
    }, 5000);
    if (!r.ok) return null;
    const d = await r.json();
    const rates = d?.[0]?.rates;
    if (!Array.isArray(rates)) return null;
    const pick = {};
    for (const x of rates) pick[x.code] = x.mid;
    return { date: d[0].effectiveDate, rates: pick };
  });
}
function fmtFx(pick, codes) {
  const out = [];
  for (const c of codes) {
    if (pick.rates[c]) out.push(`${c}/PLN: ${pick.rates[c].toFixed(4)} zł`);
  }
  if (pick.rates.EUR && pick.rates.USD) out.push(`EUR/USD: ${(pick.rates.EUR/pick.rates.USD).toFixed(4)}`);
  return `KURSY NBP (średnie, ${pick.date}):\n` + out.join(' | ');
}

// GPW summary — JEDNO zapytanie Stooq o wiele symboli naraz
async function getGpwSummary() {
  return cached('gpw:summary', 300000, async () => {
    const syms = 'wig20 pkn pko pzu ale cdr';
    const r = await fetchWithTimeout(
      `https://stooq.com/q/l/?s=${encodeURIComponent(syms)}&f=sd2t2ohlcv&h&e=csv`,
      { headers: { 'User-Agent': 'Mozilla/5.0' } }, 5000
    );
    if (!r.ok) return null;
    const csv = await r.text();
    const rows = csv.trim().split('\n').slice(1);
    const names = { WIG20:'INDEKS WIG20', PKN:'ORLEN (PKN)', PKO:'PKO BP', PZU:'PZU', ALE:'ALLEGRO', CDR:'CD PROJEKT' };
    const out = [];
    for (const row of rows) {
      const c = row.split(',');
      if (c.length < 8) continue;
      const sym = c[0].toUpperCase(), open = parseFloat(c[3]), close = parseFloat(c[6]);
      if (!isFinite(close)) continue;
      const chg = isFinite(open) && open > 0 ? ((close - open) / open) * 100 : null;
      const unit = sym === 'WIG20' ? 'pkt' : 'PLN';
      out.push(`${names[sym] || sym}: ${close.toFixed(2)} ${unit}${chg!==null ? ` | od otwarcia: ${chg>=0?'+':''}${chg.toFixed(2)}%` : ''}`);
    }
    return out.length ? 'GPW:\n' + out.join('\n') : null;
  });
}

// Klucz WYLACZNIE ze srodowiska. Poprzedni literal byl widoczny w publicznym
// repozytorium, wiec nalezy go traktowac jako spalony. Brak klucza nie psuje
// akcji — Alpha Vantage jest teraz zrodlem trzecim, za Yahoo i Stooqiem.
const AV_KEY = process.env.ALPHA_VANTAGE_KEY || '';
if (!AV_KEY) console.log('UWAGA: brak ALPHA_VANTAGE_KEY — akcje ida przez Yahoo i Stooq');

// ── ALPHA VANTAGE — akcje (Mag7 + WIG20) ────────────────────
// Kolejnosc odwrocona: Yahoo przed Alpha Vantage.
//
// Alpha Vantage na darmowym planie daje 25 zapytan na DOBE. Bedac zrodlem
// pierwszym, wyczerpywal sie w kilkanascie minut ruchu i przez reszte doby
// kazde zapytanie o akcje placilo pelny timeout za nic, zanim trafilo na
// Yahoo — ktore jest darmowe, bez klucza i bez limitu dziennego.
// Teraz Alpha Vantage jest tam, gdzie jego miejsce: jako trzecie zrodlo.
async function getStockPrice(symbol) {
  return cached(`stock:${symbol}`, 60000, async () => {
    // 1. Yahoo Finance — darmowe, bez klucza, zna .WA i .DE
    try {
      const r2 = await fetchWithTimeout(
        `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }, 3000
      );
      const d2 = await r2.json();
      const meta = d2?.chart?.result?.[0]?.meta;
      if (meta?.regularMarketPrice) {
        const price = meta.regularMarketPrice;
        const prev = meta.chartPreviousClose || price;
        return {
          price,
          change24h: ((price - prev) / prev * 100),
          volume24h: meta.regularMarketVolume * price || 0,
          high24h: meta.regularMarketDayHigh || price,
          low24h: meta.regularMarketDayLow || price,
          source: 'Yahoo'
        };
      }
    } catch(e2) { console.log('Yahoo error:', e2.message); }

    // 2. Alpha Vantage — tylko gdy klucz jest ustawiony
    if (AV_KEY) {
      try {
        const r = await fetchWithTimeout(
          `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${AV_KEY}`, {}, 3000
        );
        const d = await r.json();
        const q = d['Global Quote'];
        if (q && q['05. price']) {
          return {
            price: parseFloat(q['05. price']),
            change24h: parseFloat(q['10. change percent'].replace('%','')),
            volume24h: parseFloat(q['06. volume']) * parseFloat(q['05. price']),
            high24h: parseFloat(q['03. high']),
            low24h: parseFloat(q['04. low']),
            source: 'AlphaVantage'
          };
        }
      } catch(e) { console.log('AlphaVantage error:', e.message); }
    }

    // 3. Stooq — ostatnia deska ratunku, obsluguje i .WA, i tickery US
    return await getStooqQuote(symbol).catch(() => null);
  });
}

// ── FOREX ─────────────────────────────────────────────────────
async function getForexRate(from, to) {
  return cached(`forex:${from}${to}`, 60000, async () => {
    try {
      const r = await fetchWithTimeout(
        `https://api.exchangerate-api.com/v4/latest/${from}`, {}, 3000
      );
      const d = await r.json();
      if (d.rates && d.rates[to]) {
        const rate = d.rates[to];
        return {
          price: rate,
          change24h: 0,
          volume24h: 0,
          high24h: rate,
          low24h: rate,
          source: 'ExchangeRate'
        };
      }
    } catch(e) {}

    // Fallback — open.er-api.com
    try {
      const r2 = await fetchWithTimeout(`https://open.er-api.com/v6/latest/${from}`, {}, 3000);
      const d2 = await r2.json();
      if (d2.rates && d2.rates[to]) {
        return {
          price: d2.rates[to],
          change24h: 0,
          volume24h: 0,
          high24h: d2.rates[to],
          low24h: d2.rates[to],
          source: 'ExchangeRate'
        };
      }
    } catch(e2) {}

    // Fallback 2 — NBP API dla PLN
    if (to === 'PLN' || from === 'PLN') {
      try {
        const currency = from === 'PLN' ? to : from;
        const r3 = await fetchWithTimeout(`https://api.nbp.pl/api/exchangerates/rates/a/${currency}/?format=json`, {}, 3000);
        const d3 = await r3.json();
        const rate = d3.rates?.[0]?.mid;
        if (rate) {
          const finalRate = from === 'PLN' ? (1/rate) : rate;
          return {
            price: finalRate,
            change24h: 0,
            volume24h: 0,
            high24h: finalRate,
            low24h: finalRate,
            source: 'NBP'
          };
        }
      } catch(e3) {}
    }
    return null;
  });
}

// ── UNIVERSAL TICKER — wykrywa typ symbolu ────────────────────
const STOCK_SYMBOLS_LIST = ['AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','PKN.WA','KGH.WA','PKO.WA','CDR.WA','LPP.WA','PEO.WA'];
const FOREX_PAIRS = {
  'EURUSD': {from:'EUR',to:'USD'}, 'USDPLN': {from:'USD',to:'PLN'},
  'EURPLN': {from:'EUR',to:'PLN'}, 'GBPUSD': {from:'GBP',to:'USD'},
  'USDEUR': {from:'USD',to:'EUR'},
};

async function getUniversalTicker(symbol) {
  if (FOREX_PAIRS[symbol]) {
    const {from, to} = FOREX_PAIRS[symbol];
    return getForexRate(from, to);
  }
  if (STOCK_SYMBOLS_LIST.includes(symbol)) {
    return getStockPrice(symbol);
  }
  return getBinanceTicker(symbol);
}

async function getBinanceTicker(symbol) {
  return cached(`ticker:${symbol}`, 15000, async () => {
    try {
      const r = await fetchWithTimeout(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }, 2500);
      if (r.ok) {
        const d = await r.json();
        if (d.lastPrice) {
          return {
            price: parseFloat(d.lastPrice),
            change24h: parseFloat(d.priceChangePercent),
            volume24h: parseFloat(d.quoteVolume),
            high24h: parseFloat(d.highPrice),
            low24h: parseFloat(d.lowPrice),
            source: 'Binance'
          };
        }
      }
    } catch(e) { console.log('Binance error:', e.message); }

    // 1b. Binance.US — dziala z serwerow USA (Render)
    try {
      const rus = await fetchWithTimeout(`https://api.binance.us/api/v3/ticker/24hr?symbol=${symbol.replace('USDT','USD')}`, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }, 2500);
      if (rus.ok) {
        const d = await rus.json();
        if (d.lastPrice) {
          return {
            price: parseFloat(d.lastPrice),
            change24h: parseFloat(d.priceChangePercent),
            volume24h: parseFloat(d.quoteVolume),
            high24h: parseFloat(d.highPrice),
            low24h: parseFloat(d.lowPrice),
            source: 'Binance.US'
          };
        }
      }
    } catch(eus) { console.log('Binance.US error:', eus.message); }

    const cgId = COINGECKO_MAP[symbol];
    if (cgId) {
      try {
        const r2 = await fetchWithTimeout(
          `https://api.coingecko.com/api/v3/simple/price?ids=${cgId}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_high_24h=true&include_low_24h=true`,
          { headers: { 'Accept': 'application/json', 'User-Agent': 'AURIMIQ/1.0' } },
          3000
        );
        if (r2.ok) {
          const d2 = await r2.json();
          const coin = d2[cgId];
          if (coin) {
            return {
              price: coin.usd,
              change24h: coin.usd_24h_change || 0,
              volume24h: coin.usd_24h_vol || 0,
              high24h: coin.usd_24h_high || coin.usd,
              low24h: coin.usd_24h_low || coin.usd,
              source: 'CoinGecko'
            };
          }
        }
      } catch(e2) { console.log('CoinGecko error:', e2.message); }
    }

    try {
      const krakenBase = symbol.replace('USDT', '').replace('BTC','XBT').replace('DOGE','XDG');
      const krakenSym = krakenBase + 'USD';
      const r3 = await fetchWithTimeout(`https://api.kraken.com/0/public/Ticker?pair=${krakenSym}`, {}, 3000);
      if (r3.ok) {
        const d3 = await r3.json();
        const pairs = Object.values(d3.result || {});
        if (pairs.length > 0) {
          const p = pairs[0];
          const price = parseFloat(p.c[0]);
          const open = parseFloat(p.o);
          const change = open ? ((price - open) / open * 100) : 0;
          return {
            price,
            change24h: change,
            volume24h: parseFloat(p.v[1]) * price,
            high24h: parseFloat(p.h[1]),
            low24h: parseFloat(p.l[1]),
            source: 'Kraken'
          };
        }
      }
    } catch(e3) { console.log('Kraken error:', e3.message); }

    return null;
  });
}

async function getBinanceChart(symbol, interval, limit) {
  return cached(`chart:${symbol}:${interval}:${limit}`, 60000, async () => {
    let r = await fetchWithTimeout(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`, {}, 3000
    ).catch(() => null);
    if (!r || !r.ok) {
      r = await fetchWithTimeout(
        `https://api.binance.us/api/v3/klines?symbol=${symbol.replace('USDT','USD')}&interval=${interval}&limit=${limit}`, {}, 3000
      ).catch(() => null);
    }
    if (!r || !r.ok) return null;
    const d = await r.json();
    return d.map(k => ({
      t: k[0],
      o: parseFloat(k[1]),
      h: parseFloat(k[2]),
      l: parseFloat(k[3]),
      c: parseFloat(k[4]),
      v: parseFloat(k[5]),
    }));
  });
}

// ── WSKAŹNIKI TECHNICZNE liczone z klines (AI dostaje liczby, nie zgaduje) ──
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = gains / losses;
  return 100 - 100 / (1 + rs);
}
function calcSMA(closes, period) {
  if (closes.length < period) return null;
  return closes.slice(-period).reduce((a,b) => a+b, 0) / period;
}
function calcEMA(closes, period) {
  if (closes.length < period) return null;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < closes.length; i++) ema = closes[i] * k + ema * (1 - k);
  return ema;
}
function calcMACD(closes) {
  const e12 = calcEMA(closes, 12), e26 = calcEMA(closes, 26);
  if (e12 == null || e26 == null) return null;
  return e12 - e26;
}
async function getTechnicals(symbol) {
  return cached(`tech:${symbol}`, 120000, async () => {
    const klines = await getBinanceChart(symbol, '1d', 220);
    if (!klines || klines.length < 60) return null;
    const closes = klines.map(k => k.c);
    const highs = klines.map(k => k.h), lows = klines.map(k => k.l);
    const last = closes[closes.length - 1];
    const rsi = calcRSI(closes);
    const sma50 = calcSMA(closes, 50);
    const sma200 = calcSMA(closes, 200);
    const macd = calcMACD(closes);
    const hi30 = Math.max(...highs.slice(-30)), lo30 = Math.min(...lows.slice(-30));
    const w = [];
    if (rsi != null) w.push(`RSI(14): ${rsi.toFixed(1)} ${rsi>70?'(wykupienie)':rsi<30?'(wyprzedanie)':'(neutralnie)'}`);
    if (sma50 != null) w.push(`SMA50: $${sma50.toFixed(2)} (cena ${last>sma50?'POWYŻEJ':'PONIŻEJ'})`);
    if (sma200 != null) w.push(`SMA200: $${sma200.toFixed(2)} (cena ${last>sma200?'POWYŻEJ':'PONIŻEJ'})${sma50!=null?(sma50>sma200?' | złoty krzyż':' | krzyż śmierci'):''}`);
    if (macd != null) w.push(`MACD: ${macd>=0?'+':''}${macd.toFixed(2)} (${macd>=0?'byczo':'niedźwiedzio'})`);
    w.push(`Opór 30d: $${hi30.toFixed(2)} | Wsparcie 30d: $${lo30.toFixed(2)}`);
    return w.join('\n');
  });
}

async function getFearGreed() {
  return cached('fear_greed', 300000, async () => {
    const r = await fetchWithTimeout('https://api.alternative.me/fng/?limit=1', {}, 3000);
    const d = await r.json();
    return d.data[0];
  });
}

async function getStockData(symbol) {
  // Wlasny prefiks klucza — wczesniej dzielil `stock:${symbol}` z
  // getStockPrice, ktore ma inny TTL i inny ksztalt wyniku. Nadpisywaly sie
  // nawzajem, wiec raz przychodzila cena z Alpha Vantage, a raz ze Stooqa,
  // zaleznie od tego, ktora funkcja trafila pierwsza.
  return cached(`stockdata:${symbol}`, 300000, async () => {
    // Polskie walory: Stooq jako źródło główne
    if (symbol.endsWith('.WA') || symbol.startsWith('WIG')) {
      const sq = await getStooqQuote(symbol).catch(() => null);
      if (sq) return sq;
    }
    // USA: AlphaVantage, fallback Stooq.
    // Bez klucza pomijamy od razu — inaczej kazde zapytanie o akcje placi
    // 3 sekundy timeoutu za odpowiedz, ktora i tak bedzie bledem.
    if (AV_KEY) try {
      const r = await fetchWithTimeout(
        `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${AV_KEY}`, {}, 3000
      );
      const d = await r.json();
      const q = d['Global Quote'];
      if (q && q['05. price']) {
        return {
          price: parseFloat(q['05. price']),
          change24h: parseFloat(q['10. change percent']),
          volume24h: parseFloat(q['06. volume']),
          source: 'AlphaVantage'
        };
      }
    } catch(e) { console.log('AV error:', e.message); }
    return await getStooqQuote(symbol).catch(() => null);
  });
}

const BINANCE_SYMBOLS = {
  'bitcoin': 'BTCUSDT', 'btc': 'BTCUSDT',
  'ethereum': 'ETHUSDT', 'eth': 'ETHUSDT',
  'solana': 'SOLUSDT', 'sol': 'SOLUSDT',
  'ripple': 'XRPUSDT', 'xrp': 'XRPUSDT',
  'binancecoin': 'BNBUSDT', 'bnb': 'BNBUSDT',
  'cardano': 'ADAUSDT', 'ada': 'ADAUSDT',
  'dogecoin': 'DOGEUSDT', 'doge': 'DOGEUSDT',
  'polkadot': 'DOTUSDT', 'dot': 'DOTUSDT',
  'avalanche': 'AVAXUSDT', 'avax': 'AVAXUSDT',
  'chainlink': 'LINKUSDT', 'link': 'LINKUSDT',
};

// ── RAG — buduj kontekst dla AI ───────────────────────────────
// Czy w tekscie pada nazwa jakiegokolwiek znanego instrumentu.
// Uzywane do decyzji, czy pytanie stoi samodzielnie, czy jest dopowiedzeniem.
function mentionsInstrument(text) {
  const t = (text || '').toLowerCase();
  if (Object.values(COMMODITY_KEYWORDS).some(ws => ws.some(w => t.includes(w)))) return true;
  if (Object.keys(BINANCE_SYMBOLS).some(k => new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`).test(t))) return true;
  const words = ['akcj','stock','aktie','wig','gpw','forex','walut','kurs','dolar','euro','jen','frank','funt',
                 'apple','aapl','microsoft','msft','nvidia','nvda','tesla','tsla','orlen','kghm','pko','pzu',
                 'allegro','dino','jsw','cd projekt','lpp','pekao','amazon','google','meta'];
  return words.some(w => t.includes(w));
}

// `message` to biezace pytanie, `prevMsg` — poprzednie pytanie uzytkownika.
//
// Wykrywanie instrumentu na samej ostatniej wiadomosci gubilo kazde pytanie
// uzupelniajace. "Co ze srebrem?" -> odpowiedz z cena -> "a jak wyglada
// wykres?" i w kontekscie nie ma juz zadnego surowca.
//
// Poprzednie pytanie doklejamy TYLKO wtedy, gdy biezace samo nie wskazuje
// zadnego instrumentu. Inaczej pytanie o zloto po pytaniu o srebro
// ciagneloby za soba srebro i marnowalo budzet czasowy na pobieranie
// czegos, o co juz nikt nie pyta.
async function buildContext(message, prevMsg = '') {
  const msg = (mentionsInstrument(message) ? message : message + ' ' + prevMsg).toLowerCase();
  const parts = [`CZAS: ${new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}`];
  const promises = [];
  // Diagnostyka: co pytanie zamowilo (`wanted`) i co faktycznie doszlo (`hits`).
  // Bez tego nie da sie odpowiedziec na pytanie "ile procent pytan o srebro
  // dostalo cene" — a wlasnie tego brakowalo, zeby zauwazyc awarie Stooqa.
  const wanted = new Set();
  const hits = new Set();
  const t0 = Date.now();

  const cryptoKeywords = {
    'bitcoin|btc|btcusdt': 'BTCUSDT',
    'ethereum|eth|ethusd': 'ETHUSDT',
    'solana|sol': 'SOLUSDT',
    'xrp|ripple': 'XRPUSDT',
    'bnb|binance coin': 'BNBUSDT',
    'cardano|ada': 'ADAUSDT',
    'dogecoin|doge': 'DOGEUSDT',
    'avax|avalanche': 'AVAXUSDT',
  };

  if (msg.includes('kryzys') || msg.includes('crisis') || msg.includes('recesj') || msg.includes('recession') || msg.includes('crash')) {
    promises.push(
      getBinanceTicker('BTCUSDT').then(d => {
        if (d) parts.push(`BITCOIN (kryzys barometr): $${d.price.toLocaleString()} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}%`);
      }).catch(() => {})
    );
    promises.push(
      getBinanceTicker('ETHUSDT').then(d => {
        if (d) parts.push(`ETHEREUM: $${d.price.toLocaleString()} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}%`);
      }).catch(() => {})
    );
    promises.push(
      getForexRate('USD', 'PLN').then(d => {
        if (d) parts.push(`USD/PLN: ${d.price.toFixed(4)}`);
      }).catch(() => {})
    );
    promises.push(
      getStockPrice('GLD').then(d => {
        if (d) parts.push(`GOLD ETF (GLD): $${d.price.toFixed(2)} | 24h: ${d.change24h.toFixed(2)}% [safe haven]`);
      }).catch(() => {})
    );
    parts.push('KONTEKST MAKRO: Sprawdź yield curve (2Y vs 10Y), Fear&Greed, VIX');
  }

  // ZAWSZE pobieraj rdzeń rynku (cache 15s = zero kosztu) — AI nigdy nie jest slepa
  const isCryptoQuery = true;

  if (isCryptoQuery) {
    promises.push(
      getBinanceTicker('BTCUSDT').then(d => {
        if (d) {
          parts.push(`BITCOIN (BTCUSDT): $${d.price.toLocaleString('en-US', {maximumFractionDigits: 0})} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}% | Vol24h: $${(d.volume24h/1e6).toFixed(0)}M | H: $${d.high24h.toLocaleString()} | L: $${d.low24h.toLocaleString()}`);
        } else {
          parts.push('BTCUSDT: błąd pobierania z Binance');
        }
      }).catch(e => parts.push('BTCUSDT: error - ' + e.message))
    );
  }

  for (const [keys, binSym] of Object.entries(cryptoKeywords)) {
    const mentioned = keys.split('|').some(k => msg.includes(k));
    if (mentioned && binSym !== 'BTCUSDT') {
      wanted.add(binSym);
      promises.push(
        getBinanceTicker(binSym).then(d => {
          if (d) { parts.push(`${binSym}: $${d.price.toLocaleString('en-US', {maximumFractionDigits: 4})} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}%`); hits.add(binSym); }
        }).catch(() => {})
      );
    }
    // Wskaźniki techniczne dla wykrytego symbolu — AI dostaje policzone RSI/SMA/MACD
    if (mentioned) {
      promises.push(
        getTechnicals(binSym).then(t => {
          if (t) parts.push(`WSKAŹNIKI TECHNICZNE ${binSym} (policzone z danych 1D):\n${t}`);
        }).catch(() => {})
      );
    }
  }

  // SUROWCE — bez tego pytanie o srebro czy rope trafialo do modelu bez ceny
  // Nazwa dostawcy danych nie trafia do kontekstu — model ja papugowal
  // ("nie mam ceny z live API", "instrument nie jest w zestawie danych"),
  // a uzytkownika nie interesuje instalacja hydrauliczna, tylko rynek.
  // Wyjatkiem jest ETF: to informacja RYNKOWA, bo cena funduszu rozni sie od
  // ceny kruszcu i przemilczenie tego byloby wprowadzaniem w blad.
  const fmtCommodity = (key, d, suffix = '') => {
    if (d.isProxy) {
      const etf = (d.source.match(/ETF (\w+)/) || [])[1] || 'ETF';
      return `${d.name} (${key}): brak notowania samego surowca; kurs funduszu ${etf}: $${d.price.toFixed(2)} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}% — to cena ETF-u, nie uncji/baryłki${suffix}`;
    }
    return `${d.name} (${key}): $${d.price.toFixed(2)} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}%${suffix}`;
  };

  for (const [key, words] of Object.entries(COMMODITY_KEYWORDS)) {
    if (words.some(w => msg.includes(w))) {
      wanted.add(key);
      promises.push(
        getCommodityQuote(key).then(d => {
          if (d) { parts.push(fmtCommodity(key, d)); hits.add(key); }
        }).catch(() => {})
      );
      // Wskazniki liczone z tych samych swiec co dla krypto — inaczej prompt
      // TYPU A prosil o RSI/SMA/MACD, ktorych model dla surowca nie dostawal.
      promises.push(
        getCommodityTechnicals(key).then(t => {
          if (t) parts.push(`WSKAŹNIKI TECHNICZNE ${key} (policzone z danych 1D):\n${t}`);
        }).catch(() => {})
      );
      // Zloto i srebro chodza parami — przy pytaniu o jedno warto miec drugie,
      // bo relacja zloto/srebro jest podstawowym punktem odniesienia.
      if (key === 'XAGUSD') {
        wanted.add('XAUUSD');
        promises.push(getCommodityQuote('XAUUSD').then(d => {
          if (d) { parts.push(fmtCommodity('XAUUSD', d, ' (do relacji złoto/srebro)')); hits.add('XAUUSD'); }
        }).catch(() => {}));
      }
    }
  }

  // FOREX / waluty — NBP dla wymieniających waluty
  const fxTriggers = ['jen','jpy','yen','dolar','usd','euro',' eur','frank','chf','funt','gbp','korona','nok','sek','czk','forint','huf','hrywna','uah','walut','forex','kantor','wymien','wymian'];
  if (fxTriggers.some(k => msg.includes(k))) {
    promises.push(
      getNbpRates().then(d => {
        if (d) parts.push(fmtFx(d, ['USD','EUR','CHF','GBP','JPY','NOK','SEK','CZK','UAH']));
      }).catch(() => {})
    );
  }

  const stockKeywords = {
    'apple|aapl': 'AAPL', 'microsoft|msft': 'MSFT', 'nvidia|nvda': 'NVDA',
    'google|alphabet|googl': 'GOOGL', 'amazon|amzn': 'AMZN',
    'meta|facebook': 'META', 'tesla|tsla': 'TSLA',
    'orlen|pkn': 'PKN.WA', 'kghm': 'KGH.WA', 'pko bp|pko bank': 'PKO.WA',
    'cd projekt|cdprojekt|cdr': 'CDR.WA', 'lpp': 'LPP.WA', 'pekao': 'PEO.WA',
    'pzu': 'PZU.WA', 'allegro': 'ALE.WA', 'dino': 'DNP.WA', 'jsw': 'JSW.WA',
    'wig20|wig 20|gpw|giełd|gield': 'WIG20_SUMMARY',
    'akcj|stock|shares|magnificent': 'MULTI_STOCK',
  };

  for (const [keys, stockSym] of Object.entries(stockKeywords)) {
    if (keys.split('|').some(k => msg.includes(k))) {
      if (stockSym === 'WIG20_SUMMARY') {
        promises.push(getGpwSummary().then(t => { if (t) parts.push(t); }).catch(() => {}));
        continue;
      }
      if (stockSym === 'MULTI_STOCK') {
        ['AAPL','MSFT','NVDA','TSLA'].forEach(sym => {
          promises.push(
            getStockPrice(sym).then(d => {
              if (d) parts.push(`${sym}: $${d.price.toFixed(2)} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}%`);
            }).catch(() => {})
          );
        });
      } else {
        promises.push(
          getStockPrice(stockSym).then(d => {
            if (d) parts.push(`${stockSym}: $${d.price.toFixed(2)} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}%`);
          }).catch(() => {})
        );
      }
    }
  }

  const forexKeywords = {
    'eur|euro': {sym:'EURUSD', from:'EUR', to:'USD'},
    'pln|złoty|zloty|usdpln': {sym:'USDPLN', from:'USD', to:'PLN'},
    'eurpln': {sym:'EURPLN', from:'EUR', to:'PLN'},
    'gbp|funt': {sym:'GBPUSD', from:'GBP', to:'USD'},
    'forex|walut|kurs': {sym:'MULTI_FOREX', from:'', to:''},
  };

  for (const [keys, pair] of Object.entries(forexKeywords)) {
    if (keys.split('|').some(k => msg.includes(k))) {
      if (pair.sym === 'MULTI_FOREX') {
        [['USD','PLN'],['EUR','PLN'],['EUR','USD']].forEach(([f,t]) => {
          promises.push(
            getForexRate(f, t).then(d => {
              if (d) parts.push(`${f}/${t}: ${d.price.toFixed(4)}`);
            }).catch(() => {})
          );
        });
      } else {
        promises.push(
          getForexRate(pair.from, pair.to).then(d => {
            if (d) parts.push(`${pair.from}/${pair.to}: ${d.price.toFixed(4)}`);
          }).catch(() => {})
        );
      }
    }
  }

  // ETH zawsze w tle (cache)
  promises.push(
    getBinanceTicker('ETHUSDT').then(d => {
      if (d) parts.push(`ETHEREUM (ETHUSDT): $${d.price.toLocaleString('en-US',{maximumFractionDigits:0})} | 24h: ${d.change24h>=0?'+':''}${d.change24h.toFixed(2)}%`);
    }).catch(() => {})
  );
  // Fear & Greed zawsze
  promises.push(
    getFearGreed().then(d => d &&
      parts.push(`Fear & Greed Index (nastroje rynku KRYPTO, nie dotyczy metali/akcji/walut): ${d.value}/100 (${d.value_classification})`)
    ).catch(() => {})
  );

  // Budzet czasowy, nie sztywne oczekiwanie — wyscig konczy sie w momencie,
  // gdy ostatnie zrodlo odda dane. Bylo 2500 ms przy timeoucie Stooqa 6000 ms,
  // wiec surowiec z zimnym cache NIE MIAL SZANS zdazyc i wypadal z kontekstu.
  // 4500 ms mieszcza sie oba realne zrodla surowcow (Stooq 4 s, Yahoo 4 s),
  // a rdzen rynku i tak schodzi z podgrzanego cache w kilka milisekund.
  await Promise.race([
    Promise.all(promises),
    new Promise(res => setTimeout(res, 4500))
  ]);

  // Lista instrumentow bez notowania. Poprzednia wersja kazala modelowi
  // "powiedziec o tym wprost" — i model rzeczywiscie mowil, akapitem o brakach
  // w API. Teraz to czysta informacja techniczna: nie zmyslaj ceny, ale tez nie
  // rob z braku notowania tematu rozmowy.
  const missing = [...wanted].filter(k => !hits.has(k));
  if (missing.length) {
    parts.push(`NIEDOSTĘPNE (nie podawaj dla nich ceny, nie komentuj tego braku): ${missing.join(', ')}`);
  }

  console.log(
    `ctx ${Date.now() - t0}ms | zamówione: ${[...wanted].join(',') || '-'} | ` +
    `dostarczone: ${[...hits].join(',') || '-'} | braki: ${missing.join(',') || '-'} | wierszy: ${parts.length - 1}`
  );

  return parts.length > 1 ? parts.join('\n') : null;
}
// ── System prompty ────────────────────────────────────────────
//
// Przepisane po skardze uzytkownikow, ze odpowiedzi "sa dziwne, wskazuja na
// braki w danych i sa nieprzyjemne". Trzy przyczyny w starej wersji:
//
// 1. Prompt kazal modelowi opowiadac o wlasnym zapleczu ("nie mam ceny z live
//    API", "instrument nie jest w obecnym zestawie danych", nazwy dostawcow).
//    Uzytkownika nie interesuje, skad plyna dane — interesuje go rynek.
// 2. Byl zbudowany z zakazow (ZAKAZ, NIGDY, ‼️ przy co drugim akapicie).
//    Model pod takim promptem pisze asekuracyjnie i nieprzyjemnie.
// 3. Trzy rownolegle zestawy regul (szablon + WYMOG KONKRETU + NIE DORADZASZ)
//    rywalizowaly ze soba; nadmiar ograniczen daje wymijajaca odpowiedz.
//
// Zasada zgodnosci zostaje bez zmian: opisujemy, nie doradzamy. Ale opis ma
// byc odwazny — poziomy techniczne, wskazniki i historyczne analogie to fakty,
// nie rekomendacje, i nie ma powodu ich rozmywac.

const SYSTEM = `Jesteś AURIMIQ.ai — asystentem analiz finansowych. Odpowiadasz jak dobry analityk, który tłumaczy znajomemu, co się dzieje na rynku: rzeczowo, konkretnie, bez asekuracji i bez korporacyjnej sztywności.

DANE
Poniżej promptu dostajesz notowania pobrane przed chwilą. Wszystkie bieżące ceny, zmiany procentowe i wartości wskaźników bierzesz stąd — Twoja wiedza o AKTUALNYCH kursach jest nieaktualna.
Nieaktualne są tylko one. Typowa zmienność instrumentu, skala historycznych obsunięć, wieloletnie średnie relacji i przeszłe analogie to Twoja wiedza i masz jej używać, żeby ocenić, czy dzisiejszy ruch jest duży, czy mały. Podawaj takie odniesienia liczbowo ("srebro robi 3–5% na sesji"), nie ogólnikami.
Ta sekcja to Twoje zaplecze, nie temat rozmowy. Nigdy nie pisz, skąd pochodzą dane, jak je pobierasz, czego "nie ma w zestawie danych" ani że coś jest "z live API". Nie wymieniaj nazw dostawców danych.
Gdy dla instrumentu nie ma notowania: odpowiedz merytorycznie i po prostu nie podawaj ceny. Nie zapowiadaj tego i NIGDY nie zaczynaj od tego odpowiedzi. Wzmianka jest dopuszczalna tylko wtedy, gdy użytkownik pytał wprost o bieżący kurs — wtedy jedno krótkie zdanie PO pierwszym akapicie merytorycznym, nigdy przed nim. Nie pisz "nie mam", "w tej chwili", "tutaj". Nigdy nie zmyślaj ceny.

‼️ ZASADA NADRZĘDNA — ODPOWIADASZ NA ZADANE PYTANIE
Pierwsze zdanie odpowiedzi zawiera odpowiedź na to, o co użytkownik faktycznie zapytał. Nie wstęp, nie kontekst, nie szablon — odpowiedź.
Szablony w sekcji FORMATY to rusztowanie, nie obowiązek. Zakres odpowiedzi wyznacza pytanie:
- pytanie wąskie (o jedną liczbę, jeden wskaźnik, jedno porównanie) → odpowiedź wąska. Podaj to, o co pytano, dołóż najwyżej jedno zdanie kontekstu i skończ. NIE rozwijaj do pełnego szablonu.
- pytanie otwarte ("co z X", "jak wygląda Y") → dopiero wtedy pełny format.
- pytanie złożone z kilku części → odpowiedz na KAŻDĄ, w kolejności, w jakiej padły.
- pytanie o porównanie dwóch rzeczy → porównaj je wprost, liczba do liczby. Nie opisuj ich po kolei osobno.
Zanim skończysz, przeczytaj pierwsze zdanie i sprawdź, czy odpowiada na pytanie. Jeśli nie — przepisz je.

JAK PISZESZ
Każde zdanie niesie liczbę, datę albo nazwę własną. Zdanie, które pasuje równie dobrze do srebra, miedzi i bitcoina, skreśl.
Zaczynasz od odpowiedzi. Bez wstępu, bez "to ciekawe pytanie", bez definicji instrumentu, o którą nikt nie prosił.
Ton spokojny i ludzki. Pewny tam, gdzie masz dane. Jedno zastrzeżenie wystarczy — nie powtarzaj go w każdym akapicie.
Krótkie akapity. Emoji wyłącznie jako znaczniki sekcji w formacie TYP A.

CO ROBISZ
Pokazujesz, co widać w danych, i tłumaczysz, co to znaczy. Decyzję podejmuje użytkownik.
Nie wydajesz zaleceń kupna, sprzedaży ani trzymania. Nie podajesz ceny docelowej ani stop-lossa. Nie wystawiasz ocen punktowych typu "7/10" czy "AI Score".
To nie znaczy, że masz być mglisty. Poziomy techniczne, wartości wskaźników, historyczne analogie, twarde ryzyka i daty wydarzeń to fakty — podawaj je precyzyjnie i bez owijania.
Gdy pytanie brzmi "czy warto", "czy kupować teraz", "co byś zrobił" — nie odmawiaj i nie zapowiadaj odmowy. Zacznij od liczby albo faktu, nigdy od zdania o tym, czyja jest decyzja. Pokaż: gdzie stoi cena wobec ostatniego zakresu, jaki argument mają dziś kupujący i jaki sprzedający (każdy oparty na konkretnej wartości z danych) oraz jedno zdarzenie, które ten obraz unieważni. Zamknij pytaniem o horyzont albo o zniesienie typowego dla tego instrumentu obsunięcia — z jego historyczną skalą w procentach.

FORMATY

TYP A — OTWARTE pytanie o konkretny notowany instrument ("co z BTC", "jak wygląda srebro"):
Przy pytaniu wąskim o ten sam instrument (sam kurs, sam RSI, sam poziom oporu) użyj tylko tego punktu, którego dotyczy pytanie.
💰 Cena: $X, zmiana 24h
🔍 Wskaźniki: RSI, SMA50/200, MACD z sekcji danych; przy każdej wartości jedno zdanie, co ten poziom oznaczał historycznie. Jeśli w danych nie ma wskaźników — pomiń ten punkt bez komentarza.
📊 Poziomy 30 dni: opór $X, wsparcie $Y oraz ile procent dzieli od nich obecną cenę
📰 Nastroje — TYLKO dla krypto (BTC, ETH i pochodne): indeks strachu i chciwości z wartością i etykietą. Przy metalach, akcjach i walutach ten punkt NIE ISTNIEJE: nie zostawiaj pustego nagłówka i nie podpisuj nim niczego innego
📈 Relacja do rynku — zamiast punktu Nastroje przy metalach, akcjach i walutach: porównanie z powiązanym instrumentem z danych (dla srebra: kurs złota, iloraz złoto/srebro i jego odległość od historycznego pasma 60–90)
⚠️ Na co patrzeć: konkretne, datowane wydarzenia i ryzyka dla tego instrumentu
Do 250 słów. Lepiej gęsto i krótko niż długo i pusto.

TYP A-FX — kurs waluty (jen, dolar, frank...):
Kurs z sekcji danych, krótki komentarz i praktyczna wskazówka dla wymieniającego (kantory online zwykle 1–2% od kursu średniego).

TYP B — temat, sektor, trend, makro ("górnictwo planetarne", "czy będzie kryzys"):
2–4 akapity analizy. Potem:
🏢 Kto działa w tym obszarze: notowane spółki i ETF-y powiązane z tematem (tickery) — jako informacja, gdzie temat występuje na giełdzie, bez sugestii, że warto w nie wchodzić
⚠️ Główne ryzyka i horyzont czasowy
🔭 Co przesądzi o rozwoju tematu w najbliższych latach

TYP C — pytanie edukacyjne ("co to RSI", "jak działa DCF"):
Zwykłe, jasne wyjaśnienie. Bez szablonu, bez emoji.

Klauzulę "⚠️ Analiza edukacyjna, nie porada inwestycyjna." dopisujesz na końcu odpowiedzi w formacie TYP A, TYP B oraz wszędzie tam, gdzie oceniasz sytuację rynkową albo odpowiadasz na pytanie w rodzaju "czy warto". Przy odpowiedzi czysto faktograficznej — jedna cena, jeden wskaźnik, jedno przeliczenie, definicja — klauzulę pomijasz. Podanie samej liczby nie jest poradą.

Specjalizacje: DCF, LBO, equity research, M&A, private equity.
Odpowiadasz po polsku.`;

const SYSTEM_EN = `You are AURIMIQ.ai — a financial analysis assistant. You answer like a good analyst explaining to a friend what is happening in the market: concrete, direct, no hedging and no corporate stiffness.

DATA
Below the prompt you receive quotes fetched moments ago. Take every current price, percentage change and indicator value from there — your knowledge of CURRENT prices is out of date.
Only that is out of date. An instrument's typical volatility, the size of its historical drawdowns, multi-year average ratios and past analogues are your knowledge, and you are expected to use them to judge whether today's move is large or small. Give such references numerically ("silver moves 3–5% in a session"), not in generalities.
That section is your back office, not the subject of the conversation. Never write where the data comes from, how you fetch it, what is "not in the current data set", or that something is "from a live API". Never name data providers.
When an instrument has no quote: answer on the substance and simply give no price. Do not announce it and NEVER open your answer with it. A mention is allowed only if the user asked explicitly about the current rate — then one short sentence AFTER the first substantive paragraph, never before it. Do not write "I don't have", "right now", "here". Never invent a price.

‼️ OVERRIDING RULE — ANSWER THE QUESTION THAT WAS ASKED
The first sentence of your reply answers what the user actually asked. Not a preamble, not context, not a template — the answer.
The templates under FORMATS are scaffolding, not an obligation. The question sets the scope:
- a narrow question (one number, one indicator, one comparison) → a narrow answer. Give what was asked, add at most one sentence of context, and stop. Do NOT expand it into the full template.
- an open question ("what about X", "how is Y doing") → only then use the full format.
- a question with several parts → answer EVERY part, in the order they were asked.
- a question comparing two things → compare them directly, number against number. Do not describe them one after another.
Before you finish, reread your first sentence and check that it answers the question. If it does not, rewrite it.

HOW YOU WRITE
Every sentence carries a number, a date or a proper name. Delete any sentence that would fit silver, copper and bitcoin equally well.
Start with the answer. No preamble, no "great question", no definition of an instrument nobody asked about.
Calm, human tone. Confident where you have data. One disclaimer is enough — do not repeat it in every paragraph.
Short paragraphs. Emoji only as section markers in the TYPE A format.

WHAT YOU DO
You show what the data says and explain what it means. The user makes the decision.
You do not issue buy, sell or hold calls. No price targets, no stop-loss levels. No numeric ratings such as "7/10" or "AI Score".
That does not mean being vague. Technical levels, indicator values, historical analogues, hard risks and event dates are facts — state them precisely and without hedging.
When the question is "is it worth it", "should I buy now", "what would you do" — do not refuse and do not announce a refusal. Open with a number or a fact, never with a sentence about whose decision it is. Show: where the price sits against the recent range, what argument buyers have today and what argument sellers have (each anchored to a specific value from the data), and one event that would invalidate that picture. Close with a question about their horizon, or about tolerating this instrument's typical drawdown — giving its historical size in percent.

FORMATS

TYPE A — an OPEN question about a specific listed instrument ("what about BTC", "how is silver doing"):
For a narrow question about the same instrument (just the price, just RSI, just the resistance level) use only the bullet the question is about.
💰 Price: $X, 24h change
🔍 Indicators: RSI, SMA50/200, MACD from the data section; for each value, one sentence on what that level has meant historically. If the data has no indicators — skip this bullet without comment.
📊 30-day levels: resistance $X, support $Y, and how many percent the current price sits from each
📰 Sentiment — CRYPTO ONLY (BTC, ETH and the like): the fear and greed reading with its label. For metals, equities and currencies this bullet DOES NOT EXIST: do not leave an empty header and do not file anything else under it
📈 Cross-market — replaces the sentiment bullet for metals, equities and currencies: a comparison with a related instrument from the data (for silver: the gold price, the gold/silver ratio and how far it sits from its historical 60–90 band)
⚠️ What to watch: specific, dated events and risks for this instrument
Up to 250 words. Dense and short beats long and empty.

TYPE A-FX — a currency rate question:
The rate from the data section, a short comment and a practical tip for someone exchanging money (online exchange offices are usually 1–2% off the mid rate).

TYPE B — a topic, sector, trend or macro theme:
2–4 paragraphs of analysis. Then:
🏢 Who operates in this space: listed companies and ETFs tied to the theme (tickers) — as information about where the theme appears on the market, without suggesting they are worth buying
⚠️ Main risks and time horizon
🔭 What will determine how this theme develops in the coming years

TYPE C — a general or educational question:
A plain, clear explanation. No template, no emoji.

Add the line "⚠️ Educational analysis, not investment advice." at the end of TYPE A and TYPE B answers and anywhere you assess a market situation or answer an "is it worth it" question. For a purely factual answer — one price, one indicator, one conversion, a definition — omit it. Stating a number is not advice.

Specialisations: DCF, LBO, equity research, M&A, private equity.
Respond entirely in English. Never use Polish words, even if the underlying data labels are in Polish — translate everything, including instrument names.`;

const SYSTEM_DE = `Du bist AURIMIQ.ai — ein Assistent für Finanzanalysen. Du antwortest wie ein guter Analyst, der einem Bekannten erklärt, was am Markt passiert: konkret, direkt, ohne Absicherungsfloskeln und ohne Behördendeutsch.

DATEN
Unter dem Prompt bekommst du soeben abgerufene Kurse. Jeden aktuellen Preis, jede prozentuale Veränderung und jeden Indikatorwert nimmst du von dort — dein Wissen über AKTUELLE Kurse ist veraltet.
Nur dieses ist veraltet. Die typische Volatilität eines Instruments, die Größe historischer Drawdowns, langjährige Durchschnittsverhältnisse und frühere Analogien sind dein Wissen, und du sollst sie nutzen, um zu beurteilen, ob die heutige Bewegung groß oder klein ist. Nenne solche Bezugswerte in Zahlen ("Silber bewegt sich 3–5% je Sitzung"), nicht in Allgemeinplätzen.
Dieser Abschnitt ist dein Maschinenraum, nicht das Gesprächsthema. Schreibe nie, woher die Daten kommen, wie du sie abrufst, was "nicht im aktuellen Datensatz" ist oder dass etwas "aus einer Live-API" stammt. Nenne keine Datenanbieter.
Fehlt für ein Instrument die Notierung: antworte inhaltlich und nenne einfach keinen Preis. Kündige das nicht an und beginne die Antwort NIEMALS damit. Eine Erwähnung ist nur erlaubt, wenn ausdrücklich nach dem aktuellen Kurs gefragt wurde — dann ein kurzer Satz NACH dem ersten inhaltlichen Absatz, nie davor. Schreibe nicht "ich habe nicht", "im Moment", "hier". Erfinde niemals einen Preis.

‼️ ÜBERGEORDNETE REGEL — DU BEANTWORTEST DIE GESTELLTE FRAGE
Der erste Satz deiner Antwort beantwortet das, wonach tatsächlich gefragt wurde. Keine Einleitung, kein Kontext, keine Vorlage — die Antwort.
Die Vorlagen unter FORMATE sind ein Gerüst, keine Pflicht. Die Frage bestimmt den Umfang:
- enge Frage (eine Zahl, ein Indikator, ein Vergleich) → enge Antwort. Nenne das Gefragte, füge höchstens einen Satz Kontext hinzu und höre auf. Blase sie NICHT zur vollen Vorlage auf.
- offene Frage ("was ist mit X", "wie steht Y") → erst dann das volle Format.
- mehrteilige Frage → beantworte JEDEN Teil, in der Reihenfolge der Frage.
- Vergleichsfrage → vergleiche direkt, Zahl gegen Zahl. Beschreibe nicht beides nacheinander getrennt.
Lies vor dem Abschluss deinen ersten Satz und prüfe, ob er die Frage beantwortet. Wenn nicht, schreibe ihn neu.

WIE DU SCHREIBST
Jeder Satz trägt eine Zahl, ein Datum oder einen Eigennamen. Einen Satz, der genauso auf Silber, Kupfer und Bitcoin passt, streichst du.
Beginne mit der Antwort. Keine Einleitung, kein "gute Frage", keine Definition eines Instruments, nach der niemand gefragt hat.
Ruhiger, menschlicher Ton. Sicher dort, wo du Daten hast. Ein Hinweis genügt — wiederhole ihn nicht in jedem Absatz.
Kurze Absätze. Emojis nur als Abschnittsmarker im TYP-A-Format.

WAS DU TUST
Du zeigst, was die Daten sagen, und erklärst, was das bedeutet. Die Entscheidung trifft der Nutzer.
Du gibst keine Kauf-, Verkaufs- oder Halteempfehlungen. Keine Kursziele, keine Stop-Loss-Marken. Keine Punktbewertungen wie "7/10" oder "AI Score".
Das heißt nicht, vage zu sein. Technische Niveaus, Indikatorwerte, historische Analogien, harte Risiken und Termine sind Fakten — nenne sie präzise und ohne Weichzeichner.
Lautet die Frage "lohnt sich das", "soll ich jetzt kaufen", "was würdest du tun" — verweigere nicht und kündige keine Verweigerung an. Beginne mit einer Zahl oder einem Fakt, nie mit einem Satz darüber, wessen Entscheidung es ist. Zeige: wo der Kurs im Verhältnis zur jüngsten Spanne steht, welches Argument Käufer heute haben und welches Verkäufer (jeweils an einem konkreten Wert aus den Daten festgemacht), und ein Ereignis, das dieses Bild entwertet. Schließe mit einer Frage nach dem Horizont oder danach, ob der für dieses Instrument typische Drawdown ausgehalten wird — mit seiner historischen Größe in Prozent.

FORMATE

TYP A — eine OFFENE Frage zu einem konkreten notierten Instrument ("was ist mit BTC", "wie steht Silber"):
Bei einer engen Frage zum selben Instrument (nur der Kurs, nur RSI, nur die Widerstandsmarke) verwende nur den Punkt, um den es geht.
💰 Preis: $X, Veränderung 24h
🔍 Indikatoren: RSI, SMA50/200, MACD aus dem Datenabschnitt; zu jedem Wert ein Satz, was dieses Niveau historisch bedeutet hat. Fehlen Indikatoren in den Daten — lasse den Punkt kommentarlos weg.
📊 30-Tage-Niveaus: Widerstand $X, Unterstützung $Y und wie viel Prozent der aktuelle Kurs davon entfernt ist
📰 Stimmung — NUR für Krypto (BTC, ETH und Ähnliches): Angst-und-Gier-Wert mit Einordnung. Bei Metallen, Aktien und Währungen EXISTIERT dieser Punkt NICHT: lasse keine leere Überschrift stehen und ordne ihr nichts anderes unter
📈 Marktvergleich — ersetzt bei Metallen, Aktien und Währungen den Stimmungspunkt: Vergleich mit einem verwandten Instrument aus den Daten (bei Silber: Goldkurs, Gold-Silber-Verhältnis und sein Abstand zur historischen Spanne 60–90)
⚠️ Worauf zu achten ist: konkrete, datierte Ereignisse und Risiken für dieses Instrument
Bis 250 Wörter. Dicht und kurz schlägt lang und leer.

TYP A-FX — Frage zum Wechselkurs:
Der Kurs aus dem Datenabschnitt, ein kurzer Kommentar und ein praktischer Hinweis für den Geldwechsel (Online-Wechselstuben liegen meist 1–2% vom Mittelkurs entfernt).

TYP B — Thema, Sektor, Trend, Makrothema:
2–4 Absätze Analyse. Danach:
🏢 Wer in diesem Bereich tätig ist: notierte Unternehmen und ETFs zum Thema (Ticker) — als Information darüber, wo das Thema an der Börse vorkommt, ohne anzudeuten, dass sich ein Kauf lohnt
⚠️ Hauptrisiken und Zeithorizont
🔭 Was über die Entwicklung des Themas in den nächsten Jahren entscheidet

TYP C — allgemeine oder erklärende Frage:
Eine einfache, klare Erklärung. Ohne Vorlage, ohne Emojis.

Den Satz "⚠️ Pädagogische Analyse, keine Anlageberatung." setzt du ans Ende von TYP-A- und TYP-B-Antworten sowie überall dort, wo du eine Marktlage bewertest oder eine "lohnt sich das"-Frage beantwortest. Bei einer rein faktischen Antwort — ein Preis, ein Indikator, eine Umrechnung, eine Definition — lässt du ihn weg. Eine Zahl zu nennen ist keine Beratung.

Spezialisierungen: DCF, LBO, Equity Research, M&A, Private Equity.
Antworte vollständig auf Deutsch. Verwende niemals polnische Wörter, auch wenn die zugrunde liegenden Datenbezeichnungen auf Polnisch sind — übersetze alles, auch Instrumentennamen.`;

const SYSTEM_BY_LANG = { pl: SYSTEM, en: SYSTEM_EN, de: SYSTEM_DE };

// Notatka dokladana, gdy sekcja danych jest pusta.
//
// Poprzednia wersja kazala modelowi "powiedziec wprost, ze nie ma aktualnych
// notowan" i odeslac do zakladek. Efekt: uzytkownik pytal o srebro, a dostawal
// akapit o tym, czego aplikacji brakuje, zamiast odpowiedzi. To jest dokladnie
// ta "nieprzyjemnosc" i "dziwnosc", na ktora skarzyli sie uzytkownicy.
//
// Teraz: odpowiadaj na pytanie. Brak notowania to najwyzej jedno zdanie,
// nie temat. Zmyslanie ceny nadal wykluczone — w finansach pewnie brzmiaca
// pomylka jest gorsza niz jej brak.
const NO_DATA_NOTE = {
  pl: 'Nie masz teraz sekcji z notowaniami. Odpowiedz merytorycznie na pytanie w oparciu o to, co wiesz o rynku, mechanizmach i historii. Nie podawaj konkretnych aktualnych cen. Jesli pytanie wprost dotyczy biezacego kursu, zaznacz to jednym krotkim zdaniem i przejdz do rzeczy. Nie opisuj, czego Ci brakuje, nie wymieniaj zrodel, nie odsylaj do zakladek.',
  en: 'You have no quotes section right now. Answer the question on the substance, using what you know about the market, its mechanics and its history. Do not state specific current prices. If the question is explicitly about the current rate, note it in one short sentence and move on. Do not describe what you are missing, do not name sources, do not point at app tabs.',
  de: 'Du hast gerade keinen Kursabschnitt. Beantworte die Frage inhaltlich, gestuetzt auf dein Wissen ueber Markt, Mechanik und Historie. Nenne keine konkreten aktuellen Preise. Geht die Frage ausdruecklich um den aktuellen Kurs, weise in einem kurzen Satz darauf hin und komm zur Sache. Beschreibe nicht, was dir fehlt, nenne keine Quellen, verweise nicht auf App-Tabs.',
};

// TRYB PROSTY — dokladany do promptu, gdy uzytkownik wlaczy przelacznik.
// Nie zastepuje systemowego promptu, tylko zmienia sposob mowienia; dzieki
// temu AI dalej ma wszystkie dane i zasady, a jedynie inaczej je podaje.
const SIMPLE_MODE = {
  pl: `‼️ TRYB PROSTY — WŁĄCZONY. Tłumacz tak, jakbyś rozmawiał z kimś, kto pierwszy raz słyszy o giełdzie.
ZASADY TRYBU PROSTEGO (ważniejsze niż szablony odpowiedzi powyżej):
- Zero żargonu. Jeśli musisz użyć terminu (RSI, wolumen, kapitalizacja), wytłumacz go w tym samym zdaniu prostymi słowami.
- Krótkie zdania. Maksymalnie 2-3 akapity.
- Zamiast tabel i pól typu "Kurs docelowy" — zwykłe zdania.
- Używaj porównań z życia codziennego (np. "to tak, jakby cena chleba wzrosła z 5 do 7 zł").
- Zawsze powiedz wprost, co to oznacza dla zwykłego człowieka.
- NIE używaj szablonu sygnału ani pól z emotkami. Pisz normalnym tekstem.
- Zachowaj ostrzeżenie na końcu, ale sformułuj je prosto.`,
  en: `‼️ SIMPLE MODE — ON. Explain as if talking to someone who has never heard of the stock market.
SIMPLE MODE RULES (these override the answer templates above):
- No jargon. If you must use a term (RSI, volume, market cap), explain it in the same sentence in plain words.
- Short sentences. Two or three paragraphs at most.
- No tables or fields like "Price target" — use ordinary sentences.
- Use everyday comparisons (e.g. "it is like a loaf of bread going from 2 to 3 dollars").
- Always state plainly what this means for an ordinary person.
- Do NOT use the signal template or emoji fields. Write normal prose.
- Keep the closing warning, but phrase it simply.`,
  de: `‼️ EINFACHER MODUS — AN. Erkläre so, als sprächest du mit jemandem, der noch nie von der Börse gehört hat.
REGELN DES EINFACHEN MODUS (sie haben Vorrang vor den Vorlagen oben):
- Kein Fachjargon. Musst du einen Begriff verwenden (RSI, Volumen, Marktkapitalisierung), erkläre ihn im selben Satz mit einfachen Worten.
- Kurze Sätze. Höchstens zwei bis drei Absätze.
- Keine Tabellen oder Felder wie "Kursziel" — normale Sätze.
- Nutze Vergleiche aus dem Alltag (z. B. "als würde ein Brot von 2 auf 3 Euro steigen").
- Sage immer klar, was das für einen normalen Menschen bedeutet.
- Verwende NICHT die Signal-Vorlage oder Emoji-Felder. Schreibe normalen Fließtext.
- Behalte den Warnhinweis am Ende, formuliere ihn aber einfach.`,
};

// Naglowek mowil "DANE Z BINANCE API" nad danymi ze Stooqa, NBP i Yahoo.
// Etykieta, ktora nie zgadza sie z trescia, uczy model nie ufac sekcji danych.
// Neutralne etykiety. Poprzednie krzyczaly "LIVE" i "DANE Z BINANCE API",
// wiec model przejmowal ten jezyk i pisal uzytkownikowi o "cenie z live API"
// zamiast po prostu podac cene.
function liveDataHeader(lang, now) {
  if (lang === 'en') return `QUOTES (as of ${now}) — use these numbers:`;
  if (lang === 'de') return `KURSE (Stand ${now}) — verwende diese Zahlen:`;
  return `NOTOWANIA (stan na ${now}) — używaj tych liczb:`;
}
const LIVE_DATA_FOOTER = {
  pl: 'Koniec notowań. Nie cytuj tej sekcji, jej nagłówka ani nazw pól — to zaplecze, nie treść odpowiedzi.',
  en: 'End of quotes. Do not quote this section, its header or its field names — it is back office, not answer content.',
  de: 'Ende der Kurse. Zitiere diesen Abschnitt, seine Überschrift und seine Feldnamen nicht — das ist Maschinenraum, kein Antwortinhalt.',
};

// ── POST /api/chat ────────────────────────────────────────────
// Szacunek kosztu jednego zapytania w zlotowkach.
//
// Ceny Sonnet 5 (sierpien 2026): $2 za milion tokenow wejscia, $10 wyjscia,
// odczyt z cache to jedna dziesiata wejscia. Kurs domyslny 3,73 PLN/USD;
// podmienialny zmienna USD_PLN, bo to szacunek do logu, nie ksiegowosc.
const PRICE_IN  = Number(process.env.PRICE_IN_USD)  || 2;
const PRICE_OUT = Number(process.env.PRICE_OUT_USD) || 10;
const USD_PLN   = Number(process.env.USD_PLN)       || 3.73;
function estimateCostPLN(u = {}) {
  const inp   = (u.input_tokens || 0)                 * PRICE_IN  / 1e6;
  const write = (u.cache_creation_input_tokens || 0)  * PRICE_IN  * 1.25 / 1e6;
  const read  = (u.cache_read_input_tokens || 0)      * PRICE_IN  * 0.1  / 1e6;
  const out   = (u.output_tokens || 0)                * PRICE_OUT / 1e6;
  return ((inp + write + read + out) * USD_PLN).toFixed(4) + ' zl';
}

app.post('/api/chat', auth, checkPlan, async (req, res) => {
  const { messages, lang: rawLang, simple } = req.body;
  const lang = ['pl', 'en', 'de'].includes(rawLang) ? rawLang : 'pl';
  const simpleMode = simple === true;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'No messages' });

  const safe = messages
    .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-6)
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

  const userMsgs = safe.filter(m => m.role === 'user');
  const lastMsg = userMsgs[userMsgs.length - 1]?.content || '';
  // Przedostatnie pytanie — potrzebne, zeby "a jak wyglada wykres?" wiedzialo,
  // ze rozmowa nadal toczy sie o srebrze.
  const prevUserMsg = userMsgs[userMsgs.length - 2]?.content || '';

  // ── ROUTER INTELIGENCJI: klasyfikacja NAJPIERW (tanio, tekstowo) ──
  function classifyQuery(msg) {
    const m = (msg || '').toLowerCase();
    // Twarde sygnały merytoryczne → CLAUDE
    const serious = ['analiz','btc','bitcoin','eth','krypto','crypto','akcj','stock','kurs','cena','price',
      'kupi','sprzeda','buy','sell','hold','portfel','portfolio','dcf','lbo','rsi','macd','wig','gpw',
      'inwest','invest','zarob','earn','prognoz','forecast','trend','wsparc','opor','dolar','euro','jen',
      'frank','funt','walut','forex','złot','gold','silver','srebr','ropa','oil','recesj','kryzys','crisis',
      'wytłumacz','wyjaśnij','explain','erklär','analyse','aktie','währung',
      // Surowce poza zlotem i ropa w ogole nie byly na tej liscie, wiec
      // "co z palladem?" (14 znakow) wpadalo w prog dlugosci ponizej i szlo do
      // Groq BEZ jakichkolwiek danych rynkowych — gwarantowane "nie mam danych".
      'surowc','rohstoff','commodit','metal','uran','nbp','wykres','chart'];
    if (serious.some(k => m.includes(k))) return 'claude';

    // Rejestr surowcow jest zrodlem prawdy — nowy surowiec dodany do
    // COMMODITY_KEYWORDS automatycznie zaczyna byc routowany do modelu z danymi,
    // bez pamietania o drugiej liscie slow.
    if (Object.values(COMMODITY_KEYWORDS).some(ws => ws.some(w => m.includes(w)))) return 'claude';
    // Tickery dopasowujemy jako CALE SLOWO, nie jako podciag. Proste
    // m.includes() lapaloby "ada" w "zasada" i "dot" w "dotyczy", a odsianie
    // ich progiem dlugosci wycinalo tez XRP, SOL, BNB i ADA — czyli pytanie
    // "co z xrp?" (8 znakow) szlo do Groq bez zadnych danych rynkowych.
    const asWord = k => new RegExp(`(^|[^a-z0-9])${k}([^a-z0-9]|$)`).test(m);
    if (Object.keys(BINANCE_SYMBOLS).some(asWord)) return 'claude';

    // Small talk / testy → GROQ
    const trivial = ['cześć','czesc','hej','hello','hi ','siema','dzięki','dzieki','thanks','danke','hallo',
      'kim jesteś','who are you','co umiesz','what can you','test','ok','dobra','super','fajnie'];
    if (m.length < 15 || trivial.some(k => m === k || m.startsWith(k))) return 'groq';
    return 'gray';
  }

  async function askGroq(sysPrompt, msgs) {
    try {
      const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
          max_tokens: 2048,
          temperature: 0.4,
          messages: [{ role: 'system', content: sysPrompt }, ...msgs],
        })
      });
      const d = await groqRes.json();
      return d.error ? null : d.choices[0].message.content;
    } catch(e) { return null; }
  }

  // Prosty system prompt bez danych rynkowych — dla Groq (trivial/probe)
  // Tryb prosty dokladamy na koncu, zeby mial pierwszenstwo nad szablonami
  // odpowiedzi z promptu systemowego.
  const LOCALIZED_SYSTEM = (SYSTEM_BY_LANG[lang] || SYSTEM)
    + (simpleMode ? '\n\n' + (SIMPLE_MODE[lang] || SIMPLE_MODE.en) : '');
  const BASE_SYSTEM = LOCALIZED_SYSTEM + '\n\n' + NO_DATA_NOTE[lang];

  try {
    const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
    let reply = null;
    let usedModel = 'claude';

    // Dopowiedzenie ("a wykres?", "a co dalej?") samo w sobie nie wyglada na
    // pytanie merytoryczne i wpadaloby do Groq BEZ danych rynkowych, mimo ze
    // rozmowa toczy sie o konkretnym instrumencie. Jesli poprzednie pytanie
    // dotyczylo instrumentu, a biezace jest krotkie i niczego nie nazywa —
    // traktujemy je jako ciag dalszy tej samej rozmowy.
    let route = classifyQuery(lastMsg);
    if (route === 'groq' && prevUserMsg && !mentionsInstrument(lastMsg) && mentionsInstrument(prevUserMsg)) {
      route = 'claude';
      console.log('router: dopowiedzenie do poprzedniego pytania → Claude z danymi');
    }

    // Szare przypadki → prosto do Claude.
    //
    // Wcześniej leciała tu dodatkowa sonda do Groq ("ESCALATE albo odpowiedz
    // sam"), która przy każdym niejednoznacznym pytaniu dokładała jedno pełne
    // okrążenie sieciowe przed właściwą odpowiedzią, a część pytań kończyła na
    // llamie zamiast na Claude. To był główny powód spadku prędkości i precyzji
    // względem wersji 1.11. Small talk i tak łapie classifyQuery (lista
    // `trivial` + próg 15 znaków), więc sonda nie wnosiła nic poza opóźnieniem.
    if (route === 'gray') {
      route = 'claude';
    }

    if (route === 'groq' && !reply) {
      reply = await askGroq(BASE_SYSTEM, safe);
      if (reply) { usedModel = 'groq-router'; console.log('Model: Groq (router — trivial)'); }
    }

    // Dane rynkowe pobieramy TYLKO gdy faktycznie idziemy do Claude
    if (route === 'claude' && !reply) {
      let context = null;
      try {
        context = await buildContext(lastMsg, prevUserMsg);
      } catch (ctxErr) {
        console.log('buildContext error (kontynuuję bez danych):', ctxErr.message);
      }
      const now = new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });
      const systemPrompt = context
        ? LOCALIZED_SYSTEM + '\n\n' + liveDataHeader(lang, now) + '\n' + context + '\n' + LIVE_DATA_FOOTER[lang]
        : BASE_SYSTEM;

      if (CLAUDE_KEY) {
        try {
          const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': CLAUDE_KEY,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
              // Sonnet 5 zamiast 4.6: nowszy model, a przy tym TANSZY
              // ($2/$10 za milion tokenow wobec $3/$15). Jedyny przypadek,
              // gdy lepsza jakosc i nizszy koszt ida w te sama strone.
              // Nadpisywalne zmienna srodowiskowa, zeby zmiana modelu nie
              // wymagala deploya.
              model: process.env.CLAUDE_MODEL || 'claude-sonnet-5',
              // 1024 tokeny ucinaly odpowiedzi TYPU B (analiza tematu +
              // spolki + ryzyka + horyzont) w polowie zdania. W polskim
              // tokenizacja jest gorsza niz w angielskim, wiec limit bil
              // wczesniej, niz wygladal.
              max_tokens: 2048,
              // Bez `temperature`. Sonnet 5 odrzuca ten parametr
              // ("`temperature` is deprecated for this model"), a poniewaz
              // caly request leci wtedy bledem 400, KAZDA odpowiedz spadala
              // na Groqa. Model wyglada na dzialajacy, tylko nie jest to
              // Claude. Trzymanie sie liczb zalatwia prompt systemowy,
              // ktory i tak nakazuje opierac sie na sekcji danych.
              // Prompt systemowy rozbity na dwa bloki: staly (kilka tysiecy
              // tokenow, identyczny przy kazdym zapytaniu) idzie z cache_control,
              // wiec Anthropic przetwarza go raz zamiast za kazdym razem.
              // Dane rynkowe zmieniaja sie co zapytanie, wiec zostaja poza cache.
              system: [
                { type: 'text', text: LOCALIZED_SYSTEM, cache_control: { type: 'ephemeral' } },
                ...(context
                  ? [{ type: 'text', text: liveDataHeader(lang, now) + '\n' + context + '\n' + LIVE_DATA_FOOTER[lang] }]
                  : [{ type: 'text', text: NO_DATA_NOTE[lang] }]),
              ],
              messages: safe.map(m => ({ role: m.role, content: m.content })),
            })
          });

          const claudeData = await claudeRes.json();
          if (claudeData.content?.[0]?.text) {
            reply = claudeData.content[0].text;
            // Realne zuzycie z odpowiedzi API, nie szacunek. Bez tego nie da
            // sie odpowiedziec na pytanie "ile naprawde kosztuje uzytkownik",
            // a to jest liczba, od ktorej zalezy sensownosc calego cennika.
            const u = claudeData.usage || {};
            console.log(
              `Model: Claude ${process.env.CLAUDE_MODEL || 'claude-sonnet-5'} | ` +
              `we: ${u.input_tokens ?? '?'} (cache zapis ${u.cache_creation_input_tokens ?? 0}, ` +
              `odczyt ${u.cache_read_input_tokens ?? 0}) | wy: ${u.output_tokens ?? '?'} | ` +
              `koszt: ${estimateCostPLN(u)}`
            );
          } else {
            console.log('Claude error:', JSON.stringify(claudeData).slice(0, 200));
          }
        } catch(e) {
          console.log('Claude failed:', e.message);
        }
      }

      if (!reply) {
        reply = await askGroq(systemPrompt, safe);
        if (reply) { usedModel = 'groq-fallback'; console.log('Model: Groq GPT-OSS 120B (fallback)'); }
      }
    }

    if (!reply) return res.status(502).json({ error: 'AI unavailable' });

    try {
      await supabase.from('chat_history').insert({
        user_id: req.user.id,
        user_message: lastMsg,
        ai_reply: reply,
        model: usedModel === 'claude' ? (process.env.CLAUDE_MODEL || 'claude-sonnet-5') : usedModel,
      });
      await incQueries(req.user.id);
    } catch(e) {}

    const totalEver = req.totalEver || 0;
    const remaining = calcRemaining(req.plan, req.queries + 1, (req.totalEver || 0) + 1);

    res.json({ reply, plan: req.plan, remaining, limit: req.plan === 'pro' ? 999 : planLimit(req.plan) });

  } catch(e) {
    res.status(502).json({ error: 'AI error: ' + e.message });
  }
});

// ── GET /api/chart/:symbol ────────────────────────────────────
app.get('/api/chart/:symbol', auth, async (req, res) => {
  const sym = req.params.symbol;
  const type = req.query.type || 'crypto';
  const interval = req.query.interval || '1d';
  const limit = parseInt(req.query.limit) || 90;

  try {
    if (type === 'crypto') {
      const binSym = BINANCE_SYMBOLS[sym.toLowerCase()] || sym.toUpperCase() + 'USDT';

      const [klines, ticker, fg] = await Promise.all([
        getBinanceChart(binSym, interval, limit),
        getBinanceTicker(binSym),
        getFearGreed(),
      ]);

      if (!klines || !klines.length) {
        return res.status(404).json({ error: `No data for ${sym}` });
      }

      return res.json({
        symbol: binSym,
        type: 'crypto',
        interval,
        klines,
        meta: {
          price: ticker?.price,
          change24h: ticker?.change24h,
          volume24h: ticker?.volume24h,
          high24h: ticker?.high24h,
          low24h: ticker?.low24h,
          fearGreed: fg ? { value: fg.value, label: fg.value_classification } : null,
        }
      });

    } else {
      const up = sym.toUpperCase();

      // ── Gieldy poza USA: Alpha Vantage nie zna .WA ani .DE, idziemy Stooqiem.
      // Stooq trzyma polskie walory bez sufiksu (pkn), a niemieckie z nim (sap.de).
      if (STOOQ_MAP[up] || up.endsWith('.WA') || up.endsWith('.DE')) {
        const stooqSym = STOOQ_MAP[up]
          || (up.endsWith('.WA') ? up.replace('.WA', '').toLowerCase() : up.toLowerCase());
        const klines = await getStooqChart(stooqSym, limit);
        if (!klines) return res.status(404).json({ error: `No exchange data for ${sym}` });

        const last = klines[klines.length - 1];
        const prev = klines[klines.length - 2];
        return res.json({
          symbol: up,
          type: 'stock',
          interval,
          klines,
          meta: {
            price: last.c,
            change24h: prev ? ((last.c - prev.c) / prev.c * 100) : 0,
            volume24h: last.v,
            source: up.endsWith('.DE') ? 'Stooq/XETRA' : 'Stooq/GPW',
          }
        });
      }

      // ── Surowce: najpierw Stooq, awaryjnie ETF przez Alpha Vantage ──
      const commodity = COMMODITY_SOURCES[up];
      if (commodity) {
        const klines = await getStooqChart(commodity.stooq, limit);
        if (klines) {
          const last = klines[klines.length - 1];
          const prev = klines[klines.length - 2];
          console.log(`CHART ${up}: Stooq OK (${klines.length} swiec)`);
          return res.json({
            symbol: up,
            type: 'commodity',
            interval,
            klines,
            meta: {
              price: last.c,
              change24h: prev ? ((last.c - prev.c) / prev.c * 100) : 0,
              volume24h: last.v,
              source: 'Stooq',
              name: commodity.name,
            }
          });
        }
        // Zanim spadniemy na ETF (inna wartosc bezwzgledna!), probujemy
        // kontraktu terminowego z Yahoo — to nadal cena samego surowca.
        if (commodity.yahoo) {
          const yk = await getYahooChart(commodity.yahoo, limit);
          if (yk && yk.length) {
            const last = yk[yk.length - 1];
            const prev = yk[yk.length - 2];
            console.log(`CHART ${up}: Stooq odmowil, Yahoo ${commodity.yahoo} OK (${yk.length} swiec)`);
            return res.json({
              symbol: up,
              type: 'commodity',
              interval,
              klines: yk,
              meta: {
                price: last.c,
                change24h: prev ? ((last.c - prev.c) / prev.c * 100) : 0,
                volume24h: last.v,
                source: `Yahoo ${commodity.yahoo}`,
                name: commodity.name,
              }
            });
          }
        }
        console.log(`CHART ${up}: Stooq i Yahoo odmowily, probuje ETF ${commodity.etf}`);
      }

      // Dla surowca bez danych ze Stooqa pytamy o ETF, ktory go sledzi.
      const avSymbol = commodity ? commodity.etf : up;

      // Yahoo PRZED Alpha Vantage. Wczesniej wykres akcji amerykanskiej szedl
      // wylacznie przez Alpha Vantage — bez Yahoo, bez Stooqa, bez zadnego
      // zapasu. Odkad klucz jest brany tylko ze srodowiska, brak zmiennej
      // ALPHA_VANTAGE_KEY oznaczal 404 na kazdym wykresie AAPL czy NVDA.
      // Yahoo jest darmowe, nie wymaga klucza i nie ma limitu dziennego,
      // wiec to ono powinno byc pierwsze niezaleznie od klucza.
      const yStock = await getYahooChart(avSymbol, limit);
      if (yStock && yStock.length) {
        const yl = yStock[yStock.length - 1];
        const yp = yStock[yStock.length - 2];
        return res.json({
          symbol: up,
          type: commodity ? 'commodity' : 'stock',
          interval,
          klines: yStock,
          meta: {
            price: yl.c,
            change24h: yp ? ((yl.c - yp.c) / yp.c * 100) : 0,
            volume24h: yl.v,
            source: commodity ? `ETF ${commodity.etf} (proxy)` : 'Yahoo',
            ...(commodity ? { name: commodity.name, isProxy: true } : {}),
          }
        });
      }

      // Alpha Vantage dopiero teraz i tylko z kluczem. Bez klucza zapytanie
      // i tak wrociloby bledem, placac po drodze pelny timeout.
      if (!AV_KEY) return res.status(404).json({ error: `No stock data for ${sym}` });

      const size = limit <= 90 ? 'compact' : 'full';
      const r = await fetchWithTimeout(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${avSymbol}&outputsize=${size}&apikey=${AV_KEY}`, {}, 6000
      );
      const d = await r.json();
      const ts = d['Time Series (Daily)'];
      if (!ts) return res.status(404).json({ error: `No stock data for ${sym}` });

      const entries = Object.entries(ts)
        .sort((a, b) => a[0] < b[0] ? -1 : 1)
        .slice(-limit);

      const klines = entries.map(([date, v]) => ({
        t: new Date(date).getTime(),
        o: parseFloat(v['1. open']),
        h: parseFloat(v['2. high']),
        l: parseFloat(v['3. low']),
        c: parseFloat(v['4. close']),
        v: parseFloat(v['5. volume']),
      }));

      const last = klines[klines.length - 1];
      const prev = klines[klines.length - 2];
      const change = prev ? ((last.c - prev.c) / prev.c * 100) : 0;

      return res.json({
        symbol: up,
        type: commodity ? 'commodity' : 'stock',
        interval,
        klines,
        meta: {
          price: last.c,
          change24h: change,
          volume24h: last.v,
          // Przy surowcu z ETF-u mowimy wprost, ze to notowanie funduszu,
          // a nie samego surowca — inaczej uzytkownik zobaczylby cene GLD
          // i pomyslal, ze zloto kosztuje 300 dolarow.
          source: commodity ? `ETF ${commodity.etf} (proxy)` : 'AlphaVantage',
          ...(commodity ? { name: commodity.name, isProxy: true } : {}),
        }
      });
    }

  } catch(e) {
    res.status(502).json({ error: 'Chart error: ' + e.message });
  }
});

// ── POST /api/report — zglaszanie odpowiedzi AI ──────────────
//
// Wymog polityki Google Play dla aplikacji generujacych tresc AI:
// "Apps that generate content using AI must contain in-app user reporting
// or flagging features that allow users to report or flag offensive content
// to developers without needing to exit the app."
//
// Zgloszenie zapisujemy razem z trescia pytania i odpowiedzi, bo bez nich
// nie da sie ocenic, co poszlo nie tak. Kategoria jest opcjonalna —
// wymaganie uzasadnienia zniechecaloby do zglaszania.
const REPORT_REASONS = ['inaccurate', 'offensive', 'harmful', 'advice', 'other'];

app.post('/api/report', auth, async (req, res) => {
  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const userMessage = str(req.body?.message, 2000);
  const aiReply     = str(req.body?.reply, 8000);
  const rawReason   = str(req.body?.reason, 40).toLowerCase();
  const reason      = REPORT_REASONS.includes(rawReason) ? rawReason : 'other';
  const note        = str(req.body?.note, 1000);
  const lang        = ['pl', 'en', 'de'].includes(req.body?.lang) ? req.body.lang : 'pl';

  if (!aiReply) return res.status(400).json({ error: 'Nothing to report' });

  const now = new Date();
  const ref = 'RP-' + now.toISOString().slice(0, 10).replace(/-/g, '') + '-' +
              Math.abs([...(req.user.id + aiReply.slice(0, 40) + now.toISOString())]
                .reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 11))
                .toString(36).toUpperCase().slice(0, 6);

  try {
    await supabase.from('ai_reports').insert({
      ref,
      user_id: req.user.id,
      user_message: userMessage,
      ai_reply: aiReply,
      reason, note, lang,
      created_at: now.toISOString(),
    });
  } catch (e) {
    // Uzytkownik ma dostac potwierdzenie nawet gdy baza zawiedzie —
    // inaczej zglosi to samo piec razy. Tresc zostaje w logu.
    console.error('REPORT: zapis do bazy nieudany:', e.message);
  }

  console.log(`REPORT ${ref} | user=${req.user.id} | ${reason} | "${userMessage.slice(0, 60)}"`);
  res.json({ ok: true, ref });
});

// ── GET /api/snapshot/:symbol ────────────────────────────────
//
// Lekki endpoint: cena, zmiana dobowa i policzone wskazniki, BEZ modelu.
// Sluzy do wypelnienia okna czekania na odpowiedz AI trescia zamiast
// animacji — uzytkownik dostaje czesc odpowiedzi, zanim przyjdzie calosc.
// Nie zuzywa limitu zapytan, bo nie dotyka Claude ani Groq.
//
// Przyjmuje symbol w formacie TradingView, ktorego uzywa terminal
// (OANDA:XAGUSD, BINANCE:BTCUSDT, GPW:KGH), i sam go tlumaczy.
function parseTvSymbol(raw) {
  const up = decodeURIComponent(raw || '').toUpperCase();
  const [prefix, rest] = up.includes(':') ? up.split(':') : ['', up];
  const bare = rest || up;

  if (prefix === 'BINANCE') return { kind: 'crypto', sym: bare };
  if (COMMODITY_SOURCES[bare]) return { kind: 'commodity', sym: bare };
  if (bare === 'NATGASUSD') return { kind: 'commodity', sym: 'NATGAS' };
  if (prefix === 'GPW')  return { kind: 'stock', sym: bare + '.WA' };
  if (prefix === 'XETR') return { kind: 'stock', sym: bare + '.DE' };
  if (prefix === 'NASDAQ' || prefix === 'NYSE') return { kind: 'stock', sym: bare };
  // Bez prefiksu: para konczaca sie na USDT to krypto, reszta to akcja.
  if (bare.endsWith('USDT')) return { kind: 'crypto', sym: bare };
  return { kind: 'stock', sym: bare };
}

app.get('/api/snapshot/:symbol', auth, async (req, res) => {
  const { kind, sym } = parseTvSymbol(req.params.symbol);
  try {
    let quote = null, tech = null;

    // `spark` to same ceny zamkniecia z ostatnich ~40 sesji. Aplikacja rysuje
    // z nich miniature wykresu w oknie czekania — na telefonie czat i wykres
    // sa na osobnych zakladkach, wiec bez tego uzytkownik w trakcie odpowiedzi
    // nie widzi zadnego obrazka, tylko liczby.
    let closes = null;
    const SPARK = 40;
    const toCloses = k => (Array.isArray(k) && k.length > 1
      ? k.slice(-SPARK).map(x => x.c).filter(Number.isFinite)
      : null);

    if (kind === 'crypto') {
      const [q, t, k] = await Promise.all([
        getBinanceTicker(sym).catch(() => null),
        getTechnicals(sym).catch(() => null),
        getBinanceChart(sym, '1d', SPARK).catch(() => null),
      ]);
      quote = q; tech = t; closes = toCloses(k);
    } else if (kind === 'commodity') {
      const src = COMMODITY_SOURCES[sym] || {};
      const [q, t, k] = await Promise.all([
        getCommodityQuote(sym).catch(() => null),
        getCommodityTechnicals(sym).catch(() => null),
        getStooqChart(src.stooq, SPARK).catch(() => null),
      ]);
      quote = q; tech = t; closes = toCloses(k);
      if (!closes && src.yahoo) {
        closes = toCloses(await getYahooChart(src.yahoo, SPARK).catch(() => null));
      }
    } else {
      const [q, k] = await Promise.all([
        getStockPrice(sym).catch(() => null),
        getYahooChart(sym, SPARK).catch(() => null),
      ]);
      quote = q; closes = toCloses(k);
      if (!closes) closes = toCloses(await getStooqChart(sym.replace('.WA', '').toLowerCase(), SPARK).catch(() => null));
    }

    if (!quote) return res.status(404).json({ error: 'No data' });

    res.json({
      symbol: sym,
      kind,
      price: quote.price,
      change24h: quote.change24h,
      isProxy: quote.isProxy || false,
      tech: tech || null,
      spark: closes && closes.length > 4 ? closes : null,
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/prices ──────────────────────────────────────────
app.get('/api/prices', auth, async (req, res) => {
  const symbols = (req.query.symbols || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,BNBUSDT').split(',');
  try {
    const results = {};
    await Promise.all(symbols.map(async (sym) => {
      const ticker = await getBinanceTicker(sym.trim());
      if (ticker) results[sym] = ticker;
    }));
    res.json({ prices: results, ts: Date.now() });
  } catch(e) { res.status(502).json({ error: e.message }); }
});

// ── GET /api/ticker/:symbol ───────────────────────────────────
app.get('/api/ticker/:symbol', auth, async (req, res) => {
  const sym = req.params.symbol.toUpperCase();
  const binSym = BINANCE_SYMBOLS[sym.toLowerCase()] || sym + 'USDT';
  try {
    const ticker = await getBinanceTicker(binSym);
    if (!ticker) return res.status(404).json({ error: 'Not found' });
    res.json(ticker);
  } catch(e) {
    res.status(502).json({ error: e.message });
  }
});

// ── GET /api/profile ──────────────────────────────────────────
app.get('/api/profile', auth, async (req, res) => {
  const { data } = await supabase
    .from('profiles')
    .select('plan, queries_today, last_query_date, total_queries_ever')
    .eq('id', req.user.id)
    .single();
  const today = new Date().toISOString().slice(0, 10);
  const queries = data?.last_query_date?.slice(0, 10) === today ? (data.queries_today || 0) : 0;
  const plan = data?.plan || 'free';
  const totalEver = data?.total_queries_ever || 0;
  const remaining = calcRemaining(plan, queries, totalEver);
  res.json({ plan, queries_today: queries, total_queries_ever: totalEver, limit: plan === 'pro' ? 999 : planLimit(plan), remaining });
});

// ── DELETE /api/account — trwałe usunięcie konta i wszystkich danych ──
app.delete('/api/account', auth, async (req, res) => {
  const uid = req.user.id;

  // 1. Anuluj aktywną subskrypcję (Stripe — terminal webowy, Google Play — apka),
  //    żeby nie obciążać usuniętego konta.
  try {
    const { data: profile } = await supabase
      .from('profiles')
      .select('stripe_customer_id, play_purchase_token')
      .eq('id', uid)
      .single();

    if (profile?.stripe_customer_id) {
      const subs = await stripe.subscriptions.list({ customer: profile.stripe_customer_id, status: 'active', limit: 10 });
      for (const sub of subs.data) {
        await stripe.subscriptions.cancel(sub.id).catch(e => console.log('Stripe cancel error:', e.message));
      }
    }

    if (profile?.play_purchase_token) {
      try {
        const client = getPlayClient();
        if (client) {
          const sub = await fetchPlaySubscription(profile.play_purchase_token);
          const items = sub.lineItems || [];
          const productId = items[items.length - 1]?.productId;
          if (productId) {
            await client.purchases.subscriptions.cancel({
              packageName: PLAY_PACKAGE,
              subscriptionId: productId,
              token: profile.play_purchase_token,
            });
          }
        }
      } catch (e) {
        console.log('Play cancel error (kontynuuję usuwanie):', e.message);
      }
    }
  } catch (e) {
    console.log('Billing cleanup error (kontynuuję usuwanie):', e.message);
  }

  // 2. Usuń dane użytkownika ze wszystkich tabel
  try {
    await supabase.from('chat_history').delete().eq('user_id', uid);
    await supabase.from('portfolio').delete().eq('user_id', uid);
    await supabase.from('price_alerts').delete().eq('user_id', uid);
    await supabase.from('profiles').delete().eq('id', uid);
  } catch (e) {
    console.error('DELETE ACCOUNT — błąd czyszczenia danych:', e.message);
    return res.status(500).json({ error: 'Nie udało się usunąć danych konta: ' + e.message });
  }

  // 3. Usuń użytkownika z Supabase Auth (wymaga service role key)
  try {
    const { error: authErr } = await supabase.auth.admin.deleteUser(uid);
    if (authErr) {
      console.error('DELETE ACCOUNT — błąd usuwania z Auth:', authErr.message);
      return res.status(500).json({ error: 'Dane konta usunięte, ale nie udało się usunąć logowania: ' + authErr.message });
    }
  } catch (e) {
    console.error('DELETE ACCOUNT — wyjątek przy usuwaniu z Auth:', e.message);
    return res.status(500).json({ error: 'Dane konta usunięte, ale nie udało się usunąć logowania: ' + e.message });
  }

  res.json({ deleted: true });
});

// ── GET /api/history ──────────────────────────────────────────
app.get('/api/history', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('chat_history')
    .select('id, user_message, ai_reply, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: 'DB error' });
  res.json({ history: data || [] });
});

// ── Stripe checkout ───────────────────────────────────────────
app.post('/api/create-checkout', auth, async (req, res) => {
  try {
    const { currency = 'pln', plan = 'pro', lang = 'pl' } = req.body;
    const STRIPE_LOCALE = { pl: 'pl', en: 'en', de: 'de' }[lang] || 'auto';
    const PRICES = {
      pro: {
        pln: process.env.STRIPE_PRICE_PRO_PLN || 'price_1Th6zS2eFAwvdlMu59DYdPui',
        usd: process.env.STRIPE_PRICE_PRO_USD || 'price_1TyCim2eFAwvdlMueUlDiWvB',
        eur: process.env.STRIPE_PRICE_PRO_EUR || 'price_1Txrl22eFAwvdlMuQDr5jk3D',
      },
      lite: {
        pln: process.env.STRIPE_PRICE_LITE_PLN || 'BRAK_CENY_LITE_PLN',
        usd: process.env.STRIPE_PRICE_LITE_USD || 'BRAK_CENY_LITE_USD',
        eur: process.env.STRIPE_PRICE_LITE_EUR || 'BRAK_CENY_LITE_EUR',
      },
    };
    const planKey = PRICES[plan] ? plan : 'pro';
    const priceId = PRICES[planKey][currency] || PRICES[planKey].pln;
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      locale: STRIPE_LOCALE,
      line_items: [{ price: priceId, quantity: 1 }],
      customer_email: req.user.email,
      client_reference_id: req.user.id,
      success_url: (process.env.FRONTEND_URL || 'https://aurimiq-ai.netlify.app') + '?upgraded=true',
      cancel_url: (process.env.FRONTEND_URL || 'https://aurimiq-ai.netlify.app') + '?cancelled=true',
      metadata: { user_id: req.user.id, plan: planKey }
    });
    res.json({ url: session.url });
  } catch(e) {
    console.error('STRIPE ERROR:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Stripe webhook ────────────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { return res.status(400).json({ error: e.message }); }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const uid = s.metadata?.user_id || s.client_reference_id;
    const purchasedPlan = ['lite','pro'].includes(s.metadata?.plan) ? s.metadata.plan : 'pro';
    if (uid) await supabase.from('profiles').upsert({ id: uid, plan: purchasedPlan, stripe_customer_id: s.customer }, { onConflict: 'id' });
  }
  if (event.type === 'customer.subscription.deleted') {
    const { data } = await supabase.from('profiles').select('id').eq('stripe_customer_id', event.data.object.customer).single();
    if (data) await supabase.from('profiles').update({ plan: 'free' }).eq('id', data.id);
  }
  res.json({ received: true });
});

// ══════════════════════════════════════════════════════════════
// GOOGLE PLAY BILLING
//
// Stripe zostaje dla terminala webowego. Aplikacja z Google Play
// MUSI rozliczac sie przez Play Billing — sprzedaz tresci cyfrowych
// z linkiem na zewnatrz lamie Payments policy i konczy sie odrzuceniem.
//
// Zrodlem prawdy pozostaje profiles.plan, dokladnie jak przy Stripe.
// ══════════════════════════════════════════════════════════════

const PLAY_PACKAGE = process.env.PLAY_PACKAGE_NAME || 'com.aurimiq';

// productId w Play Console  →  nazwa planu w profiles.plan
const PLAY_PRODUCTS = {
  'aurimiq_lite': 'lite',
  'aurimiq_pro': 'pro',
};

// Stany, w ktorych subskrypcja daje dostep. Grace period celowo liczy sie
// jako aktywny — uzytkownikowi odmowila karta, ale Google wciaz probuje
// pobrac oplate i odcinanie go w tym momencie to najprostsza droga do
// jednogwiazdkowej recenzji.
const PLAY_ACTIVE_STATES = new Set([
  'SUBSCRIPTION_STATE_ACTIVE',
  'SUBSCRIPTION_STATE_IN_GRACE_PERIOD',
  // CANCELED znaczy "wylaczyl odnawianie", a NIE "stracil dostep".
  // Dokumentacja Google: "Subscription is canceled but not expired yet (...)
  // The user might still have access (...) Use lineItems.expiry_time".
  // Bez tego stanu uzytkownik, ktory rezygnuje w polowie oplaconego miesiaca,
  // tracil dostep natychmiast — czyli okres, za ktory juz zaplacil.
  // Koniec dostepu wyznacza expiryTime nizej oraz powiadomienie EXPIRED.
  'SUBSCRIPTION_STATE_CANCELED',
]);

let playClientCache = null;
function getPlayClient() {
  if (playClientCache) return playClientCache;
  const raw = process.env.GOOGLE_PLAY_SERVICE_ACCOUNT;
  if (!raw) return null;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: JSON.parse(raw),
      scopes: ['https://www.googleapis.com/auth/androidpublisher'],
    });
    playClientCache = google.androidpublisher({ version: 'v3', auth });
    return playClientCache;
  } catch (e) {
    console.error('PLAY: zly GOOGLE_PLAY_SERVICE_ACCOUNT:', e.message);
    return null;
  }
}

// Pyta Google o stan subskrypcji. Nigdy nie ufamy temu, co przyslala apka —
// purchaseToken z klienta jest tylko wskaznikiem, prawde mowi androidpublisher.
async function fetchPlaySubscription(purchaseToken) {
  const client = getPlayClient();
  if (!client) throw new Error('Play service account not configured');
  const { data } = await client.purchases.subscriptionsv2.get({
    packageName: PLAY_PACKAGE,
    token: purchaseToken,
  });
  return data;
}

function planFromPlaySubscription(sub) {
  if (!sub || !PLAY_ACTIVE_STATES.has(sub.subscriptionState)) return 'free';
  // Przy zmianie planu (upgrade lite→pro) Google dopisuje nowy lineItem
  // na koniec listy, wiec bierzemy ostatni.
  const items = sub.lineItems || [];
  const item = items[items.length - 1];
  // Data wygasniecia rozstrzyga przypadek CANCELED: dostep trwa do niej,
  // a nie do momentu klikniecia "anuluj".
  const exp = item?.expiryTime ? Date.parse(item.expiryTime) : NaN;
  if (Number.isFinite(exp) && exp <= Date.now()) return 'free';
  return PLAY_PRODUCTS[item?.productId] || 'free';
}

// Brak potwierdzenia w ciagu 3 dni = Google automatycznie zwraca pieniadze.
// Klient tez to robi przez finishTransaction, ale jesli apka zginie miedzy
// zakupem a potwierdzeniem, uzytkownik traci plan bez powodu.
async function acknowledgePlayPurchase(productId, purchaseToken) {
  const client = getPlayClient();
  if (!client) return;
  try {
    await client.purchases.subscriptions.acknowledge({
      packageName: PLAY_PACKAGE,
      subscriptionId: productId,
      token: purchaseToken,
      requestBody: {},
    });
  } catch (e) {
    // 400 "already acknowledged" jest normalny — klient zdazyl pierwszy.
    if (!String(e.message).includes('already been acknowledged')) {
      console.error('PLAY acknowledge error:', e.message);
    }
  }
}

async function applyPlayPurchase(userId, purchaseToken) {
  const sub = await fetchPlaySubscription(purchaseToken);
  const plan = planFromPlaySubscription(sub);
  const items = sub.lineItems || [];
  const productId = items[items.length - 1]?.productId;

  if (plan !== 'free' && productId) {
    await acknowledgePlayPurchase(productId, purchaseToken);
  }

  await supabase.from('profiles').upsert(
    { id: userId, plan, play_purchase_token: purchaseToken },
    { onConflict: 'id' }
  );

  return { plan, state: sub.subscriptionState, expiryTime: sub.lineItems?.[items.length - 1]?.expiryTime };
}

// ── POST /api/play/verify — wolane przez apke zaraz po zakupie ──
app.post('/api/play/verify', auth, async (req, res) => {
  const { purchaseToken } = req.body || {};
  if (!purchaseToken || typeof purchaseToken !== 'string') {
    return res.status(400).json({ error: 'No purchaseToken' });
  }
  try {
    const result = await applyPlayPurchase(req.user.id, purchaseToken);
    console.log(`PLAY verify: user=${req.user.id} plan=${result.plan} state=${result.state}`);
    res.json(result);
  } catch (e) {
    console.error('PLAY verify error:', e.message);
    res.status(502).json({ error: 'Play verification failed' });
  }
});

// ── POST /api/play/rtdn — Real-time Developer Notifications ────
//
// Pub/Sub push. Bez tego odnowienia, anulowania i zwroty nigdy nie
// dotarlyby do bazy — apka wola /verify tylko raz, w chwili zakupu,
// a subskrypcja zyje miesiacami.
//
// Zawsze odpowiadamy 200: kazdy inny kod kaze Pub/Sub ponawiac
// wiadomosc w kolko, a bledny token nie naprawi sie od powtarzania.
app.post('/api/play/rtdn', async (req, res) => {
  try {
    const encoded = req.body?.message?.data;
    if (!encoded) return res.json({ received: true });

    const payload = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));

    // "Send test notification" z Play Console przysyla testNotification,
    // nie subscriptionNotification. Bez tego logu test wyglada jak cisza,
    // mimo ze caly lancuch Play → Pub/Sub → backend dziala poprawnie.
    if (payload.testNotification) {
      console.log('PLAY rtdn: TEST OK — polaczenie z Play dziala, pakiet=' + payload.packageName);
      return res.json({ received: true });
    }

    const note = payload.subscriptionNotification;
    if (!note?.purchaseToken) {
      console.log('PLAY rtdn: pominieto, brak subscriptionNotification — ' + JSON.stringify(payload).slice(0, 200));
      return res.json({ received: true });
    }

    const { data: profile } = await supabase
      .from('profiles')
      .select('id')
      .eq('play_purchase_token', note.purchaseToken)
      .single();

    if (!profile) {
      console.log('PLAY rtdn: nieznany token, pomijam');
      return res.json({ received: true });
    }

    const result = await applyPlayPurchase(profile.id, note.purchaseToken);
    console.log(`PLAY rtdn: type=${note.notificationType} user=${profile.id} plan=${result.plan}`);
  } catch (e) {
    console.error('PLAY rtdn error:', e.message);
  }
  res.json({ received: true });
});

// ══════════════════════════════════════════════════════════════
// PORTFOLIO TRACKER
// ══════════════════════════════════════════════════════════════

app.get('/api/portfolio', auth, async (req, res) => {
  const { data, error } = await supabase
    .from('portfolio')
    .select('*')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false });

  if (error) return res.status(500).json({ error: 'DB error' });

  const enriched = await Promise.all((data || []).map(async (pos) => {
    let currentPrice = null;
    try {
      const binSym = BINANCE_SYMBOLS[pos.symbol.toLowerCase()] || pos.symbol.toUpperCase() + 'USDT';
      const ticker = await getBinanceTicker(binSym);
      currentPrice = ticker?.price || null;
    } catch(e) {}

    const pnl = currentPrice ? (currentPrice - pos.buy_price) * pos.amount : null;
    const pnlPct = currentPrice ? ((currentPrice - pos.buy_price) / pos.buy_price * 100) : null;
    const value = currentPrice ? currentPrice * pos.amount : pos.buy_price * pos.amount;

    return { ...pos, currentPrice, pnl, pnlPct, value };
  }));

  const totalValue = enriched.reduce((s, p) => s + (p.value || 0), 0);
  const totalPnl = enriched.reduce((s, p) => s + (p.pnl || 0), 0);

  res.json({ positions: enriched, totalValue, totalPnl });
});

app.post('/api/portfolio', auth, async (req, res) => {
  const { symbol, name, amount, buy_price, buy_date, notes } = req.body;
  if (!symbol || !amount || !buy_price) return res.status(400).json({ error: 'Missing fields' });

  const { data, error } = await supabase
    .from('portfolio')
    .insert({ user_id: req.user.id, symbol, name: name || symbol, amount, buy_price, buy_date, notes })
    .select().single();

  if (error) return res.status(500).json({ error: 'DB error' });
  res.json({ position: data });
});

app.delete('/api/portfolio/:id', auth, async (req, res) => {
  const { error } = await supabase
    .from('portfolio')
    .delete()
    .eq('id', req.params.id)
    .eq('user_id', req.user.id);

  if (error) return res.status(500).json({ error: 'DB error' });
  res.json({ deleted: true });
});

// ══════════════════════════════════════════════════════════════
// PRICE ALERTS
// ══════════════════════════════════════════════════════════════

app.get('/api/alerts', auth, async (req, res) => {
  const { data } = await supabase
    .from('price_alerts')
    .select('*')
    .eq('user_id', req.user.id)
    .eq('triggered', false)
    .order('created_at', { ascending: false });
  res.json({ alerts: data || [] });
});

app.post('/api/alerts', auth, async (req, res) => {
  const { symbol, target, direction } = req.body;
  if (!symbol || !target || !direction) return res.status(400).json({ error: 'Missing fields' });

  const { data, error } = await supabase
    .from('price_alerts')
    .insert({ user_id: req.user.id, symbol, target, direction })
    .select().single();

  if (error) return res.status(500).json({ error: 'DB error' });
  res.json({ alert: data });
});

app.delete('/api/alerts/:id', auth, async (req, res) => {
  await supabase.from('price_alerts').delete().eq('id', req.params.id).eq('user_id', req.user.id);
  res.json({ deleted: true });
});

async function checkAlerts() {
  try {
    const { data: alerts } = await supabase
      .from('price_alerts')
      .select('*, profiles(plan)')
      .eq('triggered', false)
      .limit(100);

    if (!alerts || !alerts.length) return;

    for (const alert of alerts) {
      const binSym = BINANCE_SYMBOLS[alert.symbol.toLowerCase()] || alert.symbol.toUpperCase() + 'USDT';
      const ticker = await getBinanceTicker(binSym);
      if (!ticker) continue;

      const triggered =
        (alert.direction === 'above' && ticker.price >= alert.target) ||
        (alert.direction === 'below' && ticker.price <= alert.target);

      if (triggered) {
        await supabase.from('price_alerts').update({ triggered: true }).eq('id', alert.id);
        console.log(`Alert triggered: ${alert.symbol} ${alert.direction} ${alert.target} (current: ${ticker.price})`);
      }
    }
  } catch(e) {}
}

setInterval(checkAlerts, 5 * 60 * 1000);

// ══════════════════════════════════════════════════════════════
// NEWS FEED
// ══════════════════════════════════════════════════════════════

// Google News per jezyk. Zapytania musza byc w jezyku docelowym — samo
// przestawienie hl/gl przy angielskiej frazie oddaje dalej anglojezyczne
// wyniki, bo wyszukiwarka dopasowuje sie do tresci zapytania, nie do naglowka.
const NEWS_LOCALES = {
  pl: {
    hl: 'pl', gl: 'PL', ceid: 'PL:pl',
    queries: ['kryptowaluty bitcoin', 'giełda kurs akcji', 'bitcoin cena'],
    fallback: [
      { title: 'Bitcoin — analiza kursu i sytuacja na rynku', url: 'https://www.bankier.pl/kryptowaluty', source: 'Bankier.pl' },
      { title: 'GPW — podsumowanie sesji na warszawskiej giełdzie', url: 'https://www.parkiet.com', source: 'Parkiet' },
      { title: 'Rynki finansowe — przegląd tygodnia', url: 'https://www.money.pl/gielda', source: 'Money.pl' },
    ],
  },
  de: {
    hl: 'de', gl: 'DE', ceid: 'DE:de',
    queries: ['Kryptowährung Bitcoin', 'Börse Aktienkurs', 'Bitcoin Kurs'],
    fallback: [
      { title: 'Bitcoin — Kursanalyse und Marktlage', url: 'https://www.handelsblatt.com/finanzen', source: 'Handelsblatt' },
      { title: 'DAX — Zusammenfassung des Handelstages', url: 'https://www.boerse.de', source: 'boerse.de' },
      { title: 'Finanzmärkte — Wöchentlicher Überblick', url: 'https://www.finanzen.net', source: 'finanzen.net' },
    ],
  },
  en: {
    hl: 'en-US', gl: 'US', ceid: 'US:en',
    queries: ['cryptocurrency bitcoin', 'stock market shares', 'bitcoin price'],
    fallback: [
      { title: 'Bitcoin price analysis — latest market update', url: 'https://coindesk.com', source: 'CoinDesk' },
      { title: 'Ethereum network activity reaches new highs', url: 'https://cointelegraph.com', source: 'CoinTelegraph' },
      { title: 'Crypto market outlook — weekly summary', url: 'https://decrypt.co', source: 'Decrypt' },
    ],
  },
};

async function fetchCryptoNews(lang = 'en') {
  const loc = NEWS_LOCALES[lang] || NEWS_LOCALES.en;
  return cached(`news:${lang}`, 300000, async () => {
    const queries = loc.queries;

    for (const query of queries) {
      try {
        const encoded = encodeURIComponent(query);
        const url = `https://news.google.com/rss/search?q=${encoded}&hl=${loc.hl}&gl=${loc.gl}&ceid=${loc.ceid}`;
        const r = await fetchWithTimeout(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinAI/2.0)' }
        }, 5000);
        if (!r.ok) continue;
        const text = await r.text();

        const items = [];
        const itemRe = /<item>([\s\S]*?)<\/item>/g;
        let m;
        while ((m = itemRe.exec(text)) !== null && items.length < 15) {
          const block = m[1];
          const title = (block.match(/<title>(.*?)<\/title>/) || [])[1];
          const link = (block.match(/<link\/>(.*?)<\/item>/) || block.match(/<link>(.*?)<\/link>/) || [])[1];
          const pubDate = (block.match(/<pubDate>(.*?)<\/pubDate>/) || [])[1];
          const source = (block.match(/<source[^>]*>(.*?)<\/source>/) || [])[1];

          if (title && link) {
            items.push({
              title: title.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'"),
              url: link.trim(),
              source: source || 'Google News',
              category: 'crypto',
              published: pubDate || null,
              summary: '',
            });
          }
        }

        if (items.length >= 5) return items;
      } catch(e) { console.log('Google News error:', e.message); }
    }

    // Gdy Google nie odda nic sensownego, pokazujemy zaslepki w jezyku
    // uzytkownika zamiast anglojezycznych — inaczej Polak przy pustym
    // wyniku dostawal trzy angielskie tytuly i wygladalo to na blad.
    return loc.fallback.map(x => ({
      ...x,
      category: 'crypto',
      published: new Date().toISOString(),
      summary: '',
    }));
  });
}

app.get('/api/news', auth, async (req, res) => {
  try {
    const lang = ['pl', 'en', 'de'].includes(req.query.lang) ? req.query.lang : 'en';
    const news = await fetchCryptoNews(lang);
    res.json({ news, lang, category: req.query.category || 'crypto' });
  } catch(e) {
    res.status(502).json({ error: 'News fetch error' });
  }
});

// ══════════════════════════════════════════════════════════════
// DCF/LBO CALCULATOR
// ══════════════════════════════════════════════════════════════

app.post('/api/calculate/dcf', auth, async (req, res) => {
  const { revenue, ebitda_margin, growth_rate, wacc, years, terminal_growth } = req.body;
  if (!revenue || !ebitda_margin || !wacc) {
    return res.status(400).json({ error: 'Missing: revenue, ebitda_margin, wacc' });
  }

  const r = parseFloat(revenue);
  const margin = parseFloat(ebitda_margin) / 100;
  const g = parseFloat(growth_rate || 5) / 100;
  const w = parseFloat(wacc) / 100;
  const n = parseInt(years || 5);
  const tg = parseFloat(terminal_growth || 2) / 100;

  const projections = [];
  let totalPV = 0;
  let currentRevenue = r;

  for (let i = 1; i <= n; i++) {
    currentRevenue *= (1 + g);
    const ebitda = currentRevenue * margin;
    const fcf = ebitda * 0.7;
    const pv = fcf / Math.pow(1 + w, i);
    totalPV += pv;
    projections.push({
      year: i,
      revenue: Math.round(currentRevenue),
      ebitda: Math.round(ebitda),
      fcf: Math.round(fcf),
      pv: Math.round(pv),
    });
  }

  const lastFCF = projections[n-1].fcf;
  const terminalValue = (lastFCF * (1 + tg)) / (w - tg);
  const terminalPV = terminalValue / Math.pow(1 + w, n);
  const enterpriseValue = totalPV + terminalPV;

  res.json({
    projections,
    terminalValue: Math.round(terminalValue),
    terminalPV: Math.round(terminalPV),
    pvFCF: Math.round(totalPV),
    enterpriseValue: Math.round(enterpriseValue),
    evRevenue: (enterpriseValue / r).toFixed(1),
    evEbitda: (enterpriseValue / (r * margin)).toFixed(1),
    assumptions: { revenue: r, ebitda_margin, growth_rate, wacc, years: n, terminal_growth },
  });
});

app.post('/api/calculate/lbo', auth, async (req, res) => {
  const { ebitda, entry_multiple, debt_pct, exit_multiple, years, interest_rate } = req.body;
  if (!ebitda || !entry_multiple || !exit_multiple) {
    return res.status(400).json({ error: 'Missing: ebitda, entry_multiple, exit_multiple' });
  }

  const e = parseFloat(ebitda);
  const entryEV = e * parseFloat(entry_multiple);
  const debtRatio = parseFloat(debt_pct || 60) / 100;
  const debt = entryEV * debtRatio;
  const equity = entryEV * (1 - debtRatio);
  const ir = parseFloat(interest_rate || 6) / 100;
  const n = parseInt(years || 5);
  const exitEV = e * parseFloat(exit_multiple);

  const annualRepayment = debt * 0.1;
  const remainingDebt = Math.max(0, debt - annualRepayment * n);
  const exitEquity = exitEV - remainingDebt;
  const moic = exitEquity / equity;
  const irr = (Math.pow(moic, 1/n) - 1) * 100;

  res.json({
    entryEV: Math.round(entryEV),
    debt: Math.round(debt),
    equity: Math.round(equity),
    exitEV: Math.round(exitEV),
    remainingDebt: Math.round(remainingDebt),
    exitEquity: Math.round(exitEquity),
    moic: moic.toFixed(2),
    irr: irr.toFixed(1),
    years: n,
    assumptions: { ebitda: e, entry_multiple, exit_multiple, debt_pct, interest_rate },
  });
});

// ── Health + keep-alive ───────────────────────────────────────
// ══════════════════════════════════════════════════════════════
// WIDERRUF — § 356a BGB
//
// Od 19.06.2026 kazdy, kto zawiera z niemieckim konsumentem umowe przez
// interfejs online, musi udostepnic elektroniczna funkcje odstapienia:
// stale dostepna, wyroznione miejsce, latwo osiagalna. Przepis obejmuje
// zakupy w aplikacjach i sprzedaz przez platformy, i wprost stanowi, ze
// nieistotne jest, czy umowa idzie przez wlasna strone, czy przez platforme
// zewnetrzna — przedsiebiorca ma zapewnic, ze konsument moze z funkcji
// skorzystac. W odroznieniu od Kundigungsbutton (§ 312k) NIE MA tu wyjatku
// dla uslug finansowych.
//
// Celowo BEZ auth: konsument musi moc odstapic takze wtedy, gdy nie potrafi
// sie zalogowac. To jest sens tego przepisu.
// ══════════════════════════════════════════════════════════════

const widerrufSeen = new Map();
function widerrufThrottled(ip) {
  const now = Date.now();
  for (const [k, t] of widerrufSeen) if (now - t > 3600000) widerrufSeen.delete(k);
  const last = widerrufSeen.get(ip);
  if (last && now - last < 20000) return true;
  widerrufSeen.set(ip, now);
  return false;
}

app.post('/api/widerruf', async (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || 'unknown';
  if (widerrufThrottled(ip)) {
    return res.status(429).json({ error: 'Bitte warten Sie einen Moment und versuchen Sie es erneut.' });
  }

  const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  const name     = str(req.body?.name, 200);
  const email    = str(req.body?.email, 200);
  const contract = str(req.body?.contract, 300);
  const contact  = str(req.body?.contact, 200);
  const note     = str(req.body?.note, 2000);

  if (!name || !email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return res.status(400).json({ error: 'Name und eine gültige E-Mail-Adresse sind erforderlich.' });
  }

  // Numer referencyjny czytelny dla czlowieka — konsument dostaje go od razu
  // na ekranie, wiec ma dowod zlozenia oswiadczenia nawet gdyby mail nie doszedl.
  const now = new Date();
  const ref = 'WR-' + now.toISOString().slice(0, 10).replace(/-/g, '') + '-' +
              Math.abs([...(email + name + now.toISOString())].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7))
                .toString(36).toUpperCase().slice(0, 6);

  try {
    await supabase.from('widerruf').insert({
      ref, name, email, contract, contact, note,
      received_at: now.toISOString(),
      ip,
    });
  } catch (e) {
    // Blad bazy NIE moze uniewaznic oswiadczenia konsumenta — jest ono
    // skuteczne z chwila zlozenia. Logujemy i potwierdzamy mimo wszystko.
    console.error('WIDERRUF: zapis do bazy nieudany:', e.message);
  }

  console.log(`WIDERRUF ${ref} | ${name} <${email}> | ${contract || 'brak wskazania umowy'}`);

  res.json({
    ok: true,
    ref,
    receivedAt: now.toISOString(),
    message: 'Ihr Widerruf ist bei uns eingegangen. Sie erhalten die Bestätigung per E-Mail.',
  });
});

app.get('/health', (_, res) => res.json({ status: 'ok', v: 2, source: 'binance' }));

const SELF = process.env.RENDER_EXTERNAL_URL || 'https://aplikacja-yrql.onrender.com';
setInterval(() => fetch(SELF + '/health').catch(() => {}), 14 * 60 * 1000);

// ── Podgrzewanie rdzenia rynku ────────────────────────────────
//
// BTC, ETH i Fear&Greed idą do promptu przy KAŻDYM zapytaniu do Claude.
// Przy chybieniu cache uzytkownik czekal na pelne okrazenie do Binance,
// zanim cokolwiek poszlo do modelu. Odswiezamy je w tle co 12 s (TTL tickera
// to 15 s), wiec buildContext praktycznie zawsze czyta z pamieci.
async function warmMarketCore() {
  await Promise.allSettled([
    getBinanceTicker('BTCUSDT'),
    getBinanceTicker('ETHUSDT'),
    getFearGreed(),
  ]);
}
warmMarketCore().catch(() => {});
setInterval(() => warmMarketCore().catch(() => {}), 12000);

// ── Podgrzewanie surowcow i kursow NBP ────────────────────────
//
// Rdzen rynku byl podgrzewany, surowce nie — a to wlasnie one chodza przez
// Stooqa z timeoutem 4-6 s. Przy zimnym cache pytanie o srebro wypadalo
// z budzetu czasowego buildContext i model dostawal kontekst BEZ ceny srebra,
// mimo ze zakladka SUROWCE pokazywala ja poprawnie.
//
// Cykl 5 min, nie 12 s: surowce nie sa notowane w trybie ciaglym jak krypto,
// a Stooq limituje liczbe zapytan z jednego IP (Render ma IP wspoldzielone).
const WARM_COMMODITIES = ['XAUUSD', 'XAGUSD', 'USOIL', 'COPPER'];
async function warmSlowSources() {
  await Promise.allSettled([
    ...WARM_COMMODITIES.map(k => getCommodityQuote(k)),
    getNbpRates(),
  ]);
}
warmSlowSources().catch(() => {});
setInterval(() => warmSlowSources().catch(() => {}), 300000);

app.listen(PORT, () => console.log(`AURIMIQ.ai on port ${PORT}`));
