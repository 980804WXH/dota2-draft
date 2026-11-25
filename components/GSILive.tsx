'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Hero, Team } from '@/lib/types';
import { Language, ls } from '@/lib/i18n';
import { useDraftStore } from '@/store/draftStore';
import { getHeroDisplayName } from '@/lib/heroNames';
import { inferPosition, POS_TAG } from '@/lib/position';
import HeroCard from './HeroCard';
import DraftSummary from './DraftSummary';
import GSIRecommendations from './GSIRecommendations';
import clsx from 'clsx';

/** GSI 服务器 /state 返回的一条英雄引用（含 id 与 console name 两种兜底） */
interface HeroRef {
  id: number | null;
  name: string | null;
}

interface GsiState {
  connected: boolean;
  lastUpdate: number | null;
  ageSeconds: number | null;
  payloadCount: number;
  matchId: string | null;
  phase: string;
  activeTeam: string | null;
  localHero: HeroRef | null;
  localSide: string | null;
  radiant: { picks: HeroRef[]; bans: HeroRef[] };
  dire: { picks: HeroRef[]; bans: HeroRef[] };
  ready: boolean;
}

const EMPTY_STATE: GsiState = {
  connected: false,
  lastUpdate: null,
  ageSeconds: null,
  payloadCount: 0,
  matchId: null,
  phase: '—',
  activeTeam: null,
  localHero: null,
  localSide: null,
  radiant: { picks: [], bans: [] },
  dire: { picks: [], bans: [] },
  ready: false,
};

const DEFAULT_URL = 'http://127.0.0.1:8765';

// 阶段 -> 文案
const PHASE_LABEL: Record<string, [string, string, string]> = {
  picking: ['选人中', 'Väljer hjältar', 'Picking'],
  strategy: ['策略时间', 'Strategitid', 'Strategy time'],
  pregame: ['准备中', 'Förbereder', 'Pre-game'],
  playing: ['对局进行中', 'Spel pågår', 'In game'],
  postgame: ['对局结束', 'Matchen slut', 'Post-game'],
  loading: ['加载中', 'Laddar', 'Loading'],
  menu: ['主菜单', 'Huvudmeny', 'Main menu'],
};

/** 通过 GSI 实时读取对局阵容并分析（替代手动点选） */
export default function GSILive({ lang }: { lang: Language }) {
  const { heroes, heroesLoaded } = useDraftStore();
  const [url, setUrl] = useState(DEFAULT_URL);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_URL);
  const [state, setState] = useState<GsiState>(EMPTY_STATE);
  const [showResult, setShowResult] = useState(false);
  // 用户手动指定的分路:heroId -> 1..5(优先级高于按 roles 自动推断)
  const [positionOverrides, setPositionOverrides] = useState<Record<number, number>>({});

  // 换局(matchId 变化)时清空手动分路与旧的分析结果
  useEffect(() => {
    setPositionOverrides({});
    setShowResult(false);
  }, [state.matchId]);

  // 轮询本地 GSI 服务器
  const poll = useCallback(async () => {
    try {
      const res = await fetch(`${draftUrl}/state`, { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      const data = await res.json();
      setState(data as GsiState);
    } catch {
      setState((s) => ({ ...s, connected: false }));
    }
  }, [draftUrl]);

  useEffect(() => {
    poll();
    const id = setInterval(poll, 1200);
    return () => clearInterval(id);
  }, [poll]);

  // id -> Hero / name -> Hero 映射
  const { byId, byName } = useMemo(() => {
    const byId = new Map<number, Hero>();
    const byName = new Map<string, Hero>();
    for (const h of heroes) {
      byId.set(h.id, h);
      byName.set(h.name, h); // npc_dota_hero_xxx
    }
    return { byId, byName };
  }, [heroes]);

  const resolve = useCallback(
    (ref: HeroRef): Hero | null => {
      if (ref.id != null && byId.has(ref.id)) return byId.get(ref.id)!;
      if (ref.name && byName.has(ref.name)) return byName.get(ref.name)!;
      return null;
    },
    [byId, byName]
  );

  const radiantPicks = useMemo(
    () => state.radiant.picks.map(resolve).filter((h): h is Hero => !!h),
    [state.radiant.picks, resolve]
  );
  const direPicks = useMemo(
    () => state.dire.picks.map(resolve).filter((h): h is Hero => !!h),
    [state.dire.picks, resolve]
  );
  const allBannedHeroes = useMemo(
    () =>
      [...state.radiant.bans, ...state.dire.bans]
        .map(resolve)
        .filter((h): h is Hero => !!h),
    [state.radiant.bans, state.dire.bans, resolve]
  );
  // 推荐服务于本地玩家所在队伍(未识别时默认天辉)
  const mySide = state.localSide === 'dire' ? 'dire' : 'radiant';
  const myPicks = mySide === 'dire' ? direPicks : radiantPicks;
  const enemyPicks = mySide === 'dire' ? radiantPicks : direPicks;

  const phaseText = (() => {
    const t = PHASE_LABEL[state.phase];
    return t ? ls(lang, t[0], t[1], t[2]) : state.phase;
  })();

  const applyUrl = () => {
    setShowResult(false);
    setDraftUrl(url.trim().replace(/\/+$/, '') || DEFAULT_URL);
  };

  const renderTeam = (team: Team, picks: HeroRef[], bans: HeroRef[], resolved: Hero[]) => {
    const isRadiant = team === 'radiant';
    return (
      <div
        className={clsx(
          'rounded-lg border p-3',
          isRadiant ? 'border-radiant/50 bg-radiant/5' : 'border-dire/50 bg-dire/5'
        )}
      >
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className={clsx('w-2 h-2 rounded-full', isRadiant ? 'bg-radiant' : 'bg-dire')} />
            <h3 className={clsx('font-bold text-sm', isRadiant ? 'text-radiant-glow' : 'text-dire-glow')}>
              {isRadiant
                ? ls(lang, '天辉', 'Radiant', 'Radiant')
                : ls(lang, '夜魇', 'Dire', 'Dire')}
            </h3>
            {state.activeTeam === team && (
              <span className="text-[10px] text-game-gold">
                {ls(lang, '正在选', 'Väljer', 'Picking')}
              </span>
            )}
          </div>
          <span className="text-[10px] text-gray-500">{resolved.length}/5</span>
        </div>
        <div className="grid grid-cols-5 gap-1.5">
          {Array.from({ length: 5 }, (_, i) => {
            const h = resolved[i];
            return (
              <div key={i} className="aspect-square rounded border border-gray-700/60 bg-gray-900/50 overflow-hidden relative">
                {h ? (
                  <>
                    <HeroCard
                      hero={h}
                      displayName={getHeroDisplayName(h, lang)}
                      size="sm"
                      lang={lang}
                      showStats={false}
                    />
                    {/* 分路角标:点击循环 1→5 手动指定;手动值高亮显示 M 标记 */}
                    <button
                      type="button"
                      onClick={() =>
                        setPositionOverrides((prev) => ({
                          ...prev,
                          [h.id]: ((prev[h.id] ?? inferPosition(h)) % 5) + 1,
                        }))
                      }
                      title={ls(lang, '点击修改分路(1-5 号位循环)', 'Klicka för att ändra bana', 'Click to change lane (cycles 1-5)')}
                      className={clsx(
                        'absolute top-0 left-0 text-[9px] px-1 rounded-br font-bold transition-colors',
                        positionOverrides[h.id]
                          ? 'bg-game-gold text-black'
                          : 'bg-black/70 text-game-gold hover:bg-black/90',
                      )}
                    >
                      {POS_TAG[positionOverrides[h.id] ?? inferPosition(h)]}
                      {positionOverrides[h.id] ? '·M' : ''}
                    </button>
                  </>
                ) : (
                  <span className="w-full h-full flex items-center justify-center text-gray-700 text-xl">+</span>
                )}
              </div>
            );
          })}
        </div>
        {bans.length > 0 && (
          <div className="mt-2 flex items-center gap-1 flex-wrap">
            <span className="text-[10px] text-gray-500 mr-1">{ls(lang, '禁用', 'Bannade', 'Bans')}:</span>
            {bans.map((b, i) => {
              const h = resolve(b);
              return h ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img key={i} src={h.icon_url} alt={h.localized_name} title={h.localized_name}
                  className="w-6 h-6 rounded opacity-50 grayscale object-cover" />
              ) : null;
            })}
          </div>
        )}
      </div>
    );
  };

  if (!heroesLoaded) {
    return (
      <div className="bg-game-panel/80 border border-game-border rounded-lg p-6 text-center text-gray-400">
        {ls(lang, '加载英雄数据...', 'Laddar hjältar...', 'Loading heroes...')}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* 连接设置 + 状态 */}
      <div className="bg-game-panel/80 border border-game-border rounded-lg p-3">
        <div className="flex flex-wrap items-center gap-2 mb-2">
          <span className="text-xs text-gray-400">{ls(lang, 'GSI 服务地址', 'GSI-server', 'GSI server')}:</span>
          <input
            type="text"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') applyUrl(); }}
            placeholder={DEFAULT_URL}
            className="flex-1 min-w-[200px] bg-gray-900 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200 placeholder-gray-600 focus:outline-none focus:border-game-gold/50"
          />
          <button
            onClick={applyUrl}
            className="px-3 py-1 text-xs rounded bg-game-gold text-black font-bold hover:bg-game-gold-light"
          >
            {ls(lang, '连接', 'Anslut', 'Connect')}
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span className={state.connected ? 'text-green-400' : 'text-red-400'}>
            ● {state.connected
              ? ls(lang, '已连接', 'Ansluten', 'Connected')
              : ls(lang, '未连接（请启动本地 GSI 服务器）', 'Ej ansluten (starta GSI-servern)', 'Not connected (start the local GSI server)')}
          </span>
          <span className="text-gray-400">
            {ls(lang, '阶段', 'Fas', 'Phase')}: <span className="text-game-gold">{phaseText}</span>
          </span>
          <span className="text-gray-400">
            {ls(lang, '对局', 'Match', 'Match')}: <span className="font-mono">{state.matchId || '—'}</span>
          </span>
          <span className="text-gray-500">
            {state.payloadCount} {ls(lang, '次推送', 'uppdateringar', 'updates')}
          </span>
        </div>
      </div>

      {/* 说明 */}
      <div className="bg-game-panel/80 border border-game-border rounded-lg p-3 text-xs text-gray-400 flex flex-wrap items-center justify-between gap-2">
        <span className="flex-1 min-w-[240px]">
          {ls(
            lang,
            '进游戏后自动读取双方阵容。分路默认按英雄定位推测（GSI 不推送精确分路），点击英雄左上角的号位角标可循环切换 1-5 号位手动指定，推荐分组会即时跟随。若"未连接"，请确认已运行 gsi_server.py 且 cfg 中 uri/token 一致；HTTPS 站点会拦截本地 HTTP 请求，请用本地开发服务器访问。',
            'Lag läses automatiskt. Banor uppskattas från roller; klicka på positionsmärket för att välja 1-5 manuellt.',
            'Lineups are read automatically. Lanes are inferred from roles; click the position badge on a hero to set lane 1-5 manually.'
          )}
        </span>
        {Object.keys(positionOverrides).length > 0 && (
          <button
            type="button"
            onClick={() => setPositionOverrides({})}
            className="shrink-0 px-2 py-1 text-[10px] rounded border border-gray-600 text-gray-400 hover:text-game-gold hover:border-game-gold/50 transition-colors"
          >
            {ls(lang, '恢复自动分路', 'Återställ banor', 'Reset lanes')}
            {' '}({Object.keys(positionOverrides).length})
          </button>
        )}
      </div>

      {/* 双方阵容 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {renderTeam('radiant', state.radiant.picks, state.radiant.bans, radiantPicks)}
        {renderTeam('dire', state.dire.picks, state.dire.bans, direPicks)}
      </div>

      {/* 补位推荐:基于双方已选阵容,按分路分组、按推荐指数排序 */}
      <GSIRecommendations
        myPicks={myPicks}
        enemyPicks={enemyPicks}
        bannedHeroes={allBannedHeroes}
        positionOverrides={positionOverrides}
        lang={lang}
      />

      {/* 分析按钮 */}
      <div className="flex items-center justify-center gap-3">
        <button
          onClick={() => setShowResult(true)}
          disabled={!state.ready || radiantPicks.length < 5 || direPicks.length < 5}
          className="px-6 py-2 bg-game-gold text-black font-bold rounded hover:bg-game-gold-light disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm"
        >
          {ls(lang, '分析当前阵容', 'Analysera lag', 'Analyze lineups')}
        </button>
        {!state.ready && (
          <span className="text-[10px] text-gray-500">
            {ls(lang, '等待双方选满 5 人（GSI 实时同步中）…', 'Väntar på 5 hjältar per lag…', 'Waiting for 5 heroes per team…')}
          </span>
        )}
      </div>

      {/* 分析结果：复用现有评分引擎的分路/胜率分析 */}
      {showResult && radiantPicks.length === 5 && direPicks.length === 5 && (
        <DraftSummary
          radiantPicks={radiantPicks}
          direPicks={direPicks}
          lang={lang}
          onReset={() => setShowResult(false)}
        />
      )}
    </div>
  );
}
