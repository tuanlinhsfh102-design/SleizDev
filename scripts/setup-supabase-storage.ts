// Auto-setup Supabase storage buckets via Storage API
// This works with the service role API key (sb_secret__)
// Tables still need to be created via SQL Editor

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY;

const BUCKETS = [
  { id: 'thumbnails', name: 'thumbnails', public: true },
  { id: 'videos', name: 'videos', public: true },
  { id: 'dubbed-videos', name: 'dubbed-videos', public: true },
  { id: 'channel-avatars', name: 'channel-avatars', public: true },
];

async function setupBuckets() {
  console.log('=== Setting up Supabase Storage Buckets ===');
  console.log(`URL: ${SUPABASE_URL}`);

  // List existing buckets
  const listRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY!,
    },
  });

  if (!listRes.ok) {
    console.error('Failed to list buckets:', await listRes.text());
    process.exit(1);
  }

  const existing = await listRes.json() as Array<{ id: string; name: string }>;
  console.log(`Existing buckets: ${existing.map(b => b.id).join(', ') || 'none'}`);

  // Create missing buckets
  for (const bucket of BUCKETS) {
    if (existing.find(b => b.id === bucket.id)) {
      console.log(`✓ Bucket "${bucket.id}" already exists`);
    } else {
      console.log(`Creating bucket "${bucket.id}"...`);
      const createRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SERVICE_KEY}`,
          apikey: SERVICE_KEY!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: bucket.id,
          name: bucket.name,
          public: bucket.public,
        }),
      });

      if (createRes.ok) {
        console.log(`✓ Created bucket "${bucket.id}"`);
      } else {
        const err = await createRes.text();
        console.error(`✗ Failed to create bucket "${bucket.id}": ${err}`);
      }
    }
  }

  // Verify
  const verifyRes = await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY!,
    },
  });
  const finalBuckets = await verifyRes.json() as Array<{ id: string }>;
  console.log(`\n=== Final buckets: ${finalBuckets.map(b => b.id).join(', ')} ===`);

  // Check if tables exist
  console.log('\n=== Checking database tables ===');
  const tablesRes = await fetch(`${SUPABASE_URL}/rest/v1/channels?select=id&limit=1`, {
    headers: {
      Authorization: `Bearer ${SERVICE_KEY}`,
      apikey: SERVICE_KEY!,
    },
  });
  const tablesData = await tablesRes.json();

  if (tablesRes.ok) {
    console.log('✓ Tables are set up!');
  } else if (tablesData.code === 'PGRST205') {
    console.log('✗ Tables not yet created. User needs to run SQL schema.');
  } else {
    console.log('✗ Table check failed:', tablesData);
  }
}

setupBuckets().catch(err => {
  console.error('Setup failed:', err);
  process.exit(1);
});
