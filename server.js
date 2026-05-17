// FinAI Backend — Node.js + Express
import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT || 3000;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'Authorization'] }));
app.use(express.json({ limit: '10kb' }));

const aiLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Za dużo zapytań.' } });

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
    if (payload.exp && payload.exp < now) {
      return res.status(401).json({ error: 'Token wygasł — zaloguj się ponownie' });
    }

    if (!payload.sub) return res.status(401).json({ error: 'Nieprawidłowy token' });

    req.user = { id: payload.sub, email: payload.email || '' };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Błąd tokenu: ' + err.message });
  }
}

app.post('/api/chat', requireAuth, aiLimiter, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'Brak wiadomości' });

  const safe = messages
    .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

  const SYSTEM_PROMPT = `Jesteś ekspertowym asystentem analiz finansowych specjalizującym się w DCF, LBO, Comparable Company Analysis, Equity Research, Investment Banking, Private Equity, KYC i M&A. Odpowiadaj po polsku. Przy obliczeniach pokazuj wzory krok po kroku. Zaznaczaj, że analizy są do weryfikacji przez specjalistów i nie stanowią porady inwestycyjnej.`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({ model: 'llama-3.3-70b-versatile', max_tokens: 1500, messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...safe] })
    });

    const data = await groqRes.json();
    if (data.error) return res.status(502).json({ error: data.error.message });

    const reply = data.choices[0].message.content;

    supabase.from('chat_history').insert({
      user_id: req.user.id,
      user_message: safe[safe.length - 1]?.content,
      ai_reply: reply,
      model: 'llama-3.3-70b-versatile',
    }).catch(e => console.error('History:', e.message));

    res.json({ reply });
  } catch (err) {
    res.status(502).json({ error: 'Błąd AI: ' + err.message });
  }
});

app.get('/api/history', requireAuth, async (req, res) => {
  const { data, error } = await supabase.from('chat_history').select('id, user_message, ai_reply, created_at').eq('user_id', req.user.id).order('created_at', { ascending: false }).limit(50);
  if (error) return res.status(500).json({ error: 'Błąd bazy danych' });
  res.json({ history: data || [] });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: req.user }));
app.get('/health', (_, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => console.log(`FinAI backend na porcie ${PORT}`));
