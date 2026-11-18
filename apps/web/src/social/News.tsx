import { useEffect, useState } from 'react';
import { api, type Announcement } from '../api';

const ago = (t: number) => {
  const m = Math.floor((Date.now() - t) / 60000);
  return m < 1 ? '방금' : m < 60 ? `${m}분 전` : m < 1440 ? `${Math.floor(m / 60)}시간 전` : `${Math.floor(m / 1440)}일 전`;
};

/** 최근 전체 알림 (보스·레이드·던전 소식) */
export function News() {
  const [list, setList] = useState<Announcement[]>();
  useEffect(() => { api.announcements(0).then((r) => setList([...r.announcements].reverse())).catch(() => setList([])); }, []);
  return (
    <div className="card">
      <div className="card-title">최근 소식</div>
      {!list && <div className="muted">불러오는 중...</div>}
      {list?.length === 0 && <div className="muted">아직 소식이 없어요. 보스를 쓰러뜨리면 모두에게 알려져요!</div>}
      {list?.map((a) => (
        <div key={a.id} className="wiki-def">
          <div>{a.text}</div>
          <div className="muted gdesc">{ago(a.at)}</div>
        </div>
      ))}
    </div>
  );
}
