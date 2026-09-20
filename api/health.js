export default async function handler(req, res) {
  res.status(200).json({
    ok: true,
    service: 'telegram-manager',
    runtime: 'vercel'
  });
}
