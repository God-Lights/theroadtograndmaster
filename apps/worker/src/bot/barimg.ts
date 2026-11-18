/**
 * 전투 화면용 HP·AP 막대 이미지(PNG)를 만든다. 외부 이미지 라이브러리 없이 직접 그린다 (Workers/Node 모두 동작).
 * 주소 예: /bot/bars.png?r=a62,_,f40,p4,u30
 *   a=아군 HP% · f=적 HP% · b=보스 HP% · x=쓰러짐 · _=간격 · p<0~6>=AP 점 · u<0~100>=궁극기 게이지
 */
export type Row = { t: 'a' | 'f' | 'b' | 'x'; pct: number } | { t: 'gap' } | { t: 'pips'; n: number } | { t: 'gauge'; pct: number };

const TOKEN = /^(?:[afbx]\d{1,3}|_|p[0-6]|u\d{1,3})$/;
export const MAX_ROWS = 16;

export function parseRows(q: string | null | undefined): Row[] | null {
  if (!q) return null;
  const parts = q.split(',');
  if (parts.length === 0 || parts.length > MAX_ROWS || !parts.every((p) => TOKEN.test(p))) return null;
  return parts.map((p): Row => {
    if (p === '_') return { t: 'gap' };
    const n = Number(p.slice(1));
    if (p[0] === 'p') return { t: 'pips', n };
    if (p[0] === 'u') return { t: 'gauge', pct: Math.min(100, n) };
    return { t: p[0] as 'a' | 'f' | 'b' | 'x', pct: Math.min(100, n) };
  });
}

/** 막대 길이를 5% 단위로 맞춘다 — 주소 종류가 줄어 캐시 적중이 크게 늘고, 눈금(25·50·75%)과도 맞는다. 살아 있으면 최소 5% */
export const snapPct = (n: number): number => (n <= 0 ? 0 : Math.min(100, Math.max(5, Math.round(n / 5) * 5)));
export const rowsToQuery = (rows: Row[]): string => rows.map((r) => (r.t === 'gap' ? '_' : r.t === 'pips' ? `p${r.n}` : r.t === 'gauge' ? `u${snapPct(r.pct)}` : `${r.t}${snapPct(r.pct)}`)).join(',');

// ─── 그리기 ──────────────────────────────────────────────────────────────────

const W = 480, PAD = 6, THICK = 26, THIN = 16, GAP = 7, GROUP_GAP = 12, PIP = 16, PIP_GAP = 8;
type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const PALETTE: Record<string, [RGB, RGB]> = {
  a: [[156, 220, 96], [66, 176, 84]],      // 아군: 연두 → 초록
  f: [[255, 138, 101], [232, 74, 74]],     // 적: 주황 → 빨강
  b: [[255, 213, 79], [245, 124, 0]],      // 보스: 금 → 주황
  g: [[206, 147, 216], [126, 87, 194]],    // 궁극기: 보라
  low: [[255, 112, 67], [198, 40, 40]],    // 위험(25% 이하): 진한 빨강
};
const TRACK: RGB = [26, 26, 56];
const FRAME: RGB = [74, 74, 128];

interface Shape { y: number; h: number; kind: Exclude<Row, { t: 'gap' }> }

function layout(rows: Row[]): { shapes: Shape[]; height: number } {
  const thick = rows.filter((r) => r.t === 'a' || r.t === 'f' || r.t === 'b' || r.t === 'x').length <= 2;
  const shapes: Shape[] = [];
  let y = PAD;
  rows.forEach((r, i) => {
    const prev = rows[i - 1];
    if (r.t === 'gap') { y += GROUP_GAP; return; }
    if (i > 0 && prev && prev.t !== 'gap') y += GAP;
    const h = r.t === 'pips' ? PIP : r.t === 'gauge' ? 10 : thick ? THICK : THIN;
    shapes.push({ y, h, kind: r });
    y += h;
  });
  return { shapes, height: y + PAD };
}

/** 둥근 사각형(x0..x1, y0..y1, 반지름 r) 안쪽 거리 — 음수면 안쪽. 가장자리 안티앨리어싱에 쓴다 */
function sdRound(px: number, py: number, x0: number, y0: number, x1: number, y1: number, r: number): number {
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, hx = (x1 - x0) / 2 - r, hy = (y1 - y0) / 2 - r;
  const dx = Math.abs(px - cx) - hx, dy = Math.abs(py - cy) - hy;
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
}
const cover = (d: number) => Math.max(0, Math.min(1, 0.5 - d)); // 거리 → 0~1 커버리지

export function renderRgba(rows: Row[]): { width: number; height: number; data: Uint8Array } {
  const { shapes, height } = layout(rows);
  const data = new Uint8Array(W * height * 4);
  const put = (x: number, y: number, c: RGB, a: number) => {
    if (a <= 0) return;
    const i = (y * W + x) * 4;
    const ea = data[i + 3]! / 255;
    const oa = a + ea * (1 - a);
    for (let k = 0; k < 3; k++) data[i + k] = Math.round((c[k]! * a + data[i + k]! * ea * (1 - a)) / oa);
    data[i + 3] = Math.round(oa * 255);
  };
  for (const s of shapes) {
    const k = s.kind;
    if (k.t === 'pips') {
      for (let n = 0; n < 6; n++) {
        const cx = PAD + 8 + n * (PIP + PIP_GAP), cy = s.y + PIP / 2;
        for (let y = s.y; y < s.y + PIP; y++) for (let x = cx - PIP / 2 - 1; x <= cx + PIP / 2 + 1; x++) {
          const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - PIP / 2 + 1;
          const on = n < k.n;
          put(x, y, on ? mix([130, 196, 255], [38, 128, 230], (y - s.y) / PIP) : TRACK, cover(d));
          if (!on) put(x, y, FRAME, cover(d) * (1 - cover(d + 1.6)));
        }
      }
      continue;
    }
    const x0 = PAD, x1 = W - PAD, r = s.h / 2;
    const pct = k.pct;
    const fillW = Math.max(0, ((x1 - x0) * pct) / 100);
    const key: string = k.t === 'gauge' ? 'g' : k.t;
    const colors = key === 'x' ? null : key === 'a' && pct <= 25 ? PALETTE.low! : PALETTE[key]!;
    for (let y = s.y; y < s.y + s.h; y++) for (let x = x0; x < x1; x++) {
      const px = x + 0.5, py = y + 0.5;
      const outer = cover(sdRound(px, py, x0, s.y, x1, s.y + s.h, r));
      if (outer <= 0) continue;
      const inner = cover(sdRound(px, py, x0 + 1.5, s.y + 1.5, x1 - 1.5, s.y + s.h - 1.5, r - 1.5));
      put(x, y, FRAME, outer);
      put(x, y, TRACK, inner);
      // 채워진 부분: 왼쪽에서 pct% 만큼, 끝은 둥글게
      if (colors && fillW > 0.5) {
        const fx1 = x0 + 1.5 + Math.max(0, fillW - 3);
        const fd = sdRound(px, py, x0 + 1.5, s.y + 1.5, Math.max(fx1, x0 + 1.5 + s.h - 3), s.y + s.h - 1.5, r - 1.5);
        const a = Math.min(inner, cover(fd));
        if (a > 0) {
          const t = (py - s.y) / s.h;
          let c = mix(colors[0], colors[1], t);
          if (t < 0.34) c = mix(c, [255, 255, 255], 0.22 * (1 - t / 0.34)); // 위쪽 하이라이트
          put(x, y, c, a);
        }
      }
      // 25·50·75% 눈금
      if (k.t !== 'gauge') for (const tick of [25, 50, 75]) {
        const tx = x0 + ((x1 - x0) * tick) / 100;
        if (Math.abs(px - tx) < 0.7) put(x, y, [10, 10, 30], 0.35 * inner);
      }
    }
  }
  return { width: W, height, data };
}

// ─── PNG 인코딩 ──────────────────────────────────────────────────────────────

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (bytes: Uint8Array): number => { let c = 0xffffffff; for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function chunk(type: string, body: Uint8Array): Uint8Array {
  const t = new TextEncoder().encode(type);
  const td = new Uint8Array(t.length + body.length);
  td.set(t); td.set(body, t.length);
  const out = new Uint8Array(12 + body.length);
  out.set(u32(body.length), 0); out.set(td, 4); out.set(u32(crc32(td)), 8 + body.length);
  return out;
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const stream = new Response(raw as unknown as BodyInit).body!.pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function encodePng(img: { width: number; height: number; data: Uint8Array }): Promise<Uint8Array> {
  const { width, height, data } = img;
  const raw = new Uint8Array((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width * 4 + 1)] = 0; raw.set(data.subarray(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1); }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0); ihdr.set(u32(height), 4); ihdr[8] = 8; ihdr[9] = 6; // 8비트 RGBA
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array())];
  const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const renderBarsPng = async (rows: Row[]): Promise<Uint8Array> => encodePng(renderRgba(rows));
