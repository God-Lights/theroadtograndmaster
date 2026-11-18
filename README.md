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

## 배포 (GitHub Actions)

도메인은 `rtgm.officialgl.com` (`wrangler.toml`의 `routes`). D1 `rtgm`은 이미 만들어져 있다.
`.github/workflows/deploy.yml`: PR은 타입체크·테스트·빌드만, `main` 푸시/수동 실행은 D1 마이그레이션 → 배포 → 시크릿 동기화 순서로 실행한다.

GitHub 저장소 설정(Settings → Secrets and variables → Actions)에 등록할 값:

| 이름 | 종류 | 용도 |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | Workers 편집 + D1 편집 권한 + 존 읽기(커스텀 도메인) |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Cloudflare 계정 ID |
| `GL_ACCOUNT_KEY` | Secret | GL Account 서비스 키 → 배포 때 Worker 시크릿으로 자동 동기화 |

`production` Environment를 만들어 두면 배포 승인자·브랜치 제한을 걸 수 있다. 일반 변수는 GitHub Variables에 두고 워크플로우의 `wrangler deploy --var NAME:${{ vars.NAME }}`로 넘긴다.

## 로그인 (GL Account 연동)

로그인·로그아웃·회원가입은 `account.officialgl.com`이 처리한다. 이 서비스는 화면을 만들지 않는다.

- 모든 요청(페이지·정적 파일·API, `/api/health` 제외)에서 `gl_session` 쿠키를 서버가 `verify-session`으로 검증한다.
- 비로그인: 페이지는 `https://account.officialgl.com/?return=<현재 주소>`로 리다이렉트, API는 401 (클라이언트가 같은 로그인 주소로 이동).
- GL Account 장애(5xx/네트워크)는 로그인 반복을 막기 위해 503.
- 사용자 키는 `user.id`(UUID)만 쓴다. 이메일은 저장·노출하지 않는다. 검증 결과 캐시는 30초.
- 이메일 인증이 필요한 기능에는 `requireVerifiedEmail` 미들웨어를 붙인다. 닉네임 조회는 `GET /api/users/:id`.
- 서비스 키는 시크릿으로만 둔다: `npx wrangler secret put GL_ACCOUNT_KEY`. 로컬은 `apps/worker/.dev.vars` (`.dev.vars.example` 참고, gitignore 대상).
- 서비스 키는 GL Account 쪽 `SERVICE_API_KEYS`에 등록해야 한다. 로컬에서는 `*.officialgl.com` 쿠키가 오지 않으므로 로그인 전체 흐름은 배포 후 확인한다.

## 현재 상태 (뼈대)

- UI/UX는 EDRPG를 기준으로 했다: 남색+금색 테마, 상단바(닉네임·달런트·티어), 상단 탭(모바일은 하단 고정 내비), 카드·아이템 그리드, 등급 색, 숙련도 잠금 라벨, 전투 아레나, 승패 모달·토스트.
- 폰 최적화: 노치·홈 인디케이터 안전영역, `dvh`, 터치 44px 타깃, 하단 내비·2열 전투 버튼, 가로 모드 대응, 판매 수량 스텝퍼, 요청 15초 타임아웃·실패 시 재시도, 앱 복귀 시 자동 새로고침, 진동 피드백, 홈 화면 추가(PWA 매니페스트·아이콘). 앱 아이콘·매니페스트만 로그인 없이 공개한다.
- 구현: 공용 전투 엔진(공격·방어·아이템, 속도순 해결, 연속 방어 감소, 결정론적 RNG), 전투 API, 기본 화면 4개
- 구현: 인벤토리(장착·해제·판매), 상점 구매, 전투 보상, 숙련도 티어 표시
- 미구현: 제작·시장·농장·길드·PvP·친구 탭, 스킬·역할 시스템, 마나/AP, 제작, 친구·길드·레이드·교환소·PvP
- 임시값: 피해 공식(`calcDamage`)은 EDRPG 계산식과 대조 후 교체 예정
