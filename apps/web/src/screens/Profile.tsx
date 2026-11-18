import { getNextTier, getProfTier, itemById } from '@rtgm/data';
import { ACCOUNT_ORIGIN } from '../api';
import { useGame } from '../game';
import { DiscordLink } from '../components/DiscordLink';
import { AdminEvents, Events } from '../components/Events';
import { Icon } from '../Icon';

export function Profile() {
  const { me, inv } = useGame();
  if (!me || !inv) return null;

  const tier = getProfTier(me.proficiency);
  const next = getNextTier(me.proficiency);
  const pct = next ? Math.round(((me.proficiency - tier.min) / (next.min - tier.min)) * 100) : 100;
  const equipped = inv.items.filter((i) => i.equipped).map((i) => itemById(i.itemId)).filter((i) => !!i);
  const slotName = (type: string) => equipped.find((i) => i.type === type)?.name ?? '없음';
  const stats = inv.stats;
  const total = inv.items.reduce((a, b) => a + b.quantity, 0);

  return (
    <>
      <div className="section-hd"><h2><Icon name="person" className="ico-hd" /> 내 정보</h2></div>

      <Events />

      <div className="card">
        <div className="card-title"><Icon name="chart" className="ico-hd" /> 스탯</div>
        <div className="stat-row"><span className="stat-label">닉네임</span><span style={{ color: 'var(--gold)', fontWeight: 700 }}>{me.nickname}</span></div>
        <div className="stat-row"><span className="stat-label">달런트</span><span style={{ color: 'var(--gold2)' }}><Icon name="coin" /> {me.gold.toLocaleString()} D</span></div>
        <div className="stat-row"><span className="stat-label">최대 HP</span><span style={{ color: 'var(--hp)' }}><Icon name="heart" /> {stats.maxHp}</span></div>
        <div className="stat-row"><span className="stat-label">공격력</span><span style={{ color: '#ff8a65' }}><Icon name="sword" /> {stats.atk}</span></div>
        <div className="stat-row"><span className="stat-label">방어력</span><span style={{ color: '#42a5f5' }}><Icon name="shield" /> {stats.def}</span></div>
      </div>

      <div className="card">
        <div className="card-title"><Icon name="bag" className="ico-hd" /> 장착 아이템</div>
        <div className="stat-row"><span className="stat-label">검</span><span>{slotName('sword')}</span></div>
        <div className="stat-row"><span className="stat-label">방패</span><span>{slotName('shield')}</span></div>
        <div className="stat-row"><span className="stat-label">갑옷</span><span>{slotName('armor')}</span></div>
      </div>

      <div className="card">
        <div className="card-title"><Icon name="bolt" className="ico-hd" /> 숙련도</div>
        <div className="stat-row"><span className="stat-label">현재 티어</span><span style={{ color: 'var(--epic)', fontWeight: 700 }}>{tier.name} (Lv.{tier.level})</span></div>
        <div className="stat-row"><span className="stat-label">숙련도</span><span>{me.proficiency}{next ? ` / ${next.min}` : ' (MAX)'}</span></div>
        <div className="prof-bar-wrap"><div className="prof-bar" style={{ width: `${pct}%` }} /></div>
        <div style={{ fontSize: '.74rem', color: next ? 'var(--dim)' : 'var(--epic)', marginTop: 2 }}>
          {next ? `다음 티어: ${next.name} (${next.min} 필요)` : '최고 티어 달성!'}
        </div>
      </div>

      <div className="card">
        <div className="card-title"><Icon name="package" className="ico-hd" /> 인벤토리</div>
        <div className="stat-row"><span className="stat-label">아이템 종류</span><span>{inv.items.length} 종</span></div>
        <div className="stat-row"><span className="stat-label">총 수량</span><span>{total} 개</span></div>
      </div>

      <DiscordLink />

      {me.isAdmin && <AdminEvents />}

      <div className="card">
        <div className="card-title"><Icon name="settings" className="ico-hd" /> 계정</div>
        <div className="note">로그인·로그아웃·닉네임 변경은 GL Account에서 관리합니다.</div>
        <a className="btn btn-ghost" href={ACCOUNT_ORIGIN} target="_blank" rel="noreferrer">GL Account 열기</a>
      </div>
    </>
  );
}
