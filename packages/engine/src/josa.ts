/** 한글 받침 유무에 따라 조사를 고른다. 예: josa('좀비', '이', '가') → '좀비가' */
export function josa(word: string, withBatchim: string, without: string): string {
  const code = word.charCodeAt(word.length - 1);
  const isHangul = code >= 0xac00 && code <= 0xd7a3;
  const hasBatchim = isHangul && (code - 0xac00) % 28 !== 0;
  return word + (hasBatchim ? withBatchim : without);
}
