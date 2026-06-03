// AURIMIQ.ai — Backend
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
  return cached(`ticker:${symbol}`, 10000, async () => {
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
  const parts = [`CZAS: ${new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}`];
  const promises = [];

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

  // Zawsze pobierz BTC jeśli jakiekolwiek pytanie o krypto/analizę/cenę
  const isCryptoQuery = Object.keys(cryptoKeywords).some(k => k.split('|').some(w => msg.includes(w)))
    || msg.includes('krypto') || msg.includes('crypto') || msg.includes('analiz')
    || msg.includes('cen') || msg.includes('kurs') || msg.includes('rynek')
    || msg.includes('bitcoin') || msg.includes('btc');

  if (isCryptoQuery) {
    // Zawsze pobierz BTC jako bazowy punkt odniesienia
    promises.push(
      getBinanceTicker('BTCUSDT').then(d => {
        if (d) {
          parts.push(`BITCOIN (BTCUSDT): $${d.price.toLocaleString('en-US', {maximumFractionDigits: 0})} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}% | Vol24h: $${(d.volume24h/1e6).toFixed(0)}M | H: $${d.high24h.toLocaleString()} | L: $${d.low24h.toLocaleString()} [BINANCE LIVE]`);
        } else {
          parts.push('BTCUSDT: błąd pobierania z Binance');
        }
      }).catch(e => parts.push('BTCUSDT: error - ' + e.message))
    );
  }

  // Pobierz dodatkowe monety jeśli pytanie konkretne
  for (const [keys, binSym] of Object.entries(cryptoKeywords)) {
    if (binSym === 'BTCUSDT') continue; // już pobrane
    if (keys.split('|').some(k => msg.includes(k))) {
      promises.push(
        getBinanceTicker(binSym).then(d => {
          if (d) parts.push(`${binSym}: $${d.price.toLocaleString('en-US', {maximumFractionDigits: 4})} | 24h: ${d.change24h >= 0 ? '+' : ''}${d.change24h.toFixed(2)}% [BINANCE LIVE]`);
        }).catch(() => {})
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
const SYSTEM = `Jesteś AURIMIQ.ai AI — eksperckim asystentem analiz finansowych.

‼️ NAJWAŻNIEJSZA ZASADA: W sekcji "DANE BINANCE" znajdziesz AKTUALNE ceny pobrane właśnie teraz z Binance API. MUSISZ używać TYCH cen. Twoje dane treningowe są z 2024 roku i są NIEAKTUALNE. Jeśli Binance mówi BTC = $73,000 — piszesz $73,000. Jeśli mówi $105,000 — piszesz $105,000. Nigdy nie używaj cen z pamięci.

ZASADY ODPOWIEDZI:
1. Cena aktywa = ZAWSZE z sekcji DANE BINANCE, nigdy z pamięci
2. Generuj SYGNAŁ: BUY / SELL / HOLD z uzasadnieniem
3. Podawaj KONKRETNE poziomy bazując na aktualnej cenie z Binance
4. Analiza: TECHNICZNA + FUNDAMENTALNA + SENTYMENT
5. Na końcu: AI Score 1-10

FORMAT dla krypto/akcji:
📊 SYGNAŁ: [BUY/SELL/HOLD]
💰 Aktualna cena: $X (Binance, live)
📈 Cel: $Y | 🛡️ Wsparcie: $Z | ⛔ Stop-loss: $W
🔍 Analiza techniczna: [obserwacje]
📰 Sentyment: [Fear&Greed]
⭐ AI Score: X/10
⚠️ Analiza edukacyjna, nie porada inwestycyjna.

Specjalizacje: DCF, LBO, Equity Research, IB, PE, KYC, M&A.
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
  const now = new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });
  const systemPrompt = context
    ? SYSTEM + '\n\n‼️ DANE Z BINANCE API (pobrane ' + now + ') — UŻYJ TYCH CEN:\n' + context + '\n‼️ POWYŻSZE CENY SĄ AKTUALNE. UŻYJ ICH W ANALIZIE.'
    : SYSTEM + '\n\nUWAGA: Brak danych Binance. Zaznacz że podajesz szacunkowe ceny z wiedzy treningowej (mogą być nieaktualne).'

  try {
    // Claude Sonnet jako główny model, Groq jako fallback
    const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
    let reply = null;

    // 1. Claude Sonnet 4 — najlepszy model analityczny
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
            model: 'claude-sonnet-4-6',
            max_tokens: 2000,
            system: systemPrompt,
            messages: safe.map(m => ({ role: m.role, content: m.content })),
          })
        });

        const claudeData = await claudeRes.json();
        if (claudeData.content?.[0]?.text) {
          reply = claudeData.content[0].text;
          console.log('Model: Claude Sonnet 4.6');
        } else {
          console.log('Claude error:', JSON.stringify(claudeData).slice(0, 200));
        }
      } catch(e) {
        console.log('Claude failed:', e.message);
      }
    }

    // 2. Fallback — Groq Llama
    if (!reply) {
      try {
        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            max_tokens: 2000,
            temperature: 0.7,
            messages: [{ role: 'system', content: systemPrompt }, ...safe],
          })
        });
        const groqData = await groqRes.json();
        if (!groqData.error) {
          reply = groqData.choices[0].message.content;
          console.log('Model: Groq Llama 3.3 (fallback)');
        }
      } catch(e) {}
    }

    if (!reply) return res.status(502).json({ error: 'AI unavailable' });

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

  // Pobierz aktualne ceny dla wszystkich pozycji
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

// Sprawdź alerty co 5 minut
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
// NEWS FEED — CryptoPanic + Yahoo Finance RSS
// ══════════════════════════════════════════════════════════════

async function fetchCryptoNews() {
  return cached('news:crypto', 300000, async () => {

    // Google News RSS — bez klucza, zawsze działa
    const queries = ['cryptocurrency bitcoin', 'crypto ethereum', 'bitcoin price'];

    for (const query of queries) {
      try {
        const encoded = encodeURIComponent(query);
        const url = `https://news.google.com/rss/search?q=${encoded}&hl=en-US&gl=US&ceid=US:en`;
        const r = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FinAI/2.0)' }
        });
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

    // Fallback statyczny
    return [
      { title: 'Bitcoin price analysis — latest market update', url: 'https://coindesk.com', source: 'CoinDesk', category: 'crypto', published: new Date().toISOString(), summary: 'Check coindesk.com for latest news' },
      { title: 'Ethereum network activity reaches new highs', url: 'https://cointelegraph.com', source: 'CoinTelegraph', category: 'crypto', published: new Date().toISOString(), summary: '' },
      { title: 'Crypto market outlook — weekly summary', url: 'https://decrypt.co', source: 'Decrypt', category: 'crypto', published: new Date().toISOString(), summary: '' },
    ];
  });
}


app.get('/api/news', auth, async (req, res) => {
  const category = req.query.category || 'crypto';

  try {
    const news = await fetchCryptoNews();
    res.json({ news, category });
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
    const fcf = ebitda * 0.7; // uproszczone założenie
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

  // Uproszczone spłaty długu
  const annualRepayment = debt * 0.1;
  const remainingDebt = Math.max(0, debt - annualRepayment * n);
  const exitEquity = exitEV - remainingDebt;

  // IRR (uproszczony)
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
app.get('/health', (_, res) => res.json({ status: 'ok', v: 2, source: 'binance' }));

const SELF = process.env.RENDER_EXTERNAL_URL || 'https://aplikacja-yrql.onrender.com';
setInterval(() => fetch(SELF + '/health').catch(() => {}), 14 * 60 * 1000);

app.listen(PORT, () => console.log(`AURIMIQ.ai on port ${PORT}`));
