import type { BossScript, PatternDef } from '@rtgm/engine';
import {
  BOSS_SCRIPTS, DUNGEONS, RAID_BOSSES, RAID_ROLES, RAID_ROLE_IDS, raidKit, raidRoleCap, raidSkillById, ITEMS, MOBS, RECIPES, SKILLS, STARTER_ITEMS,
  entryCost, itemById, mobById,
  type DungeonData, type ItemData, type MobData, type RecipeData, type SkillData,
} from './index';

/**
 * 인게임 위키가 쓰는 파생 정보. 게임 데이터에서 계산하므로 수치가 어긋나지 않는다.
 * (화면 문구는 한국어, 순수 함수라 테스트할 수 있다)
 */

export interface ItemSources {
  starter: boolean;
  shop?: { price: number; minProficiency: number };
  drops: { mob: MobData; chance: number }[];
  raidDrops: { name: string; chance: number }[];
  crafts: RecipeData[];
}

/** 이 아이템을 얻는 방법: 시작 지급 / 상점 / 몹 드롭 / 제작 */
export function itemSources(itemId: string): ItemSources {
  const item = itemById(itemId);
  return {
    starter: (STARTER_ITEMS as readonly string[]).includes(itemId),
    shop: item && item.buy !== null ? { price: item.buy, minProficiency: item.minProficiency } : undefined,
    raidDrops: Object.values(RAID_BOSSES).flatMap((b) => b.drops.filter((d) => d.itemId === itemId).map((d) => ({ name: `${b.name} (레이드)`, chance: d.chance }))),
    drops: MOBS.flatMap((mob) => mob.drops.filter((d) => d.itemId === itemId).map((d) => ({ mob, chance: d.chance }))),
    crafts: RECIPES.filter((r) => r.resultId === itemId),
  };
}

export const hasSource = (s: ItemSources): boolean => s.starter || !!s.shop || s.drops.length > 0 || s.raidDrops.length > 0 || s.crafts.length > 0;

/** 이 아이템을 재료로 쓰는 레시피 */
export const itemUses = (itemId: string): RecipeData[] =>
  RECIPES.filter((r) => r.materials.some((m) => m.itemId === itemId));

export const itemCategory = (item: ItemData): '장비' | '소모품' | '재료' =>
  item.type === 'material' ? '재료' : item.type === 'consumable' ? '소모품' : '장비';

export const TYPE_LABEL: Record<string, string> = { sword: '무기', shield: '방패', armor: '갑옷', consumable: '소모품', material: '재료' };
export const RARITY_LABEL: Record<string, string> = { basic: '기본', normal: '일반', rare: '희귀', epic: '영웅' };

// ─── 보스 패턴 설명 ───────────────────────────────────────────────────────────

const pct = (n: number) => `${Math.round(n * 100)}%`;
const TARGET_TEXT: Record<string, string> = { random: '무작위 한 명', lowest_hp: 'HP 비율이 가장 낮은 한 명', highest_hp: 'HP 비율이 가장 높은 한 명', all: '파티 전체', first: '' };
const aimText = (rule: string | undefined) => (rule && TARGET_TEXT[rule] ? ` (대상: ${TARGET_TEXT[rule]})` : '');
const unbreakable = (v: number) => v >= 1; // 끊기 기준이 보스 최대 HP 이상이면 사실상 끊을 수 없다

/** 패턴 한 줄 설명 (페이즈 번호는 1부터, 충전 기술의 페이즈별 수치용) */
export function describePattern(def: PatternDef, phase = 1): string {
  switch (def.kind) {
    case 'attack':
      return `공격력 ${pct(def.mult)}${def.hits && def.hits > 1 ? ` × ${def.hits}회` : ''} 피해${aimText(def.target)}`;
    case 'debuff':
      return `대상 공격력 -${pct(1 - def.atkMult)} (${def.turns}라운드)${aimText(def.target)}`;
    case 'drain':
      return `대상 최대 HP의 ${pct(def.pct)}를 빼앗아 자신이 회복${aimText(def.target)}`;
    case 'summon':
      return `하수인을 최대 ${def.count}체까지 소환 (${def.minPhase}페이즈부터)`;
    case 'stance':
      return `이번 라운드 받는 피해 -${pct(1 - def.takenMult)}, 공격한 쪽에 ${pct(def.reflectPct)} 반사`;
    case 'devour':
      return `공격력 ${pct(def.mult)}로 물어뜯고 준 피해의 ${pct(def.healPct)}만큼 회복해요. 허기가 ${def.minHunger} 이상일 때 쓰고, 먹으면 허기가 0이 돼요`;
    case 'copy_item':
      return `직전 라운드에 당신이 쓴 회복 아이템을 똑같이 써요 (최대 HP의 ${pct(def.maxHealPct)}까지 회복). 아이템을 쓰지 않았다면 나오지 않아요`;
    case 'mirror':
      return `플레이어가 직전 라운드에 입힌 피해의 ${pct(def.pct)}를 되돌려 줌`;
    case 'charge_attack': {
      const i = Math.min(2, Math.max(0, phase - 1));
      const rounds = def.chargeRounds[i]!;
      const need = def.interruptPct[i]!;
      const charge = rounds >= 2 ? `${rounds}라운드 충전 후 ` : '충전 없이 바로 ';
      const brk = unbreakable(need) ? ' (끊을 수 없음)' : ` (한 라운드에 보스 최대 HP의 ${pct(need)} 이상 피해를 주면 끊김)`;
      return `${charge}공격력 ${pct(def.mult)} 강타${aimText(def.target)}${brk}`;
    }
  }
}

export interface PatternView {
  id: string;
  name: string;
  telegraph: string;
  text: string;
  /** 이 패턴이 나오는 페이즈 (1부터) */
  phases: number[];
}
export interface PhaseView {
  phase: number;
  /** 보스 HP가 이 비율(%) 이하에서 시작 */
  fromHpPct: number;
  atkMult: number;
  enterText?: string;
  pool: { name: string; share: number }[];
}
export interface BossView {
  patterns: PatternView[];
  phases: PhaseView[];
  vessel?: string;
  minion?: string;
  stance?: string[];
  hunger?: string;
  enrage?: string;
}

/** 몹의 패턴 스크립트를 사람이 읽는 형태로 바꾼다. 스크립트가 없으면 undefined (일반 AI) */
export function bossView(mobId: string): BossView | undefined {
  const raw = BOSS_SCRIPTS[mobId];
  return raw ? scriptView(raw as unknown as Omit<BossScript, 'bossId'>) : undefined;
}

/** 레이드 보스의 패턴 보기 */
export const raidBossView = (id: string): BossView | undefined => {
  const b = RAID_BOSSES[id];
  return b ? scriptView(b.script as unknown as Omit<BossScript, 'bossId'>) : undefined;
};

function scriptView(script: Omit<BossScript, 'bossId'>): BossView {
  const phases: PhaseView[] = script.phases.map((p, i) => {
    const total = p.pool.reduce((a, b) => a + b.weight, 0);
    return {
      phase: i + 1,
      fromHpPct: p.fromHpPct,
      atkMult: p.atkMult,
      enterText: p.enterText,
      pool: p.pool.map((e) => ({ name: script.patterns[e.id]?.name ?? e.id, share: e.weight / total })),
    };
  });
  const patterns: PatternView[] = Object.entries(script.patterns).map(([id, def]) => {
    const inPhases = script.phases.map((p, i) => (p.pool.some((e) => e.id === id) ? i + 1 : 0)).filter((n) => n > 0);
    return {
      id, name: def.name, text: describePattern(def, inPhases[0] ?? 1),
      telegraph: (def.kind === 'charge_attack' ? def.telegraphCharge : def.telegraph).replace('{target}', '지목된 대상'), phases: inPhases,
    };
  });
  const view: BossView = { patterns, phases };
  if (script.vessel) {
    const v = script.vessel;
    view.vessel = `${v.appearsAtPhase}페이즈부터 ${v.name}(HP ${v.hp})이 나타나 보스 피해를 ${pct(v.damageReduction)} 줄여요. 살아 있는 채로 보스가 쓰러지면 HP ${pct(v.reviveHpPct)}로 한 번 부활하고, ${v.name}을 부수면 보스가 한 라운드 경직돼요.`;
  }
  if (script.minion) {
    const m = script.minion;
    view.minion = `${m.name}(HP ${m.stats.maxHp}, ATK ${m.stats.atk}) 최대 ${m.max}체. 살아 있는 동안 라운드마다 보스 최대 HP의 ${pct(m.healBossPct)}씩 회복시켜요.`;
  }
  if (script.stance) {
    const s = script.stance;
    view.stance = [
      '직전에 한 행동의 반대 자세를 취해요. 스킬·아이템을 쓰면 중립이에요.',
      `공격 → 반격의 자세: 기본 공격 피해 -${pct(s.counter.reduction)}, ${pct(s.counter.reflect)} 반사 (스킬은 영향 없음)`,
      `방어 → 공세의 자세: 보스 공격력 +${pct(s.offense.atkMult - 1)}, 방어 효과 ${pct(s.offense.guardPierce)} 무시`,
      `${s.enhancedFromPhase}페이즈부터 같은 행동을 연속하면 자세 효과가 ×${s.enhancedMult}로 강해져요.`,
      `${s.reversalFromPhase}페이즈부터 ${s.reversalEvery}라운드마다 규칙이 뒤집혀요 (공격 → 공세, 방어 → 반격).`,
    ];
  }
  if (script.enrage) view.enrage = `${script.enrage.fromRound}라운드부터 매 라운드 공격력이 +${pct(script.enrage.perRound)}씩 쌓여요 (격노).`;
  if (script.hunger) {
    const h = script.hunger;
    view.hunger = `허기: 매 라운드 +${h.perRound} (최대 ${h.max}), 허기 1당 공격력 +${pct(h.atkPerStack)}. 식사로 해소해요.`;
  }
  return view;
}

// ─── 검색 ────────────────────────────────────────────────────────────────────

export type WikiKind = 'item' | 'mob' | 'skill' | 'dungeon' | 'recipe' | 'raid';
export interface WikiEntry {
  kind: WikiKind;
  id: string;
  name: string;
  /** 검색 결과에 보여 줄 부가 설명 */
  hint: string;
}

export const WIKI_KIND_LABEL: Record<WikiKind, string> = { item: '아이템', mob: '몹·보스', skill: '스킬', dungeon: '던전', recipe: '제작', raid: '레이드' };

/** 위키의 모든 항목 (검색 색인) */
export function wikiEntries(): WikiEntry[] {
  const items = ITEMS.map((i): WikiEntry => ({ kind: 'item', id: i.id, name: i.name, hint: `${itemCategory(i)} · ${RARITY_LABEL[i.rarity]}` }));
  const mobs = MOBS.map((m): WikiEntry => ({ kind: 'mob', id: m.id, name: m.name, hint: `${m.kind === 'boss' ? '보스' : '몹'} · ${dungeonName(m.dungeon)}` }));
  const skills = SKILLS.map((s): WikiEntry => ({ kind: 'skill', id: s.id, name: s.name, hint: `${s.ultimate ? '궁극기' : '스킬'} · ${s.role}` }));
  const dungeons = DUNGEONS.map((d): WikiEntry => ({ kind: 'dungeon', id: d.id, name: d.name, hint: `숙련도 ${d.minProficiency}~` }));
  const recipes = RECIPES.map((r): WikiEntry => ({ kind: 'recipe', id: r.id, name: `${itemById(r.resultId)?.name ?? r.resultId} 제작`, hint: `숙련도 ${r.unlockProficiency}에 해금` }));
  const raids = Object.values(RAID_BOSSES).map((b): WikiEntry => ({ kind: 'raid', id: b.id, name: b.name, hint: `${'★'.repeat(b.star)} · ${b.recParty}~${b.maxParty}명` }));
  return [...items, ...mobs, ...skills, ...dungeons, ...recipes, ...raids];
}

const dungeonName = (id: string) => DUNGEONS.find((d: DungeonData) => d.id === id)?.name ?? id;

/** 이름에 검색어가 들어간 항목 (공백 무시, 대소문자 무시, 앞에서 시작하는 일치를 먼저) */
export function searchWiki(query: string, entries: WikiEntry[] = wikiEntries()): WikiEntry[] {
  const q = query.replace(/\s+/g, '').toLowerCase();
  if (!q) return [];
  const norm = (s: string) => s.replace(/\s+/g, '').toLowerCase();
  const hits = entries.filter((e) => norm(e.name).includes(q) || e.id.toLowerCase().includes(q));
  return hits.sort((a, b) => Number(!norm(a.name).startsWith(q)) - Number(!norm(b.name).startsWith(q)) || a.name.localeCompare(b.name, 'ko'));
}

/** 몹 한 마리의 요약 (위키 상세용) */
export function mobSummary(mob: MobData) {
  const cost = entryCost(mob);
  return { cost, key: cost.key ? itemById(cost.key) : undefined, dungeon: DUNGEONS.find((d) => d.id === mob.dungeon), boss: mobById(mob.id) };
}

export const skillsByRole = (): Record<string, SkillData[]> => {
  const out: Record<string, SkillData[]> = {};
  for (const s of SKILLS) (out[s.ultimate ? '궁극기' : s.role] ??= []).push(s);
  return out;
};

/** 레이드 역할 설명과 스킬 */
export const raidRoleViews = () => RAID_ROLE_IDS.map((r) => ({
  id: r, label: RAID_ROLES[r].label, desc: RAID_ROLES[r].desc,
  skills: raidKit(r).map((id) => raidSkillById(id)!).filter(Boolean),
}));
export { RAID_BOSSES, raidRoleCap };
