import { defineConfig } from 'astro/config';
import fs from 'node:fs';
import path from 'node:path';

// Local development reads the API one of two ways:
//  - default: proxied to the live site, so the page runs against real data;
//  - LEDGER_API_DIR=/some/dir: served from saved responses in that folder,
//    /api/ad → ad.json, /api/session/<date> → session/<date>.json (save them with
//    `curl https://finance.sulaksono.id/api/ad -o dir/ad.json`). Use this when
//    the proxy is refused — Node's TLS connection to the site can be reset
//    where curl's isn't.
const apiDir = process.env.LEDGER_API_DIR;

const savedApi = {
  name: 'ledger-saved-api',
  configureServer(server) {
    server.middlewares.use('/api', (req, res) => {
      // /api/session/2026-11-11 → session/2026-11-11.json, else the first
      // segment: /api/movers/a/b → movers.json.
      const segs = req.url.split('?')[0].split('/').filter(s => /^[\w-]+$/.test(s));
      const nested = path.join(apiDir, ...segs) + '.json';
      const file = segs.length > 1 && fs.existsSync(nested) ? nested : path.join(apiDir, `${segs[0]}.json`);
      res.setHeader('content-type', 'application/json');
      if (!segs.length || !fs.existsSync(file)) { res.statusCode = 200; res.end('{"success":false}'); return; }
      fs.createReadStream(file).pipe(res);
    });
  },
};

// Static output, one .html file per page, so the S3 layout and every existing
// URL (/valuation.html, /sentiment.html, …) stay exactly as they are today.
export default defineConfig({
  site: 'https://finance.sulaksono.id',
  output: 'static',
  build: { format: 'file', inlineStylesheets: 'never' },
  vite: apiDir
    ? { plugins: [savedApi] }
    : { server: { proxy: { '/api': { target: 'https://finance.sulaksono.id', changeOrigin: true, secure: true } } } },
});
