import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [tailwindcss(), reactRouter()],
  resolve: { alias: { '~': '/app' } },
  build: { target: 'es2020' }, // cheap Android phones: no top-level await or newer syntax in the client bundle
  ssr: { noExternal: ['@pathshala/ui'] },
});
