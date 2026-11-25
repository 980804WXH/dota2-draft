'use client';

import { create } from 'zustand';
import { Hero, GameMode, Team, DraftState } from '@/lib/types';
import { Language } from '@/lib/i18n';
import { getSequence, RANDOM_DRAFT_POOL_SIZE } from '@/lib/draftEngine';

export type SortBy = 'alpha' | 'pro_pick' | 'pro_ban' | 'pro_win' | 'pub_win';
export type SortDir = 'desc' | 'asc';

interface DraftStore extends DraftState {
  // UI state
  language: Language;
  heroes: Hero[];
  heroesLoaded: boolean;
  // 随机征召的共享英雄池（英雄 id），其余模式为空
  randomPool: number[];
  matchupCache: Record<number, { hero_id: number; games_played: number; wins: number }[]>;
  searchQuery: string;
  attrFilter: string;
  sortBy: SortBy;
  sortDir: SortDir;

  // Actions
  setLanguage: (lang: Language) => void;
  setHeroes: (heroes: Hero[]) => void;
  setMode: (mode: GameMode) => void;
  rollRandomPool: () => void;
  selectHero: (hero: Hero) => void;
  undoLastAction: () => void;
  resetDraft: () => void;
  setMatchupData: (heroId: number, data: { hero_id: number; games_played: number; wins: number }[]) => void;
  setSearchQuery: (q: string) => void;
  setAttrFilter: (attr: string) => void;
  setSortBy: (s: SortBy) => void;
  setSortDir: (d: SortDir) => void;

  // Derived
  getBannedHeroIds: () => Set<number>;
  getPickedHeroIds: () => Set<number>;
  getCurrentStep: () => import('@/lib/types').DraftStep | null;
  getActiveTeam: () => Team | null;
}

function createInitialDraftState(mode: GameMode): Omit<DraftState, 'mode'> {
  return {
    currentStep: 0,
    radiantBans: [],
    radiantPicks: [],
    direBans: [],
    direPicks: [],
    sequence: getSequence(mode),
    isComplete: false,
  };
}

// 从全部英雄中随机抽取共享池
function generateRandomPool(heroes: Hero[]): number[] {
  const ids = heroes.map((h) => h.id);
  // Fisher-Yates 洗牌
  for (let i = ids.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [ids[i], ids[j]] = [ids[j], ids[i]];
  }
  return ids.slice(0, Math.min(RANDOM_DRAFT_POOL_SIZE, ids.length));
}

export const useDraftStore = create<DraftStore>((set, get) => ({
  // Draft state
  mode: 'allpick',
  ...createInitialDraftState('allpick'),

  // UI state
  language: 'zh',
  heroes: [],
  heroesLoaded: false,
  randomPool: [],
  matchupCache: {},
  searchQuery: '',
  attrFilter: 'all',
  sortBy: 'alpha',
  sortDir: 'desc',

  setLanguage: (lang) => set({ language: lang }),

  setHeroes: (heroes) =>
    set((state) => ({
      heroes,
      heroesLoaded: true,
      // 若当前处于随机征召且尚无池，则初始化一个
      randomPool:
        state.mode === 'randomdraft' && state.randomPool.length === 0
          ? generateRandomPool(heroes)
          : state.randomPool,
    })),

  setMode: (mode) =>
    set((state) => ({
      mode,
      ...createInitialDraftState(mode),
      // 切到随机征召时生成新池；离开时清空
      randomPool:
        mode === 'randomdraft' ? generateRandomPool(state.heroes) : [],
    })),

  rollRandomPool: () =>
    set((state) => ({
      randomPool: generateRandomPool(state.heroes),
      ...createInitialDraftState('randomdraft'),
    })),

  selectHero: (hero) =>
    set((state) => {
      if (state.isComplete) return state;
      const step = state.sequence[state.currentStep];
      if (!step) return state;
      // 随机征召模式只能在共享池内选取
      if (state.mode === 'randomdraft' && !state.randomPool.includes(hero.id)) return state;

      const nextStep = state.currentStep + 1;
      const isComplete = nextStep >= state.sequence.length;

      const updates: Partial<DraftStore> = { currentStep: nextStep, isComplete };

      if (step.team === 'radiant' && step.action === 'ban') {
        updates.radiantBans = [...state.radiantBans, hero];
      } else if (step.team === 'radiant' && step.action === 'pick') {
        updates.radiantPicks = [...state.radiantPicks, hero];
      } else if (step.team === 'dire' && step.action === 'ban') {
        updates.direBans = [...state.direBans, hero];
      } else if (step.team === 'dire' && step.action === 'pick') {
        updates.direPicks = [...state.direPicks, hero];
      }

      return updates;
    }),

  undoLastAction: () =>
    set((state) => {
      if (state.currentStep === 0) return state;
      const prevStep = state.currentStep - 1;
      const step = state.sequence[prevStep];
      if (!step) return state;

      const updates: Partial<DraftStore> = { currentStep: prevStep, isComplete: false };

      if (step.team === 'radiant' && step.action === 'ban') {
        updates.radiantBans = state.radiantBans.slice(0, -1);
      } else if (step.team === 'radiant' && step.action === 'pick') {
        updates.radiantPicks = state.radiantPicks.slice(0, -1);
      } else if (step.team === 'dire' && step.action === 'ban') {
        updates.direBans = state.direBans.slice(0, -1);
      } else if (step.team === 'dire' && step.action === 'pick') {
        updates.direPicks = state.direPicks.slice(0, -1);
      }

      return updates;
    }),

  resetDraft: () =>
    set((state) => ({
      ...createInitialDraftState(state.mode),
    })),

  setMatchupData: (heroId, data) =>
    set((state) => ({
      matchupCache: { ...state.matchupCache, [heroId]: data },
    })),

  setSearchQuery: (q) => set({ searchQuery: q }),
  setAttrFilter: (attr) => set({ attrFilter: attr }),
  setSortBy: (s) => set({ sortBy: s }),
  setSortDir: (d) => set({ sortDir: d }),

  getBannedHeroIds: () => {
    const s = get();
    return new Set([
      ...s.radiantBans.map((h) => h.id),
      ...s.direBans.map((h) => h.id),
    ]);
  },

  getPickedHeroIds: () => {
    const s = get();
    return new Set([
      ...s.radiantPicks.map((h) => h.id),
      ...s.direPicks.map((h) => h.id),
    ]);
  },

  getCurrentStep: () => {
    const s = get();
    return s.sequence[s.currentStep] ?? null;
  },

  getActiveTeam: () => {
    const s = get();
    const step = s.sequence[s.currentStep];
    return step?.team ?? null;
  },
}));
