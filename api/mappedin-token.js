// GET /api/mappedin-token → { accessToken, expiresIn }
//
// Trades the Mappedin API key and secret for a short-lived bearer token, so the secret never
// ships to the browser or sits in the repo. Credentials come from environment variables:
//   MAPPEDIN_KEY, MAPPEDIN_SECRET   (Vercel → Project → Settings → Environment Variables,
//                                    or .env.local for `npm run dev`)
// Pattern from https://developer.mappedin.com/web-sdk/getting-started (bearer token auth).

const TOKEN_URL = 'https://app.mappedin.com/api/v1/api-key/token';
const REFRESH_MARGIN_S = 300; // fetch a new token 5 minutes before the old one expires

let cached = null; // { accessToken, expiresAt } reused while this function instance is warm

export async function GET() {
  const key = process.env.MAPPEDIN_KEY;
  const secret = process.env.MAPPEDIN_SECRET;
  if (!key || !secret) return json({ error: 'Mappedin credentials are not configured on the server.' }, 500);

  const now = Date.now() / 1000;
  if (!cached || cached.expiresAt - REFRESH_MARGIN_S < now) {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, secret }),
    });
    if (!res.ok) return json({ error: `Mappedin token request failed (${res.status}).` }, 502);
    const data = await res.json();
    cached = { accessToken: data.access_token, expiresAt: now + data.expires_in };
  }

  return json({ accessToken: cached.accessToken, expiresIn: Math.floor(cached.expiresAt - now) }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
