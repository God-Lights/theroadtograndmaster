# RTGM — The Road to Grand Master

웹에서 즐기는 온라인 GUI RPG. 던전에서 몹을 잡고, 장비를 사거나 만들고, 탐험하고, 친구·길드·레이드·교환소·PvP로 이어지는 게임.

## 구조 (npm workspaces 모노레포)

```
apps/
  web/        React(Vite) 클라이언트: 마을·던전·상점·인벤토리 GUI
  worker/     Cloudflare Workers(Hono) API + D1. 전투 판정은 서버에서만 한다
packages/
  engine/     동시 선택 턴제 전투 엔진 (순수 함수, 솔로/PvP/레이드 공용)
  data/       아이템·몹 데이터 JSON (Python 밸런스 시뮬레이터와 공유 예정)
```

수치의 기준은 별도 스프레드시트(스킬·장비·몹 수치 시트)이며, 확정되면 `packages/data/data/*.json`으로 옮긴다.

## 실행

```bash
npm install
npm test            # 전투 엔진 테스트
npm run typecheck
npm run build       # 클라이언트 빌드 (apps/web/dist)
```

로컬 개발 (터미널 2개):

```bash
npm run build && npm run db:migrate:local -w @rtgm/worker
npm run dev:worker   # http://localhost:8787 (API + 빌드된 클라이언트)
```

```bash
npm run dev:web      # http://localhost:5173 (HMR, /api 는 8787로 프록시)
```

배포 전에 `wrangler d1 create rtgm`으로 D1을 만들고 `apps/worker/wrangler.toml`의 `database_id`를 교체한다.

## 현재 상태 (뼈대)

- 구현: 공용 전투 엔진(공격·방어·아이템, 속도순 해결, 연속 방어 감소, 결정론적 RNG), 전투 API, 기본 화면 4개
- 미구현: 로그인/계정, 인벤토리·장비 반영, 상점 구매, 스킬·역할 시스템, 마나/AP, 제작, 친구·길드·레이드·교환소·PvP
- 임시값: 피해 공식(`calcDamage`)은 EDRPG 계산식과 대조 후 교체 예정
