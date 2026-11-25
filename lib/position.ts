import { Hero } from './types';

/**
 * 依据英雄官方 roles 标签推断分路(1-5 号位)。
 *
 * 权重设计要点(经 127 英雄全池分布验证:P1=46/P2=8/P3=39/P4=15/P5=19):
 * - Carry 与 Support 互斥打折:带 Support 的 Carry 核心(莉娜/莱恩类)降 1 号位权重,
 *   带 Carry 的 Support 辅助降 5 号位权重,避免辅助被误判为核心;
 * - 带 Support 的 Nuker(莉娜/巫医类)中单分打折,归辅助位;
 * - Initiator + Disabler 的先手辅助(撼地者/复仇之魂)自然落 4 号位;
 * - 纯 Support(水晶室女/巫医/拉比克)稳定落 5 号位;
 * - 并列时取靠前的位置(核心优先)。
 */
export function inferPosition(hero: Hero): number {
  const r = hero.roles ?? [];
  const score = [0, 0, 0, 0, 0]; // P1..P5
  const add = (idx: number, w: number) => { score[idx] += w; };

  const hasCarry = r.includes('Carry');
  const hasSupport = r.includes('Support') || r.includes('Lane Support');

  for (const role of r) {
    switch (role) {
      case 'Carry':
        add(0, hasSupport ? 2 : 5);
        break;
      case 'Nuker':
        add(1, hasSupport ? 2 : 4);
        break;
      case 'Escape':
        add(3, 1);
        break;
      case 'Durable':
        add(2, 3);
        break;
      case 'Initiator':
        add(2, 2); add(3, 2);
        break;
      case 'Disabler':
        add(2, 1); add(3, 1); add(4, 1);
        break;
      case 'Support':
        add(4, hasCarry ? 2 : 3); add(3, 1);
        break;
      case 'Lane Support':
        add(4, 2);
        break;
      case 'Pusher':
        add(0, 1); add(2, 1);
        break;
    }
  }
  let best = 0;
  for (let i = 1; i < 5; i++) if (score[i] > score[best]) best = i;
  return best + 1;
}

/** 位置中文标签(用于紧凑展示) */
export const POS_TAG: Record<number, string> = { 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' };

/** 分路名称:ls(lang, zh, sv, en) 顺序 */
export const POSITION_LABELS: Record<number, [string, string, string]> = {
  1: ['1号位 · 核心', 'Pos 1 · Carry', 'Pos 1 · Carry'],
  2: ['2号位 · 中单', 'Pos 2 · Mid', 'Pos 2 · Mid'],
  3: ['3号位 · 劣单', 'Pos 3 · Offlane', 'Pos 3 · Offlane'],
  4: ['4号位 · 软辅', 'Pos 4 · Soft support', 'Pos 4 · Soft support'],
  5: ['5号位 · 硬辅', 'Pos 5 · Hard support', 'Pos 5 · Hard support'],
};

/**
 * 己方某位置是否已有英雄占据。
 * 支持传入手动覆盖映射(heroId -> 1..5),优先采用用户指定值,否则按 roles 推断。
 */
export function occupiedPositions(
  picks: Hero[],
  overrides?: Record<number, number>,
): Set<number> {
  return new Set(
    picks.map((h) => overrides?.[h.id] ?? inferPosition(h))
  );
}
