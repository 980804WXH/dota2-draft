'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Hero, Team } from '@/lib/types';
import { Language, ls } from '@/lib/i18n';
import { useDraftStore } from '@/store/draftStore';
import { getHeroDisplayName } from '@/lib/heroNames';
import HeroCard from './HeroCard';
import DraftSummary from './DraftSummary';
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

// 依据英雄 roles 粗略推断分路（1-5 号位）；GSI 本身不推送分路数据
function inferPosition(hero: Hero): number {
  const r = hero.roles ?? [];
  const score = [0, 0, 0, 0, 0]; // P1..P5
  const add = (idx: number, w: number) => { score[idx] += w; };
  if (r.includes('Carry')) { add(0, 4); add(2, 1); }
  if (r.includes('Nuker')) { add(1, 2); add(3, 1); }
  if (r.includes('Initiator')) { add(2, 2); add(3, 1); }
  if (r.includes('Durable')) { add(2, 3); }
  if (r.includes('Disabler')) { add(3, 2); add(4, 1); }
  if (r.includes('Support') || r.includes('Lane Support')) { add(4, 3); add(3, 2); }
  if (r.includes('Escape')) { add(1, 1); }
  if (r.includes('Pusher')) { add(0, 1); }
  let best = 0;
  for (let i = 1; i < 5; i++) if (score[i] > score[best]) best = i;
  return best + 1;
}

const POS_LABEL: Record<number, string> = { 1: '1', 2: '2', 3: '3', 4: '4', 5: '5' };

/** 通过 GSI 实时读取对局阵容并分析（替代手动点选） */
export default function GSILive({ lang }: { lang: Language }) {
  const { heroes, heroesLoaded } = useDraftStore();
  const [url, setUrl] = useState(DEFAULT_URL);
  const [draftUrl, setDraftUrl] = useState(DEFAULT_URL);
  const [state, setState] = useState<GsiState>(EMPTY_STATE);
  const [showResult, setShowResult] = useState(false);

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
                    <span className="absolute top-0 left-0 bg-black/70 text-game-gold text-[9px] px-1 rounded-br">
                      {POS_LABEL[inferPosition(h)]}
                    </span>
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
      <div className="bg-game-panel/80 border border-game-border rounded-lg p-3 text-xs text-gray-400">
        {ls(
          lang,
          '进游戏后自动读取双方阵容，无需手动点选。分路按英雄定位推测（GSI 不推送精确分路）。若一直显示"未连接"，请确认已运行 gsi_server.py 且 cfg 中 uri/token 与服务器一致；部署到 HTTPS 站点时浏览器会拦截对本地 HTTP 的请求，请用本地开发服务器访问。',
          'Lag läses automatiskt in från matchen. Banor uppskattas från hjälteroller (GSI skickar exakta banor ej).',
          'Lineups are read automatically from the match. Lanes are inferred from hero roles (GSI does not push exact lanes).'
        )}
      </div>

      {/* 双方阵容 */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {renderTeam('radiant', state.radiant.picks, state.radiant.bans, radiantPicks)}
        {renderTeam('dire', state.dire.picks, state.dire.bans, direPicks)}
      </div>

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
