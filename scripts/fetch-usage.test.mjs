// node --test scripts/ 로 실행되는 단위 테스트 (네트워크 호출은 전부 모킹)
import test from "node:test";
import assert from "node:assert/strict";
import { parseCredentials, fetchUsage, run } from "./fetch-usage.mjs";

const USAGE = {
  five_hour: { utilization: 42, resets_at: "2026-08-31T18:00:00Z" },
  seven_day: { utilization: 71.5, resets_at: "2026-09-03T00:00:00Z" },
  seven_day_opus: null,
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
};

const jsonRes = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
  text: async () => JSON.stringify(body),
});

function mockFetch(handlers) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, opts });
    for (const h of handlers) {
      if (url.includes(h.match)) return h.respond(calls, opts);
    }
    throw new Error(`unexpected url: ${url}`);
  };
  fn.calls = calls;
  return fn;
}

test("장기 토큰(sk-ant-...) 문자열을 해석한다", () => {
  const c = parseCredentials("  sk-ant-oat01-abc  ");
  assert.equal(c.accessToken, "sk-ant-oat01-abc");
  assert.equal(c.static, true);
});

test("credentials.json (claudeAiOauth 래핑) 을 해석한다", () => {
  const raw = JSON.stringify({
    claudeAiOauth: { accessToken: "at", refreshToken: "rt", expiresAt: 1000 },
  });
  const c = parseCredentials(raw);
  assert.equal(c.accessToken, "at");
  assert.equal(c.refreshToken, "rt");
});

test("유효한 토큰이면 갱신 없이 바로 조회한다", async () => {
  const f = mockFetch([{ match: "/api/oauth/usage", respond: () => jsonRes(200, USAGE) }]);
  const now = Date.now();
  const creds = { accessToken: "at", refreshToken: "rt", expiresAt: now + 3_600_000, static: false };
  const { data } = await fetchUsage(creds, f, { now });
  assert.equal(data.five_hour.utilization, 42);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].opts.headers.Authorization, "Bearer at");
  assert.equal(f.calls[0].opts.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.match(f.calls[0].opts.headers["User-Agent"], /^claude-code\//);
});

test("401 을 받으면 갱신한 뒤 다시 조회한다", async () => {
  const f = mockFetch([
    {
      match: "/v1/oauth/token",
      respond: (_, opts) => {
        const body = JSON.parse(opts.body);
        assert.equal(body.grant_type, "refresh_token");
        assert.equal(body.refresh_token, "rt");
        return jsonRes(200, { access_token: "at2", refresh_token: "rt2", expires_in: 28800 });
      },
    },
    {
      match: "/api/oauth/usage",
      respond: (_, opts) => (opts.headers.Authorization === "Bearer old" ? jsonRes(401, {}) : jsonRes(200, USAGE)),
    },
  ]);
  const now = Date.now();
  const creds = { accessToken: "old", refreshToken: "rt", expiresAt: now - 1, static: false };
  const { creds: updated } = await fetchUsage(creds, f, { now });
  assert.equal(updated.accessToken, "at2");
  assert.equal(updated.refreshToken, "rt2");
  assert.ok(updated.expiresAt > now);
});

test("액세스 토큰이 살아 있으면 만료시각이 지났어도 갱신하지 않는다", async () => {
  let tokenCalls = 0;
  const f = mockFetch([
    { match: "/v1/oauth/token", respond: () => (tokenCalls++, jsonRes(200, { access_token: "x" })) },
    { match: "/api/oauth/usage", respond: () => jsonRes(200, USAGE) },
  ]);
  const now = Date.now();
  const creds = { accessToken: "still-good", refreshToken: "rt", expiresAt: now - 999_999, static: false };
  const { data } = await fetchUsage(creds, f, { now });
  assert.equal(data.five_hour.utilization, 42);
  assert.equal(tokenCalls, 0);
});

test("401 이면 강제 갱신 후 1회 재시도한다", async () => {
  let usageCalls = 0;
  const f = mockFetch([
    { match: "/v1/oauth/token", respond: () => jsonRes(200, { access_token: "at2", expires_in: 100 }) },
    {
      match: "/api/oauth/usage",
      respond: () => (++usageCalls === 1 ? jsonRes(401, { error: "expired" }) : jsonRes(200, USAGE)),
    },
  ]);
  const now = Date.now();
  const creds = { accessToken: "stale", refreshToken: "rt", expiresAt: now + 3_600_000, static: false };
  const { creds: updated, data } = await fetchUsage(creds, f, { now });
  assert.equal(updated.accessToken, "at2");
  assert.equal(updated.refreshToken, "rt"); // 응답에 refresh_token 없으면 기존 것 유지
  assert.equal(data.seven_day.utilization, 71.5);
  assert.equal(usageCalls, 2);
});

test("429 이면 대기 후 1회 재시도한다", async () => {
  let usageCalls = 0;
  let slept = 0;
  const f = mockFetch([
    {
      match: "/api/oauth/usage",
      respond: () => (++usageCalls === 1 ? jsonRes(429, { error: "rate" }) : jsonRes(200, USAGE)),
    },
  ]);
  const creds = { accessToken: "at", refreshToken: null, expiresAt: null, static: true };
  const { data } = await fetchUsage(creds, f, { retryDelayMs: 1, sleepImpl: async (ms) => void (slept = ms) });
  assert.equal(data.five_hour.utilization, 42);
  assert.equal(slept, 1);
});

test("상태 파일 자격증명이 죽었으면 시크릿으로 폴백한다", async () => {
  const f = mockFetch([
    {
      match: "/v1/oauth/token",
      respond: (_, opts) => {
        const body = JSON.parse(opts.body);
        // 상태 파일의 rt-dead 는 실패, 시크릿의 rt-live 는 성공
        return body.refresh_token === "rt-dead"
          ? jsonRes(400, { error: "invalid_grant" })
          : jsonRes(200, { access_token: "at-new", refresh_token: "rt-new", expires_in: 100 });
      },
    },
    {
      match: "/api/oauth/usage",
      respond: (_, opts) =>
        opts.headers.Authorization === "Bearer at-new" ? jsonRes(200, USAGE) : jsonRes(401, {}),
    },
  ]);
  const now = Date.now();
  const state = JSON.stringify({ accessToken: "at-dead", refreshToken: "rt-dead", expiresAt: now - 1 });
  const secret = JSON.stringify({ claudeAiOauth: { accessToken: "at-old", refreshToken: "rt-live", expiresAt: now - 1 } });
  const { output, state: newState } = await run({ secretRaw: secret, stateRaw: state, fetchImpl: f, now });
  assert.equal(output.data.five_hour.utilization, 42);
  assert.equal(newState.refreshToken, "rt-new");
  assert.equal(output.version, 1);
  assert.ok(output.fetched_at);
});

test("장기 토큰이면 상태를 저장하지 않는다", async () => {
  const f = mockFetch([{ match: "/api/oauth/usage", respond: () => jsonRes(200, USAGE) }]);
  const { state } = await run({ secretRaw: "sk-ant-oat01-x", fetchImpl: f });
  assert.equal(state, null);
});

test("토큰 갱신이 429 면 백오프 후 재시도한다", async () => {
  let tokenCalls = 0;
  const slept = [];
  const f = mockFetch([
    {
      match: "/v1/oauth/token",
      respond: () =>
        ++tokenCalls < 3
          ? jsonRes(429, { error: { type: "rate_limit_error" } })
          : jsonRes(200, { access_token: "at-ok", expires_in: 28800 }),
    },
    {
      match: "/api/oauth/usage",
      respond: (_, opts) => (opts.headers.Authorization === "Bearer old" ? jsonRes(401, {}) : jsonRes(200, USAGE)),
    },
  ]);
  const now = Date.now();
  const creds = { accessToken: "old", refreshToken: "rt", expiresAt: now - 1, static: false };
  const { creds: updated } = await fetchUsage(creds, f, {
    now,
    sleepImpl: async (ms) => void slept.push(ms),
    refreshRetryDelays: [1, 2, 3],
  });
  assert.equal(updated.accessToken, "at-ok");
  assert.equal(tokenCalls, 3);
  assert.deepEqual(slept, [1, 2]); // 두 번 실패 → 두 번 대기
});

test("토큰 갱신 429 가 재시도 횟수를 넘으면 실패한다", async () => {
  const f = mockFetch([
    { match: "/v1/oauth/token", respond: () => jsonRes(429, { error: "rate" }) },
    { match: "/api/oauth/usage", respond: () => jsonRes(401, {}) },
  ]);
  const now = Date.now();
  const creds = { accessToken: "old", refreshToken: "rt", expiresAt: now - 1, static: false };
  await assert.rejects(
    () => fetchUsage(creds, f, { now, sleepImpl: async () => {}, refreshRetryDelays: [1] }),
    /토큰 갱신 실패: HTTP 429/
  );
});

test("토큰 갱신이 429 아닌 오류면 즉시 실패한다", async () => {
  let tokenCalls = 0;
  const f = mockFetch([
    { match: "/v1/oauth/token", respond: () => (tokenCalls++, jsonRes(400, { error: "invalid_grant" })) },
    { match: "/api/oauth/usage", respond: () => jsonRes(401, {}) },
  ]);
  const now = Date.now();
  const creds = { accessToken: "old", refreshToken: "rt", expiresAt: now - 1, static: false };
  await assert.rejects(() => fetchUsage(creds, f, { now, sleepImpl: async () => {} }), /HTTP 400/);
  assert.equal(tokenCalls, 1); // 재시도 없음
});
