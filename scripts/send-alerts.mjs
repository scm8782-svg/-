#!/usr/bin/env node
// 사용량이 임계값(70%, 90%)을 처음 넘는 순간 폰으로 웹 푸시 알림을 보낸다.
//
// - 입력(환경변수)
//   PUSH_SUBSCRIPTION  : 앱의 "알림 설정"에서 복사한 구독 JSON (없으면 조용히 종료)
//   VAPID_PRIVATE_KEY  : 푸시 서명용 개인키 (GitHub Secret)
//   USAGE_FILE         : usage.json 경로 (기본 _site/usage.json)
//   NOTIFY_STATE_FILE  : 이미 보낸 알림 기록 파일 (기본 notify-state.json)
//
// - 같은 기간(resets_at) 안에서는 같은 임계값 알림을 반복하지 않는다.
//   한도가 리셋되면(resets_at 변경) 다시 알림이 가능해진다.

import { readFile, writeFile } from "node:fs/promises";

export const THRESHOLDS = [70, 90];
export const VAPID_PUBLIC_KEY =
  "BFnWFPeCWL9oQ3X2FAOlq2qsBbH3qQWyoJSQDZ4lF2jngb8TUJ9EusYIV50TfDoj0eRuyGOmUjSMhOW_1dNDlFU";

const LABELS = {
  five_hour: "5시간 세션",
  seven_day: "주간 · 전체 모델",
  seven_day_opus: "주간 · Opus",
  seven_day_sonnet: "주간 · Sonnet",
};

const fmtKo = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/**
 * 어떤 알림을 보낼지 결정한다. (순수 함수 - 테스트 대상)
 * @param data usage.json 의 data 부분
 * @param state { alerted: { "창이름|resets_at|임계값": true } }
 * @returns { alerts: [{key, label, pct, threshold, resets_at}], state }
 */
export function decideAlerts(data, state) {
  const alerted = { ...(state?.alerted ?? {}) };
  const alerts = [];
  const liveKeys = new Set();

  for (const [key, w] of Object.entries(data ?? {})) {
    if (key === "extra_usage") continue;
    if (!w || typeof w !== "object" || typeof w.utilization !== "number") continue;
    const pct = w.utilization;
    const resetsAt = w.resets_at ?? "no-reset";
    const crossed = THRESHOLDS.filter((t) => pct >= t);
    for (const t of crossed) liveKeys.add(`${key}|${resetsAt}|${t}`);

    // 넘은 임계값 중 아직 알리지 않은 가장 높은 것 하나만 알린다.
    const unnotified = crossed.filter((t) => !alerted[`${key}|${resetsAt}|${t}`]);
    if (unnotified.length > 0) {
      const top = Math.max(...unnotified);
      alerts.push({ key, label: LABELS[key] ?? key.replaceAll("_", " "), pct, threshold: top, resets_at: w.resets_at ?? null });
      // 알림을 보내면 그 이하 임계값도 모두 처리된 것으로 기록
      for (const t of crossed) alerted[`${key}|${resetsAt}|${t}`] = true;
    }
  }

  // 지나간 기간의 기록은 정리 (리셋되면 다시 알림 가능)
  for (const k of Object.keys(alerted)) {
    if (!liveKeys.has(k)) {
      const [key, resetsAt] = k.split("|");
      const w = data?.[key];
      if (!w || (w.resets_at ?? "no-reset") !== resetsAt) delete alerted[k];
    }
  }

  return { alerts, state: { alerted } };
}

export function alertMessage(a) {
  const title = a.pct >= 90 ? `🚨 ${a.label} ${Math.round(a.pct)}% 사용` : `⚠️ ${a.label} ${Math.round(a.pct)}% 사용`;
  let body = a.pct >= 90 ? "한도가 거의 소진됐어요." : "한도의 70%를 넘었어요.";
  if (a.resets_at) {
    const t = Date.parse(a.resets_at);
    if (Number.isFinite(t)) body += ` ${fmtKo.format(t)} 초기화.`;
  }
  return { title, body, tag: `claude-usage-${a.key}` };
}

async function main() {
  const subRaw = process.env.PUSH_SUBSCRIPTION;
  if (!subRaw || !subRaw.trim()) {
    console.log("PUSH_SUBSCRIPTION 미설정 - 알림 기능 건너뜀");
    return;
  }
  const priv = process.env.VAPID_PRIVATE_KEY;
  if (!priv) {
    console.warn("VAPID_PRIVATE_KEY 가 없어 알림을 보낼 수 없습니다.");
    return;
  }

  const usagePath = process.env.USAGE_FILE || "_site/usage.json";
  const statePath = process.env.NOTIFY_STATE_FILE || "notify-state.json";
  const usage = JSON.parse(await readFile(usagePath, "utf8"));
  let state = null;
  try { state = JSON.parse(await readFile(statePath, "utf8")); } catch {}

  const { alerts, state: newState } = decideAlerts(usage.data, state);
  if (alerts.length === 0) {
    console.log("보낼 알림 없음");
    await writeFile(statePath, JSON.stringify(newState));
    return;
  }

  const subscription = JSON.parse(subRaw);
  const { default: webpush } = await import("web-push");
  webpush.setVapidDetails("mailto:noreply@example.com", VAPID_PUBLIC_KEY, priv);

  let sent = 0;
  for (const a of alerts) {
    try {
      await webpush.sendNotification(subscription, JSON.stringify(alertMessage(a)), { TTL: 3600 });
      console.log(`알림 발송: ${a.label} ${a.pct}% (임계 ${a.threshold}%)`);
      sent++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        console.warn("구독이 만료됐습니다. 앱에서 알림을 다시 켜고 PUSH_SUBSCRIPTION 시크릿을 새 값으로 교체하세요.");
      } else {
        console.warn(`알림 발송 실패: ${e.message ?? e}`);
      }
    }
  }
  // 발송 성공 여부와 무관하게 상태 저장(실패 반복 스팸 방지, 다음 기간에 다시 시도됨)
  await writeFile(statePath, JSON.stringify(newState));
  console.log(`총 ${sent}/${alerts.length}건 발송`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    // 알림 실패가 배포 전체를 막지 않도록 경고만 남기고 정상 종료
    console.warn(e.message ?? e);
  });
}
