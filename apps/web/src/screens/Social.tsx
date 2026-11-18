import { useState } from 'react';
import { Icon } from '../Icon';
import { Chat, type ChatTarget } from '../social/Chat';
import { Exchange } from '../social/Exchange';
import { Friends } from '../social/Friends';
import { Guild } from '../social/Guild';

const SUBS = [
  { id: 'friends', label: '친구' },
  { id: 'chat', label: '채팅' },
  { id: 'guild', label: '길드' },
  { id: 'exchange', label: '교환소' },
] as const;
type SubId = (typeof SUBS)[number]['id'];

export function Social() {
  const [sub, setSub] = useState<SubId>('friends');
  const [target, setTarget] = useState<ChatTarget>({ channel: 'global', label: '전체' });
  return (
    <>
      <div className="section-hd"><h2><Icon name="users" className="ico-hd" /> 소셜</h2></div>
      <div className="pill-tabs">
        {SUBS.map((s) => <button key={s.id} className={`pill${sub === s.id ? ' active' : ''}`} onClick={() => setSub(s.id)}>{s.label}</button>)}
      </div>
      {sub === 'friends' && <Friends onWhisper={(p) => { setTarget({ channel: `dm:${p.id}`, label: `${p.nickname}님과 귓속말` }); setSub('chat'); }} />}
      {sub === 'chat' && <Chat target={target} onTarget={setTarget} />}
      {sub === 'guild' && <Guild />}
      {sub === 'exchange' && <Exchange />}
    </>
  );
}
