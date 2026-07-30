// Load environment variables from main project's .env.local
import fs from 'fs';
import path from 'path';

function loadEnv() {
  const envPaths = [
    path.resolve(process.cwd(), '../../.env.local'),
    path.resolve(process.cwd(), '.env.local'),
    path.resolve(process.cwd(), '.env'),
  ];

  for (const envPath of envPaths) {
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx === -1) continue;
        const key = trimmed.substring(0, eqIdx).trim();
        const value = trimmed.substring(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
      console.log(`[env] Loaded from ${envPath}`);
      break;
    }
  }
}

loadEnv();
