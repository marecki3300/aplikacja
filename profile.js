import { createClient } from '@supabase/supabase-js';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

function decodeToken(token) {
  const parts = token.split('.');
  const padding = parts[1].length % 4;
  const padded = padding ? parts[1] + '='.repeat(4 - padding) : parts[1];
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Brak tokenu' });

  try {
    const payload = decodeToken(token);
    const { data } = await supabase.from('profiles').select('plan, queries_today, last_query_date').eq('id', payload.sub).single();
    const today = new Date().toISOString().slice(0, 10);
    const queries = data?.last_query_date?.slice(0, 10) === today ? (data.queries_today || 0) : 0;
    const plan = data?.plan || 'free';
    res.json({ plan, queries_today: queries, limit: plan === 'pro' ? 999 : 5, remaining: plan === 'pro' ? 999 : Math.max(0, 5 - queries) });
  } catch(e) { res.status(401).json({ error: 'Błąd autoryzacji' }); }
}
