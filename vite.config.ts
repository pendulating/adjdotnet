import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  return {
    plugins: [react()],
    server: {
      port: 8924
    },
    define: {
      'import.meta.env.NYCOD_APP_TOKEN': JSON.stringify(env.NYCOD_APP_TOKEN)
    }
  }
})
