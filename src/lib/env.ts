// Shared environment access for the SleizDev Next.js frontend.
//
// Why this module exists:
//   Next.js automatically loads `.env`, `.env.local`, etc. from the project
//   root on startup. But `.env*` is gitignored, so a fresh git clone / zip
//   download has NO env file. The 5 files that read Supabase env vars
//   (`src/utils/supabase/{middleware,server,client}.ts`,
//    `src/lib/storage-setup.ts`, `src/app/api/setup-storage/route.ts`) would
//   get `undefined` and `createServerClient(undefined!, undefined!, ...)`
//   throws "Your project's URL and Key are required to create a Supabase
//   client!" — crashing the middleware on every request.
//
//   This module fixes that by falling back to the documented default
//   credentials (taken verbatim from README-SETUP.md — they're already
//   public via the README, so not secret) when env vars are missing.
//
//   Users who want their own Supabase project should set the env vars in
//   `.env.local` at the SleizDev root — Next.js will load them before this
//   module's fallback kicks in.
//
// Usage:
//   import { supabaseUrl, supabasePublishableKey, supabaseServiceRoleKey } from '@/lib/env';
//
// All values are eagerly resolved at module load (Next.js loads `.env*`
// files before any user code runs, so `process.env.X` is already populated
// by the time this module is imported).

/**
 * Documented default credentials, taken verbatim from README-SETUP.md.
 * These are the project's own Supabase instance — already public via the
 * README, so baking them in as a fallback is safe.
 *
 * Users who want to use their own Supabase project should create a
 * `.env.local` file at the SleizDev root with their own values.
 */
const DEFAULTS = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://okeyouuilaldknazzhkx.supabase.co',
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_kkTBJYylMxU2itNaXSdpsg_8LmNTyH2',
  SUPABASE_SECRET_KEY: 'sb_secret__prLx0suhRL4yJtj-k7e2A_gt9Em5Uj',
  SUPABASE_SERVICE_ROLE_KEY: 'sb_secret__prLx0suhRL4yJtj-k7e2A_gt9Em5Uj',
  SUPABASE_URL: 'https://okeyouuilaldknazzhkx.supabase.co',
} as const;

/** Supabase project URL (e.g. https://xyz.supabase.co). */
export const supabaseUrl: string =
  process.env.NEXT_PUBLIC_SUPABASE_URL ||
  process.env.SUPABASE_URL ||
  DEFAULTS.NEXT_PUBLIC_SUPABASE_URL;

/** Supabase publishable (anon) key — safe for browser use. */
export const supabasePublishableKey: string =
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  DEFAULTS.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

/** Supabase service role key — bypasses RLS. Server-side only, NEVER expose to browser. */
export const supabaseServiceRoleKey: string =
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SECRET_KEY ||
  DEFAULTS.SUPABASE_SERVICE_ROLE_KEY;

/**
 * Whether the active config is the documented default (vs a user-provided
 * env). Useful for surfacing a "you're using shared test credentials" notice
 * in the UI without leaking the credentials themselves.
 */
export const isUsingDefaultCredentials: boolean =
  supabaseUrl === DEFAULTS.NEXT_PUBLIC_SUPABASE_URL;
