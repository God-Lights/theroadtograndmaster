import { useEffect, useMemo, useState } from 'react';
import {
  DUNGEONS, ITEMS, MOBS, PROFICIENCY_TIERS, RECIPES, SKILLS, SKILL_SLOTS, START_AP, ULTIMATE_SLOTS, CRAFT_PROFICIENCY_GAIN,
  dungeonById, getProfTier, itemById, mobById, skillById,
} from '@rtgm/data';
import {
  RARITY_LABEL, TYPE_LABEL, WIKI_KIND_LABEL, bossView, itemSources, itemUses, mobSummary, searchWiki, skillsByRole, wikiEntries,
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
  { id: 'skills', label: '스킬', desc: `${SKILLS.length}종 · 역할별` },
  { id: 'dungeons', label: '던전', desc: `${DUNGEONS.length}곳 · 입장 조건` },
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

const KIND_PATH: Record<WikiEntry['kind'], string> = { item: 'items', mob: 'mobs', skill: 'skills', dungeon: 'dungeons', recipe: 'recipes' };
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
    ['숙련도', `전투 승리·패배와 제작(+${CRAFT_PROFICIENCY_GAIN})으로 올라요. 숙련도에 따라 상점 품목, 제작법, 스킬, 던전 입장이 열려요.`],
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
        <div className="stat-row"><span className="stat-label">출현</span><span>{s.dungeon ? <A to={`/dungeons/${s.dungeon.id}`}>{s.dungeon.name}</A> : mob.dungeon}</span></div>
        <div className="stat-row"><span className="stat-label">입장 비용</span><span>{s.cost.gold}D{s.cost.key && <> + {itemLink(s.cost.key)} 1개</>}</span></div>
      </div>
      <div className="card">
        <div className="card-title">드롭</div>
        {mob.drops.length === 0 ? <div className="muted">없음</div> : mob.drops.map((d) => <div key={d.itemId} className="wiki-line">{itemLink(d.itemId)} {pct(d.chance)}</div>)}
      </div>
      {view && (
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
          {(view.vessel || view.minion || view.stance || view.hunger) && (
            <div className="card">
              <div className="card-title">특수 규칙</div>
              {view.vessel && <div className="wiki-line">{view.vessel}</div>}
              {view.minion && <div className="wiki-line">{view.minion}</div>}
              {view.hunger && <div className="wiki-line">{view.hunger}</div>}
              {view.stance?.map((t) => <div key={t} className="wiki-line">{t}</div>)}
            </div>
          )}
        </>
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
  if (!d) return <div className="empty">없는 던전이에요.</div>;
  return (
    <>
      <div className="card">
        <div className="card-title">{d.name}</div>
        <div className="note">{d.description}</div>
        <div className="stat-row"><span className="stat-label">입장 숙련도</span><span>{d.minProficiency}+</span></div>
        <div className="stat-row"><span className="stat-label">일반 전투</span><span>{d.entry.normalGold}D</span></div>
        <div className="stat-row"><span className="stat-label">보스 전투</span><span>{d.entry.bossGold}D{d.entry.bossKey && <> + {itemLink(d.entry.bossKey)}</>}</span></div>
      </div>
      <div className="card">
        <div className="card-title">출현 몹</div>
        {d.mobs.map((m) => <div key={m} className="wiki-line"><A to={`/mobs/${m}`}>{mobById(m)?.name ?? m}</A></div>)}
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
