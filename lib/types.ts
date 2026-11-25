export type Team = 'radiant' | 'dire';
export type ActionType = 'ban' | 'pick';
// 仅保留两种路人模式：全英雄选择、随机征召
export type GameMode = 'allpick' | 'randomdraft';
export type Language = 'en' | 'zh' | 'sv';
export type PrimaryAttr = 'agi' | 'str' | 'int' | 'all';

export interface DraftStep {
  team: Team;
  action: ActionType;
  phase: number;
}

export interface Hero {
  id: number;
  name: string;
  localized_name: string;
  primary_attr: PrimaryAttr;
  attack_type: 'Melee' | 'Ranged';
  roles: string[];
  pro_win: number;
  pro_pick: number;
  pro_ban: number;
  pub_win: number;
  pub_pick: number;
  // 最新版本（路人）胜率数据，由 OpenDota Explorer 按 patch 统计得到
  patchPubWin: number;
  patchPubGames: number;
  patchVersion: string;
  image_url: string;
  icon_url: string;
}

export interface HeroMatchup {
  hero_id: number;
  games_played: number;
  wins: number;
}

export interface Recommendation {
  hero: Hero;
  score: number;
  winRate: number;
  proWinRate: number;
  counterScore: number;
  reasons: string[];
}

export interface DraftState {
  mode: GameMode;
  currentStep: number;
  radiantBans: Hero[];
  radiantPicks: Hero[];
  direBans: Hero[];
  direPicks: Hero[];
  sequence: DraftStep[];
  isComplete: boolean;
}
