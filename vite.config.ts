// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig, loadEnv } from 'vite';
import { resolve } from 'node:path';

/**
 * The dev server proxies the IRIS SysAdmin REST API and injects Basic auth
 * from .env on the server side: the browser app calls same-origin `/api/...`
 * (no CORS), and credentials never reach client JS.
 */
export default defineConfig(({ mode, command, isPreview }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const host = env.IRIS_HOST || 'localhost';
  const port = env.IRIS_PORT || '52774';
  // This instance's Admin API also serves reads over Unauthenticated access, so
  // only inject Basic when credentials are actually configured.
  const auth = env.IRIS_USERNAME
    ? 'Basic ' + Buffer.from(`${env.IRIS_USERNAME}:${env.IRIS_PASSWORD}`).toString('base64')
    : null;

  type ProxyReq = { setHeader: (k: string, v: string) => void; getHeader: (k: string) => unknown };
  type ProxyApi = { on(e: 'proxyReq', cb: (preq: ProxyReq) => void): void };

  const adminProxy = {
    target: `http://${host}:${port}`,
    changeOrigin: true,
    configure: (proxy: ProxyApi) => {
      // Fill in Basic only when the browser sent no credentials, so a signed-in
      // user's Bearer token is never overwritten.
      if (auth) proxy.on('proxyReq', (proxyReq) => { if (!proxyReq.getHeader('authorization')) proxyReq.setHeader('Authorization', auth); });
    },
  };

  // Resolve the linked @evolution-ui/core to its source (not its built dist),
  // for both dev and build, so library edits hot-reload straight in. This needs
  // the evolution-ui-2 checkout next to this repo.
  const EVO_SRC = resolve(process.cwd(), '../evolution-ui-2/src');
  const evoDevAlias = [
    { find: /^@evolution-ui\/core\/design\/(.*)$/, replacement: `${EVO_SRC}/design/$1` },
    { find: /^@evolution-ui\/core\/signals$/, replacement: `${EVO_SRC}/signals/index.ts` },
    { find: /^@evolution-ui\/core\/base$/, replacement: `${EVO_SRC}/base/index.ts` },
    { find: /^@evolution-ui\/core\/(.+)\.js$/, replacement: `${EVO_SRC}/$1.ts` },
  ];

  return {
    // Production is served by IRIS as the /portal web application (module.xml),
    // so built asset URLs carry that prefix. Dev stays at root so the /api proxy
    // resolves same-origin. Override the deploy path with PORTAL_BASE.
    // `vite preview` serves the build output, so it needs the build's base too.
    base: command === 'build' || isPreview ? env.PORTAL_BASE || '/portal/' : '/',
    resolve: { alias: evoDevAlias },
    optimizeDeps: { exclude: ['@evolution-ui/core'] },
    server: {
      port: 5274,
      strictPort: true,
      // /csp too, so Management Portal deep links open on the dev server as they do in production.
      proxy: { '/api': adminProxy, '/csp': adminProxy },
      fs: { allow: ['..'] },
    },
    build: {
      outDir: 'dist-web',
      emptyOutDir: true,
      target: 'es2022',
      chunkSizeWarningLimit: 5000,
    },
  };
});
