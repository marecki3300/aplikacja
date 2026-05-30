// FinAI Backend v3 — DeepSeek R1 + RAG + Live Data
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const AV_KEY = process.env.ALPHA_VANTAGE_KEY || 'OIZANHH0509LUD9H';

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'] }));
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '50kb' }));
const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Za dużo zapytań.' } });

// ── AUTH ────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Brak tokenu' });
  try {
    const parts = token.split('.');
    const padding = parts[1].length % 4;
    const padded = padding ? parts[1] + '='.repeat(4 - padding) : parts[1];
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return res.status(401).json({ error: 'Token wygasł' });
    if (!payload.sub) return res.status(401).json({ error: 'Nieprawidłowy token' });
    req.user = { id: payload.sub, email: payload.email || '' };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Błąd tokenu: ' + err.message });
  }
}

// ── PLAN CHECK ──────────────────────────────────────────────
const FREE_LIMIT = 5;

async function checkPlan(req, res, next) {
  const { data: profile } = await supabase.from('profiles').select('plan, queries_today, last_query_date').eq('id', req.user.id).single();
  const today = new Date().toISOString().slice(0, 10);
  let queries = profile?.last_query_date?.slice(0, 10) === today ? (profile.queries_today || 0) : 0;
  req.userPlan = profile?.plan || 'free';
  req.queriesToday = queries;
  if (req.userPlan === 'free' && queries >= FREE_LIMIT) {
    return res.status(403).json({ error: 'Przekroczono limit 5 zapytań/dzień.', upgrade: true, plan: 'free' });
  }
  next();
}

async function incrementCount(userId) {
  const today = new Date().toISOString().slice(0, 10);
  try { await supabase.rpc('increment_queries', { user_id: userId, today }); } catch(e) {}
}

// ══════════════════════════════════════════════════════════════
// RAG — POBIERANIE DANYCH NA ŻYWO
// ══════════════════════════════════════════════════════════════

// 1. Kryptowaluty — CoinGecko
async function fetchCrypto(coins) {
  try {
    const ids = coins.join(',');
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd,pln&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`);
    const d = await r.json();
    return Object.entries(d).map(([id, data]) => {
      const change = data.usd_24h_change?.toFixed(2) || '?';
      const sign = parseFloat(change) >= 0 ? '+' : '';
      return `${id.toUpperCase()}: $${data.usd?.toLocaleString()} (${sign}${change}% 24h) | MCap: $${(data.usd_market_cap/1e9).toFixed(1)}B | Vol24h: $${(data.usd_24h_vol/1e6).toFixed(0)}M`;
    }).join('\n');
  } catch(e) { return null; }
}

// 2. Metale szlachetne — metals.live
async function fetchMetals() {
  try {
    const r = await fetch('https://metals.live/api/v1/spot');
    const d = await r.json();
    const metals = Array.isArray(d) ? d : [];
    return metals.slice(0, 4).map(m => `${m.name || m.symbol}: $${parseFloat(m.price || m.ask || 0).toFixed(2)}/oz`).join(' | ');
  } catch(e) { return null; }
}

// 3. Akcje — Alpha Vantage
async function fetchStock(symbol) {
  try {
    const r = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${AV_KEY}`);
    const d = await r.json();
    const q = d['Global Quote'];
    if (!q || !q['05. price']) return null;
    const price = parseFloat(q['05. price']).toFixed(2);
    const change = parseFloat(q['09. change']).toFixed(2);
    const pct = q['10. change percent']?.replace('%','').trim();
    const sign = parseFloat(change) >= 0 ? '+' : '';
    return `${symbol}: $${price} (${sign}${change}, ${sign}${parseFloat(pct).toFixed(2)}%) | Vol: ${parseInt(q['06. volume']).toLocaleString()}`;
  } catch(e) { return null; }
}

// 4. Fear & Greed Index
async function fetchFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=3');
    const d = await r.json();
    return d.data.map(fg => `${fg.timestamp ? new Date(fg.timestamp*1000).toLocaleDateString('pl-PL') : 'dziś'}: ${fg.value}/100 (${fg.value_classification})`).join(', ');
  } catch(e) { return null; }
}

// 5. Forex — exchangerate.host
async function fetchForex(pairs) {
  try {
    const r = await fetch(`https://api.exchangerate.host/latest?base=USD&symbols=${pairs.join(',')}`);
    const d = await r.json();
    if (!d.rates) return null;
    return pairs.map(p => `USD/${p}: ${d.rates[p]?.toFixed(4)}`).join(' | ');
  } catch(e) { return null; }
}

// ── GŁÓWNA FUNKCJA RAG ──────────────────────────────────────
// Analizuje pytanie i zbiera tylko potrzebne dane
async function buildContext(userMessage) {
  const msg = userMessage.toLowerCase();
  const parts = [];
  const timestamp = new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' });
  parts.push(`AKTUALNA DATA I CZAS: ${timestamp}`);

  const promises = [];

  // Kryptowaluty
  const cryptoMap = {
    'bitcoin|btc': 'bitcoin', 'ethereum|eth': 'ethereum',
    'solana|sol': 'solana', 'bnb|binance': 'binancecoin',
    'xrp|ripple': 'ripple', 'cardano|ada': 'cardano',
    'dogecoin|doge': 'dogecoin', 'polkadot|dot': 'polkadot',
    'avalanche|avax': 'avalanche-2', 'chainlink|link': 'chainlink',
  };

  const coinsToFetch = [];
  for (const [keywords, coinId] of Object.entries(cryptoMap)) {
    if (keywords.split('|').some(k => msg.includes(k))) coinsToFetch.push(coinId);
  }

  // Jeśli pytanie ogólne o krypto — pobierz top 5
  if (msg.includes('krypto') || msg.includes('crypto') || msg.includes('rynek') || coinsToFetch.length === 0 && (msg.includes('analiz') || msg.includes('cen'))) {
    if (coinsToFetch.length === 0) coinsToFetch.push('bitcoin', 'ethereum', 'solana', 'binancecoin', 'ripple');
  }

  if (coinsToFetch.length > 0) {
    promises.push(fetchCrypto(coinsToFetch).then(d => d && parts.push('KRYPTOWALUTY (na żywo):\n' + d)));
  }

  // Fear & Greed — zawsze dla krypto
  if (coinsToFetch.length > 0 || msg.includes('sentyment') || msg.includes('fear') || msg.includes('strach')) {
    promises.push(fetchFearGreed().then(d => d && parts.push('FEAR & GREED INDEX (ostatnie 3 dni): ' + d)));
  }

  // Metale
  if (['zloto', 'złoto', 'gold', 'srebro', 'silver', 'platyna', 'metal', 'surowiec'].some(k => msg.includes(k))) {
    promises.push(fetchMetals().then(d => d && parts.push('METALE SZLACHETNE (na żywo): ' + d)));
  }

  // Akcje polskie i zagraniczne
  const stockMap = {
    'apple|aapl': 'AAPL', 'tesla|tsla': 'TSLA', 'microsoft|msft': 'MSFT',
    'nvidia|nvda': 'NVDA', 'google|googl|alphabet': 'GOOGL', 'amazon|amzn': 'AMZN',
    'meta': 'META', 'netflix|nflx': 'NFLX', 'xtb': 'XTB.WA',
    'orlen|pkn': 'PKN.WA', 'kghm|kgh': 'KGH.WA', 'pko': 'PKO.WA',
    'cd projekt|cdpr|cdr': 'CDR.WA', 'allegro|ale': 'ALE.WA', 'lpp': 'LPP.WA',
  };

  for (const [keywords, symbol] of Object.entries(stockMap)) {
    if (keywords.split('|').some(k => msg.includes(k))) {
      promises.push(fetchStock(symbol).then(d => d && parts.push(`AKCJE ${symbol} (na żywo): ${d}`)));
    }
  }

  // Forex
  if (['dolar', 'euro', 'frank', 'funt', 'forex', 'walut', 'kurs usd', 'kurs eur', 'pln'].some(k => msg.includes(k))) {
    promises.push(fetchForex(['PLN', 'EUR', 'GBP', 'CHF', 'JPY']).then(d => d && parts.push('FOREX USD (na żywo): ' + d)));
  }

  await Promise.all(promises);

  return parts.length > 1 ? parts.join('\n\n') : null;
}

// ══════════════════════════════════════════════════════════════
// SYSTEM PROMPT
// ══════════════════════════════════════════════════════════════
const BASE_SYSTEM = `Jesteś eksperckim asystentem analiz finansowych. Zawsze dajesz KONKRETNE odpowiedzi z liczbami.

ZASADY:
1. Gdy otrzymujesz dane rynkowe w kontekście — UŻYWAJ ICH jako podstawy analizy
2. Dla kryptowalut analizuj z 3 perspektyw: TECHNICZNA, FUNDAMENTALNA, ON-CHAIN
3. Podawaj konkretne poziomy: "wsparcie $X, opór $Y, cel $Z"
4. Bądź odważny w prognozach — to analiza, nie gwarancja
5. Używaj danych historycznych + aktualne dane z kontekstu
6. Na końcu jedno zdanie zastrzeżenia

Specjalizujesz się w: DCF, LBO, Equity Research, IB, Private Equity, KYC, M&A, kryptowaluty, akcje, forex, surowce.
Odpowiadaj po polsku. Przy obliczeniach pokazuj wzory.`;

// ── POST /api/chat ───────────────────────────────────────────
app.post('/api/chat', requireAuth, checkPlan, aiLimiter, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'Brak wiadomości' });

  const safe = messages
    .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-10)
    .map(m => ({ role: m.role, content: m.content.slice(0, 3000) }));

  const lastUserMsg = safe.filter(m => m.role === 'user').pop()?.content || '';

  try {
    // RAG — pobierz dane na żywo równolegle z budowaniem odpowiedzi
    const contextData = await buildContext(lastUserMsg);

    // Zbuduj system prompt z danymi
    const systemPrompt = contextData
      ? BASE_SYSTEM + '\n\n═══ AKTUALNE DANE RYNKOWE (pobrane na żywo) ═══\n' + contextData + '\n═══════════════════════════════════════════════\nUżyj powyższych danych jako podstawy swojej analizy.'
      : BASE_SYSTEM;

    console.log('Context data:', contextData ? contextData.slice(0, 200) : 'none');

    // Wywołaj DeepSeek R1 na Groq
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 2000,
        messages: [{ role: 'system', content: systemPrompt }, ...safe],
        temperature: 0.6,
      })
    });

    const groqData = await groqRes.json();
    if (groqData.error) return res.status(502).json({ error: groqData.error.message });

    let reply = groqData.choices[0].message.content;

    // Usuń bloki <think>...</think> z DeepSeek R1 (wewnętrzne rozumowanie)
    reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Zapisz historię
    try {
      await supabase.from('chat_history').insert({
        user_id: req.user.id,
        user_message: lastUserMsg,
        ai_reply: reply,
        model: 'llama-3.3-70b-versatile',
      });
      await incrementCount(req.user.id);
    } catch(e) { console.error('DB:', e.message); }

    const remaining = req.userPlan === 'pro' ? 999 : FREE_LIMIT - req.queriesToday - 1;
    res.json({ reply, plan: req.userPlan, remaining });

  } catch (err) {
    res.status(502).json({ error: 'Błąd AI: ' + err.message });
  }
});

// ── Stripe checkout ──────────────────────────────────────────
app.post('/api/create-checkout', requireAuth, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'blik', 'p24'],
      mode: 'subscription',
      line_items: [{ price_data: { currency: 'pln', product_data: { name: 'FinAI Pro', description: 'Nielimitowane analizy finansowe AI' }, unit_amount: 4900, recurring: { interval: 'month' } }, quantity: 1 }],
      customer_email: req.user.email,
      client_reference_id: req.user.id,
      success_url: process.env.FRONTEND_URL + '?upgraded=true',
      cancel_url: process.env.FRONTEND_URL + '?cancelled=true',
      metadata: { user_id: req.user.id }
    });
    res.json({ url: session.url });
  } catch(err) { res.status(500).json({ error: 'Błąd Stripe: ' + err.message }); }
});

// ── Stripe Webhook ───────────────────────────────────────────
app.post('/api/webhook', async (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
  } catch(err) { return res.status(400).json({ error: err.message }); }

  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    const userId = s.metadata?.user_id || s.client_reference_id;
    if (userId) await supabase.from('profiles').upsert({ id: userId, plan: 'pro', stripe_customer_id: s.customer }, { onConflict: 'id' });
  }
  if (event.type === 'customer.subscription.deleted') {
    const s = event.data.object;
    const { data } = await supabase.from('profiles').select('id').eq('stripe_customer_id', s.customer).single();
    if (data) await supabase.from('profiles').update({ plan: 'free' }).eq('id', data.id);
  }
  res.json({ received: true });
});

// ── GET /api/profile ─────────────────────────────────────────
app.get('/api/profile', requireAuth, async (req, res) => {
  const { data } = await supabase.from('profiles').select('plan, queries_today, last_query_date').eq('id', req.user.id).single();
  const today = new Date().toISOString().slice(0, 10);
  const queries = data?.last_query_date?.slice(0, 10) === today ? (data.queries_today || 0) : 0;
  const plan = data?.plan || 'free';
  res.json({ plan, queries_today: queries, limit: plan === 'pro' ? 999 : FREE_LIMIT, remaining: plan === 'pro' ? 999 : Math.max(0, FREE_LIMIT - queries) });
});

app.get('/api/history', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('chat_history').select('id, user_message, ai_reply, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: 'Błąd bazy' });
  res.json({ history: data || [] });
});


// ── GET /api/chart/:symbol ───────────────────────────────────
app.get('/api/chart/:symbol', requireAuth, async (req, res) => {
  const symbol = req.params.symbol.toLowerCase();
  const days   = parseInt(req.query.days) || 30;
  const type   = req.query.type || 'crypto';

  try {
    if (type === 'crypto') {
      const r = await fetch(
        `https://api.coingecko.com/api/v3/coins/${symbol}/market_chart?vs_currency=usd&days=${days}`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'FinAI/1.0' } }
      );
      if (!r.ok) return res.status(404).json({ error: `Nie znaleziono krypto: ${symbol}` });
      const d = await r.json();

      const prices  = (d.prices || []).map(p => ({ t: p[0], v: p[1] }));
      const volumes = (d.total_volumes || []).map(p => ({ t: p[0], v: p[1] }));

      const infoR = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${symbol}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true&include_24hr_vol=true`,
        { headers: { 'Accept': 'application/json', 'User-Agent': 'FinAI/1.0' } }
      );
      const info = await infoR.json();
      const meta = info[symbol] || {};

      return res.json({
        symbol, type: 'crypto', days, prices, volumes,
        meta: {
          price:     meta.usd,
          change24h: meta.usd_24h_change,
          marketCap: meta.usd_market_cap,
          vol24h:    meta.usd_24h_vol,
        }
      });

    } else {
      const size = days <= 90 ? 'compact' : 'full';
      const r = await fetch(
        `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol.toUpperCase()}&outputsize=${size}&apikey=${AV_KEY}`
      );
      const d = await r.json();
      const ts = d['Time Series (Daily)'];
      if (!ts) return res.status(404).json({ error: `Nie znaleziono akcji: ${symbol}` });

      const entries = Object.entries(ts)
        .sort((a, b) => a[0] < b[0] ? -1 : 1)
        .slice(-days);

      const prices  = entries.map(([date, v]) => ({ t: new Date(date).getTime(), v: parseFloat(v['4. close']) }));
      const volumes = entries.map(([date, v]) => ({ t: new Date(date).getTime(), v: parseFloat(v['5. volume']) }));

      const last   = prices[prices.length - 1]?.v;
      const prev   = prices[prices.length - 2]?.v || last;
      const change = prev ? ((last - prev) / prev * 100) : 0;

      return res.json({
        symbol: symbol.toUpperCase(), type: 'stock', days, prices, volumes,
        meta: { price: last, change24h: change, marketCap: null, vol24h: null }
      });
    }

  } catch (err) {
    res.status(502).json({ error: 'Błąd pobierania danych: ' + err.message });
  }
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));
app.get('/health', (_, res) => res.json({ status: 'ok', model: 'llama-3.3-70b-versatile', rag: true }));


// ── Keep-alive — pinguje siebie co 14 minut żeby Render nie zasnął ──────────
const SELF_URL = process.env.RENDER_EXTERNAL_URL || 'https://aplikacja-yrql.onrender.com';
setInterval(async () => {
  try {
    const r = await fetch(SELF_URL + '/health');
    console.log('Keep-alive ping:', r.status);
  } catch(e) {
    console.log('Keep-alive failed:', e.message);
  }
}, 14 * 60 * 1000); // co 14 minut

app.listen(PORT, () => console.log('FinAI v3 (DeepSeek R1 + RAG) na porcie ' + PORT));
