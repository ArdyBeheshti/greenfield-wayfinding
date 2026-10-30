import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Writes precache.json: every file in the build, plus a version that changes per build.
 * The service worker saves all of it on the first visit, so the app reopens offline even if
 * the visitor only loaded it once (scan the QR code, walk into a garage dead spot).
 */
function precacheManifest(): Plugin {
  return {
    name: 'precache-manifest',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle).filter(f => !f.endsWith('.map'));
      const version = files.filter(f => f.startsWith('assets/')).sort().join('|');
      let hash = 0;
      for (const ch of version) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
      this.emitFile({
        type: 'asset',
        fileName: 'precache.json',
        source: JSON.stringify({ version: (hash >>> 0).toString(36), files: ['/', ...files.map(f => `/${f}`)] }),
      });
    },
  };
}

/**
 * Serves api/mappedin-token.js during `npm run dev`, using the MAPPEDIN_* credentials from
 * .env.local, so local development uses the same token flow as production.
 */
function devTokenEndpoint(mode: string): Plugin {
  return {
    name: 'dev-token-endpoint',
    apply: 'serve',
    configureServer(server) {
      Object.assign(process.env, loadEnv(mode, process.cwd(), 'MAPPEDIN_'));
      server.middlewares.use('/api/mappedin-token', async (req, res) => {
        const { GET } = await import('./api/mappedin-token.js');
        const response: Response = await GET(new Request(`http://localhost${req.originalUrl ?? req.url}`));
        res.statusCode = response.status;
        response.headers.forEach((value, name) => res.setHeader(name, value));
        res.end(await response.text());
      });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [precacheManifest(), devTokenEndpoint(mode)],
}));
