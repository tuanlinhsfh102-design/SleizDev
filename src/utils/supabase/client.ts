import { createBrowserClient } from "@supabase/ssr";
import { supabaseUrl, supabasePublishableKey } from "@/lib/env";

export const createClient = () =>
  createBrowserClient(supabaseUrl, supabasePublishableKey);
