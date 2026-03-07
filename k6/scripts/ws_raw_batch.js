import http from "k6/http";
import ws from "k6/ws";
import { check } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

/**
 * MODE:
 *  - baseline : 연결만(송신X)
 *  - cursor   : sender들이 RATE Hz로 DURATION_S 동안 송신
 */
const MODE = (__ENV.MODE || "cursor").toLowerCase(); // baseline|cursor

// env
const USERS_CSV_PATH = __ENV.USERS_CSV || "../data/users.csv";
const BASE_HTTP_ENV = __ENV.BASE_URL || "http://localhost:8080";

const TOTAL_VUS = Number(__ENV.VUS || 10);

// duration-ish
const TEST_DURATION_S = Number(__ENV.TEST_DURATION_S || 60);
const HOLD_MS = Number(__ENV.HOLD_MS || TEST_DURATION_S * 1000);

const TEAM_ID = Number(__ENV.TEAM_ID || 1);
const GRAPH_ID = Number(__ENV.GRAPH_ID || 1);

const RATE_HZ = Number(__ENV.RATE || 20);
const SEND_DURATION_S = Number(__ENV.DURATION_S || 30);

const SENDER_RATIO = Number(__ENV.SENDER_RATIO || 0.1);
const SENDER_COUNT_ENV = Number(__ENV.SENDER_COUNT || 0);

const PAD_LEN = Number(__ENV.PAD || 0);
const PAD_STR = PAD_LEN > 0 ? "x".repeat(PAD_LEN) : null;

const NODE_ID_MIN = Number(__ENV.NODE_ID_MIN || 1);
const NODE_ID_MAX = Number(__ENV.NODE_ID_MAX || 1000);

const SUMMARY_OUT = __ENV.SUMMARY || "outputs/ws_raw_summary.json";

// ---- latency bucket thresholds (ms) ----
const LAT_OK_MS = Number(__ENV.LAT_OK_MS || 200);
const LAT_WARN_MS = Number(__ENV.LAT_WARN_MS || 1000);

// ---- realtime rate thresholds (env override 가능) ----
const RT_OK_200_MIN = Number(__ENV.RT_OK_200_MIN || 0.9); // 90%
const RT_OK_1S_MIN = Number(__ENV.RT_OK_1S_MIN || 0.99); // 99%
const RT_OK_200_SEND_MIN = Number(__ENV.RT_OK_200_SEND_MIN || 0.9);
const RT_OK_200_AFTER_MIN = Number(__ENV.RT_OK_200_AFTER_MIN || 0.9);

// ✅ open()은 init stage(전역)에서만
const USERS_CSV_TEXT = open(USERS_CSV_PATH);

// Metrics
const raw_connect_ms = new Trend("raw_connect_ms", true);

const raw_phase_during_cnt = new Counter("raw_phase_during_cnt");
const raw_phase_after_cnt = new Counter("raw_phase_after_cnt");

const raw_latency_ms = new Trend("raw_latency_ms", true);
const raw_latency_during_send_ms = new Trend("raw_latency_during_send_ms", true);
const raw_latency_after_send_ms = new Trend("raw_latency_after_send_ms", true);

const raw_sent = new Counter("raw_sent");

// ✅ recv: 논리 이벤트(배치면 items 개수만큼)
const raw_recv = new Counter("raw_recv");
// ✅ recv frames: 물리 수신 프레임 수
const raw_recv_frames = new Counter("raw_recv_frames");

// bucket counters
const raw_lat_le_200ms = new Counter("raw_lat_le_200ms");
const raw_lat_le_1s = new Counter("raw_lat_le_1s");
const raw_lat_gt_1s = new Counter("raw_lat_gt_1s");

// realtime success rates (threshold 걸기용)
const raw_rt_ok_200 = new Rate("raw_rt_ok_200"); // lat<=200ms
const raw_rt_ok_1s = new Rate("raw_rt_ok_1s"); // lat<=1000ms
const raw_rt_ok_200_during_send = new Rate("raw_rt_ok_200_during_send");
const raw_rt_ok_200_after_send = new Rate("raw_rt_ok_200_after_send");

// 진단용(정상이라면 count≈VUS)
const raw_open = new Counter("raw_open");
const raw_close = new Counter("raw_close");
const raw_errors = new Counter("raw_errors");

const DUMP_ERR = Number(__ENV.DUMP_ERR || 0);
const DUMP_ERR_LIMIT = Number(__ENV.DUMP_ERR_LIMIT || 20);
let errDumped = 0;

export const options = {
  scenarios: {
    one_conn_per_vu: {
      executor: "per-vu-iterations",
      vus: TOTAL_VUS,
      iterations: 1,
      maxDuration: `${Math.ceil(HOLD_MS / 1000) + 30}s`,
      gracefulStop: "5s",
    },
  },
  thresholds: {
    raw_connect_ms: ["p(95)<2000"],
    ...(MODE === "cursor"
      ? {
          raw_latency_ms: ["p(95)<120", "p(99)<250"],
          raw_rt_ok_200: [`rate>${RT_OK_200_MIN}`],
          raw_rt_ok_1s: [`rate>${RT_OK_1S_MIN}`],
          raw_rt_ok_200_during_send: [`rate>${RT_OK_200_SEND_MIN}`],
          raw_rt_ok_200_after_send: [`rate>${RT_OK_200_AFTER_MIN}`],
        }
      : {}),
  },
  summaryTrendStats: ["avg", "min", "max", "p(50)", "p(95)", "p(99)"],
};

function cookieHeaderFromResponse(res) {
  const parts = [];
  const jar = res.cookies || {};
  for (const [name, arr] of Object.entries(jar)) {
    if (!arr || !arr.length) continue;
    const v = arr[0]?.value;
    if (v == null) continue;
    parts.push(`${name}=${v}`);
  }
  return parts.join("; ");
}

function recordLatency(lat, tags, phaseTags, metrics) {
  if (!(lat >= 0 && lat < 60_000)) return;

  const { LAT_OK_MS, LAT_WARN_MS } = metrics;

  metrics.latency.add(lat, tags);

  if (lat <= LAT_OK_MS) metrics.le200.add(1, tags);
  else if (lat <= LAT_WARN_MS) metrics.le1s.add(1, tags);
  else metrics.gt1s.add(1, tags);

  metrics.rt200.add(lat <= LAT_OK_MS, tags);
  metrics.rt1s.add(lat <= LAT_WARN_MS, tags);

  if (phaseTags?.inSendWindow === true) {
    metrics.phaseDuringCnt.add(1, tags);
    metrics.latDuring.add(lat, tags);
    metrics.rt200During.add(lat <= LAT_OK_MS, tags);
  } else if (phaseTags?.inSendWindow === false) {
    metrics.phaseAfterCnt.add(1, tags);
    metrics.latAfter.add(lat, tags);
    metrics.rt200After.add(lat <= LAT_OK_MS, tags);
  }
}

export function setup() {
  const base = BASE_HTTP_ENV;
  const userLimit = Number(__ENV.USER_LIMIT || 0);

  const lines = USERS_CSV_TEXT.split(/\r?\n/).filter(Boolean);

  const users = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i === 0 && line.toLowerCase().startsWith("loginid,")) continue;
    const [loginId, password, id] = line.split(",");
    if (loginId && password) users.push({ loginId, password, id: String(id ?? "").trim() });
  }

  const picked = userLimit > 0 ? users.slice(0, Math.min(userLimit, users.length)) : users;
  if (!picked.length) throw new Error(`users.csv 비어있음 path=${USERS_CSV_PATH}`);

  const sessions = [];
  for (const u of picked) {
    const jar = http.cookieJar();
    const res = http.post(
      `${base}/api/login/signin`,
      JSON.stringify({ loginId: u.loginId, password: u.password }),
      { headers: { "Content-Type": "application/json" }, jar, tags: { phase: "auth_setup" } }
    );

    check(res, { "setup login 200": (r) => r.status === 200 });
    if (res.status !== 200) {
      throw new Error(`setup 로그인 실패 loginId=${u.loginId} status=${res.status} body=${res.body}`);
    }

    const cookie = cookieHeaderFromResponse(res);
    if (!cookie) throw new Error(`setup 쿠키 비어있음 loginId=${u.loginId}`);

    sessions.push({ id: u.id, loginId: u.loginId, cookie });
  }

  return { base, sessions };
}

function isSenderVU() {
  if (MODE !== "cursor") return false;
  const k =
    SENDER_COUNT_ENV > 0
      ? Math.min(SENDER_COUNT_ENV, TOTAL_VUS)
      : Math.max(1, Math.ceil(TOTAL_VUS * SENDER_RATIO));
  return __VU <= k;
}

function pickNodeId() {
  if (NODE_ID_MAX < NODE_ID_MIN) return NODE_ID_MIN;
  const span = NODE_ID_MAX - NODE_ID_MIN + 1;
  return NODE_ID_MIN + Math.floor(Math.random() * span);
}

function buildCursorPayload() {
  const msg = {
    type: "CURSOR",
    teamId: TEAM_ID,
    graphId: GRAPH_ID,
    nodeId: pickNodeId(),
    x: Math.random() * 1000,
    y: Math.random() * 800,
    sentAt: Date.now(),
  };
  if (PAD_STR) msg.pad = PAD_STR;
  return msg;
}

// drift-correcting loop (k6 ws socket.setTimeout 기반)
function startDriftLoop(socket, { hz, durationMs, onTick, onDone }) {
  const intervalMs = Math.max(1, Math.round(1000 / hz));
  const start = Date.now();
  let tick = 0;
  let cancelled = false;

  function step() {
    if (cancelled) return;

    const elapsed = Date.now() - start;
    if (elapsed >= durationMs) {
      onDone?.();
      return;
    }

    onTick?.(tick, elapsed);
    tick += 1;

    const nextTarget = start + tick * intervalMs;
    const delay = Math.max(0, nextTarget - Date.now());
    socket.setTimeout(step, Math.max(1, delay));
  }

  socket.setTimeout(step, 1);
  return () => (cancelled = true);
}

export default function (data) {
  const baseHttp = data.base;
  const baseWs = baseHttp.replace(/^http/, "ws");
  const sessions = data.sessions;

  const idx = (__VU - 1) % sessions.length;
  const sess = sessions[idx];

  const sender = isSenderVU();
  const connectStart = Date.now();

  const params = {
    headers: { Cookie: sess.cookie },
    tags: { proto: "raw", mode: MODE, user: sess.loginId, role: sender ? "sender" : "receiver" },
  };

  const wsUrl = `${baseWs}/ws/canvas-raw?teamId=${TEAM_ID}&graphId=${GRAPH_ID}`;

  ws.connect(wsUrl, params, (socket) => {
    let cancel = null;

    // 기준 시각들
    let openedAtMs = null;      // ws open
    let sendStartAtMs = null;   // sender: 첫 send 시각
    let firstRecvAtMs = null;   // receiver(or sender): 첫 수신 시각 (k6-only 트릭)

    const sendWindowMs = SEND_DURATION_S * 1000;

    socket.on("open", () => {
      raw_open.add(1);
      openedAtMs = Date.now();

      raw_connect_ms.add(Date.now() - connectStart, {
        mode: MODE,
        role: sender ? "sender" : "receiver",
      });

      socket.setTimeout(() => {
        try {
          socket.close();
        } catch (_) {}
      }, HOLD_MS);

      if (MODE === "baseline") return;

      if (sender) {
        cancel = startDriftLoop(socket, {
          hz: RATE_HZ,
          durationMs: SEND_DURATION_S * 1000,
          onTick: () => {
            if (sendStartAtMs == null) sendStartAtMs = Date.now(); // ✅ 첫 send 기준점
            socket.send(JSON.stringify(buildCursorPayload()));
            raw_sent.add(1, { role: "sender" });
          },
        });
      }
    });

    socket.on("message", (msgText) => {
      // ✅ 물리 프레임 카운트
      raw_recv_frames.add(1, { role: sender ? "sender" : "receiver" });

      if (MODE !== "cursor") return;

      // ✅ receiver 기준점 보정: 첫 수신 시각
      if (firstRecvAtMs == null) firstRecvAtMs = Date.now();

      let msg = null;
      try { msg = JSON.parse(msgText); } catch { return; }

      const tags = { role: sender ? "sender" : "receiver" };

      // ✅ phase 기준점 통일(옵션 A + 트릭)
      //  - sender: sendStartAtMs(첫 send)
      //  - receiver: firstRecvAtMs(첫 수신)
      const phaseStartAt = sender ? sendStartAtMs : firstRecvAtMs;
      let inSendWindow = null;
      if (phaseStartAt != null) {
        const elapsed = Date.now() - phaseStartAt;
        inSendWindow = elapsed <= sendWindowMs;
      } else if (openedAtMs != null) {
        // 혹시 phaseStartAt이 null인 극단 케이스 fallback
        const elapsed = Date.now() - openedAtMs;
        inSendWindow = elapsed <= sendWindowMs;
      }

      const metrics = {
        LAT_OK_MS, LAT_WARN_MS,
        latency: raw_latency_ms,
        latDuring: raw_latency_during_send_ms,
        latAfter: raw_latency_after_send_ms,
        le200: raw_lat_le_200ms,
        le1s: raw_lat_le_1s,
        gt1s: raw_lat_gt_1s,
        rt200: raw_rt_ok_200,
        rt1s: raw_rt_ok_1s,
        rt200During: raw_rt_ok_200_during_send,
        rt200After: raw_rt_ok_200_after_send,
        phaseDuringCnt: raw_phase_during_cnt,
  phaseAfterCnt: raw_phase_after_cnt,
      };

      // ✅ 1) 단일 CURSOR
      if (msg?.type === "CURSOR" && typeof msg?.sentAt === "number") {
        raw_recv.add(1, tags);
        const lat = Date.now() - msg.sentAt;
        recordLatency(lat, tags, { inSendWindow }, metrics);
        return;
      }

      // ✅ 2) 배치 PRESENCE_BATCH
      if (msg?.type === "PRESENCE_BATCH" && Array.isArray(msg?.cursors)) {
        const n = msg.cursors.length;
        if (n > 0) raw_recv.add(n, tags);

        for (const it of msg.cursors) {
          if (!it || typeof it.sentAt !== "number") continue;
          const lat = Date.now() - it.sentAt;
          recordLatency(lat, tags, { inSendWindow }, metrics);
        }
        return;
      }
    });

    socket.on("error", (e) => {
      raw_errors.add(1);
      if (DUMP_ERR && errDumped < DUMP_ERR_LIMIT) {
        console.log(JSON.stringify({ vu: __VU, iter: __ITER, role: sender ? "sender" : "receiver", err: String(e) }));
        errDumped += 1;
      }
    });

    socket.on("close", () => {
      raw_close.add(1);
      if (cancel) cancel();
    });
  });
}

/** ---------------- Summary ---------------- */
function num(x, d = 2) {
  return typeof x === "number" && isFinite(x) ? x.toFixed(d) : "—";
}

function metric(data, base) {
  const metrics = data?.metrics || {};
  if (metrics[base]) return metrics[base];

  const keys = Object.keys(metrics).filter((k) => k === base || k.startsWith(base + "{"));
  if (!keys.length) return null;

  let best = null;
  for (const k of keys) {
    const m = metrics[k];
    const cnt = m?.values?.count ?? m?.count ?? 0;
    if (!best || cnt > (best.values?.count ?? best.count ?? 0)) best = m;
  }
  return best;
}

function vCount(m) {
  if (!m) return 0;
  return m.values?.count ?? m.count ?? 0;
}

function t(m, key) {
  if (!m) return null;
  const v = m.values ?? m;
  if (key in v) return v[key];
  if (key === "p95") return v["p(95)"];
  if (key === "p99") return v["p(99)"];
  if (key === "p50") return v["p(50)"];
  return v[key] ?? null;
}

export function handleSummary(data) {
  const durS = (data?.state?.testRunDurationMs ?? HOLD_MS) / 1000;

  const mSent = metric(data, "raw_sent");
  const mRecv = metric(data, "raw_recv");
  const mRecvFrames = metric(data, "raw_recv_frames");
  const mConn = metric(data, "raw_connect_ms");

  const mLat = metric(data, "raw_latency_ms");
  const mLatSend = metric(data, "raw_latency_during_send_ms");
  const mLatAfter = metric(data, "raw_latency_after_send_ms");

  const mOpen = metric(data, "raw_open");
  const mClose = metric(data, "raw_close");
  const mErr = metric(data, "raw_errors");

  const mOk = metric(data, "raw_lat_le_200ms");
  const mWarn = metric(data, "raw_lat_le_1s");
  const mBad = metric(data, "raw_lat_gt_1s");

  const mRt200 = metric(data, "raw_rt_ok_200");
  const mRt1s = metric(data, "raw_rt_ok_1s");
  const mRt200Send = metric(data, "raw_rt_ok_200_during_send");
  const mRt200After = metric(data, "raw_rt_ok_200_after_send");

  const mPhaseDuring = metric(data, "raw_phase_during_cnt");
  const mPhaseAfter = metric(data, "raw_phase_after_cnt");

  const sent = vCount(mSent);
  const recv = vCount(mRecv);
  const recvFrames = vCount(mRecvFrames);

  const ok = vCount(mOk);
  const warn = vCount(mWarn);
  const bad = vCount(mBad);
  const bucketTotal = ok + warn + bad;

  const rateVal = (m) => {
    const v = m?.values ?? m;
    const r = v?.rate;
    return typeof r === "number" ? r : null;
  };

  const lines = [];
  lines.push(`=== RAW Summary (MODE=${MODE}) ===`);
  lines.push(`duration: ${num(durS, 2)}s`);
  lines.push(`open: ${vCount(mOpen)} / close: ${vCount(mClose)} / errors: ${vCount(mErr)}`);
  lines.push(`sent: ${sent} / received(events): ${recv} / received(frames): ${recvFrames}`);
  lines.push(
    `sent/s: ${num(sent / durS, 2)} / recv_events/s: ${num(recv / durS, 2)} / recv_frames/s: ${num(
      recvFrames / durS,
      2
    )}`
  );

  if (mConn) {
    lines.push(
      `connect(ms) count=${vCount(mConn)} avg=${num(t(mConn, "avg"), 1)} ` +
        `p50=${num(t(mConn, "p(50)"), 1)} p95=${num(t(mConn, "p(95)"), 1)} p99=${num(t(mConn, "p(99)"), 1)}`
    );
  }

  if (MODE === "cursor" && mLat && vCount(mLat) > 0) {
    lines.push(
      `latency(all) count=${vCount(mLat)} avg=${num(t(mLat, "avg"), 1)} p50=${num(t(mLat, "p(50)"), 1)} p95=${num(
        t(mLat, "p(95)"),
        1
      )} p99=${num(t(mLat, "p(99)"), 1)}`
    );
  }

  if (MODE === "cursor" && mLatSend && vCount(mLatSend) > 0) {
    lines.push(
      `latency(send-window ${SEND_DURATION_S}s) count=${vCount(mLatSend)} p50=${num(t(mLatSend, "p(50)"), 1)} p95=${num(
        t(mLatSend, "p(95)"),
        1
      )} p99=${num(t(mLatSend, "p(99)"), 1)}`
    );
  }

  if (MODE === "cursor" && mLatAfter && vCount(mLatAfter) > 0) {
    lines.push(
      `latency(after-send) count=${vCount(mLatAfter)} p50=${num(t(mLatAfter, "p(50)"), 1)} p95=${num(
        t(mLatAfter, "p(95)"),
        1
      )} p99=${num(t(mLatAfter, "p(99)"), 1)}`
    );
  }

  if (MODE === "cursor") {
    const pct = (x) => (bucketTotal > 0 ? num((x / bucketTotal) * 100, 2) : "—");

    lines.push(
      `latency buckets(ms): <=${LAT_OK_MS}=${ok} (${pct(ok)}%) / <=${LAT_WARN_MS}=${warn} (${pct(warn)}%) / >${LAT_WARN_MS}=${bad} (${pct(bad)}%)`
    );
    lines.push(
      `phase samples: during=${vCount(mPhaseDuring)} / after=${vCount(mPhaseAfter)}`
    );
    const r200 = rateVal(mRt200);
    const r1s = rateVal(mRt1s);
    const r200Send = rateVal(mRt200Send);
    const r200After = rateVal(mRt200After);

    lines.push(
      `realtime rates: ok<=${LAT_OK_MS}=${r200 == null ? "—" : num(r200 * 100, 2) + "%"} (min ${num(
        RT_OK_200_MIN * 100,
        2
      )}%) / ok<=${LAT_WARN_MS}=${r1s == null ? "—" : num(r1s * 100, 2) + "%"} (min ${num(
        RT_OK_1S_MIN * 100,
        2
      )}%)`
    );

    lines.push(
      `realtime rates by phase: during-send ok<=${LAT_OK_MS}=${r200Send == null ? "—" : num(r200Send * 100, 2) + "%"} (min ${num(
        RT_OK_200_SEND_MIN * 100,
        2
      )}%), after-send ok<=${LAT_OK_MS}=${r200After == null ? "—" : num(r200After * 100, 2) + "%"} (min ${num(
        RT_OK_200_AFTER_MIN * 100,
        2
      )}%)`
    );
  }

  return {
    [SUMMARY_OUT]: JSON.stringify(data, null, 2),
    stdout: lines.join("\n") + "\n",
  };
}