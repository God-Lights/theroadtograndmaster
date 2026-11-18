import { useEffect, useRef, useState } from 'react';
import { api, type Announcement } from '../api';

const SHOW_MS = 8000;
export const ANNOUNCE_ICON: Record<Announcement['kind'], string> = { boss: '📢', raid: '📢', dungeon: '📢' };

/** 전체 알림: 보스·큰 몹·레이드·던전 소식이 올라오면 상단에 잠깐 보여 준다. 처음 접속했을 때는 지난 알림을 한꺼번에 띄우지 않는다. */
export function Announcer() {
  const [current, setCurrent] = useState<Announcement>();
  const cursor = useRef<number | null>(null);
  const queue = useRef<Announcement[]>([]);
  const timer = useRef<number>();

  useEffect(() => {
    let alive = true;
    const showNext = () => {
      const next = queue.current.shift();
      setCurrent(next);
      window.clearTimeout(timer.current);
      if (next) timer.current = window.setTimeout(showNext, SHOW_MS);
    };
    const poll = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const r = await api.announcements(cursor.current ?? 0);
        if (!alive) return;
        if (cursor.current === null) { cursor.current = r.latest; return; }
        if (r.announcements.length > 0) {
          cursor.current = r.announcements[r.announcements.length - 1]!.id;
          queue.current.push(...r.announcements);
          setCurrent((cur) => { if (!cur) { queueMicrotask(showNext); } return cur; });
        }
      } catch { /* 다음 주기에 */ }
    };
    void poll();
    const id = window.setInterval(poll, 12_000);
    return () => { alive = false; window.clearInterval(id); window.clearTimeout(timer.current); };
  }, []);

  if (!current) return null;
  return (
    <div className="news-bar" role="status" onClick={() => setCurrent(undefined)}>
      <span>{ANNOUNCE_ICON[current.kind]} {current.text}</span>
    </div>
  );
}
