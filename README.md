# Claude 사용량 한도 앱 📱

Claude 구독(Pro/Max)의 **5시간 세션 사용량**과 **주간 한도**를 핸드폰에서 한눈에 보는 개인용 앱입니다.

```
[GitHub Actions] --30분마다--> Anthropic 사용량 API 조회 --> usage.json
        └--> GitHub Pages 배포 --> 📱 폰 홈 화면의 웹앱이 표시
```

- 5시간 세션 / 주간(전체·Opus·Sonnet) 사용량을 게이지와 %로 표시
- 리셋까지 남은 시간 카운트다운
- 여유 → 주의 → 한도 임박 → 거의 소진 상태 표시
- 홈 화면에 추가하면 일반 앱처럼 아이콘으로 실행 (PWA), 오프라인에서도 마지막 데이터 표시

> ⚠️ Anthropic이 공식 제공하는 API가 아니라 Claude Code의 `/status` 명령이 쓰는
> 비공식 엔드포인트를 사용합니다. 언제든 형식이 바뀌거나 막힐 수 있어요.

---

## 처음 설정하기 (한 번만)

### 1. 저장소 공개(public) 전환 + Pages 켜기

무료 GitHub 계정은 **public 저장소에서만 GitHub Pages(앱 호스팅)를 쓸 수 있습니다.**

1. 저장소 **Settings → General** 맨 아래 **Change visibility → Public** 으로 전환
   - 공개되는 것은 이 코드와 사용량 **퍼센트 숫자**뿐입니다. 토큰·대화 내용은 절대 공개되지 않아요.
2. **Settings → Pages → Source** 를 **GitHub Actions** 로 선택

### 2. Claude 토큰을 Secret으로 등록

컴퓨터에 [Claude Code](https://code.claude.com/docs)가 설치되어 있고 구독 계정으로 로그인돼 있어야 합니다.

**방법 A (추천 · 간단): 장기 토큰 만들기**

터미널에서:

```bash
claude setup-token
```

브라우저 인증 후 나오는 `sk-ant-oat01-...` 토큰 전체를 복사하세요. (약 1년 유효, 자동 갱신 불필요)

**방법 B: credentials 파일 붙여넣기**

| OS | 가져오는 방법 |
|---|---|
| Windows | `%USERPROFILE%\.claude\.credentials.json` 파일 내용 전체 복사 |
| Linux / WSL | `cat ~/.claude/.credentials.json` |
| macOS | `security find-generic-password -s "Claude Code-credentials" -w` |

이 방법은 토큰이 주기적으로 만료되지만, 워크플로가 refresh 토큰으로 **자동 갱신**합니다.

**등록:** 저장소 **Settings → Secrets and variables → Actions → New repository secret**

- Name: `CLAUDE_CREDENTIALS`
- Secret: 위에서 복사한 값 (토큰 문자열 또는 JSON 전체)

### 3. 기본 브랜치(main)에 반영

예약 실행(cron)은 **기본 브랜치의 워크플로만** 동작합니다. 이 브랜치를 main에 머지하세요.

### 4. 첫 실행 & 폰에 설치

1. **Actions 탭 → "Claude 사용량 갱신" → Run workflow** 로 수동 실행
2. 성공하면 앱 주소가 열립니다: `https://<계정명>.github.io/<저장소명>/`
3. 폰(Android Chrome)에서 그 주소 접속 → 메뉴(⋮) → **"홈 화면에 추가"**

이후에는 30분마다 자동으로 갱신됩니다. 앱을 열면 1분마다 최신 데이터를 다시 확인합니다.

---

## 로컬에서 개발/미리보기

```bash
# 단위 테스트
node --test scripts/fetch-usage.test.mjs

# 샘플 데이터로 앱 미리보기
cp dev/usage.sample.json app/usage.json
python3 -m http.server 8000 --directory app
# → http://localhost:8000 접속 (확인 후 app/usage.json 삭제)
```

## 보안 메모

- 토큰은 GitHub **Secret**에만 저장됩니다. 페이지에 배포되는 것은 사용량 %와 리셋 시각뿐입니다.
- 실행 간에 갱신된 토큰은 Actions 캐시에 저장되는데, **시크릿에서 파생한 키로 AES-256 암호화**되어 캐시가 유출돼도 읽을 수 없습니다.
- 워크플로 로그에서도 토큰은 마스킹됩니다.

## 문제 해결

| 증상 | 원인/해결 |
|---|---|
| 앱에 "데이터가 없어요" | Actions가 아직 안 돌았거나 실패. Actions 탭에서 로그 확인 후 수동 실행 |
| `HTTP 401` 반복 | 토큰 만료/로그아웃. 컴퓨터에서 Claude Code 재로그인(또는 `claude setup-token` 재발급) 후 Secret을 새 값으로 교체 |
| `HTTP 429` | 비공식 API의 속도 제한. 워크플로가 자동으로 1회 재시도하며, 계속되면 다음 주기에 정상화되는 경우가 대부분 |
| "데이터가 오래됐어요" 배너 | 90분 이상 갱신이 없음. GitHub cron이 밀렸거나(흔함) 워크플로 실패. Actions 탭 확인 |
| 갱신 주기를 바꾸고 싶다 | `.github/workflows/usage.yml`의 `cron` 값 수정 (예: 15분마다 `"7,22,37,52 * * * *"`) |
