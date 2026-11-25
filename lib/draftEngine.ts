import { DraftStep, GameMode } from './types';

// 随机征召共享英雄池大小（Dota 2 Random Draft 标准）
export const RANDOM_DRAFT_POOL_SIZE = 20;

// 全英雄选择（All Pick）：标准路人规则，双方各 5 禁 5 选。
// ban 阶段交替进行，pick 阶段交替进行。
export const ALL_PICK_SEQUENCE: DraftStep[] = (() => {
  const steps: DraftStep[] = [];
  for (let i = 0; i < 10; i++) {
    steps.push({ team: i % 2 === 0 ? 'radiant' : 'dire', action: 'ban', phase: 1 });
  }
  for (let i = 0; i < 10; i++) {
    steps.push({ team: i % 2 === 0 ? 'radiant' : 'dire', action: 'pick', phase: 2 });
  }
  return steps;
})();

// 随机征召（Random Draft）：从共享随机池（20 人）中双方轮流选取，无禁用阶段。
// Dota 2 标准先手顺序：R, D, R, D, R, D, D, R, D, R（第 7 手交换先手）。
export const RANDOM_DRAFT_SEQUENCE: DraftStep[] = [
  { team: 'radiant', action: 'pick', phase: 1 },
  { team: 'dire', action: 'pick', phase: 1 },
  { team: 'radiant', action: 'pick', phase: 1 },
  { team: 'dire', action: 'pick', phase: 1 },
  { team: 'radiant', action: 'pick', phase: 1 },
  { team: 'dire', action: 'pick', phase: 1 },
  { team: 'dire', action: 'pick', phase: 1 },
  { team: 'radiant', action: 'pick', phase: 1 },
  { team: 'dire', action: 'pick', phase: 1 },
  { team: 'radiant', action: 'pick', phase: 1 },
];

export function getSequence(mode: GameMode): DraftStep[] {
  return mode === 'allpick' ? ALL_PICK_SEQUENCE : RANDOM_DRAFT_SEQUENCE;
}

export function getPhaseLabel(step: DraftStep, lang: 'en' | 'zh'): string {
  const phaseMap = {
    en: { ban: 'Ban', pick: 'Pick' },
    zh: { ban: '禁用', pick: '选取' },
  };
  const phaseNum = lang === 'zh'
    ? `第${step.phase}阶段`
    : `Phase ${step.phase}`;
  return `${phaseMap[lang][step.action]} • ${phaseNum}`;
}
