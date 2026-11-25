'use client';

import { useEffect, useMemo, useState } from 'react';
import { Hero, HeroMatchup } from '@/lib/types';
import { Language, ls } from '@/lib/i18n';
import { useDraftStore } from '@/store/draftStore';
import { getHeroDisplayName } from '@/lib/heroNames';
import { MIN_SYNERGY_SAMPLES } from '@/lib/opendota';
import {
  analyzePickHero,
  PickAnalysis,
  scorePickHeroFull,
  PickScoreParts,
  SynergyScore,
} from '@/lib/scoreEngine';
import { inferPosition, POSITION_LABELS, occupiedPositions } from '@/lib/position';
import HeroCard from './HeroCard';
import clsx from 'clsx';

interface GSIRecommendationsProps {
  /** 本地玩家所在队伍已选英雄 */
  myPicks: Hero[];
  /** 敌方已选英雄 */
  enemyPicks: Hero[];
  /** 双方已禁用英雄 */
  bannedHeroes: Hero[];
  /** 用户手动指定的分路覆盖(heroId -> 1..5) */
  positionOverrides?: Record<number, number>;
  lang: Language;
}

interface ScoredEntry {
  hero: Hero;
  analysis: PickAnalysis;
  score: number;
  parts: PickScoreParts;
}

const PER_GROUP = 6;           // 每个分路展示的推荐数
const VACANT_BONUS = 0.04;     // 补空缺位置加成
const OCCUPIED_PENALTY = 0.02; // 位置已被占时的轻微降权

/**
 * 实时对局补位推荐:
 * 基于双方已选阵容,按 1-5 号位分组、组内按推荐指数排序。
 *
 * 综合指数 = 版本胜率 + 克制对方 + 己方配合(见 scorePickHeroFull)
 *  - 克制:预取「敌方已选 + 双方禁用」的对位表,反转为候选视角;
 *  - 配合:一次性预取「己方已选」英雄的同队组合胜率表(synergy)。
 */
export default function GSIRecommendations({
  myPicks,
  enemyPicks,
  bannedHeroes,
  positionOverrides,
  lang,
}: GSIRecommendationsProps) {
  const { heroes, matchupCache, setMatchupData } = useDraftStore();
  // 组合胜率表:anchor(己方英雄id) -> 同队英雄列表
  const [synergyData, setSynergyData] = useState<Record<number, HeroMatchup[]>>({});
  const [synergyLoading, setSynergyLoading] = useState(false);

  // ── 1. 预取锚点英雄的对位表(敌方已选 + 双方禁用,未缓存的) ──
  const anchorIds = useMemo(
    () => [...enemyPicks.map((h) => h.id), ...bannedHeroes.map((h) => h.id)],
    [enemyPicks, bannedHeroes]
  );

  useEffect(() => {
    const missing = anchorIds.filter((id) => !matchupCache[id]);
    if (missing.length === 0) return;
    missing.forEach((id) => {
      fetch(`/api/matchups/${id}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data) => setMatchupData(id, data as HeroMatchup[]))
        .catch(() => { /* 单个英雄预取失败不阻塞整体推荐 */ });
    });
  }, [anchorIds, matchupCache, setMatchupData]);

  // ── 2. 反转对位缓存:锚点视角 → 候选视角 ──
  const reversedCache = useMemo(() => {
    const cache: Record<number, HeroMatchup[]> = {};
    const anchors = [...enemyPicks, ...bannedHeroes];
    for (const a of anchors) {
      const table = matchupCache[a.id];
      if (!table) continue;
      for (const m of table) {
        const list = (cache[m.hero_id] ??= []);
        list.push({
          hero_id: a.id,
          games_played: m.games_played,
          wins: m.games_played - m.wins, // 候选对锚点的胜场
        });
      }
    }
    return cache;
  }, [enemyPicks, bannedHeroes, matchupCache]);

  const matchupLoading = anchorIds.length > 0 && anchorIds.some((id) => !matchupCache[id]);

  // ── 3. 预取己方英雄的同队组合胜率(synergy) ──
  // key 用排序后的 id 串,保证阵容稳定时不重复请求
  const myKey = useMemo(
    () => myPicks.map((h) => h.id).sort((a, b) => a - b).join(','),
    [myPicks]
  );
  useEffect(() => {
    if (!myKey) { setSynergyData({}); return; }
    let cancelled = false;
    setSynergyLoading(true);
    fetch(`/api/synergy?heroes=${myKey}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((data) => { if (!cancelled) setSynergyData(data as Record<number, HeroMatchup[]>); })
      .catch(() => { if (!cancelled) setSynergyData({}); })
      .finally(() => { if (!cancelled) setSynergyLoading(false); });
    return () => { cancelled = true; };
  }, [myKey]);

  /** 候选与己方每个已选英雄的同队组合胜率均值 */
  const calcSynergy = useMemo(() => {
    // 预建 Map 加速查找:anchorId -> (partnerId -> matchup)
    const tables = new Map<number, Map<number, HeroMatchup>>();
    for (const [k, list] of Object.entries(synergyData)) {
      tables.set(Number(k), new Map(list.map((m) => [m.hero_id, m])));
    }
    return (candidateId: number): SynergyScore => {
      let total = 0;
      let count = 0;
      for (const ally of myPicks) {
        const m = tables.get(ally.id)?.get(candidateId);
        if (m && m.games_played >= MIN_SYNERGY_SAMPLES) {
          total += m.wins / m.games_played;
          count++;
        }
      }
      return { score: count > 0 ? total / count : 0.5, dataPoints: count };
    };
  }, [synergyData, myPicks]);

  // ── 4. 候选评分 + 分路分组 ──
  const occupied = useMemo(
    () => occupiedPositions(myPicks, positionOverrides),
    [myPicks, positionOverrides]
  );
  const takenIds = useMemo(
    () => new Set([...myPicks, ...enemyPicks, ...bannedHeroes].map((h) => h.id)),
    [myPicks, enemyPicks, bannedHeroes]
  );

  const groups = useMemo(() => {
    if (heroes.length === 0) return [];
    const scored: { hero: Hero; analysis: PickAnalysis; score: number; parts: PickScoreParts; pos: number }[] = [];
    for (const hero of heroes) {
      if (takenIds.has(hero.id)) continue;
      const analysis = analyzePickHero(hero, myPicks, enemyPicks, bannedHeroes, reversedCache);
      const { score, parts } = scorePickHeroFull(hero, analysis, calcSynergy(hero.id));
      const pos = inferPosition(hero);
      const adjusted = score + (occupied.has(pos) ? -OCCUPIED_PENALTY : VACANT_BONUS);
      scored.push({ hero, analysis, score: adjusted, parts, pos });
    }
    return [1, 2, 3, 4, 5]
      .map((pos) => ({
        pos,
        vacant: !occupied.has(pos),
        top: scored
          .filter((s) => s.pos === pos)
          .sort((a, b) => b.score - a.score)
          .slice(0, PER_GROUP),
      }))
      .sort((a, b) => Number(b.vacant) - Number(a.vacant));
  }, [heroes, takenIds, myPicks, enemyPicks, bannedHeroes, reversedCache, occupied, calcSynergy]);

  if (myPicks.length + enemyPicks.length === 0) {
    return (
      <div className="bg-game-panel/80 border border-game-border rounded-lg p-4 text-center text-xs text-gray-500">
        {ls(lang, '选人开始后将基于双方阵容给出分路补位推荐', 'Rekommendationer visas när draften börjar', 'Recommendations appear once the draft starts')}
      </div>
    );
  }

  const wrColor = (wr: number) =>
    wr >= 0.54 ? 'text-green-400' : wr < 0.48 ? 'text-red-400' : 'text-yellow-400';

  return (
    <div className="bg-game-panel/80 border border-game-border rounded-lg p-3">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <h3 className="text-sm font-bold text-game-gold">
          {ls(lang, '补位推荐', 'Rekommendationer', 'Fill-in recommendations')}
        </h3>
        <div className="text-[10px] text-gray-500">
          {ls(lang, '版本胜率 40% + 克制对方 35% + 己方配合 25% · 按分路分组、指数排序',
            'Vinst 40% + Counter 35% + Synergi 25% · per lane',
            'Win rate 40% + Counter 35% + Synergy 25% · by lane, sorted by score')}
        </div>
      </div>

      {(matchupLoading || synergyLoading) && (
        <div className="mb-2 text-[10px] text-gray-500">
          {ls(lang, '对位与组合数据加载中,克制/配合关系将逐步生效…',
            'Laddar match- och kombinationsdata…',
            'Loading matchup & synergy data, counters/combos will refine…')}
        </div>
      )}

      <div className="flex flex-col gap-2.5">
        {groups.map((g) => {
          const label = POSITION_LABELS[g.pos];
          return (
            <div key={g.pos} className={clsx(
              'rounded border p-2',
              g.vacant ? 'border-game-gold/30 bg-game-gold/5' : 'border-gray-700/60 bg-gray-900/30'
            )}>
              <div className="flex items-center gap-2 mb-1.5">
                <span className={clsx('text-xs font-bold', g.vacant ? 'text-game-gold' : 'text-gray-400')}>
                  {ls(lang, label[0], label[1], label[2])}
                </span>
                {g.vacant ? (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-game-gold/20 text-game-gold">
                    {ls(lang, '空缺', 'Ledig', 'Open')}
                  </span>
                ) : (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-700/40 text-gray-500">
                    {ls(lang, '已占 · 补强', 'Upptagen', 'Filled')}
                  </span>
                )}
              </div>
              {g.top.length === 0 ? (
                <div className="text-[10px] text-gray-600">
                  {ls(lang, '无合适候选', 'Inga kandidater', 'No candidates')}
                </div>
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {g.top.map((entry, idx) => (
                    <div
                      key={entry.hero.id}
                      className="w-[116px] shrink-0 rounded border border-gray-700/60 bg-gray-900/60 p-1.5 relative"
                    >
                      <span className="absolute top-0.5 left-1 text-[10px] font-bold text-game-gold/80 z-10">
                        #{idx + 1}
                      </span>
                      <HeroCard
                        hero={entry.hero}
                        displayName={getHeroDisplayName(entry.hero, lang)}
                        size="sm"
                        lang={lang}
                        showStats={false}
                      />
                      <div className="mt-1 text-[11px] font-bold text-game-gold">
                        {ls(lang, '指数', 'Idx', 'Score')} {Math.round(entry.score * 100)}
                      </div>
                      <div className="text-[10px] text-gray-400 flex flex-col gap-0.5">
                        <span>
                          {ls(lang, '版本', 'Patch', 'Patch')}:{' '}
                          <span className={wrColor(entry.parts.patchWR)}>
                            {Math.round(entry.parts.patchWR * 100)}%
                          </span>
                        </span>
                        <span>
                          {ls(lang, '克制', 'Counter', 'Counter')}:{' '}
                          {entry.parts.counterDataPoints > 0 ? (
                            <span className={wrColor(entry.parts.counter)}>
                              {Math.round(entry.parts.counter * 100)}%
                            </span>
                          ) : (
                            <span className="text-gray-600">{ls(lang, '样本不足', 'ej data', 'no data')}</span>
                          )}
                        </span>
                        <span>
                          {ls(lang, '配合', 'Synergi', 'Synergy')}:{' '}
                          {entry.parts.synergyDataPoints > 0 ? (
                            <span className={wrColor(entry.parts.synergy)}>
                              {Math.round(entry.parts.synergy * 100)}%
                            </span>
                          ) : (
                            <span className="text-gray-600">{ls(lang, '样本不足', 'ej data', 'no data')}</span>
                          )}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
