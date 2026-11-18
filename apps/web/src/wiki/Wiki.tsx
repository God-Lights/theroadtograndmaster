import { useEffect, useMemo, useState } from 'react';
import {
  DUNGEONS, ITEMS, MOBS, PVP_RULES, ROGUE_DUNGEONS, ROGUE_EVENT_WEIGHTS, rogueById, spawnRates, PROFICIENCY_TIERS, RECIPES, SKILLS, SKILL_SLOTS, START_AP, ULTIMATE_SLOTS, CRAFT_PROFICIENCY_GAIN,
  dungeonById, getProfTier, itemById, mobById, skillById, starLabel,
} from '@rtgm/data';
import {
  RARITY_LABEL, RAID_BOSSES, TYPE_LABEL, WIKI_KIND_LABEL, bossView, raidBossView, raidRoleCap, raidRoleViews, itemSources, itemUses, mobSummary, searchWiki, skillsByRole, wikiEntries,
  type WikiEntry,
} from '@rtgm/data/src/wiki';
import { AP_MAX, AP_REGEN, GAUGE_MAX, GUARD_REDUCTION } from '@rtgm/engine';
import { useGame } from '../game';
import { ItemStats, rarityClass } from '../screens/ItemInfo';

/** 해시 경로: #/wiki/<섹션>/<id> */
export const isWikiHash = (h: string) => h.startsWith('#/wiki');
export const useWikiPath = () => {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return hash;
};
const go = (path: string) => { window.location.hash = `#/wiki${path}`; };
export const openWiki = () => go('');
export const closeWiki = () => { history.replaceState(null, '', window.location.pathname + window.location.search); window.dispatchEvent(new HashChangeEvent('hashchange')); };

function A({ to, children }: { to: string; children: React.ReactNode }) {
  return <a className="wlink" href={`#/wiki${to}`}>{children}</a>;
}
const itemLink = (id: string) => <A to={`/items/${id}`}>{itemById(id)?.name ?? id}</A>;
const pct = (n: number) => `${Math.round(n * 1000) / 10}%`;

const SECTIONS = [
  { id: 'guide', label: '게임 가이드', desc: '전투·AP·궁극기 규칙' },
  { id: 'items', label: '아이템', desc: `${ITEMS.length}종 · 얻는 곳과 쓰임` },
  { id: 'mobs', label: '몹·보스', desc: `${MOBS.length}종 · 드롭과 패턴` },
  { id: 'rogue', label: '던전(로그라이크)', desc: `${ROGUE_DUNGEONS.length}곳 · 층마다 몬스터·보물·함정` },
  { id: 'raids', label: '레이드', desc: `${Object.keys(RAID_BOSSES).length}종 · 별 등급과 역할` },
  { id: 'pvp', label: 'PvP·팀전', desc: '1v1 랭크, 4v4 역할 팀전' },
  { id: 'skills', label: '스킬', desc: `${SKILLS.length}종 · 역할별` },
  { id: 'dungeons', label: '지역(바이옴)', desc: `${DUNGEONS.length}곳 · 출현 몬스터와 입장 조건` },
  { id: 'recipes', label: '제작', desc: `${RECIPES.length}종 · 재료와 해금` },
  { id: 'tiers', label: '숙련도', desc: `${PROFICIENCY_TIERS.length}단계 칭호` },
];

export function Wiki({ hash }: { hash: string }) {
  const parts = hash.replace(/^#\/wiki\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const [section, id] = parts;
  const title = SECTIONS.find((s) => s.id === section)?.label ?? (section === 'search' ? '검색' : '위키');
  return (
    <div className="wiki">
      <div className="wiki-bar">
        <button className="btn btn-ghost btn-sm" onClick={() => (section ? (id ? history.back() : go('')) : closeWiki())}>← {section ? '뒤로' : '게임으로'}</button>
        <strong>{title}</strong>
        <a className="btn btn-ghost btn-sm" href="#/wiki">홈</a>
      </div>
      {!section && <Home />}
      {section === 'search' && <Results q={id ?? ''} />}
      {section === 'guide' && <Guide />}
      {section === 'items' && (id ? <ItemPage id={id} /> : <ItemList />)}
      {section === 'mobs' && (id ? <MobPage id={id} /> : <MobList />)}
      {section === 'rogue' && (id ? <RoguePage id={id} /> : <RogueList />)}
      {section === 'pvp' && <PvpGuide />}
      {section === 'raids' && (id ? <RaidPage id={id} /> : <RaidList />)}
      {section === 'skills' && <SkillList focus={id} />}
      {section === 'dungeons' && (id ? <DungeonPage id={id} /> : <DungeonList />)}
      {section === 'recipes' && <RecipeList />}
      {section === 'tiers' && <Tiers />}
    </div>
  );
}

function SearchBox({ initial = '' }: { initial?: string }) {
  const [q, setQ] = useState(initial);
  return (
    <form className="wiki-search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) go(`/search/${encodeURIComponent(q.trim())}`); }}>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="아이템·몹·스킬 검색" enterKeyHint="search" />
      <button className="btn btn-primary" type="submit">검색</button>
    </form>
  );
}

function Home() {
  return (
    <>
      <SearchBox />
      <div className="wiki-grid">
        {SECTIONS.map((s) => (
          <a key={s.id} className="card wiki-card" href={`#/wiki/${s.id}`}>
            <div className="card-title">{s.label}</div>
            <div className="muted">{s.desc}</div>
          </a>
        ))}
      </div>
    </>
  );
}

const KIND_PATH: Record<WikiEntry['kind'], string> = { item: 'items', mob: 'mobs', skill: 'skills', dungeon: 'dungeons', recipe: 'recipes', raid: 'raids', rogue: 'rogue' };
function Results({ q }: { q: string }) {
  const results = useMemo(() => searchWiki(q), [q]);
  return (
    <>
      <SearchBox initial={q} />
      {results.length === 0 ? <div className="empty">‘{q}’에 맞는 항목이 없어요.</div> : (
        <div className="card">
          {results.map((r) => (
            <a key={`${r.kind}:${r.id}`} className="wiki-row" href={`#/wiki/${KIND_PATH[r.kind]}${r.kind === 'recipe' ? '' : `/${r.id}`}`}>
              <span>{r.name}</span><span className="badge">{WIKI_KIND_LABEL[r.kind]}</span><span className="muted wiki-hint">{r.hint}</span>
            </a>
          ))}
        </div>
      )}
    </>
  );
}

function Guide() {
  const rows: [string, string][] = [
    ['동시 선택', '매 라운드 나와 상대가 동시에 행동을 고르고, 속도 순서대로 한꺼번에 처리돼요. 가드·선행 스킬이 가장 먼저, 아이템과 후행 회복은 마지막에 처리돼요.'],
    ['AP(행동력)', `시작 ${START_AP}, 최대 ${AP_MAX}. 라운드가 끝나면 +${AP_REGEN}, 기본 공격을 하면 +1. 스킬은 AP를 소모해요.`],
    ['가드', `이번 라운드 받는 피해 -${pct(GUARD_REDUCTION)}. 연속으로 쓰면 효과가 절반이 돼요.`],
    ['궁극기', `피해를 주거나 받거나 회복하면 게이지가 차고, ${GAUGE_MAX}가 되면 궁극기를 쓸 수 있어요. 장착 슬롯은 ${ULTIMATE_SLOTS}개예요.`],
    ['스킬 슬롯', `일반 스킬 ${SKILL_SLOTS}개 + 궁극기 ${ULTIMATE_SLOTS}개를 장착해요. 솔로에서는 역할 제한 없이 자유롭게 고를 수 있어요.`],
    ['쿨다운', '강한 스킬은 쓴 뒤 몇 라운드 동안 다시 쓸 수 없어요.'],
    ['방어력', '방어력이 높을수록 받는 피해가 줄어요. 단, 보스의 일부 공격은 방어를 무시해요.'],
    ['보스', '보스는 패턴과 예고가 있어요. 예고 문구를 읽고 가드·끊기·회복 타이밍을 정하세요. HP가 줄면 페이즈가 바뀌어요.'],
    ['숙련도', `전투 승리·패배와 제작(+${CRAFT_PROFICIENCY_GAIN})으로 올라요. 숙련도에 따라 상점 품목, 제작법, 스킬, 지역(바이옴) 입장이 열려요.`],
  ];
  return <div className="card">{rows.map(([k, v]) => <div key={k} className="wiki-def"><div className="wiki-k">{k}</div><div>{v}</div></div>)}</div>;
}

function ItemName({ id }: { id: string }) {
  const it = itemById(id);
  return <span className={it ? rarityClass(it) : ''}>{it?.name ?? id}</span>;
}

function ItemList() {
  const [cat, setCat] = useState('all');
  const list = ITEMS.filter((i) => cat === 'all' || i.type === cat);
  const cats = ['all', 'sword', 'shield', 'armor', 'consumable', 'material'];
  return (
    <>
      <div className="pill-tabs">
        {cats.map((c) => <button key={c} className={`pill${c === cat ? ' active' : ''}`} onClick={() => setCat(c)}>{c === 'all' ? '전체' : TYPE_LABEL[c]}</button>)}
      </div>
      <div className="card">
        {list.map((i) => (
          <a key={i.id} className="wiki-row" href={`#/wiki/items/${i.id}`}>
            <span className={rarityClass(i)}>{i.name}</span><span className="muted wiki-hint">{TYPE_LABEL[i.type]} · {RARITY_LABEL[i.rarity]}</span>
          </a>
        ))}
      </div>
    </>
  );
}

function ItemPage({ id }: { id: string }) {
  const item = itemById(id);
  if (!item) return <div className="empty">없는 아이템이에요.</div>;
  const src = itemSources(id);
  const uses = itemUses(id);
  const extra = [item.int ? `지력 +${item.int}` : '', item.spd ? `속도 +${item.spd}` : ''].filter(Boolean);
  return (
    <>
      <div className="card">
        <div className={`card-title ${rarityClass(item)}`}>{item.name}</div>
        <div className="muted">{TYPE_LABEL[item.type]} · {RARITY_LABEL[item.rarity]}</div>
        <ItemStats item={item} />
        {extra.map((e) => <div key={e} className="item-stat">{e}</div>)}
        <div className="stat-row"><span className="stat-label">판매가</span><span>{item.sell.toLocaleString()}D</span></div>
      </div>
      <div className="card">
        <div className="card-title">얻는 방법</div>
        {src.starter && <div className="wiki-line">시작할 때 지급</div>}
        {src.shop && <div className="wiki-line">상점 구매 {src.shop.price.toLocaleString()}D{src.shop.minProficiency > 0 && ` (숙련도 ${src.shop.minProficiency}+)`}</div>}
        {src.drops.map((d) => <div key={d.mob.id} className="wiki-line"><A to={`/mobs/${d.mob.id}`}>{d.mob.name}</A> 드롭 {pct(d.chance)}</div>)}
        {src.raidDrops.map((d) => <div key={d.name} className="wiki-line">{d.name} 드롭 {pct(d.chance)}</div>)}
        {src.crafts.map((r) => <div key={r.id} className="wiki-line">제작 (숙련도 {r.unlockProficiency}+): {r.materials.map((m, i) => <span key={m.itemId}>{i > 0 && ', '}{itemLink(m.itemId)} ×{m.quantity}</span>)}{r.gold > 0 && ` + ${r.gold.toLocaleString()}D`}</div>)}
        {!src.starter && !src.shop && !src.drops.length && !src.raidDrops.length && !src.crafts.length && <div className="muted">아직 얻을 수 없어요.</div>}
      </div>
      {uses.length > 0 && (
        <div className="card">
          <div className="card-title">쓰임새</div>
          {uses.map((r) => <div key={r.id} className="wiki-line">{itemLink(r.resultId)} 제작 재료 (×{r.materials.find((m) => m.itemId === id)?.quantity})</div>)}
        </div>
      )}
    </>
  );
}

function MobList() {
  const groups = [{ t: '보스', list: MOBS.filter((m) => m.kind === 'boss') }, { t: '일반 몹', list: MOBS.filter((m) => m.kind !== 'boss') }];
  return (
    <>
      {groups.map((g) => (
        <div key={g.t} className="card">
          <div className="card-title">{g.t}</div>
          {g.list.map((m) => (
            <a key={m.id} className="wiki-row" href={`#/wiki/mobs/${m.id}`}>
              <span>{m.name}</span><span className="muted wiki-hint">{dungeonById(m.dungeon)?.name} · HP {m.hp}</span>
            </a>
          ))}
        </div>
      ))}
    </>
  );
}

function MobPage({ id }: { id: string }) {
  const mob = mobById(id);
  if (!mob) return <div className="empty">없는 몹이에요.</div>;
  const s = mobSummary(mob);
  const view = bossView(id);
  return (
    <>
      <div className="card">
        <div className="card-title">{mob.name} <span className="badge">{mob.kind === 'boss' ? '보스' : '일반'}</span></div>
        {mob.note && <div className="note">{mob.note}</div>}
        {([['HP', mob.hp], ['공격력', mob.atk], ['방어력', mob.def], ['속도', mob.spd]] as const).map(([k, v]) => (
          <div key={k} className="stat-row"><span className="stat-label">{k}</span><span>{v}</span></div>
        ))}
        <div className="stat-row"><span className="stat-label">골드</span><span>{mob.gold[0]}~{mob.gold[1]}D</span></div>
        <div className="stat-row"><span className="stat-label">숙련도</span><span>승리 +{mob.profWin} / 패배 +{mob.profLose}</span></div>
        <div className="stat-row"><span className="stat-label">출현</span><span>{s.dungeon ? <A to={`/dungeons/${s.dungeon.id}`}>{s.dungeon.name}</A> : mob.dungeon}{(() => { const r = s.dungeon && spawnRates(s.dungeon).find((x) => x.mobId === mob.id); return r ? <span className="muted"> (탐험 시 {pct(r.rate)})</span> : null; })()}</span></div>
        <div className="stat-row"><span className="stat-label">입장 비용</span><span>{s.cost.gold}D{s.cost.key && <> + {itemLink(s.cost.key)} 1개</>}</span></div>
      </div>
      <div className="card">
        <div className="card-title">드롭</div>
        {mob.drops.length === 0 ? <div className="muted">없음</div> : mob.drops.map((d) => <div key={d.itemId} className="wiki-line">{itemLink(d.itemId)} {pct(d.chance)}</div>)}
      </div>
      {view && <BossBlocks view={view} />}
    </>
  );
}

function BossBlocks({ view }: { view: NonNullable<ReturnType<typeof bossView>> }) {
  return (
    <>
          {view.phases.map((p) => (
            <div key={p.phase} className="card">
              <div className="card-title">{p.phase}페이즈 <span className="muted">HP {p.fromHpPct}% 이하부터 · 공격력 ×{p.atkMult}</span></div>
              {p.enterText && <div className="note">{p.enterText}</div>}
              {p.pool.map((e) => <div key={e.name} className="wiki-line">{e.name} <span className="muted">{pct(e.share)}</span></div>)}
            </div>
          ))}
          <div className="card">
            <div className="card-title">패턴 설명</div>
            {view.patterns.map((p) => (
              <div key={p.id} className="wiki-def">
                <div className="wiki-k">{p.name} <span className="muted">{p.phases.map((n) => `${n}P`).join('·')}</span></div>
                <div>{p.text}</div>
                {p.telegraph && <div className="muted">예고: “{p.telegraph}”</div>}
              </div>
            ))}
          </div>
          {(view.vessel || view.minion || view.stance || view.hunger || view.enrage) && (
            <div className="card">
              <div className="card-title">특수 규칙</div>
              {view.vessel && <div className="wiki-line">{view.vessel}</div>}
              {view.minion && <div className="wiki-line">{view.minion}</div>}
              {view.hunger && <div className="wiki-line">{view.hunger}</div>}
              {view.enrage && <div className="wiki-line">{view.enrage}</div>}
              {view.stance?.map((t) => <div key={t} className="wiki-line">{t}</div>)}
            </div>
          )}
    </>
  );
}

function SkillList({ focus }: { focus?: string }) {
  const groups = skillsByRole();
  return (
    <>
      {Object.entries(groups).map(([role, list]) => (
        <div key={role} className="card">
          <div className="card-title">{role}</div>
          {list.map((s) => (
            <div key={s.id} id={s.id} className={`wiki-def${focus === s.id ? ' wiki-focus' : ''}`}>
              <div className="wiki-k">{s.name} <span className="muted">AP {s.apCost}{s.cooldown > 0 && ` · 쿨 ${s.cooldown}`}{s.unlockProficiency > 0 && ` · 숙련도 ${s.unlockProficiency}+`}</span></div>
              <div>{s.description}</div>
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

function DungeonList() {
  return (
    <div className="card">
      {DUNGEONS.map((d) => (
        <a key={d.id} className="wiki-row" href={`#/wiki/dungeons/${d.id}`}><span>{d.name}</span><span className="muted wiki-hint">숙련도 {d.minProficiency}+</span></a>
      ))}
    </div>
  );
}

function DungeonPage({ id }: { id: string }) {
  const d = dungeonById(id);
  if (!d) return <div className="empty">없는 지역이에요.</div>;
  return (
    <>
      <div className="card">
        <div className="card-title">{d.name}</div>
        <div className="note">{d.description}</div>
        <div className="stat-row"><span className="stat-label">입장 숙련도</span><span>{d.minProficiency > 0 ? `${d.minProficiency}+` : '제한 없음'}</span></div>
        <div className="stat-row"><span className="stat-label">권장 숙련도</span><span>{d.recommendedProficiency}+ ({getProfTier(d.recommendedProficiency).name})</span></div>
        <div className="stat-row"><span className="stat-label">일반 전투</span><span>{d.entry.normalGold}D</span></div>
        <div className="stat-row"><span className="stat-label">보스 전투</span><span>{d.entry.bossGold}D{d.entry.bossKey && <> + {itemLink(d.entry.bossKey)}</>}</span></div>
      </div>
      <div className="card">
        <div className="card-title">탐험하면 만나는 몬스터</div>
        {spawnRates(d).map(({ mobId, rate }) => <div key={mobId} className="wiki-line"><A to={`/mobs/${mobId}`}>{mobById(mobId)?.name ?? mobId}</A> <span className="muted">{pct(rate)}</span></div>)}
        {d.mobs.some((m) => mobById(m)?.kind === 'boss') && (
          <>
            <div className="card-title" style={{ marginTop: 10 }}>지역의 보스 (직접 도전)</div>
            {d.mobs.filter((m) => mobById(m)?.kind === 'boss').map((m) => <div key={m} className="wiki-line"><A to={`/mobs/${m}`}>{mobById(m)?.name ?? m}</A></div>)}
          </>
        )}
      </div>
    </>
  );
}

function RecipeList() {
  return (
    <div className="card">
      {RECIPES.map((r) => (
        <div key={r.id} className="wiki-def">
          <div className="wiki-k">{itemLink(r.resultId)}{r.resultQty > 1 && ` ×${r.resultQty}`} <span className="muted">숙련도 {r.unlockProficiency}+</span></div>
          <div>{r.materials.map((m, i) => <span key={m.itemId}>{i > 0 && ', '}{itemLink(m.itemId)} ×{m.quantity}</span>)}{r.gold > 0 && ` + ${r.gold.toLocaleString()}D`}</div>
        </div>
      ))}
    </div>
  );
}

function Tiers() {
  const { me } = useGame();
  const mine = me ? getProfTier(me.proficiency).level : -1;
  return (
    <div className="card">
      {PROFICIENCY_TIERS.map((t) => (
        <div key={t.level} className={`stat-row${t.level === mine ? ' wiki-mine' : ''}`}>
          <span>{t.level}. {t.name}{t.level === mine && ' ← 현재'}</span><span className="muted">{t.min.toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

// 사용하지 않는 import 방지용 (스킬 참조 링크 확장 대비)
void skillById;

const wait = (min: number) => (min >= 60 ? `${min / 60}시간` : `${min}분`);

function RaidList() {
  return (
    <>
      <div className="card">
        {Object.values(RAID_BOSSES).sort((a, b) => a.star - b.star).map((b) => (
          <a key={b.id} className="wiki-row" href={`#/wiki/raids/${b.id}`}>
            <span><span className="stars">{starLabel(b.star)}</span> {b.name}</span>
            <span className="muted wiki-hint">적정 {b.recParty}명 · 최대 {b.maxParty}명</span>
          </a>
        ))}
      </div>
      <div className="card">
        <div className="card-title">역할</div>
        {raidRoleViews().map((r) => (
          <div key={r.id} className="wiki-def">
            <div className="wiki-k">{r.label}</div>
            <div>{r.desc}</div>
            {r.skills.map((s) => <div key={s.id} className="muted gdesc">{s.name}{s.ultimate ? ' (궁극기)' : ''} · AP {s.apCost}{s.cooldown ? ` · 쿨 ${s.cooldown}` : ''} — {s.description}</div>)}
          </div>
        ))}
        <div className="note">4인 레이드는 역할당 1명, 8인 레이드는 2명까지 고를 수 있어요. 레이드 스탯은 장비 상한(HP 900·ATK 150·DEF 60)을 둔 뒤 역할 배율을 곱해요.</div>
      </div>
    </>
  );
}

function RaidPage({ id }: { id: string }) {
  const b = RAID_BOSSES[id];
  const view = raidBossView(id);
  if (!b || !view) return <div className="empty">없는 레이드예요.</div>;
  return (
    <>
      <div className="card">
        <div className="card-title"><span className="stars">{b.star > 0 ? '★'.repeat(b.star) + '☆'.repeat(5 - b.star) : '입문'}</span> {b.name}</div>
        <div className="note">{b.note}</div>
        <div className="stat-row"><span className="stat-label">파티</span><span>2~{b.maxParty}명 (적정 {b.recParty}명) · 역할당 {raidRoleCap(id)}명</span></div>
        <div className="stat-row"><span className="stat-label">입장 숙련도</span><span>{b.minProficiency}+ ({getProfTier(b.minProficiency).name})</span></div>
        <div className="stat-row"><span className="stat-label">보스 HP</span><span>{b.hp.toLocaleString()} (적정 인원 기준, 인원에 비례)</span></div>
        <div className="stat-row"><span className="stat-label">공격력 · 방어력</span><span>{b.atk} · {b.def}</span></div>
        <div className="stat-row"><span className="stat-label">재입장 대기</span><span>{wait(b.cooldownMinutes)} (패배 시 절반)</span></div>
        <div className="stat-row"><span className="stat-label">보상</span><span>{b.gold[0].toLocaleString()}~{b.gold[1].toLocaleString()}D · 숙련도 +{b.profWin}</span></div>
      </div>
      <div className="card">
        <div className="card-title">드롭</div>
        {b.drops.map((d) => <div key={d.itemId} className="wiki-line">{itemLink(d.itemId)} {pct(d.chance)}</div>)}
      </div>
      <BossBlocks view={view} />
    </>
  );
}

function PvpGuide() {
  const r = PVP_RULES;
  const common: [string, string][] = [
    ['동시 선택', `매 라운드 모두 행동을 숨겨서 내고, 모두 내면 서버가 한꺼번에 처리해요. 제한 시간은 ${r.roundSeconds}초예요.`],
    ['미제출', `시간 안에 못 내면 방어로 처리돼요. ${r.missLimit}번 연속 안 내면 1v1은 기권패, 팀전은 그 사람이 쓰러진 것으로 봐요.`],
    ['아이템', 'PvP에서는 아이템을 쓸 수 없어요 (돈으로 이기지 않게).'],
    ['스탯 상한', `장비 스탯은 HP ${r.cap.maxHp}·ATK ${r.cap.atk}·DEF ${r.cap.def}까지만 반영돼요. 좋은 장비는 유리하지만 한 방에 끝나지 않아요.`],
    ['시간 초과', `${r.maxRounds}라운드가 넘으면 남은 HP 비율이 높은 쪽(팀은 팀 합계)이 이겨요.`],
    ['레이팅', `Elo 방식이에요. 시작은 ${r.startRating}이고 변동은 최대 ±${r.kFactor}예요. 기대보다 강한 상대를 이기면 더 많이 올라요. 친선전은 레이팅이 바뀌지 않아요.`],
    ['보상', '랭크전 승리에는 골드·숙련도 보상이 없어요 (승리 거래 방지). 레이팅과 랭킹이 보상이에요.'],
  ];
  return (
    <>
      <div className="card">
        <div className="card-title">공통 규칙</div>
        {common.map(([k, v]) => <div key={k} className="wiki-def"><div className="wiki-k">{k}</div><div>{v}</div></div>)}
      </div>
      <div className="card">
        <div className="card-title">1v1 랭크 · 친구 도전</div>
        <div className="wiki-line">모험 탭의 <b>대전 1v1</b>에서 랭크전 대기열에 들어가면 비슷한 레이팅의 상대와 매칭돼요. 기다릴수록 범위가 넓어지고, 화면을 열어 둬야 매칭이 이어져요 (대기 {r.queueSeconds}초 후 만료).</div>
        <div className="wiki-line">스킬은 내가 장착한 스킬(숙련도로 해금된 것)과 궁극기를 그대로 써요. 친구에게는 도전장을 보내 레이팅 없이 겨룰 수 있어요.</div>
      </div>
      <div className="card">
        <div className="card-title">4v4 역할 팀전</div>
        <div className="wiki-line">팀마다 <b>탱커·딜러·힐러·서포터</b>가 한 명씩이에요. 스킬은 레이드와 같은 역할별 스킬 {`(`}<A to="/raids">레이드 위키</A>{`)`}를 쓰고, 힐·보호막은 아군에게 써요.</div>
        <div className="wiki-line"><b>랭크전</b>: 역할을 고르고 대기하면 역할별 2명씩 8명이 모여 대전이 만들어져요. 두 팀의 레이팅 합이 비슷하게 나뉘고, 팀 평균 레이팅으로 Elo를 계산해 팀원 모두에게 같은 규칙이 적용돼요.</div>
        <div className="wiki-line"><b>친선 방</b>: 코드로 모이고 팀·역할을 정해요. 양 팀에 한 명 이상이면 시작할 수 있어서 1v1~4v4가 모두 가능하고, 레이팅은 변하지 않아요. 방은 30분 뒤 사라져요.</div>
        <div className="wiki-line"><b>도발</b>: 탱커가 도발하면 상대 팀은 단일 대상 공격을 도발한 사람에게만 할 수 있어요.</div>
        <div className="wiki-line">스탯은 PvP 상한을 적용한 뒤 역할 배율(탱커 HP↑·방어↑, 딜러 공격↑, 힐러 지력↑ 등)을 곱해요.</div>
      </div>
    </>
  );
}

function RogueList() {
  const total = Object.values(ROGUE_EVENT_WEIGHTS).reduce((a, b) => a + b, 0);
  const label: Record<string, string> = { monster: '⚔️ 몬스터', treasure: '💰 보물', trap: '🪤 함정', nothing: '🌫️ 빈 방' };
  return (
    <>
      <div className="card">
        <div className="card-title">로그라이크 던전이란?</div>
        <div className="wiki-line">층마다 방이 하나씩 열려요. 마지막 층에는 최종 보스가 있고 그 전까지는 무작위예요.</div>
        {Object.entries(ROGUE_EVENT_WEIGHTS).map(([k, w]) => <div key={k} className="wiki-line">{label[k]} <span className="muted">{pct(w / total)}</span></div>)}
        <div className="wiki-line">HP는 층을 내려가도 이어지고(전투 중 아이템으로만 회복), 함정은 치명적이지 않아요(HP 1 아래로 안 내려가요).</div>
        <div className="wiki-line">얻은 보상은 <b>전리품</b>으로 쌓여요. 완주하거나 후퇴하면 받고, 쓰러지면 잃어요(숙련도만 조금).</div>
        <div className="wiki-line">끝나면 던전마다 대기시간이 걸려요. 완주는 전체, 후퇴·사망은 절반이에요.</div>
      </div>
      <div className="card">
        {ROGUE_DUNGEONS.map((d) => (
          <a key={d.id} className="wiki-row" href={`#/wiki/rogue/${d.id}`}><span>{d.name}</span><span className="muted wiki-hint">{d.floors}층 · 숙련도 {d.minProficiency}+</span></a>
        ))}
      </div>
    </>
  );
}

function RoguePage({ id }: { id: string }) {
  const d = rogueById(id);
  if (!d) return <div className="empty">없는 던전이에요.</div>;
  const boss = MOBS.find((m) => m.id === d.finalBoss.mobId);
  return (
    <>
      <div className="card">
        <div className="card-title">{d.name}</div>
        <div className="note">{d.description}</div>
        <div className="stat-row"><span className="stat-label">층 수</span><span>{d.floors}층</span></div>
        <div className="stat-row"><span className="stat-label">입장 숙련도</span><span>{d.minProficiency > 0 ? `${d.minProficiency}+` : '제한 없음'} (권장 {d.recommendedProficiency}+)</span></div>
        <div className="stat-row"><span className="stat-label">입장 비용</span><span>{d.entryGold > 0 ? `${d.entryGold}D` : '무료'}</span></div>
        <div className="stat-row"><span className="stat-label">재입장 대기</span><span>{d.cooldownMinutes}분 (후퇴·사망 시 절반)</span></div>
        <div className="stat-row"><span className="stat-label">함정 피해</span><span>최대 HP의 {d.trapDamagePct[0]}~{d.trapDamagePct[1]}%</span></div>
      </div>
      <div className="card">
        <div className="card-title">몬스터 방</div>
        {d.monsters.map((m) => <div key={m} className="wiki-line"><A to={`/mobs/${m}`}>{mobById(m)?.name ?? m}</A></div>)}
        <div className="card-title" style={{ marginTop: 10 }}>최종 보스</div>
        <div className="wiki-line">{d.finalBoss.title} <A to={`/mobs/${d.finalBoss.mobId}`}>{boss?.name}</A> — HP·공격력 ×{d.finalBoss.mult}</div>
      </div>
      <div className="card">
        <div className="card-title">보물 방 ({d.treasure.gold[0]}~{d.treasure.gold[1]}D, 층이 깊을수록 증가)</div>
        {(() => { const total = d.treasure.items.reduce((a, b) => a + b.weight, 0); return d.treasure.items.map((i) => <div key={i.itemId} className="wiki-line">{itemLink(i.itemId)} ×{i.qty[0] === i.qty[1] ? i.qty[0] : `${i.qty[0]}~${i.qty[1]}`} <span className="muted">{pct(i.weight / total)}</span></div>); })()}
      </div>
      <div className="card">
        <div className="card-title">완주 보너스</div>
        <div className="wiki-line">{d.clearBonus.gold[0].toLocaleString()}~{d.clearBonus.gold[1].toLocaleString()}D · 숙련도 +{d.clearBonus.proficiency}</div>
        {d.clearBonus.items.map((i) => <div key={i.itemId} className="wiki-line">{itemLink(i.itemId)} <span className="muted">{pct(i.chance)}</span></div>)}
      </div>
    </>
  );
}
