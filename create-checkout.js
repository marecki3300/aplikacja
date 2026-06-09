import Stripe from 'stripe';

function decodeToken(token) {
  const parts = token.split('.');
  const padding = parts[1].length % 4;
  const padded = padding ? parts[1] + '='.repeat(4 - padding) : parts[1];
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const token = req.headers.authorization?.split('Bearer ')[1];
  if (!token) return res.status(401).json({ error: 'Brak tokenu' });

  try {
    const payload = decodeToken(token);
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'blik', 'p24'],
      mode: 'subscription',
      line_items: [{ price_data: { currency: 'pln', product_data: { name: 'FinAI Pro' }, unit_amount: 4900, recurring: { interval: 'month' } }, quantity: 1 }],
      customer_email: payload.email,
      client_reference_id: payload.sub,
      success_url: process.env.FRONTEND_URL + '?upgraded=true',
      cancel_url: process.env.FRONTEND_URL + '?cancelled=true',
      metadata: { user_id: payload.sub }
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
}
