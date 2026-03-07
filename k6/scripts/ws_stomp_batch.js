import http from "k6/http";
import ws from "k6/ws";
import { check } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

/**
 * MODE:
 *  - baseline : WS open + STOMP CONNECTED + SUBSCRIBE 까지만 (송신X)
 *  - cursor   : sender들이 RATE Hz로 DURATION_S 동안 SEND
 */
const MODE = (__ENV.MODE || "cursor").toLowerCase(); // baseline|cursor

// env (init stage)
const USERS_CSV_PATH = __ENV.USERS_CSV || "../data/users.csv";
const BASE_HTTP_ENV = __ENV.BASE_URL || "http://localhost:8080";

const TOTAL_VUS = Number(__ENV.VUS || 10);
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

const SUMMARY_OUT = __ENV.SUMMARY || "outputs/ws_stomp_summary.json";

// ---- recv dump options ----
const DUMP_RECV = (__ENV.DUMP_RECV || "0") === "1";
const DUMP_RAW_FRAME = (__ENV.DUMP_RAW || "0") === "1";
const DUMP_LIMIT = Number(__ENV.DUMP_LIMIT || 20);
const DUMP_SAMPLE = Number(__ENV.DUMP_SAMPLE || 1);

// ---- latency bucket thresholds (ms) ----
const LAT_OK_MS = Number(__ENV.LAT_OK_MS || 200);
const LAT_WARN_MS = Number(__ENV.LAT_WARN_MS || 1000);

// ---- realtime rate thresholds (env override 가능) ----
const RT_OK_200_MIN = Number(__ENV.RT_OK_200_MIN || 0.9); // 90%
const RT_OK_1S_MIN = Number(__ENV.RT_OK_1S_MIN || 0.99); // 99%
const RT_OK_200_SEND_MIN = Number(__ENV.RT_OK_200_SEND_MIN || 0.9);
const RT_OK_200_AFTER_MIN = Number(__ENV.RT_OK_200_AFTER_MIN || 0.9);

// ✅ open()은 init stage에서만
const USERS_CSV_TEXT = open(USERS_CSV_PATH);

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

// ---------------- Metrics ----------------
const stomp_ws_open_ms = new Trend("stomp_ws_open_ms", true);
const stomp_ready_ms = new Trend("stomp_ready_ms", true);
const stomp_phase_during_cnt = new Counter("stomp_phase_during_cnt");
const stomp_phase_after_cnt = new Counter("stomp_phase_after_cnt");

const stomp_latency_ms = new Trend("stomp_latency_ms", true);
const stomp_latency_during_send_ms = new Trend("stomp_latency_during_send_ms", true);
const stomp_latency_after_send_ms = new Trend("stomp_latency_after_send_ms", true);

// ✅ bucket counters
const stomp_lat_le_200ms = new Counter("stomp_lat_le_200ms");
const stomp_lat_le_1s = new Counter("stomp_lat_le_1s");
const stomp_lat_gt_1s = new Counter("stomp_lat_gt_1s");

// ✅ realtime success Rates
const stomp_rt_ok_200 = new Rate("stomp_rt_ok_200");
const stomp_rt_ok_1s = new Rate("stomp_rt_ok_1s");
const stomp_rt_ok_200_during_send = new Rate("stomp_rt_ok_200_during_send");
const stomp_rt_ok_200_after_send = new Rate("stomp_rt_ok_200_after_send");

const stomp_sent = new Counter("stomp_sent");

// ✅ recv: 논리 이벤트(배치면 items 개수만큼)
const stomp_recv = new Counter("stomp_recv");
// ✅ recv frames: 물리 STOMP MESSAGE 프레임 수
const stomp_recv_frames = new Counter("stomp_recv_frames");

const stomp_connected_frames = new Counter("stomp_connected_frames");
const stomp_errors = new Counter("stomp_errors");

const stomp_open = new Counter("stomp_open");
const stomp_close = new Counter("stomp_close");

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
    stomp_ws_open_ms: ["p(95)<2000"],
    stomp_ready_ms: ["p(95)<5000"],
    ...(MODE === "cursor"
      ? {
          stomp_latency_ms: ["p(95)<120", "p(99)<250"],
          stomp_rt_ok_200: [`rate>${RT_OK_200_MIN}`],
          stomp_rt_ok_1s: [`rate>${RT_OK_1S_MIN}`],
          stomp_rt_ok_200_during_send: [`rate>${RT_OK_200_SEND_MIN}`],
          stomp_rt_ok_200_after_send: [`rate>${RT_OK_200_AFTER_MIN}`],
        }
      : {}),
  },
  summaryTrendStats: ["avg", "min", "max", "p(50)", "p(95)", "p(99)"],
};

// ---------------- STOMP helpers ----------------
function stompFrame(cmd, headers = {}, body = "") {
  let out = cmd + "\n";
  for (const [k, v] of Object.entries(headers)) out += `${k}:${v}\n`;
  out += "\n" + body + "\0";
  return out;
}

function extractFrames(state, chunk) {
  state.buf += String(chunk ?? "");
  state.buf = state.buf.replace(/\r\n/g, "\n");

  const out = [];
  let idx;
  while ((idx = state.buf.indexOf("\0")) !== -1) {
    const raw = state.buf.slice(0, idx);
    state.buf = state.buf.slice(idx + 1);

    const frameText = raw.trimStart();
    if (!frameText) continue;

    const [head, ...rest] = frameText.split("\n\n");
    const body = rest.join("\n\n");
    const lines = head.split("\n");
    const command = lines[0]?.trim();

    const headers = {};
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const p = line.indexOf(":");
      if (p > 0) headers[line.slice(0, p)] = line.slice(p + 1);
    }
    out.push({ command, headers, body });
  }
  return out;
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

function hostHeaderFromBaseHttp(baseHttp) {
  return String(baseHttp).replace(/^https?:\/\//, "").split("/")[0];
}

function recordLatency(lat, tags, inSendWindow) {
  if (!(lat >= 0 && lat < 60_000)) return;

  stomp_latency_ms.add(lat, tags);

  if (lat <= LAT_OK_MS) stomp_lat_le_200ms.add(1, tags);
  else if (lat <= LAT_WARN_MS) stomp_lat_le_1s.add(1, tags);
  else stomp_lat_gt_1s.add(1, tags);

  stomp_rt_ok_200.add(lat <= LAT_OK_MS, tags);
  stomp_rt_ok_1s.add(lat <= LAT_WARN_MS, tags);

  if (inSendWindow === true) {
    stomp_phase_during_cnt.add(1, tags);
    stomp_latency_during_send_ms.add(lat, tags);
    stomp_rt_ok_200_during_send.add(lat <= LAT_OK_MS, tags);
  } else if (inSendWindow === false) {
    stomp_phase_after_cnt.add(1, tags);
    stomp_latency_after_send_ms.add(lat, tags);
    stomp_rt_ok_200_after_send.add(lat <= LAT_OK_MS, tags);
  }
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
    subprotocols: ["v12.stomp"],
    tags: { proto: "stomp", mode: MODE, user: sess.loginId, role: sender ? "sender" : "receiver" },
  };

  const wsUrl = `${baseWs}/ws/canvas`;

  const subTopic = `/topic/teams/${TEAM_ID}/graphs/${GRAPH_ID}/presence`;
  const sendDest = `/app/teams/${TEAM_ID}/graphs/${GRAPH_ID}/presence/cursor`;
  const hostHeader = hostHeaderFromBaseHttp(baseHttp);

  ws.connect(wsUrl, params, (socket) => {
    const state = { buf: "" };
    let cancel = null;
    let readyMarked = false;

    let connectedAtMs = null;     // CONNECTED 받은 시각(참고용)
    let sendStartAtMs = null;     // sender: 첫 SEND 시각(phase 기준점)
    let firstMessageAtMs = null;  // receiver(or sender): 첫 MESSAGE 수신 시각(트릭)

    const sendWindowMs = SEND_DURATION_S * 1000;

    let dumpCount = 0;
    const recvBuf = [];
    const RECV_BUF_MAX = Math.max(1, Math.min(DUMP_LIMIT, 200));

    socket.on("open", () => {
      stomp_open.add(1);
      stomp_ws_open_ms.add(Date.now() - connectStart, { mode: MODE, role: sender ? "sender" : "receiver" });

      socket.send(
        stompFrame("CONNECT", {
          "accept-version": "1.2",
          "heart-beat": "0,0",
          host: hostHeader,
        })
      );
    });

    socket.on("message", (msgText) => {
      const frames = extractFrames(state, msgText);

      for (const fr of frames) {
        if (fr.command === "CONNECTED") {
          stomp_connected_frames.add(1);

          socket.send(
            stompFrame("SUBSCRIBE", {
              id: `sub-${__VU}`,
              destination: subTopic,
              ack: "auto",
            })
          );

          if (connectedAtMs == null) connectedAtMs = Date.now();

          if (!readyMarked) {
            readyMarked = true;
            stomp_ready_ms.add(Date.now() - connectStart, { mode: MODE, role: sender ? "sender" : "receiver" });

            socket.setTimeout(() => {
              try {
                socket.close();
              } catch (_) {}
            }, HOLD_MS);

            if (MODE === "baseline") continue;
          }

          if (sender && MODE === "cursor" && !cancel) {
            cancel = startDriftLoop(socket, {
              hz: RATE_HZ,
              durationMs: SEND_DURATION_S * 1000,
              onTick: () => {
                if (sendStartAtMs == null) sendStartAtMs = Date.now(); // ✅ 첫 SEND 기준점
                socket.send(
                  stompFrame(
                    "SEND",
                    { destination: sendDest, "content-type": "application/json" },
                    JSON.stringify(buildCursorPayload())
                  )
                );
                stomp_sent.add(1, { role: "sender" });
              },
            });
          }
        } else if (fr.command === "MESSAGE") {
          // ✅ 물리 프레임 recv
          stomp_recv_frames.add(1, { role: sender ? "sender" : "receiver" });

          if (MODE !== "cursor") continue;

          // ✅ receiver 기준점 보정: 첫 MESSAGE 수신 시각
          if (firstMessageAtMs == null) firstMessageAtMs = Date.now();

          let msg = null;
          try {
            msg = JSON.parse(fr.body);
          } catch {
            if (DUMP_RECV && DUMP_RAW_FRAME && dumpCount < DUMP_LIMIT) {
              console.log(
                JSON.stringify({
                  vu: __VU,
                  iter: __ITER,
                  role: sender ? "sender" : "receiver",
                  note: "MESSAGE body is not JSON",
                  headers: fr.headers,
                  bodyPreview: String(fr.body || "").slice(0, 500),
                })
              );
              dumpCount += 1;
            }
            continue;
          }

          if (DUMP_RECV && dumpCount < DUMP_LIMIT) {
            if (dumpCount % DUMP_SAMPLE === 0) {
              const meta = {
                vu: __VU,
                iter: __ITER,
                role: sender ? "sender" : "receiver",
                destination: fr.headers?.destination,
                subscription: fr.headers?.subscription,
                "message-id": fr.headers?.["message-id"],
                ts: Date.now(),
              };

              recvBuf.push({ meta, msg });
              if (recvBuf.length > RECV_BUF_MAX) recvBuf.shift();

              const compact = JSON.stringify({ meta, msg });
              console.log(compact.length > 2000 ? compact.slice(0, 2000) + "...(truncated)" : compact);

              if (DUMP_RAW_FRAME) {
                const raw = JSON.stringify({ command: fr.command, headers: fr.headers, body: fr.body });
                console.log(raw.length > 2000 ? raw.slice(0, 2000) + "...(truncated)" : raw);
              }
            }
            dumpCount += 1;
          }

          const tags = { role: sender ? "sender" : "receiver" };

          // ✅ phase 기준점 통일(옵션 A + 트릭)
          //  - sender: sendStartAtMs(첫 SEND)
          //  - receiver: firstMessageAtMs(첫 MESSAGE 수신)
          const phaseStartAt = sender ? sendStartAtMs : firstMessageAtMs;
          let inSendWindow = null;
          if (phaseStartAt != null) {
            const elapsed = Date.now() - phaseStartAt;
            inSendWindow = elapsed <= sendWindowMs;
          } else if (connectedAtMs != null) {
            // fallback
            const elapsed = Date.now() - connectedAtMs;
            inSendWindow = elapsed <= sendWindowMs;
          }

          // ✅ 단일 CURSOR
          if (msg?.type === "CURSOR" && typeof msg?.sentAt === "number") {
            stomp_recv.add(1, tags);
            const lat = Date.now() - msg.sentAt;
            recordLatency(lat, tags, inSendWindow);
            continue;
          }

          // ✅ 배치 PRESENCE_BATCH (cursors[] or items[])
          const arr = Array.isArray(msg?.cursors) ? msg.cursors : Array.isArray(msg?.items) ? msg.items : null;

          if (msg?.type === "PRESENCE_BATCH" && Array.isArray(arr)) {
            const n = arr.length;
            if (n > 0) stomp_recv.add(n, tags);

            for (const it of arr) {
              if (!it || typeof it.sentAt !== "number") continue;
              const lat = Date.now() - it.sentAt;
              recordLatency(lat, tags, inSendWindow);
            }
            continue;
          }

          // 기타 타입은 무시
        } else if (fr.command === "ERROR") {
          stomp_errors.add(1);
          if (DUMP_RECV) {
            console.log(
              JSON.stringify({
                vu: __VU,
                iter: __ITER,
                role: sender ? "sender" : "receiver",
                frame: "ERROR",
                headers: fr.headers,
                bodyPreview: String(fr.body || "").slice(0, 2000),
              })
            );
          }
        }
      }
    });

    socket.on("error", (e) => {
      stomp_errors.add(1);
      if (DUMP_RECV) {
        console.log(
          JSON.stringify({
            vu: __VU,
            iter: __ITER,
            role: sender ? "sender" : "receiver",
            ev: "ws:error",
            err: String(e),
          })
        );
      }
    });

    socket.on("close", () => {
      stomp_close.add(1);
      if (cancel) cancel();

      if (DUMP_RECV && recvBuf.length) {
        console.log(`[VU ${__VU}] last ${recvBuf.length} received messages (sampled/limited):`);
        for (const it of recvBuf) {
          const line = JSON.stringify(it);
          console.log(line.length > 2000 ? line.slice(0, 2000) + "...(truncated)" : line);
        }
      }
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
  const durS = (data?.state?.testRunDurationMs ?? TEST_DURATION_S * 1000) / 1000;

  const mSent = metric(data, "stomp_sent");
  const mRecv = metric(data, "stomp_recv");
  const mRecvFrames = metric(data, "stomp_recv_frames");

  const mWs = metric(data, "stomp_ws_open_ms");
  const mReady = metric(data, "stomp_ready_ms");

  const mLat = metric(data, "stomp_latency_ms");
  const mLatSend = metric(data, "stomp_latency_during_send_ms");
  const mLatAfter = metric(data, "stomp_latency_after_send_ms");

  const mOk = metric(data, "stomp_lat_le_200ms");
  const mWarn = metric(data, "stomp_lat_le_1s");
  const mBad = metric(data, "stomp_lat_gt_1s");

  const mRt200 = metric(data, "stomp_rt_ok_200");
  const mRt1s = metric(data, "stomp_rt_ok_1s");
  const mRt200Send = metric(data, "stomp_rt_ok_200_during_send");
  const mRt200After = metric(data, "stomp_rt_ok_200_after_send");

  const mPhaseDuring = metric(data, "stomp_phase_during_cnt");
  const mPhaseAfter = metric(data, "stomp_phase_after_cnt");

  const mConnFrames = metric(data, "stomp_connected_frames");
  const mErr = metric(data, "stomp_errors");
  const mOpen = metric(data, "stomp_open");
  const mClose = metric(data, "stomp_close");

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
  lines.push(`=== STOMP Summary (MODE=${MODE}) ===`);
  lines.push(`duration: ${num(durS, 2)}s`);
  lines.push(`open: ${vCount(mOpen)} / close: ${vCount(mClose)} / errors: ${vCount(mErr)}`);
  lines.push(`sent: ${sent} / received(events): ${recv} / received(frames): ${recvFrames}`);
  lines.push(
    `sent/s: ${num(sent / durS, 2)} / recv_events/s: ${num(recv / durS, 2)} / recv_frames/s: ${num(
      recvFrames / durS,
      2
    )}`
  );
  lines.push(`CONNECTED frames: ${vCount(mConnFrames)}`);

  if (mWs) {
    lines.push(
      `ws-open(ms) count=${vCount(mWs)} avg=${num(t(mWs, "avg"), 1)} p50=${num(t(mWs, "p(50)"), 1)} p95=${num(
        t(mWs, "p(95)"),
        1
      )} p99=${num(t(mWs, "p(99)"), 1)}`
    );
  }
  if (mReady) {
    lines.push(
      `ready(ms)   count=${vCount(mReady)} avg=${num(t(mReady, "avg"), 1)} p50=${num(t(mReady, "p(50)"), 1)} p95=${num(
        t(mReady, "p(95)"),
        1
      )} p99=${num(t(mReady, "p(99)"), 1)}`
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
      )}%) / ok<=${LAT_WARN_MS}=${r1s == null ? "—" : num(r1s * 100, 2) + "%"} (min ${num(RT_OK_1S_MIN * 100, 2)}%)`
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