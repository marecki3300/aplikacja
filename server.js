// FinAI Backend — Node.js + Express
// Ukrywa klucz API przed użytkownikami, weryfikuje tokeny Supabase
// Deploy: Railway.app (darmowy)

import express from 'express';
import cors from 'cors';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';
import rateLimit from 'express-rate-limit';

const app = express();
const PORT = process.env.PORT || 3000;

// ── Supabase Admin Client (tylko na serwerze) ──────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY  // service_role key — NIGDY nie ujawniaj
);

// ── Middleware ─────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',  // ustaw na URL swojej apki
  methods: ['GET', 'POST'],
}));
app.use(express.json({ limit: '10kb' }));

// Rate limiting — max 20 zapytań AI na minutę per IP
const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: 'Za dużo zapytań. Poczekaj chwilę.' }
});

// ── Middleware: weryfikacja tokenu Supabase ────────────────
async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Brak tokenu autoryzacji' });

  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Nieprawidłowy lub wygasły token' });

  req.user = user;
  next();
}

// ── POST /api/chat — główny endpoint AI ───────────────────
app.post('/api/chat', requireAuth, aiLimiter, async (req, res) => {
  const { messages } = req.body;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'Brak wiadomości' });
  }

  // Sanityzacja — tylko role user/assistant, max 20 wiadomości
  const safe = messages
    .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

  const SYSTEM_PROMPT = `Jesteś ekspertowym asystentem analiz finansowych specjalizującym się w:
DCF, LBO, Comparable Company Analysis, Equity Research, Investment Banking, Private Equity, KYC i M&A.
Odpowiadaj po polsku. Przy obliczeniach pokazuj wzory krok po kroku.
Zaznaczaj, że analizy są do weryfikacji przez specjalistów i nie stanowią porady inwestycyjnej.`;

  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`  // klucz ukryty!
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1500,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...safe]
      })
    });

    const data = await groqRes.json();

    if (data.error) {
      return res.status(502).json({ error: data.error.message });
    }

    const reply = data.choices[0].message.content;

    // Zapisz do historii w Supabase
    await supabase.from('chat_history').insert({
      user_id: req.user.id,
      user_message: safe[safe.length - 1]?.content,
      ai_reply: reply,
      model: 'llama-3.3-70b-versatile',
    });

    res.json({ reply });

  } catch (err) {
    console.error('Groq error:', err);
    res.status(502).json({ error: 'Błąd połączenia z AI' });
  }
});

// ── GET /api/history — historia rozmów użytkownika ────────
app.get('/api/history', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('chat_history')
    .select('id, user_message, ai_reply, created_at')
    .eq('user_id', req.user.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'Błąd bazy danych' });
  res.json({ history: data });
});

// ── GET /api/me — dane zalogowanego użytkownika ───────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: { id: req.user.id, email: req.user.email } });
});

// ── Health check ──────────────────────────────────────────
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => console.log(`FinAI backend działa na porcie ${PORT}`));
