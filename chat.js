import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const AV_KEY = process.env.ALPHA_VANTAGE_KEY || 'OIZANHH0509LUD9H';
const FREE_LIMIT = 5;

// ── AUTH ────────────────────────────────────────────────────
function decodeToken(token) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Nieprawidłowy token');
  const padding = parts[1].length % 4;
  const padded = padding ? parts[1] + '='.repeat(4 - padding) : parts[1];
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

// ── CRYPTO ──────────────────────────────────────────────────
const CRYPTO_MAP = {
  'bitcoin|btc': 'bitcoin', 'ethereum|eth': 'ethereum',
  'solana|sol': 'solana', 'bnb|binance': 'binancecoin',
  'xrp|ripple': 'ripple', 'cardano|ada': 'cardano',
  'dogecoin|doge': 'dogecoin', 'polkadot|dot': 'polkadot',
};

async function fetchCrypto(coins) {
  try {
    const r = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${coins.join(',')}&vs_currencies=usd,pln&include_24hr_change=true&include_market_cap=true`);
    const d = await r.json();
    return Object.entries(d).map(([id, data]) => {
      const change = data.usd_24h_change?.toFixed(2) || '?';
      const sign = parseFloat(change) >= 0 ? '+' : '';
      return `${id.toUpperCase()}: $${data.usd?.toLocaleString()} (${sign}${change}% 24h) | MCap: $${(data.usd_market_cap/1e9).toFixed(1)}B`;
    }).join('\n');
  } catch(e) { return null; }
}

async function fetchMetals() {
  try {
    const r = await fetch('https://metals.live/api/v1/spot');
    const d = await r.json();
    const metals = Array.isArray(d) ? d : [];
    return metals.slice(0, 4).map(m => `${m.name||m.symbol}: $${parseFloat(m.price||m.ask||0).toFixed(2)}/oz`).join(' | ');
  } catch(e) { return null; }
}

async function fetchStock(symbol) {
  try {
    const r = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${AV_KEY}`);
    const d = await r.json();
    const q = d['Global Quote'];
    if (!q || !q['05. price']) return null;
    const price = parseFloat(q['05. price']).toFixed(2);
    const change = parseFloat(q['09. change']).toFixed(2);
    const pct = parseFloat(q['10. change percent']).toFixed(2);
    const sign = parseFloat(change) >= 0 ? '+' : '';
    return `${symbol}: $${price} (${sign}${change}, ${sign}${pct}%)`;
  } catch(e) { return null; }
}

async function fetchFearGreed() {
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=1');
    const d = await r.json();
    const fg = d.data[0];
    return `Fear & Greed: ${fg.value}/100 (${fg.value_classification})`;
  } catch(e) { return null; }
}

async function buildContext(msg) {
  const q = msg.toLowerCase();
  const parts = [`CZAS: ${new Date().toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' })}`];
  const promises = [];

  const coinsToFetch = [];
  for (const [keys, id] of Object.entries(CRYPTO_MAP)) {
    if (keys.split('|').some(k => q.includes(k))) coinsToFetch.push(id);
  }
  if (q.includes('krypto') || q.includes('crypto')) {
    if (!coinsToFetch.length) coinsToFetch.push('bitcoin', 'ethereum', 'solana');
  }
  if (coinsToFetch.length) {
    promises.push(fetchCrypto(coinsToFetch).then(d => d && parts.push('KRYPTOWALUTY:\n' + d)));
    promises.push(fetchFearGreed().then(d => d && parts.push(d)));
  }

  if (['zloto','złoto','gold','srebro','silver','platyna','metal'].some(k => q.includes(k))) {
    promises.push(fetchMetals().then(d => d && parts.push('METALE: ' + d)));
  }

  const stockMap = {
    'apple|aapl':'AAPL','tesla|tsla':'TSLA','microsoft|msft':'MSFT',
    'nvidia|nvda':'NVDA','google|googl':'GOOGL','amazon|amzn':'AMZN',
    'meta':'META','xtb':'XTB.WA','orlen|pkn':'PKN.WA','kghm':'KGH.WA',
    'pko':'PKO.WA','cd projekt|cdpr':'CDR.WA','allegro':'ALE.WA',
  };
  for (const [keys, symbol] of Object.entries(stockMap)) {
    if (keys.split('|').some(k => q.includes(k))) {
      promises.push(fetchStock(symbol).then(d => d && parts.push('AKCJE: ' + d)));
    }
  }

  await Promise.all(promises);
  return parts.length > 1 ? parts.join('\n') : null;
}

const SYSTEM = `Jesteś eksperckim asystentem analiz finansowych. Zawsze dajesz KONKRETNE odpowiedzi z liczbami.
ZASADY:
1. Gdy masz dane rynkowe w kontekście — UŻYWAJ ICH jako podstawy analizy
2. Dla kryptowalut analizuj: TECHNICZNA, FUNDAMENTALNA, ON-CHAIN
3. Podawaj konkretne poziomy: wsparcie X, opór Y, cel Z
4. Bądź odważny w prognozach
5. Specjalizujesz się w: DCF, LBO, Equity Research, IB, PE, KYC, M&A, krypto, akcje, forex
Odpowiadaj po polsku.`;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Brak tokenu' });

  let user;
  try {
    const payload = decodeToken(token);
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return res.status(401).json({ error: 'Token wygasł' });
    user = { id: payload.sub, email: payload.email || '' };
  } catch(e) { return res.status(401).json({ error: 'Błąd tokenu' }); }

  // Sprawdź plan
  const { data: profile } = await supabase.from('profiles').select('plan, queries_today, last_query_date').eq('id', user.id).single();
  const today = new Date().toISOString().slice(0, 10);
  const queries = profile?.last_query_date?.slice(0, 10) === today ? (profile.queries_today || 0) : 0;
  const plan = profile?.plan || 'free';

  if (plan === 'free' && queries >= FREE_LIMIT) {
    return res.status(403).json({ error: 'Przekroczono limit 5 zapytań/dzień.', upgrade: true, plan: 'free' });
  }

  const { messages } = req.body;
  if (!Array.isArray(messages)) return res.status(400).json({ error: 'Brak wiadomości' });

  const safe = messages.filter(m => ['user','assistant'].includes(m.role)).slice(-10).map(m => ({ role: m.role, content: String(m.content).slice(0, 3000) }));
  const lastMsg = safe.filter(m => m.role === 'user').pop()?.content || '';

  const contextData = await buildContext(lastMsg);
  const systemPrompt = contextData ? SYSTEM + '\n\n═══ DANE RYNKOWE (na żywo) ═══\n' + contextData + '\n═══════════════════════' : SYSTEM;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'deepseek-r1-distill-llama-70b', max_tokens: 2000, temperature: 0.6, messages: [{ role: 'system', content: systemPrompt }, ...safe] })
    });

    const data = await groqRes.json();
    if (data.error) return res.status(502).json({ error: data.error.message });

    let reply = data.choices[0].message.content;
    reply = reply.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

    // Zapisz historię
    try {
      await supabase.from('chat_history').insert({ user_id: user.id, user_message: lastMsg, ai_reply: reply, model: 'deepseek-r1' });
      await supabase.rpc('increment_queries', { user_id: user.id, today });
    } catch(e) {}

    const remaining = plan === 'pro' ? 999 : FREE_LIMIT - queries - 1;
    res.json({ reply, plan, remaining });

  } catch(err) {
    res.status(502).json({ error: 'Błąd AI: ' + err.message });
  }
}
