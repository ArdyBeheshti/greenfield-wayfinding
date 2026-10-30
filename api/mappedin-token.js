// GET /api/mappedin-token?source=maker|enterprise → { accessToken, expiresIn }
//
// Exchanges Mappedin credentials for a short-lived bearer token, so no secret ships to the
// browser or sits in the repo. Credentials come from environment variables
// (Vercel → Project → Settings → Environment Variables, or .env.local for `npm run dev`):
//   maker       MAPPEDIN_KEY, MAPPEDIN_SECRET                       (Mappedin Maker maps)
//   enterprise  MAPPEDIN_ENTERPRISE_KEY, MAPPEDIN_ENTERPRISE_SECRET (Mappedin CMS maps)
// Both flows are from https://developer.mappedin.com/web-sdk/getting-started.

const REFRESH_MARGIN_S = 300; // fetch a new token 5 minutes before the old one expires

const SOURCES = {
  maker: {
    url: 'https://app.mappedin.com/api/v1/api-key/token',
    body: () => ({ key: process.env.MAPPEDIN_KEY, secret: process.env.MAPPEDIN_SECRET }),
    configured: () => !!(process.env.MAPPEDIN_KEY && process.env.MAPPEDIN_SECRET),
  },
  enterprise: {
    url: 'https://api-gateway.mappedin.com/auth/token',
    body: () => ({
      grant_type: 'client_credentials',
      client_id: process.env.MAPPEDIN_ENTERPRISE_KEY,
      client_secret: process.env.MAPPEDIN_ENTERPRISE_SECRET,
    }),
    configured: () => !!(process.env.MAPPEDIN_ENTERPRISE_KEY && process.env.MAPPEDIN_ENTERPRISE_SECRET),
  },
};

const cache = {}; // source → { accessToken, expiresAt }, reused while this instance is warm

export async function GET(request) {
  const name = new URL(request?.url ?? 'http://x/', 'http://x').searchParams.get('source') ?? 'maker';
  const source = SOURCES[name];
  if (!source) return json({ error: `Unknown source "${name}".` }, 400);
  if (!source.configured()) return json({ error: `Mappedin ${name} credentials are not configured on the server.` }, 500);

  const now = Date.now() / 1000;
  const cached = cache[name];
  if (!cached || cached.expiresAt - REFRESH_MARGIN_S < now) {
    const res = await fetch(source.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(source.body()),
    });
    if (!res.ok) return json({ error: `Mappedin token request failed (${res.status}).` }, 502);
    const data = await res.json();
    cache[name] = { accessToken: data.access_token, expiresAt: now + data.expires_in };
  }

  return json({ accessToken: cache[name].accessToken, expiresIn: Math.floor(cache[name].expiresAt - now) }, 200);
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}
