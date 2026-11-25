import { Hero, HeroMatchup } from './types';

const OPENDOTA_BASE = 'https://api.opendota.com/api';
const CDN_BASE = 'https://cdn.cloudflare.steamstatic.com';

// 单英雄在最新版本中的最小样本数，低于此值回退到整体路人胜率
export const MIN_PATCH_SAMPLES = 100;
// 最新版本总样本低于此值时，认定版本刚发布、样本不足，自动改用近 30 天窗口
const MIN_PATCH_TOTAL_GAMES = 5000;

export interface OpenDotaHeroStat {
  id: number;
  name: string;
  localized_name: string;
  primary_attr: string;
  attack_type: string;
  roles: string[];
  img: string;
  icon: string;
  pro_win: number;
  pro_pick: number;
  pro_ban: number;
  pub_win: number;
  pub_pick: number;
  '1_pick'?: number;
  '1_win'?: number;
  '2_pick'?: number;
  '2_win'?: number;
  '3_pick'?: number;
  '3_win'?: number;
  '4_pick'?: number;
  '4_win'?: number;
  '5_pick'?: number;
  '5_win'?: number;
  '6_pick'?: number;
  '6_win'?: number;
  '7_pick'?: number;
  '7_win'?: number;
  '8_pick'?: number;
  '8_win'?: number;
  turbo_picks?: number;
  turbo_wins?: number;
}

interface PatchRow {
  hero_id: number;
  games: number;
  wins: number;
}

interface PatchStatsResult {
  map: Record<number, { games: number; wins: number }>;
  totalGames: number;
  version: string;
}

/** 最新版本号，例如 { name: '7.42', id: 61 } */
export async function fetchLatestPatch(): Promise<{ name: string; id: number } | null> {
  try {
    const res = await fetch(`${OPENDOTA_BASE}/constants/patch`, { cache: 'no-store' });
    if (!res.ok) return null;
    const list: { name: string; id: number; date: string }[] = await res.json();
    if (!Array.isArray(list) || list.length === 0) return null;
    // 列表按时间升序，最后一项即最新版本
    const latest = list[list.length - 1];
    return { name: latest.name, id: latest.id };
  } catch {
    return null;
  }
}

/** 执行一条 Explorer 统计 SQL，返回 hero_id -> {games, wins} 及总场次 */
async function runExplorerStats(sql: string): Promise<{ map: Record<number, { games: number; wins: number }>; totalGames: number }> {
  try {
    const url = `${OPENDOTA_BASE}/explorer?sql=${encodeURIComponent(sql)}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) return { map: {}, totalGames: 0 };
    const json: { rows?: PatchRow[]; err?: string } = await res.json();
    if (json.err || !Array.isArray(json.rows)) return { map: {}, totalGames: 0 };
    const map: Record<number, { games: number; wins: number }> = {};
    let totalGames = 0;
    for (const row of json.rows) {
      map[row.hero_id] = { games: Number(row.games), wins: Number(row.wins) };
      totalGames += Number(row.games);
    }
    return { map, totalGames };
  } catch {
    return { map: {}, totalGames: 0 };
  }
}

const SELECT_SQL =
  "SELECT pm.hero_id AS hero_id, count(*) AS games, " +
  "sum(CASE WHEN (pm.player_slot < 128) = m.radiant_win THEN 1 ELSE 0 END) AS wins " +
  "FROM player_matches pm " +
  "JOIN matches m ON pm.match_id = m.match_id ";

/**
 * 获取"当前版本"英雄胜率统计。
 * 策略：先按最新版本(patch)统计；若版本刚发布、总样本不足 MIN_PATCH_TOTAL_GAMES，
 * 则自动回退到最近 30 天滚动窗口（仍以最新对局为主），保证数据有统计意义。
 */
export async function fetchPatchPubStats(patchName: string): Promise<PatchStatsResult> {
  if (!patchName) {
    return { map: {}, totalGames: 0, version: '' };
  }

  // 1) 精确到最新版本
  const safePatch = patchName.replace(/[^0-9.]/g, '');
  const byPatch = await runExplorerStats(
    SELECT_SQL +
    "JOIN match_patch mp ON pm.match_id = mp.match_id " +
    `WHERE mp.patch = '${safePatch}' ` +
    "GROUP BY pm.hero_id ORDER BY games DESC LIMIT 200"
  );

  if (byPatch.totalGames >= MIN_PATCH_TOTAL_GAMES) {
    return { ...byPatch, version: safePatch };
  }

  // 2) 版本样本不足 → 回退到最近 30 天窗口
  const recent = await runExplorerStats(
    SELECT_SQL +
    "WHERE m.start_time > extract(epoch from now() - interval '30 days')::int " +
    "GROUP BY pm.hero_id ORDER BY games DESC LIMIT 200"
  );
  return { ...recent, version: `${safePatch} · 30d` };
}

/** 拉取英雄基础数据，并合并最新版本路人胜率 */
export async function fetchAllHeroes(): Promise<Hero[]> {
  // 先取最新版本号，再并行拉取英雄基础数据与按版本的路人统计
  const patch = await fetchLatestPatch();
  const patchName = patch?.name ?? '';

  const [res, stats] = await Promise.all([
    fetch(`${OPENDOTA_BASE}/heroStats`, { cache: 'no-store' }),
    fetchPatchPubStats(patchName),
  ]);

  if (!res.ok) throw new Error(`OpenDota API error: ${res.status}`);

  const data: OpenDotaHeroStat[] = await res.json();

  return data.map((h) => {
    const s = stats.map[h.id];
    const hasEnough = !!s && s.games >= MIN_PATCH_SAMPLES;
    return {
      id: h.id,
      name: h.name,
      localized_name: h.localized_name,
      primary_attr: h.primary_attr as Hero['primary_attr'],
      attack_type: h.attack_type as Hero['attack_type'],
      roles: h.roles,
      pro_win: h.pro_win ?? 0,
      pro_pick: h.pro_pick ?? 0,
      pro_ban: h.pro_ban ?? 0,
      pub_win: h.pub_win ?? 0,
      pub_pick: h.pub_pick ?? 0,
      patchPubWin: hasEnough ? s!.wins / s!.games : 0,
      patchPubGames: s?.games ?? 0,
      patchVersion: stats.version,
      image_url: `${CDN_BASE}${h.img}`,
      icon_url: `${CDN_BASE}${h.icon}`,
    };
  });
}

export async function fetchHeroMatchups(heroId: number): Promise<HeroMatchup[]> {
  const res = await fetch(`${OPENDOTA_BASE}/heroes/${heroId}/matchups`, {
    cache: 'no-store',
  });

  if (!res.ok) return [];

  return res.json();
}

export function calcProWinRate(hero: Hero): number {
  if (hero.pro_pick === 0) return 0;
  return hero.pro_win / hero.pro_pick;
}

/**
 * 路人胜率：优先返回最新版本数据（样本达标时），否则回退到整体路人胜率。
 */
export function calcPubWinRate(hero: Hero): number {
  if (hero.patchPubGames >= MIN_PATCH_SAMPLES && hero.patchPubWin > 0) {
    return hero.patchPubWin;
  }
  if (hero.pub_pick === 0) return 0;
  return hero.pub_win / hero.pub_pick;
}

/** 该英雄路人胜率是否来自最新版本 */
export function isPatchWinRate(hero: Hero): boolean {
  return hero.patchPubGames >= MIN_PATCH_SAMPLES && hero.patchPubWin > 0;
}

/**
 * 有效英雄胜率：本应用面向路人模式，故以最新版本路人胜率优先，
 * 无版本数据时回退到整体路人胜率，最后才用职业胜率兜底。
 */
export function getEffectiveWinRate(hero: Hero): number {
  const pub = calcPubWinRate(hero);
  if (pub > 0) return pub;
  return calcProWinRate(hero);
}

export function calcMatchupWinRate(matchup: HeroMatchup): number {
  if (matchup.games_played === 0) return 0.5;
  return matchup.wins / matchup.games_played;
}
