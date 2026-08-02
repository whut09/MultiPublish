import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  main:{build:{outDir:'dist-electron/main'}},
  preload:{build:{outDir:'dist-electron/preload',rollupOptions:{output:{format:'cjs',entryFileNames:'[name].cjs'}}}},
  renderer:{root:'src/renderer',base:'./',build:{outDir:'dist'},plugins:[react()]}
});
