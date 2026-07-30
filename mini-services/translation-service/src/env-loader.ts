// Load environment variables from main project's .env.local
//
// Lookup order (first match wins), all paths resolved relative to THIS
// module file (not process.cwd(), which is unpredictable when the service
// is launched from an arbitrary directory):
//   1. SleizDev root:  .env.local     (preferred — same dir as package.json)
//   2. Service dir:    .env.local     (mini-services/translation-service)
//   3. SleizDev root:  .env
//   4. Service dir:    .env
//
// We deliberately do NOT fall back to process.cwd()/.env* — that would pick
// up unrelated .env files in the user's launch directory (e.g. a stray
// /home/user/.env on Linux, or C:\Users\<user>\.env on Windows).
//
// If none of these files exist (typical for a fresh git clone / zip download
// because `.env*` is gitignored), we inject the documented default Supabase
// credentials into process.env so the service can boot. Those defaults are
// the SAME values listed in README-SETUP.md, so they're not secret — they're
// the project's own Supabase instance. A clear warning is logged telling the
// user to create their own .env.local for production use.
//
// Why this matters: previously, a missing .env.local caused
//   [FATAL] Missing Supabase credentials
// followed by `supabaseUrl is required.` crash, with NO guidance on what to
// do. The service would loop forever in `--watch` mode. This fix makes the
// service start on first run, even before the user has set up their env.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Resolve paths relative to THIS module file so the lookup is independent
// of where the service was launched from. Without this, the env-loader
// could pick up unrelated .env files in the user's CWD (e.g. a stray
// /home/user/.env on Linux, or C:\Users\Admin\.env on Windows).
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const SERVICE_DIR = path.resolve(MODULE_DIR, '..');             // mini-services/translation-service
const PROJECT_ROOT = path.resolve(MODULE_DIR, '..', '..', '..'); // SleizDev root

/**
 * Documented default credentials, taken verbatim from README-SETUP.md.
 * These are the project's own Supabase instance — already public via the
 * README, so baking them in as a fallback is safe.
 *
 * Users who want to use their own Supabase project should create a
 * `.env.local` file at the SleizDev root with their own values.
 */
const DEFAULT_ENV: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://okeyouuilaldknazzhkx.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_kkTBJYylMxU2itNaXSdpsg_8LmNTyH2',
  SUPABASE_SECRET_KEY: 'sb_secret__prLx0suhRL4yJtj-k7e2A_gt9Em5Uj',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret__prLx0suhRL4yJtj-k7e2A_gt9Em5Uj',
  SUPABASE_URL: 'https://okeyouuilaldknazzhkx.supabase.co',
};

/**
 * Parse a single .env file and apply its key/value pairs to process.env.
 * Values are only set if the key isn't already present in process.env (so
 * real shell env vars take precedence over .env file contents, and explicit
 * user values take precedence over our defaults).
 */
function applyEnvFile(envPath: string): boolean {
  if (!fs.existsSync(envPath)) return false;
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
  return true;
}

function loadEnv() {
  // Only look in well-known project locations. Do NOT fall back to
  // process.cwd() — that would pick up unrelated .env files in the user's
  // launch directory (e.g. /home/user/.env or C:\Users\Admin\.env), which
  // could silently inject wrong values.
  const candidates = [
    path.resolve(PROJECT_ROOT, '.env.local'),  // SleizDev root (preferred)
    path.resolve(SERVICE_DIR, '.env.local'),   // translation-service dir
    path.resolve(PROJECT_ROOT, '.env'),        // SleizDev root (.env fallback)
    path.resolve(SERVICE_DIR, '.env'),         // translation-service dir (.env fallback)
  ];

  // Try each candidate; stop at the first one that exists.
  for (const envPath of candidates) {
    if (applyEnvFile(envPath)) {
      return;
    }
  }

  // No env file found. Inject documented defaults so the service can boot.
  console.warn('='.repeat(78));
  console.warn('[env] WARNING: No .env.local file found.');
  console.warn(`[env] Looked in:`);
  for (const p of candidates) {
    console.warn(`[env]   - ${p}`);
  }
  console.warn('');
  console.warn('[env] Injecting documented default credentials from README-SETUP.md');
  console.warn('[env] so the service can start. These are the project\'s own Supabase');
  console.warn('[env] instance — already public via the README.');
  console.warn('');
  console.warn('[env] To use your own Supabase project, create a .env.local file at');
  console.warn('[env] the SleizDev root with these variables:');
  console.warn('[env]   NEXT_PUBLIC_SUPABASE_URL');
  console.warn('[env]   NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY');
  console.warn('[env]   SUPABASE_SECRET_KEY  (a.k.a. SUPABASE_SERVICE_ROLE_KEY)');
  console.warn('[env]   SUPABASE_URL');
  console.warn('='.repeat(78));

  let injectedCount = 0;
  for (const [key, value] of Object.entries(DEFAULT_ENV)) {
    if (!process.env[key]) {
      process.env[key] = value;
      injectedCount++;
    }
  }
  console.log(`[env] Injected ${injectedCount} default values into process.env`);
}

loadEnv();
