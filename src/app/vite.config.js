import { defineConfig } from 'vite';
import path from 'path';
import react from '@vitejs/plugin-react';
import tailwindcss from 'tailwindcss';
import tsconfigPaths from 'vite-tsconfig-paths';
import { patchCssModules } from 'vite-css-modules';
import { nodePolyfills } from 'vite-plugin-node-polyfills';
import { sentryVitePlugin } from '@sentry/vite-plugin';

export default defineConfig({
    root: path.resolve(__dirname, './'), // Set root to the directory containing index.html
    base: './',
    css: {
        postcss: {
            plugins: [tailwindcss()],
        },
        preprocessorOptions: { stylus: { modules: true } },
        modules: {
            // Enable CSS Modules for all .scss files
            localsConvention: 'camelCaseOnly',
            generateScopedName: '[name]__[local]___[hash:base64:5]',
        },
        devSourcemap: true,
    },
    plugins: [
        tsconfigPaths(),
        react(),
        patchCssModules(),
        tailwindcss(),
        nodePolyfills({
            // To add only specific polyfills, add them here. If no option is passed, adds all polyfills
            include: ['process'],
            globals: { global: true, process: true },
        }),
        // GGSender: only load the Sentry upload plugin when a token is
        // configured; without one it adds nothing and can stall the build.
        ...(process.env.SENTRY_AUTH_TOKEN
            ? [
                  sentryVitePlugin({
                      org: process.env.SENTRY_ORG,
                      project: process.env.SENTRY_PROJECT,
                      authToken: process.env.SENTRY_AUTH_TOKEN,
                  }),
              ]
            : []),
    ],
    resolve: {
        alias: {
            app: path.resolve(__dirname, './src'),
            '@': path.resolve(__dirname, './src'),
        },
        dedupe: ['react', 'react-dom'],
    },
    define: {},
    server: {
        hmr: {
            overlay: false,
        },
        proxy: {
            '/api': {
                target: 'http://127.0.0.1:8000',
                changeOrigin: true,
            },
            '/socket.io': {
                target: 'http://127.0.0.1:8000',
                changeOrigin: true,
                ws: true,
            },
        },
    },
    optimizeDeps: {
        include: ['**/*.styl'],
    },
    build: {
        // GGSender: GG_READABLE_BUILD=1 keeps function names, so stack
        // traces written to the traffic log can be read without a source map.
        minify: process.env.GG_READABLE_BUILD ? false : 'esbuild',
        sourcemap: true,
        /*rollupOptions: {
            rollupOptions: {
                external: ['unenv/node/process']
            }
        }*/
    },
});
