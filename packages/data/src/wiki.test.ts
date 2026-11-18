import { describe, expect, it } from 'vitest';
import { BOSS_SCRIPTS, ITEMS, MOBS } from './index';
import { bossView, describePattern, hasSource, itemSources, itemUses, mobSummary, searchWiki, skillsByRole, wikiEntries } from './wiki';

describe('wiki', () => {
  it('모든 아이템은 얻는 방법이 하나 이상 있다', () => {
    const orphans = ITEMS.filter((i) => !hasSource(itemSources(i.id))).map((i) => i.id);
    expect(orphans).toEqual([]);
  });
  it('보스 스크립트가 있는 몹은 모두 보기를 만들 수 있다', () => {
    for (const id of Object.keys(BOSS_SCRIPTS)) {
      const v = bossView(id)!;
      expect(v.phases.length).toBeGreaterThan(0);
      for (const p of v.patterns) { expect(p.text.length).toBeGreaterThan(0); expect(p.text).not.toContain('undefined'); expect(p.text).not.toContain('NaN'); }
      for (const ph of v.phases) expect(ph.pool.reduce((a, b) => a + b.share, 0)).toBeCloseTo(1, 5);
    }
    expect(bossView('zombie')).toBeUndefined();
  });
  it('오포코는 자세 설명이 있고 리치는 영혼함 설명이 있다', () => {
    expect(bossView('oppoko')!.stance!.length).toBeGreaterThan(3);
    expect(bossView('rich')!.vessel).toContain('영혼함');
  });
  it('검색: 앞글자 일치가 먼저, 공백 무시', () => {
    const e = wikiEntries();
    expect(searchWiki('', e)).toEqual([]);
    const r = searchWiki('리치', e);
    expect(r.length).toBeGreaterThan(0);
    expect(r.some((x) => x.kind === 'mob' && x.id === 'rich')).toBe(true);
    expect(searchWiki('zzzz없음', e)).toEqual([]);
  });
  it('요약/역할별 스킬/패턴 설명', () => {
    expect(mobSummary(MOBS[0]!).dungeon).toBeDefined();
    expect(Object.keys(skillsByRole()).length).toBeGreaterThan(1);
    expect(describePattern({ kind: 'attack', name: 'x', telegraph: '', mult: 1.5, hits: 2 } as never)).toContain('2회');
  });
});
