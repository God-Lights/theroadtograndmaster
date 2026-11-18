import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type ChatMessage, type FriendsPayload } from '../api';
import { useGame } from '../game';

export interface ChatTarget { channel: string; label: string }

const fmt = (t: number) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

export function Chat({ target, onTarget }: { target: ChatTarget; onTarget: (t: ChatTarget) => void }) {
  const { me, fail } = useGame();
  const [msgs, setMsgs] = useState<ChatMessage[]>([]);
  const [text, setText] = useState('');
  const [friends, setFriends] = useState<FriendsPayload['friends']>([]);
  const [hasGuild, setHasGuild] = useState(false);
  const [denied, setDenied] = useState(false);
  const [sending, setSending] = useState(false);
  const lastId = useRef(0);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.friends().then((d) => setFriends(d.friends)).catch(() => {});
    api.guild().then((d) => setHasGuild(!!d.guild)).catch(() => {});
  }, []);

  // 채널이 바뀌면 처음부터, 열려 있는 동안 4초마다 새 글만 받는다 (화면이 가려지면 쉰다)
  const poll = useCallback(async (reset: boolean) => {
    try {
      const { messages } = await api.chat(target.channel, reset ? 0 : lastId.current);
      setDenied(false);
      if (messages.length === 0 && !reset) return;
      const last = messages[messages.length - 1];
      if (last) lastId.current = last.id;
      setMsgs((prev) => (reset ? messages : [...prev, ...messages]).slice(-200));
    } catch (e) {
      if (reset) { setMsgs([]); setDenied(true); }
      else if ((e as { code?: string }).code === 'no_channel') setDenied(true);
    }
  }, [target.channel]);

  useEffect(() => {
    lastId.current = 0;
    setMsgs([]);
    void poll(true);
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void poll(false); }, 4000);
    return () => window.clearInterval(id);
  }, [poll]);

  useEffect(() => { boxRef.current?.scrollTo({ top: boxRef.current.scrollHeight }); }, [msgs]);

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    try { await api.chatSend(target.channel, body); setText(''); await poll(false); } catch (err) { fail(err); } finally { setSending(false); }
  };

  return (
    <>
      <div className="pill-tabs">
        <button className={`pill${target.channel === 'global' ? ' active' : ''}`} onClick={() => onTarget({ channel: 'global', label: '전체' })}>전체</button>
        {hasGuild && <button className={`pill${target.channel === 'guild' ? ' active' : ''}`} onClick={() => onTarget({ channel: 'guild', label: '길드' })}>길드</button>}
        {target.channel.startsWith('dm:') && <button className="pill active">{target.label}</button>}
      </div>
      {friends.length > 0 && (
        <select className="chat-dm" value="" onChange={(e) => { const f = friends.find((x) => x.id === e.target.value); if (f) onTarget({ channel: `dm:${f.id}`, label: `${f.nickname}님과 귓속말` }); }}>
          <option value="">귓속말 상대 고르기…</option>
          {friends.map((f) => <option key={f.id} value={f.id}>{f.nickname}</option>)}
        </select>
      )}
      <div className="card chat-box" ref={boxRef}>
        {denied && <div className="muted">이 채팅방에는 들어갈 수 없어요.</div>}
        {!denied && msgs.length === 0 && <div className="muted">아직 대화가 없어요. 첫 마디를 남겨 보세요!</div>}
        {msgs.map((m) => (
          <div key={m.id} className={`cmsg${m.userId === me?.id ? ' mine' : ''}`}>
            <span className="cname">{m.nickname}</span> <span className="ctime">{fmt(m.at)}</span>
            <div className="cbody">{m.body}</div>
          </div>
        ))}
      </div>
      <form className="wiki-search" onSubmit={send}>
        <input value={text} maxLength={200} onChange={(e) => setText(e.target.value)} placeholder={`${target.label}에 메시지 보내기`} enterKeyHint="send" disabled={denied} />
        <button className="btn btn-primary" type="submit" disabled={sending || denied}>전송</button>
      </form>
    </>
  );
}
