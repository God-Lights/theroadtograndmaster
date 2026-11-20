/** 카톡용 글 만들기 도우미. 카톡은 이미지·버튼이 없어서 글과 번호 메뉴만 쓴다. */
export const CHUNK = 450; // 카톡은 긴 글을 접어 버려서 한 메시지를 짧게 나눈다

/** 줄 단위로 나눈다 (한 줄이 너무 길면 그 줄을 자른다) */
export function chunkText(text: string, size = CHUNK): string[] {
  const out: string[] = [];
  let cur = '';
  for (const raw of text.split('\n')) {
    for (let line = raw; ; ) {
      const piece = line.slice(0, size);
      line = line.slice(size);
      if (cur && cur.length + 1 + piece.length > size) { out.push(cur); cur = ''; }
      cur = cur ? `${cur}\n${piece}` : piece;
      if (!line) break;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

/** 막대: ■■■■□□ 62% */
export function bar(pct: number, width = 10): string {
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  const on = Math.round((p / 100) * width);
  return `${'■'.repeat(on)}${'□'.repeat(width - on)} ${p}%`;
}

export const numbered = (items: string[]): string => items.map((t, i) => `${i + 1}. ${t}`).join('\n');
export const won = (n: number): string => `${n.toLocaleString('ko-KR')}D`;
