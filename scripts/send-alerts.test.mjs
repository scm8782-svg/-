// 알림 판정 로직 테스트: node --test scripts/send-alerts.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { decideAlerts, alertMessage } from "./send-alerts.mjs";

const R1 = "2026-08-31T18:00:00Z";
const R2 = "2026-09-01T02:00:00Z";

test("임계값 미만이면 알림 없음", () => {
  const { alerts } = decideAlerts({ five_hour: { utilization: 69.9, resets_at: R1 } }, null);
  assert.equal(alerts.length, 0);
});

test("70% 를 처음 넘으면 알림 1건", () => {
  const { alerts, state } = decideAlerts({ five_hour: { utilization: 72, resets_at: R1 } }, null);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].threshold, 70);
  assert.equal(state.alerted[`five_hour|${R1}|70`], true);
});

test("같은 기간에는 같은 임계값 알림을 반복하지 않는다", () => {
  const first = decideAlerts({ five_hour: { utilization: 72, resets_at: R1 } }, null);
  const second = decideAlerts({ five_hour: { utilization: 75, resets_at: R1 } }, first.state);
  assert.equal(second.alerts.length, 0);
});

test("90% 를 넘으면 추가로 알림", () => {
  const first = decideAlerts({ five_hour: { utilization: 72, resets_at: R1 } }, null);
  const second = decideAlerts({ five_hour: { utilization: 91, resets_at: R1 } }, first.state);
  assert.equal(second.alerts.length, 1);
  assert.equal(second.alerts[0].threshold, 90);
});

test("한 번에 90% 를 넘으면 최고 임계값 1건만 알리고 70% 도 처리로 기록", () => {
  const { alerts, state } = decideAlerts({ five_hour: { utilization: 95, resets_at: R1 } }, null);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].threshold, 90);
  assert.equal(state.alerted[`five_hour|${R1}|70`], true);
  const again = decideAlerts({ five_hour: { utilization: 96, resets_at: R1 } }, state);
  assert.equal(again.alerts.length, 0);
});

test("리셋(resets_at 변경) 후에는 다시 알림", () => {
  const first = decideAlerts({ five_hour: { utilization: 95, resets_at: R1 } }, null);
  const afterReset = decideAlerts({ five_hour: { utilization: 71, resets_at: R2 } }, first.state);
  assert.equal(afterReset.alerts.length, 1);
  assert.equal(afterReset.alerts[0].threshold, 70);
  // 지난 기간 기록은 정리됨
  assert.equal(first.state.alerted[`five_hour|${R1}|70`], true);
  assert.equal(afterReset.state.alerted[`five_hour|${R1}|70`], undefined);
});

test("여러 창이 동시에 넘으면 각각 알림", () => {
  const { alerts } = decideAlerts(
    {
      five_hour: { utilization: 75, resets_at: R1 },
      seven_day: { utilization: 92, resets_at: R2 },
      seven_day_opus: { utilization: 10, resets_at: R2 },
      extra_usage: { is_enabled: true, utilization: 99 },
    },
    null
  );
  assert.equal(alerts.length, 2);
  const keys = alerts.map((a) => a.key).sort();
  assert.deepEqual(keys, ["five_hour", "seven_day"]);
});

test("알 수 없는 창(nimbus_quill 등)도 형태가 맞으면 알림 대상", () => {
  const { alerts } = decideAlerts({ nimbus_quill: { utilization: 80, resets_at: R1 } }, null);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].label, "nimbus quill");
});

test("알림 메시지 형식", () => {
  const m = alertMessage({ key: "five_hour", label: "5시간 세션", pct: 91.2, threshold: 90, resets_at: R1 });
  assert.match(m.title, /^🚨 5시간 세션 91% 사용/);
  assert.match(m.body, /초기화/);
  assert.equal(m.tag, "claude-usage-five_hour");
});
