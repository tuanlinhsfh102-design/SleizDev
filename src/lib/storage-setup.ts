// Auto-setup Supabase: create storage buckets automatically
// Called from Next.js client when app first loads
// Tables still need manual SQL setup, but buckets are auto-created

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const REQUIRED_BUCKETS = [
  { id: 'thumbnails', name: 'thumbnails', public: true },
  { id: 'videos', name: 'videos', public: true },
  { id: 'dubbed-videos', name: 'dubbed-videos', public: true },
  { id: 'channel-avatars', name: 'channel-avatars', public: true },
];

let setupPromise: Promise<boolean> | null = null;

/**
 * Ensure storage buckets exist. Called once on app load.
 * Uses service role key (server-side only).
 */
export async function ensureStorageBuckets(): Promise<boolean> {
  if (setupPromise) return setupPromise;

  setupPromise = (async () => {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      console.warn('[storage] Missing env vars, skipping bucket setup');
      return false;
    }

    try {
      // List existing buckets
      const listRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
        headers: {
          Authorization: `Bearer ${SERVICE_KEY}`,
          apikey: SERVICE_KEY,
        },
      });

      if (!listRes.ok) {
        console.warn('[storage] Failed to list buckets:', listRes.status);
        return false;
      }

      const existing = (await listRes.json()) as Array<{ id: string }>;
      const existingIds = new Set(existing.map((b) => b.id));

      // Create missing buckets
      for (const bucket of REQUIRED_BUCKETS) {
        if (!existingIds.has(bucket.id)) {
          console.log(`[storage] Creating bucket: ${bucket.id}`);
          const createRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${SERVICE_KEY}`,
              apikey: SERVICE_KEY,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              id: bucket.id,
              name: bucket.name,
              public: bucket.public,
            }),
          });

          if (createRes.ok) {
            console.log(`[storage] ✓ Created bucket: ${bucket.id}`);
          } else {
            console.warn(`[storage] ✗ Failed to create ${bucket.id}:`, createRes.status);
          }
        }
      }

      return true;
    } catch (error) {
      console.error('[storage] Setup failed:', error);
      return false;
    }
  })();

  return setupPromise;
}
