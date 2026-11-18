import type { Combatant } from '@rtgm/engine';
import { AP_MAX } from '@rtgm/engine';

const STATUS_LABEL: Record<string, string> = {
  weaken: '약화', vulnerable: '취약', bleed: '출혈', slow: '둔화', frenzy: '광란', counter: '반격 태세',
  ironwall: '철벽', ironwall_next: '철벽 여운', will: '의지', regen: '재생', shield: '보호막', morale: '사기',
  overdrive: '극한 개방', command: '전장 지휘', unyielding: '불굴', lastshield: '최후의 방패',
};

/** 현재 라운드 기준 상태 효과 배지 (남은 라운드 표시) */
export function StatusBadges({ who, round }: { who: Combatant; round: number }) {
  const list = (who.statuses ?? []).filter((s) => s.until >= round);
  if (list.length === 0) return null;
  return (
    <>
      {list.map((s) => {
        const waiting = (s.from ?? 0) > round;
        const left = s.until - round + 1;
        return (
          <span key={s.id} className={`badge ${s.harmful ? 'bad' : 'good'}`}>
            {STATUS_LABEL[s.id] ?? s.id}{s.shield ? ` ${s.shield}` : ''} · {waiting ? '예약' : `${left}R`}
          </span>
        );
      })}
    </>
  );
}

/** AP 점(●) 표시와 궁극기 게이지 */
export function Resources({ who }: { who: Combatant }) {
  if (who.ap === undefined) return null;
  const gauge = who.gauge ?? 0;
  return (
    <div className="resources">
      <span className="ap-pips" aria-label={`AP ${who.ap}/${AP_MAX}`}>
        <span className="muted">AP</span>
        {Array.from({ length: AP_MAX }, (_, i) => <i key={i} className={i < who.ap! ? 'on' : ''} />)}
      </span>
      <span className="gauge" aria-label={`궁극기 ${gauge}%`}>
        <span className="muted">궁극</span>
        <span className="gauge-bar"><span className={gauge >= 100 ? 'full' : ''} style={{ width: `${gauge}%` }} /></span>
      </span>
    </div>
  );
}
