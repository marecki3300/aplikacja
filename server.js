// FinAI Backend — Node.js + Express + Web Search
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
    if (payload.exp && payload.exp < now) return res.status(401).json({ error: 'Token wygasł — zaloguj się ponownie' });
    if (!payload.sub) return res.status(401).json({ error: 'Nieprawidłowy token' });
    req.user = { id: payload.sub, email: payload.email || '' };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Błąd tokenu: ' + err.message });
  }
}

// Wyszukiwanie przez DuckDuckGo (bezpłatne)
async function webSearch(query) {
  try {
    const url = 'https://api.duckduckgo.com/?q=' + encodeURIComponent(query) + '&format=json&no_html=1&skip_disambig=1';
    const r = await fetch(url);
    const d = await r.json();
    const result = d.AbstractText || d.Answer || (d.RelatedTopics?.[0]?.Text) || '';
    if (result) return result;

    // Fallback — spróbuj Infobox
    if (d.Infobox?.content?.length > 0) {
      return d.Infobox.content.slice(0, 3).map(c => c.label + ': ' + c.value).join(', ');
    }
    return 'Brak wyników — odpowiedz na podstawie dostępnej wiedzy.';
  } catch(e) {
    return 'Błąd wyszukiwania: ' + e.message;
  }
}

const SYSTEM_PROMPT = `Jesteś ekspertowym asystentem analiz finansowych z dostępem do aktualnych danych rynkowych.
Specjalizujesz się w: DCF, LBO, Comparable Company Analysis, Equity Research, Investment Banking, Private Equity, KYC i M&A.
Gdy pytanie dotyczy aktualnych kursów, cen akcji, kryptowalut lub bieżących wydarzeń — użyj narzędzia web_search.
Odpowiadaj po polsku. Przy obliczeniach pokazuj wzory. Zaznaczaj że analizy nie stanowią porady inwestycyjnej.`;

const WEB_SEARCH_TOOL = [{
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Wyszukaj aktualne informacje: kursy akcji, kryptowalut, wyniki spółek, wiadomości finansowe',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Zapytanie do wyszukiwarki po angielsku dla lepszych wyników' }
      },
      required: ['query']
    }
  }
}];

app.post('/api/chat', requireAuth, aiLimiter, async (req, res) => {
  const { messages } = req.body;
  if (!Array.isArray(messages) || messages.length === 0) return res.status(400).json({ error: 'Brak wiadomości' });

  const safe = messages
    .filter(m => ['user', 'assistant'].includes(m.role) && typeof m.content === 'string')
    .slice(-20)
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) }));

  try {
    // Pierwsze zapytanie z narzędziem web_search
    const firstRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 1500,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...safe],
        tools: WEB_SEARCH_TOOL,
        tool_choice: 'auto'
      })
    });

    const firstData = await firstRes.json();
    if (firstData.error) return res.status(502).json({ error: firstData.error.message });

    const firstMsg = firstData.choices[0].message;
    let reply = '';

    if (firstMsg.tool_calls && firstMsg.tool_calls.length > 0) {
      // Model chce przeszukać internet
      const toolCall = firstMsg.tool_calls[0];
      const args = JSON.parse(toolCall.function.arguments);
      const searchResult = await webSearch(args.query);

      console.log('Web search query:', args.query);
      console.log('Web search result:', searchResult.slice(0, 200));

      // Drugi call z wynikami wyszukiwania
      const secondRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 1500,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...safe,
            { role: 'assistant', content: null, tool_calls: firstMsg.tool_calls },
            { role: 'tool', tool_call_id: toolCall.id, content: 'Wyniki wyszukiwania dla "' + args.query + '": ' + searchResult }
          ]
        })
      });

      const secondData = await secondRes.json();
      if (secondData.error) return res.status(502).json({ error: secondData.error.message });
      reply = secondData.choices[0].message.content;
    } else {
      reply = firstMsg.content;
    }

    // Zapisz do historii
    try {
      await supabase.from('chat_history').insert({
        user_id: req.user.id,
        user_message: safe[safe.length - 1]?.content,
        ai_reply: reply,
        model: 'llama-3.3-70b-versatile',
      });
    } catch(e) {
      console.error('History error:', e.message);
    }

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
app.get('/health', (_, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => console.log('FinAI backend na porcie ' + PORT));
