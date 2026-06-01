// FinAI v2 — Backend
// Stack: Express + Groq (Llama) + Binance + Supabase + Stripe
// Deploy: Render.com

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

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
const FREE_LIMIT = 5;

async function checkPlan(req, res, next) {
  const { data } = await supabase
    .from('profiles')
    .select('plan, queries_today, last_query_date')
    .eq('id', req.user.id)
    .single();

  const today = new Date().toISOString().slice(0, 10);
  const queries = data?.last_query_date?.slice(0, 10) === today ? (data.queries_today || 0) : 0;
  req.plan = data?.plan || 'free';
  req.queries = queries;

  if (req.plan === 'free' && queries >= FREE_LIMIT) {
    return res.status(403).json({ error: 'Daily limit reached', upgrade: true, plan: 'free' });
  }
  next();
}

async function incQueries(userId) {
  const today = new Date().toISOString().slice(0, 10);
  try { await supabase.rpc('increment_queries', { user_id: userId, today }); } catch(e) {}
}

// ══════════════════════════════════════════════════════════════
// MARKET DATA — Binance (szybkie, bez limitu)
// ══════════════════════════════════════════════════════════════

// Cache 60 sekund
const cache = new Map();
function cached(key, ttl, fn) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < ttl) return Promise.resolve(hit.data);
  return fn().then(data => { cache.set(key, { data, ts: now }); return data; });
}

// Binance ticker — cena + zmiana 24h
async function getBinanceTicker(symbol) {
  return cached(`ticker:${symbol}`, 30000, async () => {
    const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
    if (!r.ok) return null;
    const d = await r.json();
    return {
      price: parseFloat(d.lastPrice),
      change24h: parseFloat(d.priceChangePercent),
      volume24h: parseFloat(d.quoteVolume),
      high24h: parseFloat(d.highPrice),
      low24h: parseFloat(d.lowPrice),
    };
  });
}

// Binance klines — dane do wykresu
async function getBinanceChart(symbol, interval, limit) {
  return cached(`chart:${symbol}:${interval}:${limit}`, 60000, async () => {
    const r = await fetch(
      `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`
    );
    if (!r.ok) return null;
    const d = await r.json();
    return d.map(k => ({
      t: k[0],           // timestamp
      o: parseFloat(k[1]), // open
      h: parseFloat(k[2]), // high
      l: parseFloat(k[3]), // low
      c: parseFloat(k[4]), // close
      v: parseFloat(k[5]), // volume
    }));
  });
}

// Fear & Greed
async function getFearGreed() {
  return cached('fear_greed', 300000, async () => {
    const r = await fetch('https://api.alternative.me/fng/?limit=1');
    const d = await r.json();
    return d.data[0];
  });
}

// Alpha Vantage — akcje
const AV_KEY = process.env.ALPHA_VANTAGE_KEY || 'OIZANHH0509LUD9H';
async function getStockData(symbol) {
  return cached(`stock:${symbol}`, 300000, async () => {
    const r = await fetch(
      `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${AV_KEY}`
    );
    const d = await r.json();
    const q = d['Global Quote'];
    if (!q || !q['05. price']) return null;
    return {
      price: parseFloat(q['05. price']),
      change24h: parseFloat(q['10. change percent']),
      volume24h: parseFloat(q['06. volume']),
    };
  });
}

// Mapa symboli Binance
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
async function buildContext(message) {
  const msg = message.toLowerCase();
  const parts = [`TIME: ${new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}`];
  const promises = [];

  // Krypto przez Binance
  const cryptoKeywords = {
    'bitcoin|btc': 'BTCUSDT',
    'ethereum|eth': 'ETHUSDT',
    'solana|sol': 'SOLUSDT',
    'xrp|ripple': 'XRPUSDT',
    'bnb|binance coin': 'BNBUSDT',
    'cardano|ada': 'ADAUSDT',
    'dogecoin|doge': 'DOGEUSDT',
    'avax|avalanche': 'AVAXUSDT',
  };

  for (const [keys, binSym] of Object.entries(cryptoKeywords)) {
    if (keys.split('|').some(k => msg.includes(k))) {
      promises.push(
        getBinanceTicker(binSym).then(d => d &&
          parts.push(`${binSym}: $${d.price.toLocaleString()} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}% | Vol: $${(d.volume24h/1e6).toFixed(0)}M | H: $${d.high24h.toLocaleString()} | L: $${d.low24h.toLocaleString()} [Binance]`)
        )
      );
    }
  }

  // Fear & Greed dla krypto
  if (Object.keys(cryptoKeywords).some(k => k.split('|').some(w => msg.includes(w))) ||
      msg.includes('krypto') || msg.includes('crypto') || msg.includes('sentyment')) {
    promises.push(
      getFearGreed().then(d => d &&
        parts.push(`Fear & Greed Index: ${d.value}/100 (${d.value_classification})`)
      )
    );
  }

  // Akcje
  const stockKeywords = {
    'apple|aapl': 'AAPL', 'tesla|tsla': 'TSLA',
    'microsoft|msft': 'MSFT', 'nvidia|nvda': 'NVDA',
    'google|googl': 'GOOGL', 'amazon|amzn': 'AMZN',
    'meta': 'META', 'netflix|nflx': 'NFLX',
    'xtb': 'XTB.WA', 'orlen|pkn': 'PKN.WA',
    'kghm': 'KGH.WA', 'cd projekt|cdpr': 'CDR.WA',
  };

  for (const [keys, sym] of Object.entries(stockKeywords)) {
    if (keys.split('|').some(k => msg.includes(k))) {
      promises.push(
        getStockData(sym).then(d => d &&
          parts.push(`${sym}: $${d.price.toFixed(2)} | 24h: ${d.change24h.toFixed(2)}% [Alpha Vantage]`)
        )
      );
    }
  }

  await Promise.all(promises);
  return parts.length > 1 ? parts.join('\n') : null;
}

// ── System prompt ─────────────────────────────────────────────
const SYSTEM = `Jesteś eksperckim asystentem analiz finansowych z dostępem do danych rynkowych na żywo.

ZASADY:
1. Gdy masz dane rynkowe w kontekście — UŻYWAJ ICH jako podstawy analizy
2. Dla kryptowalut: ANALIZA TECHNICZNA (wsparcia, opory, RSI, trend) + FUNDAMENTALNA + ON-CHAIN
3. Podawaj KONKRETNE poziomy cenowe: "wsparcie $X, opór $Y, cel $Z"
4. Bądź konkretny i odważny w prognozach
5. Krótkie zastrzeżenie na końcu

Specjalizacje: DCF, LBO, Equity Research, IB, PE, KYC, M&A, krypto, akcje, forex.
Odpowiadaj po polsku.`;

// ── POST /api/chat ────────────────────────────────────────────
app.post('/api/chat', auth, checkPlan, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || !messages.length) return res.status(400).json({ error: 'No messages' });

  const safe = messages
    .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content.slice(0, 3000) }));

  const lastMsg = safe.filter(m => m.role === 'user').pop()?.content || '';
  const context = await buildContext(lastMsg);
  const systemPrompt = context
    ? `${SYSTEM}\n\n=== DANE RYNKOWE (na żywo) ===\n${context}\n===========================`
    : SYSTEM;

  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        temperature: 0.7,
        messages: [{ role: 'system', content: systemPrompt }, ...safe],
      })
    });

    const data = await r.json();
    if (data.error) return res.status(502).json({ error: data.error.message });

    const reply = data.choices[0].message.content;

    // Save to DB
    try {
      await supabase.from('chat_history').insert({
        user_id: req.user.id,
        user_message: lastMsg,
        ai_reply: reply,
        model: 'llama-3.3-70b-versatile',
      });
      await incQueries(req.user.id);
    } catch(e) {}

    const remaining = req.plan === 'pro' ? 999 : FREE_LIMIT - req.queries - 1;
    res.json({ reply, plan: req.plan, remaining });

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
      // Konwertuj symbol na Binance format
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
      // Akcje przez Alpha Vantage
      const size = limit <= 90 ? 'compact' : 'full';
      const r = await fetch(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${sym.toUpperCase()}&outputsize=${size}&apikey=${AV_KEY}`
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
        symbol: sym.toUpperCase(),
        type: 'stock',
        interval,
        klines,
        meta: { price: last.c, change24h: change, volume24h: last.v }
      });
    }

  } catch(e) {
    res.status(502).json({ error: 'Chart error: ' + e.message });
  }
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
  const { data } = await supabase.from('profiles').select('plan, queries_today, last_query_date').eq('id', req.user.id).single();
  const today = new Date().toISOString().slice(0, 10);
  const queries = data?.last_query_date?.slice(0, 10) === today ? (data.queries_today || 0) : 0;
  const plan = data?.plan || 'free';
  res.json({ plan, queries_today: queries, limit: plan === 'pro' ? 999 : FREE_LIMIT, remaining: plan === 'pro' ? 999 : Math.max(0, FREE_LIMIT - queries) });
});

// ── GET /api/history ──────────────────────────────────────────
app.get('/api/history', auth, async (req, res) => {
  const { data, error } = await supabase.from('chat_history').select('id, user_message, ai_reply, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: 'DB error' });
  res.json({ history: data || [] });
});

// ── Stripe checkout ───────────────────────────────────────────
app.post('/api/create-checkout', auth, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'blik', 'p24'],
      mode: 'subscription',
      line_items: [{ price_data: { currency: 'pln', product_data: { name: 'FinAI Pro' }, unit_amount: 4900, recurring: { interval: 'month' } }, quantity: 1 }],
      customer_email: req.user.email,
      client_reference_id: req.user.id,
      success_url: (process.env.FRONTEND_URL || 'https://finansowa-aplikacja.netlify.app') + '?upgraded=true',
      cancel_url: (process.env.FRONTEND_URL || 'https://finansowa-aplikacja.netlify.app') + '?cancelled=true',
      metadata: { user_id: req.user.id }
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
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
    if (uid) await supabase.from('profiles').upsert({ id: uid, plan: 'pro', stripe_customer_id: s.customer }, { onConflict: 'id' });
  }
  if (event.type === 'customer.subscription.deleted') {
    const { data } = await supabase.from('profiles').select('id').eq('stripe_customer_id', event.data.object.customer).single();
    if (data) await supabase.from('profiles').update({ plan: 'free' }).eq('id', data.id);
  }
  res.json({ received: true });
});

// ── Health + keep-alive ───────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', v: 2, source: 'binance' }));

const SELF = process.env.RENDER_EXTERNAL_URL || 'https://aplikacja-yrql.onrender.com';
setInterval(() => fetch(SELF + '/health').catch(() => {}), 14 * 60 * 1000);

app.listen(PORT, () => console.log(`FinAI v2 on port ${PORT}`));
