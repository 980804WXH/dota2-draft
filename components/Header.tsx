'use client';

import { GameMode } from '@/lib/types';
import { Language, createTranslator, ls } from '@/lib/i18n';
import { useDraftStore } from '@/store/draftStore';
import clsx from 'clsx';

export type AppView = 'draft' | 'manual' | 'gsi';

interface HeaderProps {
  lang: Language;
  onLangChange: (lang: Language) => void;
  view: AppView;
  onViewChange: (view: AppView) => void;
}

const LANG_FLAGS: Record<Language, string> = { zh: '🇨🇳', en: '🇬🇧', sv: '🇸🇪' };
const LANG_LABELS: Record<Language, string> = { zh: '中', en: 'EN', sv: 'SE' };

export default function Header({ lang, onLangChange, view, onViewChange }: HeaderProps) {
  const { mode, setMode } = useDraftStore();
  const tr = createTranslator(lang);

  const handleModeChange = (newMode: GameMode) => {
    if (newMode !== mode) setMode(newMode);
  };

  return (
    <header className="bg-game-panel/90 backdrop-blur-sm border-b border-game-border sticky top-0 z-50">
      <div className="max-w-screen-2xl mx-auto px-4 py-2 flex items-center justify-between gap-4">
        {/* Logo + Title */}
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-gradient-to-br from-game-gold to-yellow-700 flex items-center justify-center text-black font-black text-sm">
            D2
          </div>
          <div>
            <h1 className="text-game-gold font-bold text-base tracking-wide leading-none">
              {tr('app.title')}
            </h1>
            <p className="text-gray-500 text-[10px] tracking-widest uppercase">
              {tr('app.subtitle')}
            </p>
          </div>
        </div>

        {/* Mode switcher */}
        <div className="flex items-center bg-gray-900 rounded border border-gray-700 p-0.5 gap-0.5">
          {(['allpick', 'randomdraft'] as GameMode[]).map((m) => (
            <button
              key={m}
              onClick={() => handleModeChange(m)}
              className={clsx(
                'px-3 py-1 rounded text-xs font-medium transition-all',
                mode === m
                  ? 'bg-game-gold text-black font-bold'
                  : 'text-gray-400 hover:text-gray-200',
              )}
            >
              {m === 'allpick' ? tr('mode.allpick') : tr('mode.randomdraft')}
            </button>
          ))}
        </div>

        {/* View switcher */}
        <div className="flex items-center bg-gray-900 rounded border border-gray-700 p-0.5 gap-0.5">
          {(['draft', 'manual', 'gsi'] as AppView[]).map((v) => (
            <button
              key={v}
              onClick={() => onViewChange(v)}
              className={clsx(
                'px-3 py-1 rounded text-xs font-medium transition-all',
                view === v
                  ? 'bg-game-gold text-black font-bold'
                  : 'text-gray-400 hover:text-gray-200',
              )}
            >
              {v === 'draft'
                ? ls(lang, '选人模拟', 'Utkast', 'Draft')
                : v === 'manual'
                ? ls(lang, '阵容分析', 'Laganalys', 'Analysis')
                : ls(lang, '实时对局', 'Live-match', 'Live Game')}
            </button>
          ))}
        </div>

        {/* Language selector */}
        <div className="flex items-center bg-gray-900 rounded border border-gray-700 p-0.5 gap-0.5">
          {(['zh', 'en', 'sv'] as Language[]).map((l) => (
            <button
              key={l}
              onClick={() => onLangChange(l)}
              className={clsx(
                'flex items-center gap-1 px-2 py-1 rounded text-xs font-medium transition-all',
                lang === l
                  ? 'bg-game-gold text-black font-bold'
                  : 'text-gray-400 hover:text-gray-200',
              )}
            >
              <span>{LANG_FLAGS[l]}</span>
              <span>{LANG_LABELS[l]}</span>
            </button>
          ))}
        </div>
      </div>
    </header>
  );
}
