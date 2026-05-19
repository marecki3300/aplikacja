// FinAI Backend — Node.js + Express + Stripe + Web Search
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';
import Stripe from 'stripe';

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ── Middleware ──────────────────────────────────────────────
app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization', 'stripe-signature'] }));

// Stripe webhook musi mieć raw body
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' }));

const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Za dużo zapytań.' } });

// ── Auth ────────────────────────────────────────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Brak tokenu' });
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return res.status(401).json({ error: 'Nieprawidłowy token' });
    const padding = parts[1].length % 4;
    const padded = padding ? parts[1] + '='.repeat(4 - padding) : parts[1];
    const payload = JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return res.status(401).json({ error: 'Token wygasł — zaloguj się ponownie' });
    if (!payload.sub) return res.status(401).json({ error: 'Nieprawidłowy token' });
    req.user = { id: payload.sub, email: payload.email || '' };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Błąd tokenu: ' + err.message });
  }
}

// ── Plan check — Free: 5 zapytań/dzień, Pro: nielimitowane ──
const FREE_DAILY_LIMIT = 5;

async function checkPlan(req, res, next) {
  const userId = req.user.id;

  // Pobierz profil użytkownika
  const { data: profile } = await supabase
    .from('profiles')
    .select('plan, queries_today, last_query_date')
    .eq('id', userId)
    .single();

  // Jeśli brak profilu — utwórz
  if (!profile) {
    await supabase.from('profiles').insert({ id: userId, plan: 'free', queries_today: 0 });
    req.userPlan = 'free';
    req.queriesToday = 0;
    return next();
  }

  const today = new Date().toISOString().slice(0, 10);
  const lastDate = profile.last_query_date?.slice(0, 10);

  // Reset licznika o północy
  let queriesToday = profile.queries_today || 0;
  if (lastDate !== today) queriesToday = 0;

  req.userPlan = profile.plan || 'free';
  req.queriesToday = queriesToday;

  // Sprawdź limit dla Free
  if (req.userPlan === 'free' && queriesToday >= FREE_DAILY_LIMIT) {
    return res.status(403).json({
      error: 'Przekroczono dzienny limit zapytań (5/dzień).',
      upgrade: true,
      plan: 'free',
      limit: FREE_DAILY_LIMIT
    });
  }

  next();
}

// ── Aktualizuj licznik zapytań ──────────────────────────────
async function incrementQueryCount(userId) {
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from('profiles').upsert({
    id: userId,
    queries_today: supabase.rpc ? undefined : 1,
    last_query_date: today
  }, { onConflict: 'id' });

  // Inkrementuj
  await supabase.rpc('increment_queries', { user_id: userId, today: today });
}

// ── CoinGecko — kursy kryptowalut ──────────────────────────
const CRYPTO_MAP = {
  bitcoin: 'bitcoin', btc: 'bitcoin',
  ethereum: 'ethereum', eth: 'ethereum',
  solana: 'solana', sol: 'solana',
  cardano: 'cardano', ada: 'cardano',
  ripple: 'ripple', xrp: 'ripple',
  dogecoin: 'dogecoin', doge: 'dogecoin',
  bnb: 'binancecoin', binance: 'binancecoin',
};

async function getCryptoPrice(query) {
  const q = query.toLowerCase();
  let coinId = null;
  for (const [key, val] of Object.entries(CRYPTO_MAP)) {
    if (q.includes(key)) { coinId = val; break; }
  }
  if (!coinId) return null;
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd,pln&include_24hr_change=true&include_market_cap=true`);
    const d = await r.json();
    const coin = d[coinId];
    if (!coin) return null;
    const change = coin.usd_24h_change ? coin.usd_24h_change.toFixed(2) : '?';
    const sign = parseFloat(change) >= 0 ? '+' : '';
    return `Aktualna cena ${coinId}: ${coin.usd.toLocaleString()} USD / ${coin.pln?.toLocaleString()} PLN | Zmiana 24h: ${sign}${change}% | Market cap: ${(coin.usd_market_cap / 1e9).toFixed(1)}B USD | Źródło: CoinGecko`;
  } catch(e) { return null; }
}

async function webSearch(query) {
  const crypto = await getCryptoPrice(query);
  if (crypto) return crypto;
  try {
    const r = await fetch('https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1');
    const d = await r.json();
    return d.AbstractText || d.Answer || (d.RelatedTopics?.[0]?.Text) || 'Brak wyników. Odpowiedz na podstawie wiedzy.';
  } catch(e) { return 'Błąd wyszukiwania.'; }
}

// ── AI Chat ─────────────────────────────────────────────────
const SYSTEM_PROMPT = `Jesteś ekspertowym asystentem analiz finansowych z dostępem do aktualnych danych.
Specjalizujesz się w: DCF, LBO, Comparable Company Analysis, Equity Research, Investment Banking, Private Equity, KYC i M&A.
Gdy pytanie dotyczy aktualnych kursów lub cen — użyj web_search.
Odpowiadaj po polsku. Przy obliczeniach pokazuj wzory. Analizy nie stanowią porady inwestycyjnej.`;

const WEB_SEARCH_TOOL = [{ type: 'function', function: { name: 'web_search', description: 'Wyszukaj aktualne informacje finansowe', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } } }];

app.post('/api/chat', requireAuth, checkPlan, aiLimiter, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'Brak wiadomości' });

  const safe = messages
    .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

  try {
    const firstRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1500, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...safe], tools: WEB_SEARCH_TOOL, tool_choice: 'auto' })
    });

    const firstData = await firstRes.json();
    if (firstData.error) return res.status(502).json({ error: firstData.error.message });

    const firstMsg = firstData.choices[0].message;
    let reply = '';

    if (firstMsg.tool_calls?.length > 0) {
      const toolCall = firstMsg.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);
      const searchResult = await webSearch(args.query);

      const secondRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile', max_tokens: 1500,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT }, ...safe,
            { role: 'assistant', content: null, tool_calls: firstMsg.tool_calls },
            { role: 'tool', tool_call_id: toolCall.id, content: searchResult }
          ]
        })
      });

      const secondData = await secondRes.json();
      if (secondData.error) return res.status(502).json({ error: secondData.error.message });
      reply = secondData.choices[0].message.content;
    } else {
      reply = firstMsg.content;
    }

    // Zapisz historię i zwiększ licznik
    try {
      await supabase.from('chat_history').insert({ user_id: req.user.id, user_message: safe[safe.length - 1]?.content, ai_reply: reply, model: 'llama-3.3-70b-versatile' });
      await incrementQueryCount(req.user.id);
    } catch(e) { console.error('DB error:', e.message); }

    // Zwróć odpowiedź + info o planie
    const remaining = req.userPlan === 'pro' ? 999 : FREE_DAILY_LIMIT - req.queriesToday - 1;
    res.json({ reply, plan: req.userPlan, remaining });

  } catch (err) {
    res.status(502).json({ error: 'Błąd AI: ' + err.message });
  }
});

// ── Stripe — utwórz sesję płatności ────────────────────────
app.post('/api/create-checkout', requireAuth, async (req, res) => {
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'blik', 'p24'],
      mode: 'subscription',
      line_items: [{
        price_data: {
          currency: 'pln',
          product_data: { name: 'FinAI Pro', description: 'Nielimitowane analizy finansowe AI' },
          unit_amount: 4900, // 49 zł w groszach
          recurring: { interval: 'month' }
        },
        quantity: 1
      }],
      customer_email: req.user.email,
      client_reference_id: req.user.id,
      success_url: process.env.FRONTEND_URL + '?upgraded=true',
      cancel_url: process.env.FRONTEND_URL + '?cancelled=true',
      metadata: { user_id: req.user.id }
    });
    res.json({ url: session.url });
  } catch(err) {
    res.status(500).json({ error: 'Błąd Stripe: ' + err.message });
  }
});

// ── Stripe Webhook — aktualizuj plan po płatności ──────────
app.post('/api/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(err) {
    return res.status(400).json({ error: 'Webhook error: ' + err.message });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userId = session.metadata.user_id || session.client_reference_id;
    if (userId) {
      await supabase.from('profiles').upsert({ id: userId, plan: 'pro', stripe_customer_id: session.customer }, { onConflict: 'id' });
      console.log('User upgraded to Pro:', userId);
    }
  }

  if (event.type === 'customer.subscription.deleted') {
    const sub = event.data.object;
    const { data } = await supabase.from('profiles').select('id').eq('stripe_customer_id', sub.customer).single();
    if (data) {
      await supabase.from('profiles').update({ plan: 'free' }).eq('id', data.id);
      console.log('User downgraded to Free:', data.id);
    }
  }

  res.json({ received: true });
});

// ── GET /api/profile — plan użytkownika ────────────────────
app.get('/api/profile', requireAuth, async (req, res) => {
  const { data } = await supabase.from('profiles').select('plan, queries_today, last_query_date').eq('id', req.user.id).single();
  const today = new Date().toISOString().slice(0, 10);
  const queriesToday = data?.last_query_date?.slice(0, 10) === today ? (data.queries_today || 0) : 0;
  const plan = data?.plan || 'free';
  res.json({ plan, queries_today: queriesToday, limit: plan === 'pro' ? 999 : FREE_DAILY_LIMIT, remaining: plan === 'pro' ? 999 : Math.max(0, FREE_DAILY_LIMIT - queriesToday) });
});

app.get('/api/history', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('chat_history').select('id, user_message, ai_reply, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: 'Błąd bazy danych' });
  res.json({ history: data || [] });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log('FinAI backend na porcie ' + PORT));
