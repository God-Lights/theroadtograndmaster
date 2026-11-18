/** 디스코드 상호작용 요청의 Ed25519 서명을 검증한다 (공개 키는 디스코드 개발자 포털의 Public Key) */
const hex = (s: string): Uint8Array => {
  if (!/^[0-9a-fA-F]*$/.test(s) || s.length % 2 !== 0) throw new Error('bad hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
};

export const MAX_SKEW_SECONDS = 300;

export async function verifyDiscordSignature(publicKeyHex: string, signatureHex: string, timestamp: string, body: string, nowMs = Date.now()): Promise<boolean> {
  try {
    const ts = Number(timestamp);
    if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > MAX_SKEW_SECONDS) return false; // 오래된 요청(재전송) 거절
    const data = new TextEncoder().encode(timestamp + body);
    const key = hex(publicKeyHex), sig = hex(signatureHex);
    if (key.length !== 32 || sig.length !== 64) return false;
    for (const alg of [{ name: 'Ed25519' }, { name: 'NODE-ED25519', namedCurve: 'NODE-ED25519' }]) {
      try {
        const k = await crypto.subtle.importKey('raw', key, alg as never, false, ['verify']);
        return await crypto.subtle.verify(alg.name, k, sig, data);
      } catch { /* 이 환경이 지원하지 않는 이름이면 다음 이름으로 */ }
    }
    return false;
  } catch {
    return false;
  }
}
