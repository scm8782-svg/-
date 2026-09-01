// Claude 사용량을 조회해 폰 앱에 바로 돌려주는 Cloudflare Worker.
//
// 왜 필요한가: 브라우저에서 api.anthropic.com 을 직접 부르면 CORS 로 막히고,
// Claude 토큰을 폰에 두게 된다. Worker 가 토큰을 쥐고 중계하면 둘 다 해결되며
// GitHub Actions 를 거치지 않으므로 1~2초 만에 끝난다.
//
// 필요한 설정
//   시크릿  CLAUDE_CREDENTIALS : ~/.claude/.credentials.json 내용 또는 sk-ant-oat... 토큰
//   시크릿  APP_KEY            : 앱만 이 Worker 를 쓰도록 하는 임의의 비밀 문자열
//   KV 바인딩 STORE            : 갱신된 토큰과 최근 조회 결과를 보관

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
// Claude Code 의 공개 OAuth client id (비밀값 아님)
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_UA = "claude-code/2.1.0";
// 같은 결과를 이 시간 안에 다시 요청하면 Anthropic 을 부르지 않는다(429 예방).
const CACHE_TTL_MS = 15_000;

const KEY_CREDS = "creds";
const KEY_USAGE = "usage";
const KEY_COOLDOWN = "refresh-cooldown-until";
// 갱신이 429 로 막히면 이 시간 동안은 갱신을 다시 시도하지 않는다.
const REFRESH_COOLDOWN_MS = 10 * 60 * 1000;

// KV 바인딩(STORE)이 아직 없어도 동작하도록 한 임시 저장소.
// 프로세스가 살아 있는 동안만 유지되므로 KV 를 연결하는 편이 좋다.
const memory = new Map();
const storeOf = (env) =>
  env.STORE ?? {
    get: async (k) => memory.get(k) ?? null,
    put: async (k, v) => void memory.set(k, v),
  };

export function parseCredentials(raw) {
  const text = (raw ?? "").trim();
  if (!text) throw new Error("CLAUDE_CREDENTIALS 가 비어 있습니다.");
  if (!text.startsWith("{")) {
    return { accessToken: text, refreshToken: null, expiresAt: null, static: true };
  }
  const obj = JSON.parse(text);
  const o = obj.claudeAiOauth ?? obj;
  if (!o.accessToken) throw new Error("credentials 에 accessToken 이 없습니다.");
  return {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken ?? null,
    expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null,
    static: false,
  };
}


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function refreshToken(creds, fetchImpl, now, opts = {}) {
  const { sleepImpl = sleep, retryDelays = [1_000, 3_000] } = opts;
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "anthropic" },
      body: JSON.stringify({ grant_type: "refresh_token", refresh_token: creds.refreshToken, client_id: CLIENT_ID }),
    });
    if (res.ok) break;
    if (res.status === 429 && attempt < retryDelays.length) {
      await sleepImpl(retryDelays[attempt]);
      continue;
    }
    throw new Error(`토큰 갱신 실패: HTTP ${res.status}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("토큰 갱신 응답에 access_token 이 없습니다.");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? creds.refreshToken,
    expiresAt: json.expires_in ? now + json.expires_in * 1000 : null,
    static: false,
  };
}

async function getUsageOnce(token, fetchImpl, ua) {
  return fetchImpl(USAGE_URL, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": ua,
      "Content-Type": "application/json",
    },
  });
}

/** 자격증명으로 사용량을 조회한다. 401 이면 갱신 후 1회 재시도. */
export async function fetchUsage(creds, fetchImpl, opts = {}) {
  const { now = Date.now(), ua = DEFAULT_UA, refreshAllowed = true } = opts;
  let current = { ...creds };

  // 저장된 만료시각은 틀릴 수 있으므로 일단 조회를 시도하고,
  // 실제로 401 이 났을 때만 갱신한다(불필요한 갱신이 429 를 부른다).
  let res = await getUsageOnce(current.accessToken, fetchImpl, ua);
  if (res.status === 401 && current.refreshToken) {
    if (!refreshAllowed) throw new Error("토큰 갱신 대기 중 (429 로 잠시 중단)");
    current = await refreshToken(current, fetchImpl, now, opts);
    res = await getUsageOnce(current.accessToken, fetchImpl, ua);
  }
  if (!res.ok) throw new Error(`사용량 조회 실패: HTTP ${res.status}`);
  return { creds: current, data: await res.json() };
}

/**
 * KV 의 저장된 자격증명(없으면 시크릿)으로 조회하고, 갱신된 토큰을 KV 에 되쓴다.
 * 저장된 자격증명이 죽어 있으면 시크릿으로 한 번 더 시도한다.
 */
export async function refreshAndStore(env, fetchImpl, now = Date.now(), opts = {}) {
  const fromSecret = parseCredentials(env.CLAUDE_CREDENTIALS);
  const store = storeOf(env);
  let stored = null;
  const raw = await store.get(KEY_CREDS);
  if (raw) {
    try { stored = parseCredentials(raw); } catch { /* 손상된 값은 무시 */ }
  }

  const cooldownRaw = await store.get(KEY_COOLDOWN);
  const cooldownUntil = cooldownRaw ? Number(cooldownRaw) : 0;
  const refreshAllowed = !(cooldownUntil > now);

  let lastErr;
  for (const creds of stored ? [stored, fromSecret] : [fromSecret]) {
    try {
      const { creds: finalCreds, data } = await fetchUsage(creds, fetchImpl, { ...opts, now, refreshAllowed });
      if (!finalCreds.static) await store.put(KEY_CREDS, JSON.stringify(finalCreds));
      const payload = { version: 1, fetched_at: new Date(now).toISOString(), data };
      await store.put(KEY_USAGE, JSON.stringify(payload));
      return payload;
    } catch (e) {
      lastErr = e;
      if (/HTTP 429/.test(String(e.message))) {
        await store.put(KEY_COOLDOWN, String(now + REFRESH_COOLDOWN_MS));
        break; // 429 면 다른 자격증명으로 더 시도해봐야 상황만 악화된다
      }
    }
  }
  throw lastErr;
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  };
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: corsHeaders() });

/** 타이밍 노출을 줄이기 위한 상수시간 비교 */
export function safeEqual(a, b) {
  // 붙여넣기 과정에서 앞뒤 공백·줄바꿈이 섞이는 일이 잦아 무시한다.
  const x = String(a ?? "").trim(), y = String(b ?? "").trim();
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

export async function handleRequest(request, env, fetchImpl = fetch, now = Date.now()) {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  if (!env.APP_KEY) return json({ error: "APP_KEY 시크릿이 설정되지 않았습니다" }, 500);
  if (!env.CLAUDE_CREDENTIALS) return json({ error: "CLAUDE_CREDENTIALS 시크릿이 설정되지 않았습니다" }, 500);

  const url = new URL(request.url);
  if (!safeEqual(url.searchParams.get("k"), env.APP_KEY)) {
    return json({ error: "unauthorized", hint: "URL 의 k 값과 APP_KEY 시크릿이 다릅니다" }, 401);
  }

  // 최근 결과가 아주 신선하면 그대로 돌려준다(Anthropic 429 예방).
  const cachedRaw = await storeOf(env).get(KEY_USAGE);
  let cached = null;
  if (cachedRaw) {
    try { cached = JSON.parse(cachedRaw); } catch {}
  }
  const age = cached ? now - Date.parse(cached.fetched_at) : Infinity;
  if (cached && Number.isFinite(age) && age >= 0 && age < CACHE_TTL_MS) {
    return json({ ...cached, cached: true });
  }

  try {
    return json(await refreshAndStore(env, fetchImpl, now));
  } catch (e) {
    // 조회에 실패해도 마지막으로 성공한 값이 있으면 그걸 준다.
    if (cached) return json({ ...cached, cached: true, error: String(e.message ?? e) });
    return json({ error: String(e.message ?? e) }, 502);
  }
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
  // 5분마다 미리 조회해 캐시를 데워 둔다(앱을 열면 즉시 최신값).
  async scheduled(event, env, ctx) {
    ctx.waitUntil(refreshAndStore(env, fetch).catch((e) => console.error(e.message ?? e)));
  },
};
