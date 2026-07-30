import { createServerClient } from "@supabase/ssr";
import { type NextRequest, NextResponse } from "next/server";
import { supabaseUrl, supabasePublishableKey } from "@/lib/env";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({
    request: {
      headers: request.headers,
    },
  });

  // supabaseUrl and supabasePublishableKey come from @/lib/env, which falls
  // back to documented defaults if env vars are missing. Without this
  // fallback, the middleware would crash on every request when the user
  // hasn't created a .env.local file — that was the original bug.
  const supabase = createServerClient(supabaseUrl, supabasePublishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) =>
          request.cookies.set(name, value)
        );
        supabaseResponse = NextResponse.next({
          request,
        });
        cookiesToSet.forEach(({ name, value, options }) =>
          supabaseResponse.cookies.set(name, value, options)
        );
      },
    },
  });

  // Refresh the user's session (this updates cookies if needed)
  // Auth checks are handled client-side in the SPA
  await supabase.auth.getUser();

  return supabaseResponse;
}
