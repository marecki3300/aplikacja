export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({ status: 'ok', model: 'deepseek-r1-distill-llama-70b', rag: true });
}
