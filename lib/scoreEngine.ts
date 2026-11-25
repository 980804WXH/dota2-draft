import { Hero, HeroMatchup } from './types';
import { calcProWinRate, calcPubWinRate, calcMatchupWinRate, getEffectiveWinRate } from './opendota';

export interface PickAnalysis {
  proWinRate: number;
  pubWinRate: number;
  // Hero's win rate vs each enemy pick (0 = no data)
  counterScore: number;
  counterDataPoints: number;
  // Role gap fill bonus
  synergyBonus: number;
  // Final combined lineup win rate estimate
  combinedWinRate: number;
  reasons: string[];
  // How many heroes that counter this pick have been banned (safety indicator)
  bannedCounterCount: number;
  bannedCounterBonus: number;
}

export interface BanAnalysis {
  proBanRate: number;
  heroStrength: number;
  // How well this hero performs vs our current lineup (higher = more threatening)
  threatScore: number;
  threatDataPoints: number;
  // Estimated our win rate after banning this hero
  winRateIfBanned: number;
  banPriority: 'critical' | 'high' | 'medium' | 'low';
  // How many important roles this hero fills that enemy team is missing
  enemyRoleGapFill: number;
}

export function analyzePickHero(
  hero: Hero,
  myPicks: Hero[],
  enemyPicks: Hero[],
  allBannedHeroes: Hero[],
  matchupCache: Record<number, HeroMatchup[]>,
): PickAnalysis {
  const proWR = calcProWinRate(hero);
  const pubWR = calcPubWinRate(hero);
  // 以最新版本路人胜率为主（getEffectiveWinRate 内部优先路人数据）
  const baseWR = getEffectiveWinRate(hero);

  // Counter score: this hero's win rate vs each enemy pick
  const heroMatchups = matchupCache[hero.id] ?? [];
  const heroMatchupMap = new Map(heroMatchups.map((m) => [m.hero_id, m]));

  let counterScore = 0.5;
  let counterDataPoints = 0;
  if (enemyPicks.length > 0) {
    let total = 0;
    let count = 0;
    for (const enemy of enemyPicks) {
      const m = heroMatchupMap.get(enemy.id);
      if (m && m.games_played > 50) {
        total += calcMatchupWinRate(m);
        count++;
      }
    }
    if (count > 0) {
      counterScore = total / count;
      counterDataPoints = count;
    }
  }

  // Synergy bonus: fills role gaps in current lineup
  const myRoles = new Set(myPicks.flatMap((h) => h.roles));
  let synergyBonus = 0;
  const importantRoles = ['Carry', 'Support', 'Initiator', 'Nuker', 'Disabler'];
  let gapsFilled = 0;
  for (const role of hero.roles) {
    if (importantRoles.includes(role) && !myRoles.has(role)) gapsFilled++;
  }
  synergyBonus = Math.min(gapsFilled * 0.015, 0.04);

  // Banned counter bonus: if heroes that counter this pick have been banned, it becomes safer
  let bannedCounterCount = 0;
  let bannedCounterBonus = 0;
  for (const bannedHero of allBannedHeroes) {
    const m = heroMatchupMap.get(bannedHero.id);
    if (m && m.games_played > 50) {
      const wrVsBanned = calcMatchupWinRate(m);
      if (wrVsBanned < 0.48) {
        // This banned hero was a counter to our candidate — its removal is a safety boost
        bannedCounterBonus += (0.48 - wrVsBanned) * 0.3;
        bannedCounterCount++;
      }
    }
  }
  bannedCounterBonus = Math.min(bannedCounterBonus, 0.03);

  // Combined lineup win rate: base + counter adjustment + synergy + banned-counter safety
  const counterAdj = counterDataPoints > 0 ? (counterScore - 0.5) * 0.45 : 0;
  const combinedWinRate = Math.min(0.78, Math.max(0.28, baseWR + counterAdj + synergyBonus + bannedCounterBonus));

  const reasons: string[] = [];
  if (baseWR >= 0.54) reasons.push('high_wr');
  if (hero.pro_pick >= 50) reasons.push('meta');
  if (counterScore >= 0.54 && counterDataPoints > 0) reasons.push('counter');
  if (synergyBonus > 0.02) reasons.push('synergy');
  if (hero.roles.length >= 3) reasons.push('flex');
  if (bannedCounterCount > 0) reasons.push('safe_pick');

  return {
    proWinRate: proWR,
    pubWinRate: pubWR,
    counterScore: counterDataPoints > 0 ? counterScore : 0,
    counterDataPoints,
    synergyBonus,
    combinedWinRate,
    reasons,
    bannedCounterCount,
    bannedCounterBonus,
  };
}

export function analyzeBanHero(
  hero: Hero,
  myPicks: Hero[],
  enemyPicks: Hero[],
  matchupCache: Record<number, HeroMatchup[]>,
): BanAnalysis {
  const proWR = calcProWinRate(hero);
  const pubWR = calcPubWinRate(hero);
  const heroStrength = getEffectiveWinRate(hero);

  const totalPB = hero.pro_ban + hero.pro_pick;
  const proBanRate = totalPB > 10 ? hero.pro_ban / totalPB : 0;

  // Threat to our team: average of (1 - ally's win rate vs this hero)
  // = how well this hero performs vs each of our allies
  let threatScore = heroStrength;
  let threatDataPoints = 0;

  if (myPicks.length > 0) {
    let totalThreats = 0;
    let count = 0;
    for (const ally of myPicks) {
      const allyMatchups = matchupCache[ally.id] ?? [];
      const m = allyMatchups.find((mu) => mu.hero_id === hero.id);
      if (m && m.games_played > 50) {
        // This hero's win rate vs our ally = 1 - ally's win rate vs it
        totalThreats += 1 - calcMatchupWinRate(m);
        count++;
        threatDataPoints++;
      }
    }
    if (count > 0) threatScore = totalThreats / count;
  }

  // Enemy role gap: how many important roles this hero fills that enemy currently lacks
  // If it fills gaps in enemy's lineup, it's a natural pick for them → higher ban priority
  const importantRoles = ['Carry', 'Support', 'Initiator', 'Nuker', 'Disabler'];
  const enemyRoles = new Set(enemyPicks.flatMap((h) => h.roles));
  let enemyRoleGapFill = 0;
  if (enemyPicks.length > 0) {
    for (const role of hero.roles) {
      if (importantRoles.includes(role) && !enemyRoles.has(role)) enemyRoleGapFill++;
    }
  }
  const enemyFillAdj = enemyPicks.length > 0 ? enemyRoleGapFill * 0.01 : 0;

  // Our win rate improvement from banning this hero
  const banImpact = Math.max(0, (threatScore - 0.5) * 0.55);
  const winRateIfBanned = Math.min(0.78, 0.5 + banImpact);

  const banScore = heroStrength * 0.3 + threatScore * 0.4 + proBanRate * 0.3 + enemyFillAdj;
  let banPriority: BanAnalysis['banPriority'];
  if (banScore >= 0.60) banPriority = 'critical';
  else if (banScore >= 0.53) banPriority = 'high';
  else if (banScore >= 0.47) banPriority = 'medium';
  else banPriority = 'low';

  return {
    proBanRate,
    heroStrength,
    threatScore,
    threatDataPoints,
    winRateIfBanned,
    banPriority,
    enemyRoleGapFill,
  };
}

export function buildBanRecommendations(
  availableHeroes: Hero[],
  myPicks: Hero[],
  enemyPicks: Hero[],
  matchupCache: Record<number, HeroMatchup[]>,
) {
  return availableHeroes
    .map((hero) => {
      const analysis = analyzeBanHero(hero, myPicks, enemyPicks, matchupCache);
      const enemyFillAdj = enemyPicks.length > 0 ? analysis.enemyRoleGapFill * 0.01 : 0;
      const scoreA = analysis.heroStrength * 0.3 + analysis.threatScore * 0.4 + analysis.proBanRate * 0.3 + enemyFillAdj;
      return { hero, analysis, score: scoreA };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}

/**
 * 选人推荐指数:胜率 35% + 克制 40% + 协同 5% + 职业热度 20%。
 * buildPickRecommendations 与实时对局补位推荐共用,保证口径一致。
 */
export function scorePickHero(hero: Hero, analysis: PickAnalysis): number {
  return (
    getEffectiveWinRate(hero) * 0.35 +
    (analysis.counterDataPoints > 0 ? analysis.counterScore : 0.5) * 0.4 +
    analysis.synergyBonus * 0.05 +
    (hero.pro_pick > 0 ? Math.min(hero.pro_pick / 300, 1) : 0) * 0.2
  );
}

/** 己方配合评分结果 */
export interface SynergyScore {
  /** 候选与己方各英雄同队组合胜率的平均值(0.5 表示无数据/中性) */
  score: number;
  /** 参与计算的有效组合数 */
  dataPoints: number;
}

/** 综合评分的三个分项,便于 UI 展示"为什么推荐" */
export interface PickScoreParts {
  patchWR: number;    // 版本胜率
  counter: number;    // 克制对方
  synergy: number;    // 己方配合
  counterDataPoints: number;
  synergyDataPoints: number;
}

/**
 * 实时对局补位推荐的三因子综合指数。
 * 用户需求:版本胜率 + 克制对方 + 己方配合。
 *
 * 权重:版本胜率 0.40 / 克制 0.35 / 配合 0.25
 *  - 版本胜率(getEffectiveWinRate)本身已是"该英雄强度"的主信号,权重最高;
 *  - 克制与配合依赖历史对局样本,缺数据时以 0.5(中性)回退,避免噪声主导;
 *  - 三者都是 0~1 的胜率类量,可直接加权,量纲一致。
 */
export function scorePickHeroFull(
  hero: Hero,
  analysis: PickAnalysis,
  synergy: SynergyScore,
): { score: number; parts: PickScoreParts } {
  const patchWR = getEffectiveWinRate(hero);
  const counter = analysis.counterDataPoints > 0 ? analysis.counterScore : 0.5;
  const syn = synergy.dataPoints > 0 ? synergy.score : 0.5;

  const score = patchWR * 0.40 + counter * 0.35 + syn * 0.25;
  return {
    score,
    parts: {
      patchWR,
      counter,
      synergy: syn,
      counterDataPoints: analysis.counterDataPoints,
      synergyDataPoints: synergy.dataPoints,
    },
  };
}

export function buildPickRecommendations(
  availableHeroes: Hero[],
  myPicks: Hero[],
  enemyPicks: Hero[],
  allBannedHeroes: Hero[],
  matchupCache: Record<number, HeroMatchup[]>,
) {
  return availableHeroes
    .map((hero) => {
      const analysis = analyzePickHero(hero, myPicks, enemyPicks, allBannedHeroes, matchupCache);
      return { hero, analysis, score: scorePickHero(hero, analysis) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 12);
}
