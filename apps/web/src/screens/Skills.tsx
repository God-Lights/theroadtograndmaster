import { useEffect, useState } from 'react';
import { getProfTier } from '@rtgm/data';
import { api, type SkillsPayload, type SkillView } from '../api';
import { useGame } from '../game';
import { Icon } from '../Icon';

const PRIORITY_TAG: Record<string, string> = { first: '선행', last: '후행', delayed: '충전' };

function SkillCard({ skill, busy, onToggle }: { skill: SkillView; busy: boolean; onToggle: () => void }) {
  return (
    <div className={`item-card${skill.equipped ? ' equipped' : ''}${skill.unlocked ? '' : ' item-locked'}`}>
      {skill.equipped && <div className="eq-badge">장착</div>}
      <div className="item-name">
        {skill.name}
        {skill.ultimate && <span className="tag ult">궁극</span>}
        {PRIORITY_TAG[skill.priority] && <span className="tag">{PRIORITY_TAG[skill.priority]}</span>}
      </div>
      <div className="item-stat">
        {skill.ultimate ? '게이지 100%' : <>AP {skill.apCost}{skill.cooldown > 0 ? ` · 쿨다운 ${skill.cooldown}` : ''}</>}
      </div>
      <div className="skill-desc">{skill.description}</div>
      {!skill.unlocked && (
        <div className="lock-label"><Icon name="lock" /> 숙련도 {skill.unlockProficiency} ({getProfTier(skill.unlockProficiency).name})</div>
      )}
      {skill.unlocked && (
        <div className="item-actions">
          <button className={`btn btn-sm ${skill.equipped ? 'btn-ghost' : 'btn-primary'}`} disabled={busy} onClick={onToggle}>
            {skill.equipped ? '해제' : '장착'}
          </button>
        </div>
      )}
    </div>
  );
}

export function Skills() {
  const { me, toast, fail } = useGame();
  const [data, setData] = useState<SkillsPayload>();
  const [busy, setBusy] = useState(false);
  useEffect(() => { api.skills().then(setData).catch(fail); }, [fail, me?.proficiency]);
  if (!data) return <div className="empty">불러오는 중...</div>;

  const normal = data.skills.filter((s) => !s.ultimate);
  const ults = data.skills.filter((s) => s.ultimate);
  const usedNormal = normal.filter((s) => s.equipped).length;
  const usedUlt = ults.filter((s) => s.equipped).length;

  const toggle = async (s: SkillView) => {
    setBusy(true);
    try {
      setData(await (s.equipped ? api.unequipSkill(s.id) : api.equipSkill(s.id)));
      toast(s.equipped ? `${s.name} 해제` : `${s.name} 장착`);
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  const section = (title: string, list: SkillView[]) => (
    <>
      <div className="card-title" style={{ marginTop: 14 }}>{title}</div>
      <div className="item-grid">
        {[...list].sort((a, b) => Number(b.equipped) - Number(a.equipped) || Number(b.unlocked) - Number(a.unlocked) || a.unlockProficiency - b.unlockProficiency)
          .map((s) => <SkillCard key={s.id} skill={s} busy={busy} onToggle={() => toggle(s)} />)}
      </div>
    </>
  );

  return (
    <>
      <div className="section-hd">
        <h2><Icon name="star" className="ico-hd" /> 스킬</h2>
        <span className="muted">일반 {usedNormal}/{data.slots} · 궁극 {usedUlt}/{data.ultimateSlots}</span>
      </div>
      <div className="note">
        전투에서 AP를 써서 사용하는 스킬이에요. AP는 라운드마다 +2, 기본 공격으로 +1 회복되고, 궁극기는 피해를 주고받으면 차오르는 게이지가 가득 차야 써요. 숙련도가 오르면 더 많은 스킬이 열려요.
      </div>
      {section('일반 스킬', normal)}
      {section('궁극기', ults)}
    </>
  );
}
