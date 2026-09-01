# Claude 사용량 Worker

폰 앱이 1~2초 만에 사용량을 받아볼 수 있게 해주는 중계 서버입니다.
GitHub Actions 를 거치지 않으므로 훨씬 빠르고, Worker 자체 스케줄러(5분)가
GitHub cron 보다 안정적으로 동작합니다.

```
폰 앱 --(1~2초)--> Cloudflare Worker --> Anthropic
                        └ KV: 토큰 + 최근 결과 보관
```

## 설정 (한 번만, 약 10분)

### 1. Worker 만들기

1. [Cloudflare 가입](https://dash.cloudflare.com/sign-up) (무료)
2. 좌측 **Compute (Workers)** → **Create** → **Start with Hello World** → 이름 `claude-usage` → **Deploy**
3. 만들어진 Worker → **Edit code** → 편집기 내용을 전부 지우고
   이 폴더의 `src/worker.js` 내용을 통째로 붙여넣기 → **Deploy**

### 2. KV 저장소 연결

1. 좌측 **Storage & Databases** → **KV** → **Create namespace** → 이름 `claude-usage-store`
2. Worker → **Settings** → **Bindings** → **Add** → **KV namespace**
   - Variable name: `STORE`  ← 반드시 이 이름
   - KV namespace: 방금 만든 것 선택

### 3. 시크릿 2개 등록

Worker → **Settings** → **Variables and Secrets** → **Add** → 타입을 **Secret** 으로

| 이름 | 값 |
|---|---|
| `CLAUDE_CREDENTIALS` | `~/.claude/.credentials.json` 내용 전체 (GitHub Secret 에 넣은 것과 동일) |
| `APP_KEY` | 아무 긴 문자열. 이 Worker 를 내 앱만 쓰게 하는 열쇠 |

`APP_KEY` 는 예를 들어 브라우저 주소창에 `javascript:` 없이, 아래를 아무 데서나 실행해 만들면 됩니다:
`openssl rand -hex 24` — 또는 그냥 길고 무작위한 문자열을 직접 지어도 됩니다.

### 4. 스케줄 등록 (자동 갱신)

Worker → **Settings** → **Trigger Events** → **Add** → **Cron Trigger** → `*/5 * * * *`

### 5. 앱에 연결

앱의 **"⚡ 즉시 갱신"** 카드에 아래 두 가지를 입력하고 저장:

- Worker 주소: `https://claude-usage.<계정이름>.workers.dev`
- APP_KEY: 위에서 정한 값

이제 새로고침을 누르면 1~2초 만에 최신 값이 뜹니다.

## 동작 확인

브라우저에서 열어 보세요 (`<KEY>` 는 APP_KEY):

```
https://claude-usage.<계정이름>.workers.dev/?k=<KEY>
```

`{"version":1,"fetched_at":"...","data":{...}}` 가 보이면 정상입니다.
`{"error":"unauthorized"}` 면 APP_KEY 가 다른 것입니다.

## 참고

- 15초 안에 다시 요청하면 직전 결과를 그대로 돌려줍니다(Anthropic 429 예방).
- 조회에 실패해도 마지막으로 성공한 값을 돌려주므로 화면이 비지 않습니다.
- 갱신된 토큰은 KV 에 보관되어 다음 호출에 재사용됩니다.
- 무료 요금제 한도(하루 10만 요청) 안에서 충분히 동작합니다.
