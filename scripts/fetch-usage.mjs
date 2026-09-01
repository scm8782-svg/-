#!/usr/bin/env node
// Claude 구독 사용량 한도를 조회해 usage.json 으로 저장하는 스크립트.
//
// - 입력(환경변수)
//   CLAUDE_CREDENTIALS : 필수. 아래 둘 중 하나
//       1) ~/.claude/.credentials.json 내용 전체(JSON, claudeAiOauth 포함)
//       2) `claude setup-token` 으로 만든 장기 토큰 문자열(sk-ant-oat...)
//   STATE_FILE         : 선택. 갱신(rotate)된 토큰 상태를 읽고/쓸 파일 경로
//   OUT                : 선택. 결과 JSON 경로 (기본 _site/usage.json)
//   CLAUDE_UA          : 선택. User-Agent 오버라이드
//
// - 비공식 엔드포인트(Claude Code 의 /status 가 쓰는 것과 동일)를 사용한다.
//   응답 형식이 예고 없이 바뀔 수 있으므로 원본을 그대로 저장하고,
//   해석은 프런트엔드에서 방어적으로 한다.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const TOKEN_URL = "https://console.anthropic.com/v1/oauth/token";
// Claude Code 의 공개 OAuth client id (비밀값 아님)
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const DEFAULT_UA = "claude-code/2.1.0";

/** 시크릿 문자열을 자격증명 객체로 해석한다. */
export function parseCredentials(raw) {
  const text = (raw ?? "").trim();
  if (!text) throw new Error("CLAUDE_CREDENTIALS 가 비어 있습니다.");
  if (!text.startsWith("{")) {
    // claude setup-token 등으로 만든 장기 토큰
    return { accessToken: text, refreshToken: null, expiresAt: null, static: true };
  }
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    throw new Error("CLAUDE_CREDENTIALS 를 JSON 으로 해석하지 못했습니다.");
  }
  const o = obj.claudeAiOauth ?? obj;
  if (!o.accessToken) throw new Error("credentials 에 accessToken 이 없습니다.");
  return {
    accessToken: o.accessToken,
    refreshToken: o.refreshToken ?? null,
    expiresAt: typeof o.expiresAt === "number" ? o.expiresAt : null,
    static: false,
  };
}


/** GitHub Actions 로그에서 토큰이 노출되지 않도록 마스킹한다. */
function maskInLogs(value) {
  if (value && process.env.GITHUB_ACTIONS === "true") {
    console.log(`::add-mask::${value}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function refreshToken(creds, fetchImpl, now = Date.now(), opts = {}) {
  // 토큰 엔드포인트도 429 를 자주 돌려주므로 백오프 재시도한다.
  const { sleepImpl = sleep, retryDelays = [5_000, 15_000, 45_000] } = opts;
  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "anthropic" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: creds.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
    if (res.ok) break;
    if (res.status === 429 && attempt < retryDelays.length) {
      console.warn(`토큰 갱신 429 - ${retryDelays[attempt] / 1000}초 후 재시도`);
      await sleepImpl(retryDelays[attempt]);
      continue;
    }
    const body = await res.text().catch(() => "");
    throw new Error(`토큰 갱신 실패: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error("토큰 갱신 응답에 access_token 이 없습니다.");
  maskInLogs(json.access_token);
  if (json.refresh_token) maskInLogs(json.refresh_token);
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

/**
 * 자격증명 하나로 조회를 시도한다. 401 이면 강제 갱신 후 1회 재시도,
 * 429 면 잠시 기다렸다가 1회 재시도한다.
 * @returns {Promise<{creds: object, data: object}>}
 */
export async function fetchUsage(creds, fetchImpl, opts = {}) {
  const { now = Date.now(), ua = DEFAULT_UA, retryDelayMs = 35_000, sleepImpl = sleep, refreshRetryDelays } = opts;
  const refreshOpts = { sleepImpl, ...(refreshRetryDelays ? { retryDelays: refreshRetryDelays } : {}) };
  let current = { ...creds };
  // 저장된 만료시각은 틀릴 수 있으므로 일단 조회부터 시도한다.
  // 불필요한 갱신은 Anthropic 토큰 엔드포인트의 429 를 유발한다.
  let res = await getUsageOnce(current.accessToken, fetchImpl, ua);
  if (res.status === 401 && current.refreshToken) {
    current = await refreshToken(current, fetchImpl, now, refreshOpts);
    res = await getUsageOnce(current.accessToken, fetchImpl, ua);
  }
  if (res.status === 429) {
    console.warn(`429 응답 - ${Math.round(retryDelayMs / 1000)}초 후 재시도합니다.`);
    await sleepImpl(retryDelayMs);
    res = await getUsageOnce(current.accessToken, fetchImpl, ua);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`사용량 조회 실패: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return { creds: current, data };
}

/**
 * 전체 실행 흐름. STATE_FILE 의 상태(이전 실행에서 갱신된 토큰)를 우선 쓰고,
 * 그 상태가 죽어 있으면(예: 사용자가 시크릿을 새로 등록) 시크릿으로 폴백한다.
 */
export async function run({ secretRaw, stateRaw = null, fetchImpl, now = Date.now(), ua, retryDelayMs, sleepImpl, refreshRetryDelays }) {
  const fromSecret = parseCredentials(secretRaw);
  let attempts;
  if (stateRaw) {
    let fromState = null;
    try {
      fromState = parseCredentials(stateRaw);
    } catch {
      console.warn("상태 파일을 해석하지 못해 무시합니다.");
    }
    attempts = fromState ? [fromState, fromSecret] : [fromSecret];
  } else {
    attempts = [fromSecret];
  }

  let lastErr;
  for (const creds of attempts) {
    try {
      const { creds: finalCreds, data } = await fetchUsage(creds, fetchImpl, { now, ua, retryDelayMs, sleepImpl, refreshRetryDelays });
      return {
        output: { version: 1, fetched_at: new Date(now).toISOString(), data },
        state: finalCreds.static ? null : finalCreds,
      };
    } catch (e) {
      lastErr = e;
      console.warn(`조회 시도 실패: ${e.message}`);
    }
  }
  throw lastErr;
}

async function main() {
  const outPath = process.env.OUT || "_site/usage.json";
  const statePath = process.env.STATE_FILE || null;

  let stateRaw = null;
  if (statePath) {
    stateRaw = await readFile(statePath, "utf8").catch(() => null);
  }

  const { output, state } = await run({
    secretRaw: process.env.CLAUDE_CREDENTIALS,
    stateRaw,
    fetchImpl: fetch,
    ua: process.env.CLAUDE_UA || DEFAULT_UA,
  });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(output, null, 2));
  console.log(`사용량 저장 완료 → ${outPath}`);

  if (statePath && state) {
    await writeFile(statePath, JSON.stringify(state));
    console.log(`토큰 상태 저장 완료 → ${statePath}`);
  }

  // 로그에는 민감하지 않은 요약만 남긴다.
  const d = output.data ?? {};
  const pct = (w) => (w && typeof w.utilization === "number" ? `${w.utilization}%` : "-");
  console.log(`5시간: ${pct(d.five_hour)} / 7일: ${pct(d.seven_day)} / 7일 Opus: ${pct(d.seven_day_opus)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
