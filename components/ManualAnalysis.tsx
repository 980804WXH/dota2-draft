'use client';

import { useMemo, useState } from 'react';
import { Hero, Team } from '@/lib/types';
import { Language, ls } from '@/lib/i18n';
import { useDraftStore } from '@/store/draftStore';
import { getHeroDisplayName } from '@/lib/heroNames';
import { calcPubWinRate, isPatchWinRate } from '@/lib/opendota';
import HeroCard from './HeroCard';
import DraftSummary from './DraftSummary';
import clsx from 'clsx';

interface ManualAnalysisProps {
  lang: Language;
}

const MAX_PICKS = 5;

/** 手动选择双方阵容进行分析（替代截图识别方案） */
export default function ManualAnalysis({ lang }: ManualAnalysisProps) {
  const { heroes, heroesLoaded } = useDraftStore();
  const [editingTeam, setEditingTeam] = useState<Team>('radiant');
  const [radiantPicks, setRadiantPicks] = useState<Hero[]>([]);
  const [direPicks, setDirePicks] = useState<Hero[]>([]);
  const [search, setSearch] = useState('');
  const [showResult, setShowResult] = useState(false);

  const usedIds = useMemo(
    () => new Set([...radiantPicks, ...direPicks].map((h) => h.id)),
    [radiantPicks, direPicks]
  );

  const pool = useMemo(() => {
    if (!search.trim()) return heroes;
    const q = search.toLowerCase();
    return heroes.filter(
      (h) =>
        h.localized_name.toLowerCase().includes(q) ||
        h.name.toLowerCase().includes(q) ||
        getHeroDisplayName(h, 'zh').includes(search)
    );
  }, [heroes, search]);

  const toggleHero = (hero: Hero) => {
    setShowResult(false);
    const target = editingTeam === 'radiant' ? radiantPicks : direPicks;
    const setter = editingTeam === 'radiant' ? setRadiantPicks : setDirePicks;
    if (usedIds.has(hero.id)) {
      // 若已选，则从所属队伍移除
      setRadiantPicks((p) => p.filter((h) => h.id !== hero.id));
      setDirePicks((p) => p.filter((h) => h.id !== hero.id));
      return;
    }
    if (target.length >= MAX_PICKS) return;
    setter([...target, hero]);
  };

  const removeHero = (team: Team, hero: Hero) => {
    setShowResult(false);
    if (team === 'radiant') setRadiantPicks((p) => p.filter((h) => h.id !== hero.id));
    else setDirePicks((p) => p.filter((h) => h.id !== hero.id));
  };

  const clearAll = () => {
    setRadiantPicks([]);
    setDirePicks([]);
    setShowResult(false);
  };

  const ready = radiantPicks.length === MAX_PICKS && direPicks.length === MAX_PICKS;

  if (!heroesLoaded) {
    return (
      <div className="bg-game-panel/80 border border-game-border rounded-lg p-6 text-center text-gray-400">
        {ls(lang, '加载英雄数据...', 'Laddar hjältar...', 'Loading heroes...')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 说明 */}
      <div className="bg-game-panel/80 border border-game-border rounded-lg p-3 text-xs text-gray-400">
        {ls(
          lang,
          '手动为天辉和夜魇各选择 5 个英雄，系统将结合最新版本胜率与阵容协同给出对比分析。点击英雄加入当前编辑的队伍，再次点击可移除。',
          'Välj 5 hjältar vardera för Radiant och Dire. Klicka på en hjälte för att lägga till i den aktiva raden, klicka igen för att ta bort.',
          'Pick 5 heroes each for Radiant and Dire. Click a hero to add it to the active team, click again to remove.'
        )}
      </div>

      {/* 两个队伍栏 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {(['radiant', 'dire'] as Team[]).map((team) => {
          const picks = team === 'radiant' ? radiantPicks : direPicks;
          const isRadiant = team === 'radiant';
          const slots = Array.from({ length: MAX_PICKS }, (_, i) => picks[i] ?? null);
          return (
            <div
              key={team}
              onClick={() => setEditingTeam(team)}
              className={clsx(
                'rounded-lg border p-3 cursor-pointer transition-colors',
                editingTeam === team
                  ? isRadiant
                    ? 'border-radiant/60 bg-radiant/5'
                    : 'border-dire/60 bg-dire/5'
                  : 'border-game-border bg-game-panel/60'
              )}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className={clsx('w-2 h-2 rounded-full', isRadiant ? 'bg-radiant' : 'bg-dire')} />
                  <h3 className={clsx('font-bold text-sm', isRadiant ? 'text-radiant-glow' : 'text-dire-glow')}>
                    {team === 'radiant' ? ls(lang, '天辉', 'Radiant', 'Radiant') : ls(lang, '夜魇', 'Dire', 'Dire')}
                  </h3>
                  <span className="text-[10px] text-gray-500">{picks.length}/{MAX_PICKS}</span>
                </div>
                {editingTeam === team && (
                  <span className="text-[10px] text-game-gold">{ls(lang, '编辑中', 'Redigerar', 'Editing')}</span>
                )}
              </div>
              <div className="grid grid-cols-5 gap-1.5">
                {slots.map((hero, i) => (
                  <div key={i} className="aspect-square rounded border border-gray-700/60 bg-gray-900/50 flex items-center justify-center overflow-hidden">
                    {hero ? (
                      <div className="relative group w-full h-full" onClick={(e) => { e.stopPropagation(); removeHero(team, hero); }}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={hero.icon_url} alt={hero.localized_name} className="w-full h-full object-cover" />
                        <span className="absolute inset-0 bg-red-900/70 opacity-0 group-hover:opacity-100 flex items-center justify-center text-white text-lg transition-opacity">×</span>
                      </div>
                    ) : (
                      <span className="text-gray-700 text-xl">+</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* 英雄池搜索 + 网格 */}
      <div className="bg-game-panel/80 border border-game-border rounded-lg p-3">
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-game-gold font-bold text-sm">{ls(lang, '英雄池', 'Hjältepool', 'Hero Pool')}</h3>
          <button
            onClick={clearAll}
            className="px-2 py-0.5 text-[10px] rounded border border-gray-700 text-gray-400 hover:text-gray-200 hover:border-gray-500"
          >
            {ls(lang, '清空', 'Rensa', 'Clear')}
          </button>
        </div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={ls(lang, '搜索英雄...', 'Sök hjältar...', 'Search heroes...')}
          className="w-full bg-gray-900 border border-gray-700 rounded px-2 py-1.5 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-game-gold/50 mb-2"
        />
        <div className="overflow-y-auto" style={{ maxHeight: '320px' }}>
          <div className="grid gap-1" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(60px, 1fr))' }}>
            {pool.map((hero) => {
              const used = usedIds.has(hero.id);
              const patchWR = calcPubWinRate(hero);
              return (
                <div key={hero.id} onClick={() => toggleHero(hero)} className={clsx('cursor-pointer rounded', used && 'opacity-30')}>
                  <HeroCard
                    hero={hero}
                    displayName={getHeroDisplayName(hero, lang)}
                    size="sm"
                    lang={lang}
                    isPicked={used}
                    showStats={false}
                  />
                  <div className={clsx('text-center text-[9px] leading-none mt-0.5', isPatchWinRate(hero) ? 'text-game-gold' : 'text-gray-600')} title={`${(patchWR * 100).toFixed(1)}%`}>
                    {(patchWR * 100).toFixed(0)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* 分析按钮 */}
      <div className="flex items-center justify-center gap-3">
        <button
          onClick={() => setShowResult(true)}
          disabled={!ready}
          className="px-6 py-2 bg-game-gold text-black font-bold rounded hover:bg-game-gold-light disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
        >
          {ls(lang, '分析阵容', 'Analysera lag', 'Analyze lineups')}
        </button>
        {!ready && (
          <span className="text-[10px] text-gray-500">
            {ls(lang, '双方各需选满 5 人', 'Båda lagen behöver 5 hjältar', 'Both teams need 5 heroes')}
          </span>
        )}
      </div>

      {/* 分析结果 */}
      {showResult && ready && (
        <DraftSummary
          radiantPicks={radiantPicks}
          direPicks={direPicks}
          lang={lang}
          onReset={clearAll}
        />
      )}
    </div>
  );
}
