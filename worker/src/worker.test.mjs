// node --test worker/src/worker.test.mjs (네트워크·KV 전부 모킹)
import test from "node:test";
import assert from "node:assert/strict";
import { handleRequest, refreshAndStore, safeEqual, parseCredentials } from "./worker.js";

const USAGE = {
  five_hour: { utilization: 24, resets_at: "2026-09-01T04:00:00Z" },
  seven_day: { utilization: 4, resets_at: "2026-09-07T00:59:00Z" },
};

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function fakeKV(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => void m.set(k, v),
    _dump: () => Object.fromEntries(m),
  };
}

function mockFetch(handlers) {
  const calls = [];
  return Object.assign(
    async (url, opts = {}) => {
      calls.push({ url, opts });
      for (const h of handlers) if (url.includes(h.match)) return h.respond(calls, opts);
      throw new Error("unexpected url " + url);
    },
    { calls }
  );
}

const envWith = (store, extra = {}) => ({
  STORE: store,
  APP_KEY: "secret-key",
  CLAUDE_CREDENTIALS: JSON.stringify({
    claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: Date.now() + 3_600_000 },
  }),
  ...extra,
});

const req = (q) => new Request(`https://w.example.dev/?${q}`);

test("APP_KEY 가 틀리면 401", async () => {
  const res = await handleRequest(req("k=wrong"), envWith(fakeKV()), mockFetch([]));
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "unauthorized" });
});

test("APP_KEY 가 없으면 401", async () => {
  const res = await handleRequest(req(""), envWith(fakeKV()), mockFetch([]));
  assert.equal(res.status, 401);
});

test("정상 요청이면 사용량을 조회해 돌려주고 KV 에 저장한다", async () => {
  const kv = fakeKV();
  const f = mockFetch([{ match: "/api/oauth/usage", respond: () => jsonRes(200, USAGE) }]);
  const now = Date.parse("2026-09-01T01:00:00Z");
  const res = await handleRequest(req("k=secret-key"), envWith(kv), f, now);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.data.five_hour.utilization, 24);
  assert.equal(body.fetched_at, "2026-09-01T01:00:00.000Z");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
  assert.ok(kv._dump().usage, "usage 가 KV 에 저장됨");
});

test("15초 안에 다시 부르면 캐시를 돌려주고 Anthropic 을 부르지 않는다", async () => {
  const now = Date.parse("2026-09-01T01:00:00Z");
  const kv = fakeKV({
    usage: JSON.stringify({ version: 1, fetched_at: new Date(now - 5000).toISOString(), data: USAGE }),
  });
  const f = mockFetch([]); // 호출되면 예외
  const res = await handleRequest(req("k=secret-key"), envWith(kv), f, now);
  const body = await res.json();
  assert.equal(body.cached, true);
  assert.equal(f.calls.length, 0);
});

test("캐시가 오래됐으면 새로 조회한다", async () => {
  const now = Date.parse("2026-09-01T01:00:00Z");
  const kv = fakeKV({
    usage: JSON.stringify({ version: 1, fetched_at: new Date(now - 60_000).toISOString(), data: {} }),
  });
  const f = mockFetch([{ match: "/api/oauth/usage", respond: () => jsonRes(200, USAGE) }]);
  const body = await (await handleRequest(req("k=secret-key"), envWith(kv), f, now)).json();
  assert.equal(body.data.five_hour.utilization, 24);
  assert.equal(body.cached, undefined);
});

test("조회에 실패해도 마지막 성공값이 있으면 그것을 돌려준다", async () => {
  const now = Date.parse("2026-09-01T01:00:00Z");
  const kv = fakeKV({
    usage: JSON.stringify({ version: 1, fetched_at: new Date(now - 60_000).toISOString(), data: USAGE }),
  });
  const f = mockFetch([
    { match: "/api/oauth/usage", respond: () => jsonRes(500, { error: "boom" }) },
    { match: "/v1/oauth/token", respond: () => jsonRes(500, { error: "boom" }) },
  ]);
  const res = await handleRequest(req("k=secret-key"), envWith(kv), f, now);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.cached, true);
  assert.match(body.error, /HTTP 500/);
});

test("캐시도 없고 조회도 실패하면 502", async () => {
  const f = mockFetch([{ match: "/api/oauth/usage", respond: () => jsonRes(500, { error: "boom" }) }]);
  const res = await handleRequest(req("k=secret-key"), envWith(fakeKV()), f);
  assert.equal(res.status, 502);
});

test("401 이면 토큰을 갱신하고 갱신된 토큰을 KV 에 남긴다", async () => {
  const kv = fakeKV();
  let usageCalls = 0;
  const f = mockFetch([
    { match: "/v1/oauth/token", respond: () => jsonRes(200, { access_token: "at2", refresh_token: "rt2", expires_in: 28800 }) },
    { match: "/api/oauth/usage", respond: () => (++usageCalls === 1 ? jsonRes(401, {}) : jsonRes(200, USAGE)) },
  ]);
  const body = await (await handleRequest(req("k=secret-key"), envWith(kv), f)).json();
  assert.equal(body.data.five_hour.utilization, 24);
  const saved = JSON.parse(kv._dump().creds);
  assert.equal(saved.accessToken, "at2");
  assert.equal(saved.refreshToken, "rt2");
});

test("KV 의 자격증명이 죽었으면 시크릿으로 폴백한다", async () => {
  const kv = fakeKV({ creds: JSON.stringify({ accessToken: "dead", refreshToken: "rt-dead", expiresAt: 0 }) });
  const f = mockFetch([
    {
      match: "/v1/oauth/token",
      respond: (_, opts) =>
        JSON.parse(opts.body).refresh_token === "rt-dead"
          ? jsonRes(400, { error: "invalid_grant" })
          : jsonRes(200, { access_token: "at-new", expires_in: 100 }),
    },
    { match: "/api/oauth/usage", respond: (_, opts) => (opts.headers.Authorization === "Bearer dead" ? jsonRes(401, {}) : jsonRes(200, USAGE)) },
  ]);
  const body = await (await handleRequest(req("k=secret-key"), envWith(kv), f)).json();
  assert.equal(body.data.five_hour.utilization, 24);
});

test("장기 토큰(sk-ant-oat)이면 KV 에 자격증명을 쓰지 않는다", async () => {
  const kv = fakeKV();
  const f = mockFetch([{ match: "/api/oauth/usage", respond: () => jsonRes(200, USAGE) }]);
  const env = { STORE: kv, APP_KEY: "secret-key", CLAUDE_CREDENTIALS: "sk-ant-oat01-xyz" };
  await refreshAndStore(env, f);
  assert.equal(kv._dump().creds, undefined);
  assert.ok(kv._dump().usage);
});

test("OPTIONS 는 CORS 프리플라이트로 응답한다", async () => {
  const res = await handleRequest(new Request("https://w.example.dev/", { method: "OPTIONS" }), envWith(fakeKV()), mockFetch([]));
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*");
});

test("safeEqual 은 길이·내용이 같을 때만 참", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
  assert.equal(safeEqual(null, ""), true);
  assert.equal(safeEqual(null, "x"), false);
});

test("parseCredentials 는 두 형식을 모두 받는다", () => {
  assert.equal(parseCredentials("sk-ant-oat01-a").static, true);
  assert.equal(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: "x" } })).accessToken, "x");
});

test("KV 바인딩이 없어도 동작한다(임시 저장소로 폴백)", async () => {
  const f = mockFetch([{ match: "/api/oauth/usage", respond: () => jsonRes(200, USAGE) }]);
  const env = {
    APP_KEY: "secret-key",
    CLAUDE_CREDENTIALS: JSON.stringify({ claudeAiOauth: { accessToken: "at", expiresAt: Date.now() + 3_600_000 } }),
  }; // STORE 없음
  const res = await handleRequest(req("k=secret-key"), env, f);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).data.five_hour.utilization, 24);
});

test("시크릿이 없으면 무엇이 빠졌는지 알려준다", async () => {
  const r1 = await handleRequest(req("k=x"), { STORE: fakeKV() }, mockFetch([]));
  assert.equal(r1.status, 500);
  assert.match((await r1.json()).error, /APP_KEY/);

  const r2 = await handleRequest(req("k=secret-key"), { STORE: fakeKV(), APP_KEY: "secret-key" }, mockFetch([]));
  assert.equal(r2.status, 500);
  assert.match((await r2.json()).error, /CLAUDE_CREDENTIALS/);
});

test("APP_KEY 앞뒤 공백·줄바꿈은 무시한다", async () => {
  const f = mockFetch([{ match: "/api/oauth/usage", respond: () => jsonRes(200, USAGE) }]);
  const env = envWith(fakeKV(), { APP_KEY: "  secret-key\n" }); // 시크릿에 공백이 섞인 경우
  const res = await handleRequest(req("k=secret-key"), env, f);
  assert.equal(res.status, 200);
});

test("키가 다르면 이유를 알려준다", async () => {
  const res = await handleRequest(req("k=nope"), envWith(fakeKV()), mockFetch([]));
  assert.equal(res.status, 401);
  assert.match((await res.json()).hint, /APP_KEY/);
});
