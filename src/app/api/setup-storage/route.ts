import { NextRequest, NextResponse } from 'next/server';
import { ensureStorageBuckets } from '@/lib/storage-setup';

// POST /api/setup-storage - auto-create Supabase storage buckets
// This route uses the service role key (server-side only) to create buckets
export async function POST(_request: NextRequest) {
  try {
    const success = await ensureStorageBuckets();
    if (success) {
      return NextResponse.json({ success: true, message: 'Storage buckets ready' });
    } else {
      return NextResponse.json(
        { success: false, error: 'Failed to setup storage buckets' },
        { status: 500 }
      );
    }
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message },
      { status: 500 }
    );
  }
}

// GET - check if storage is ready (uses service role key to list all buckets)
export async function GET() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return NextResponse.json({ error: 'Missing config' }, { status: 500 });
  }

  try {
    const res = await fetch(`${supabaseUrl}/storage/v1/bucket`, {
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
      },
    });

    if (!res.ok) {
      return NextResponse.json({ ready: false, error: 'Failed to list buckets' });
    }

    const buckets = (await res.json()) as Array<{ id: string }>;
    const required = ['thumbnails', 'videos', 'dubbed-videos', 'channel-avatars'];
    const ready = required.every((r) => buckets.find((b) => b.id === r));

    return NextResponse.json({
      ready,
      buckets: buckets.map((b) => b.id),
      missing: required.filter((r) => !buckets.find((b) => b.id === r)),
    });
  } catch (error: any) {
    return NextResponse.json({ ready: false, error: error.message }, { status: 500 });
  }
}
