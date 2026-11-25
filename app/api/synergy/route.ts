import { NextResponse } from 'next/server';
import { fetchHeroSynergy } from '@/lib/opendota';

/**
 * GET /api/synergy?heroes=1,5,22,14
 * 返回这些英雄作为 anchor 时,与所有同队英雄的组合胜率表。
 * 供实时对局补位推荐计算"己方配合"分项。
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const raw = searchParams.get('heroes') ?? '';
  const ids = raw
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n < 200)
    .slice(0, 5);

  try {
    const data = await fetchHeroSynergy(ids);
    return NextResponse.json(data, {
      headers: {
        // 组合统计基于近 365 天历史,变动缓慢,CDN 缓存 1 小时
        'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=300',
      },
    });
  } catch (err) {
    console.error('Failed to fetch synergy:', err);
    return NextResponse.json({}, { status: 200 });
  }
}
