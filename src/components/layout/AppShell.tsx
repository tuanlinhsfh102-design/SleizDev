'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/utils/supabase/client';
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  Film,
  Tv,
  KeyRound,
  LogOut,
  PanelLeftClose,
  PanelLeft,
  Sparkles,
} from 'lucide-react';
import { useAppStore, ViewType } from '@/lib/store';
import { cn } from '@/lib/utils';

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const supabase = createClient();
  const { view, setView, sidebarCollapsed, toggleSidebar } = useAppStore();
  const [user, setUser] = useState<{ email?: string; fullName?: string } | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const getUser = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (user) {
        setUser({
          email: user.email,
          fullName: user.user_metadata?.full_name,
        });
      }
      setLoading(false);
    };
    getUser();
  }, [supabase]);

  const handleLogout = async () => {
    await supabase.auth.signOut();
    window.location.reload();
  };

  const navItems: { view: ViewType; label: string; icon: React.ElementType }[] = [
    { view: { type: 'channels' }, label: 'Kênh', icon: Tv },
    { view: { type: 'api-keys' }, label: 'API Keys', icon: KeyRound },
  ];

  const isActive = (itemView: ViewType): boolean => {
    if (itemView.type === 'channels') {
      return view.type === 'channels' || view.type === 'channel-detail' || view.type === 'movie-detail';
    }
    if (itemView.type === 'api-keys') {
      return view.type === 'api-keys';
    }
    return false;
  };

  return (
    <div className="flex h-screen bg-slate-950 text-white overflow-hidden">
      {/* Sidebar */}
      <aside
        className={cn(
          'flex flex-col bg-slate-900 border-r border-slate-800 transition-all duration-300',
          sidebarCollapsed ? 'w-16' : 'w-64'
        )}
      >
        {/* Logo */}
        <div className="flex items-center gap-3 p-4 border-b border-slate-800 h-16">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-rose-500 to-orange-500 flex items-center justify-center shrink-0">
            <Film className="w-5 h-5 text-white" />
          </div>
          {!sidebarCollapsed && (
            <div className="flex-1 min-w-0">
              <h1 className="font-bold text-sm truncate">Donghua Translate</h1>
              <p className="text-xs text-slate-400 truncate">Phiên dịch & lồng tiếng</p>
            </div>
          )}
        </div>

        {/* Navigation */}
        <nav className="flex-1 p-2 space-y-1 overflow-y-auto">
          <TooltipProvider delayDuration={0}>
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = isActive(item.view);
              return (
                <Tooltip key={item.label}>
                  <TooltipTrigger asChild>
                    <button
                      onClick={() => setView(item.view)}
                      className={cn(
                        'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                        active
                          ? 'bg-gradient-to-r from-rose-500/20 to-orange-500/20 text-rose-300 border border-rose-500/30'
                          : 'text-slate-400 hover:bg-slate-800 hover:text-white'
                      )}
                    >
                      <Icon className="w-5 h-5 shrink-0" />
                      {!sidebarCollapsed && <span className="truncate">{item.label}</span>}
                    </button>
                  </TooltipTrigger>
                  {sidebarCollapsed && (
                    <TooltipContent side="right">
                      {item.label}
                    </TooltipContent>
                  )}
                </Tooltip>
              );
            })}
          </TooltipProvider>
        </nav>

        {/* User Info & Logout */}
        <div className="p-2 border-t border-slate-800 space-y-2">
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={toggleSidebar}
                  className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
                >
                  {sidebarCollapsed ? (
                    <PanelLeft className="w-5 h-5 shrink-0" />
                  ) : (
                    <>
                      <PanelLeftClose className="w-5 h-5 shrink-0" />
                      <span>Thu gọn</span>
                    </>
                  )}
                </button>
              </TooltipTrigger>
              {sidebarCollapsed && (
                <TooltipContent side="right">Mở rộng</TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>

          {!loading && user && (
            <div className="flex items-center gap-2 px-2 py-2 rounded-lg bg-slate-800/50">
              <Avatar className="w-8 h-8 shrink-0">
                <AvatarFallback className="bg-gradient-to-br from-rose-500 to-orange-500 text-white text-xs">
                  {user.fullName?.charAt(0).toUpperCase() || user.email?.charAt(0).toUpperCase() || 'U'}
                </AvatarFallback>
              </Avatar>
              {!sidebarCollapsed && (
                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium truncate">{user.fullName || 'User'}</p>
                  <p className="text-xs text-slate-500 truncate">{user.email}</p>
                </div>
              )}
              <TooltipProvider delayDuration={0}>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      onClick={handleLogout}
                      className="p-1.5 rounded-md text-slate-400 hover:bg-slate-700 hover:text-red-400 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="right">Đăng xuất</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Breadcrumb / Topbar */}
        <header className="h-16 border-b border-slate-800 bg-slate-900/50 backdrop-blur flex items-center justify-between px-6">
          <BreadcrumbTrail />
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <Sparkles className="w-4 h-4 text-amber-400" />
            <span>Powered by Gemini 3.1 Flash Lite Preview</span>
          </div>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto bg-slate-950">
          {children}
        </div>
      </main>
    </div>
  );
}

function BreadcrumbTrail() {
  const { view } = useAppStore();
  const setView = useAppStore((s) => s.setView);

  const crumbs: { label: string; onClick?: () => void }[] = [];

  if (view.type === 'channels') {
    crumbs.push({ label: 'Kênh' });
  } else if (view.type === 'channel-detail') {
    crumbs.push({ label: 'Kênh', onClick: () => setView({ type: 'channels' }) });
    crumbs.push({ label: view.channelName });
  } else if (view.type === 'movie-detail') {
    crumbs.push({ label: 'Kênh', onClick: () => setView({ type: 'channels' }) });
    crumbs.push({ label: 'Bộ phim', onClick: () => setView({ type: 'channel-detail', channelId: view.channelId, channelName: 'Bộ phim' }) });
    crumbs.push({ label: view.movieTitle });
  } else if (view.type === 'api-keys') {
    crumbs.push({ label: 'API Keys' });
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      {crumbs.map((crumb, i) => (
        <div key={i} className="flex items-center gap-2">
          {i > 0 && <span className="text-slate-600">/</span>}
          {crumb.onClick ? (
            <button
              onClick={crumb.onClick}
              className="text-slate-400 hover:text-white transition-colors"
            >
              {crumb.label}
            </button>
          ) : (
            <span className="text-white font-medium">{crumb.label}</span>
          )}
        </div>
      ))}
    </div>
  );
}
