import { create } from 'zustand';

export type ViewType =
  | { type: 'channels' }
  | { type: 'channel-detail'; channelId: string; channelName: string }
  | { type: 'movie-detail'; movieId: string; movieTitle: string; channelId: string }
  | { type: 'api-keys' };

interface AppState {
  view: ViewType;
  sidebarCollapsed: boolean;
  setView: (view: ViewType) => void;
  toggleSidebar: () => void;
  setSidebarCollapsed: (collapsed: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  view: { type: 'channels' },
  sidebarCollapsed: false,
  setView: (view) => set({ view }),
  toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
  setSidebarCollapsed: (collapsed) => set({ sidebarCollapsed: collapsed }),
}));
