'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { AuthForm } from '@/components/auth/AuthForm';
import { AppShell } from '@/components/layout/AppShell';
import { ChannelsManager } from '@/components/channels/ChannelsManager';
import { ChannelDetail } from '@/components/movies/ChannelDetail';
import { TranslationStudio } from '@/components/translation/TranslationStudio';
import { ApiKeyManager } from '@/components/apikeys/ApiKeyManager';
import { SetupCheck } from '@/components/setup/SetupCheck';
import { useAppStore } from '@/lib/store';
import { Loader2 } from 'lucide-react';

export default function Home() {
  const supabase = createClient();
  const { view } = useAppStore();
  const [user, setUser] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [schemaReady, setSchemaReady] = useState(false);
  const [storageTriggered, setStorageTriggered] = useState(false);

  useEffect(() => {
    const checkUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      setUser(user);
      setLoading(false);
    };
    checkUser();

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user || null);
    });

    return () => subscription.unsubscribe();
  }, [supabase]);

  // Auto-trigger storage bucket setup when user logs in (once)
  useEffect(() => {
    if (!user || storageTriggered) return;

    // Use a ref-like pattern to avoid setState in effect
    const controller = new AbortController();
    fetch('/api/setup-storage', {
      method: 'POST',
      signal: controller.signal,
    }).catch(() => {
      // Silent fail - SetupCheck will retry
    });

    // Mark as triggered in next tick to avoid cascading renders
    const timer = setTimeout(() => setStorageTriggered(true), 0);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [user, storageTriggered]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950">
        <Loader2 className="w-8 h-8 animate-spin text-rose-500" />
      </div>
    );
  }

  if (!user) {
    return <AuthForm onSuccess={() => setUser({})} />;
  }

  if (!schemaReady) {
    return <SetupCheck onSetupComplete={() => setSchemaReady(true)} />;
  }

  return (
    <AppShell>
      {view.type === 'channels' && <ChannelsManager />}
      {view.type === 'channel-detail' && (
        <ChannelDetail channelId={view.channelId} channelName={view.channelName} />
      )}
      {view.type === 'movie-detail' && (
        <TranslationStudio
          movieId={view.movieId}
          movieTitle={view.movieTitle}
          channelId={view.channelId}
        />
      )}
      {view.type === 'api-keys' && <ApiKeyManager />}
    </AppShell>
  );
}
