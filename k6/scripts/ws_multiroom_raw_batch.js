import http from "k6/http";
import ws from "k6/ws";
import { check } from "k6";
import { Trend, Counter, Rate } from "k6/metrics";

/**
 * RAW Multi-Room Batch Test (TOTAL USERS FIXED, FIXED DISTRIBUTION)
 *
 * 목표:
 *  1) <=200ms 집계가 "전역(단일룸 비교용)" + "룸별(진단용)"로 정상 집계되는지
 *  2) 수신량(events/frames)이 방 수에 따라 기대대로 변하는지
 *
 * 설계:
 *  - TOTAL_VUS 고정
 *  - ROOMS 변경 시, 방당 인원은 floor + remainder 방식으로 "고정 분산"
 *  - sender는 "방당 비율 유지" (size * SENDER_RATIO)
 *
 * 메트릭 구조(중요):
 *  - raw_*  : 전역 비교용 (tags=role만)  -> ROOMS=1이면 단일룸과 정합
 *  - rawr_* : 룸별 진단용 (tags=role,room,graph)
 */

const MODE = (__ENV.MODE || "cursor").toLowerCase(); // baseline|cursor

// env
const USERS_CSV_PATH = __ENV.USERS_CSV || "../data/users.csv";
const BASE_HTTP_ENV = __ENV.BASE_URL || "http://localhost:8080";
const ROOM_METRICS = Number(__ENV.ROOM_METRICS || 0);
const TOTAL_VUS = Number(__ENV.VUS || 200);
const ROOMS = Number(__ENV.ROOMS || 1);

// fixed distribution
const BASE_PER_ROOM = Math.floor(TOTAL_VUS / ROOMS);
const REMAINDER = TOTAL_VUS % ROOMS;

// duration-ish
const TEST_DURATION_S = Number(__ENV.TEST_DURATION_S || 60);
const HOLD_MS = Number(__ENV.HOLD_MS || TEST_DURATION_S * 1000);

const TEAM_ID = Number(__ENV.TEAM_ID || 1);
const GRAPH_ID_BASE = Number(__ENV.GRAPH_ID_BASE || 1);

const RATE_HZ = Number(__ENV.RATE || 20);
const SEND_DURATION_S = Number(__ENV.DURATION_S || 30);

const SENDER_RATIO = Number(__ENV.SENDER_RATIO || 0.1);
// 0이면 "비율 그대로(0 sender 가능)", 1이면 "각 방 최소 1 sender 보장"
const MIN_SENDER_PER_ROOM = Number(__ENV.MIN_SENDER_PER_ROOM || 0);

const PAD_LEN = Number(__ENV.PAD || 0);
const PAD_STR = PAD_LEN > 0 ? "x".repeat(PAD_LEN) : null;

const NODE_ID_MIN = Number(__ENV.NODE_ID_MIN || 1);
const NODE_ID_MAX = Number(__ENV.NODE_ID_MAX || 1000);

const SUMMARY_OUT = __ENV.SUMMARY || "outputs/ws_raw_multiroom_summary.json";

// latency thresholds (ms)
const LAT_OK_MS = Number(__ENV.LAT_OK_MS || 200);
const LAT_WARN_MS = Number(__ENV.LAT_WARN_MS || 1000);

// rate thresholds
const RT_OK_200_MIN = Number(__ENV.RT_OK_200_MIN || 0.9);
const RT_OK_1S_MIN = Number(__ENV.RT_OK_1S_MIN || 0.99);
const RT_OK_200_SEND_MIN = Number(__ENV.RT_OK_200_SEND_MIN || 0.9);
const RT_OK_200_AFTER_MIN = Number(__ENV.RT_OK_200_AFTER_MIN || 0.9);

// init-only open()
const USERS_CSV_TEXT = open(USERS_CSV_PATH);

// ---------------- Metrics (Global: role only) ----------------
const raw_connect_ms = new Trend("raw_connect_ms", true);

const raw_phase_during_cnt = new Counter("raw_phase_during_cnt");
const raw_phase_after_cnt = new Counter("raw_phase_after_cnt");

const raw_latency_ms = new Trend("raw_latency_ms", true);
const raw_latency_during_send_ms = new Trend("raw_latency_during_send_ms", true);
const raw_latency_after_send_ms = new Trend("raw_latency_after_send_ms", true);

const raw_sent = new Counter("raw_sent");
const raw_recv = new Counter("raw_recv"); // events
const raw_recv_frames = new Counter("raw_recv_frames"); // frames

const raw_lat_le_200ms = new Counter("raw_lat_le_200ms");
const raw_lat_le_1s = new Counter("raw_lat_le_1s");
const raw_lat_gt_1s = new Counter("raw_lat_gt_1s");

const raw_rt_ok_200 = new Rate("raw_rt_ok_200");
const raw_rt_ok_1s = new Rate("raw_rt_ok_1s");
const raw_rt_ok_200_during_send = new Rate("raw_rt_ok_200_during_send");
const raw_rt_ok_200_after_send = new Rate("raw_rt_ok_200_after_send");

const raw_open = new Counter("raw_open");
const raw_close = new Counter("raw_close");
const raw_errors = new Counter("raw_errors");

// ---------------- Metrics (Room: role+room+graph) ----------------
const rawr_sent = new Counter("rawr_sent");
const rawr_recv = new Counter("rawr_recv");
const rawr_recv_frames = new Counter("rawr_recv_frames");

const rawr_lat_le_200ms = new Counter("rawr_lat_le_200ms");
const rawr_lat_le_1s = new Counter("rawr_lat_le_1s");
const rawr_lat_gt_1s = new Counter("rawr_lat_gt_1s");

const rawr_rt_ok_200 = new Rate("rawr_rt_ok_200");
const rawr_rt_ok_1s = new Rate("rawr_rt_ok_1s");

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

/** room i size (remainder rooms get +1) */
function roomSize(roomIdx) {
  return BASE_PER_ROOM + (roomIdx < REMAINDER ? 1 : 0);
}

// 방 인덱스 계산 (블록 분배)
function roomIndexOfVu(vu) {
  let threshold = 0;
  for (let r = 0; r < ROOMS; r++) {
    threshold += roomSize(r);
    if (vu <= threshold) return r;
  }
  return ROOMS - 1;
}

// 방 내 index (1..roomSize)
function vuIndexInRoom(vu) {
  let threshold = 0;
  for (let r = 0; r < ROOMS; r++) {
    const size = roomSize(r);
    if (vu <= threshold + size) return vu - threshold;
    threshold += size;
  }
  return 1;
}

// sender 계산 (방 내부 기준) - "방당 비율 유지"
function senderCountInRoom(roomIdx) {
  const size = roomSize(roomIdx);
  let k = Math.floor(size * SENDER_RATIO + 1e-9); // 40*0.1 => 4
  if (MIN_SENDER_PER_ROOM && MODE === "cursor" && SENDER_RATIO > 0) k = Math.max(1, k);
  return k;
}
function isSender(roomIdx, vuInRoom) {
  if (MODE !== "cursor") return false;
  return vuInRoom <= senderCountInRoom(roomIdx);
}

function pickNodeId() {
  if (NODE_ID_MAX < NODE_ID_MIN) return NODE_ID_MIN;
  const span = NODE_ID_MAX - NODE_ID_MIN + 1;
  return NODE_ID_MIN + Math.floor(Math.random() * span);
}

function buildCursorPayload(teamId, graphId) {
  const msg = {
    type: "CURSOR",
    teamId,
    graphId,
    nodeId: pickNodeId(),
    x: Math.random() * 1000,
    y: Math.random() * 800,
    sentAt: Date.now(),
  };
  if (PAD_STR) msg.pad = PAD_STR;
  return msg;
}

// drift-correcting loop
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

function recordLatencyGlobal(lat, tags, phaseTags) {
  if (!(lat >= 0 && lat < 60_000)) return;

  raw_latency_ms.add(lat, tags);

  if (lat <= LAT_OK_MS) raw_lat_le_200ms.add(1, tags);
  else if (lat <= LAT_WARN_MS) raw_lat_le_1s.add(1, tags);
  else raw_lat_gt_1s.add(1, tags);

  raw_rt_ok_200.add(lat <= LAT_OK_MS, tags);
  raw_rt_ok_1s.add(lat <= LAT_WARN_MS, tags);

  if (phaseTags?.inSendWindow === true) {
    raw_phase_during_cnt.add(1, tags);
    raw_latency_during_send_ms.add(lat, tags);
    raw_rt_ok_200_during_send.add(lat <= LAT_OK_MS, tags);
  } else if (phaseTags?.inSendWindow === false) {
    raw_phase_after_cnt.add(1, tags);
    raw_latency_after_send_ms.add(lat, tags);
    raw_rt_ok_200_after_send.add(lat <= LAT_OK_MS, tags);
  }
}

function recordLatencyRoom(lat, tagsRoom) {
  if (!(lat >= 0 && lat < 60_000)) return;

  if (lat <= LAT_OK_MS) rawr_lat_le_200ms.add(1, tagsRoom);
  else if (lat <= LAT_WARN_MS) rawr_lat_le_1s.add(1, tagsRoom);
  else rawr_lat_gt_1s.add(1, tagsRoom);

  rawr_rt_ok_200.add(lat <= LAT_OK_MS, tagsRoom);
  rawr_rt_ok_1s.add(lat <= LAT_WARN_MS, tagsRoom);
}

export default function (data) {
  const baseHttp = data.base;
  const baseWs = baseHttp.replace(/^http/, "ws");
  const sessions = data.sessions;

  const roomIdx = roomIndexOfVu(__VU);
  const vuInRoom = vuIndexInRoom(__VU);

  const teamId = TEAM_ID;
  const graphId = GRAPH_ID_BASE + roomIdx;

  const sender = isSender(roomIdx, vuInRoom);
  const connectStart = Date.now();

  // VU별 세션 선택(계정 수 < VU 수면 순환)
  const idx = (__VU - 1) % sessions.length;
  const sess = sessions[idx];

  // ws-level tags (진단용)
  const params = {
    headers: { Cookie: sess.cookie },
    tags: {
      proto: "raw",
      mode: MODE,
      room: String(roomIdx),
      roomSize: String(roomSize(roomIdx)),
      graph: String(graphId),
      role: sender ? "sender" : "receiver",
    },
  };

  const wsUrl = `${baseWs}/ws/canvas-raw?teamId=${teamId}&graphId=${graphId}`;

  ws.connect(wsUrl, params, (socket) => {
    let cancel = null;

    // 기준점 (단일룸과 동일한 방식)
    let openedAtMs = null;
    let sendStartAtMs = null;  // sender: 첫 send
    let firstRecvAtMs = null;  // receiver: 첫 recv

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
            if (sendStartAtMs == null) sendStartAtMs = Date.now();

            socket.send(JSON.stringify(buildCursorPayload(teamId, graphId)));

            // global
            raw_sent.add(1, { role: "sender" });
            
            // room
            if (ROOM_METRICS) rawr_sent.add(1, { role: "sender", room: String(roomIdx), graph: String(graphId) });
          },
        });
      }
    });

    socket.on("message", (msgText) => {
      const tagsGlobal = { role: sender ? "sender" : "receiver" };
      const tagsRoom = { role: sender ? "sender" : "receiver", room: String(roomIdx), graph: String(graphId) };

      // frames
      raw_recv_frames.add(1, tagsGlobal);
      if (ROOM_METRICS) rawr_recv_frames.add(1, tagsRoom);

      if (MODE !== "cursor") return;

      if (firstRecvAtMs == null) firstRecvAtMs = Date.now();

      let msg = null;
      try {
        msg = JSON.parse(msgText);
      } catch {
        return;
      }

      // phase 기준점 통일
      const phaseStartAt = sender ? sendStartAtMs : firstRecvAtMs;
      let inSendWindow = null;
      if (phaseStartAt != null) {
        inSendWindow = Date.now() - phaseStartAt <= sendWindowMs;
      } else if (openedAtMs != null) {
        inSendWindow = Date.now() - openedAtMs <= sendWindowMs;
      }

      // 1) 단일 CURSOR
      if (msg?.type === "CURSOR" && typeof msg?.sentAt === "number") {
        raw_recv.add(1, tagsGlobal);
        if (ROOM_METRICS) rawr_recv.add(1, tagsRoom);

        const lat = Date.now() - msg.sentAt;
        recordLatencyGlobal(lat, tagsGlobal, { inSendWindow });
        recordLatencyRoom(lat, tagsRoom);
        return;
      }

      // 2) 배치 PRESENCE_BATCH
      if (msg?.type === "PRESENCE_BATCH" && Array.isArray(msg?.cursors)) {
        const n = msg.cursors.length;
        if (n > 0) {
          raw_recv.add(n, tagsGlobal);
          rawr_recv.add(n, tagsRoom);
        }

        for (const it of msg.cursors) {
          if (!it || typeof it.sentAt !== "number") continue;
          const lat = Date.now() - it.sentAt;
          recordLatencyGlobal(lat, tagsGlobal, { inSendWindow });
          if (ROOM_METRICS) recordLatencyRoom(lat, tagsRoom);
        }
      }
    });

    socket.on("error", (e) => {
      raw_errors.add(1);
      if (DUMP_ERR && errDumped < DUMP_ERR_LIMIT) {
        console.log(
          JSON.stringify({
            vu: __VU,
            iter: __ITER,
            room: roomIdx,
            graph: graphId,
            role: sender ? "sender" : "receiver",
            err: String(e),
          })
        );
        errDumped += 1;
      }
    });

    socket.on("close", () => {
      raw_close.add(1);
      if (cancel) cancel();
    });
  });
}

/** ---------------- Summary Helpers ---------------- */
function num(x, d = 2) {
  return typeof x === "number" && isFinite(x) ? x.toFixed(d) : "—";
}

function metric(data, base) {
  const metrics = data?.metrics || {};
  if (metrics[base]) return metrics[base];

  const keys = Object.keys(metrics).filter((k) => k === base || k.startsWith(base + "{"));
  if (!keys.length) return null;

  // 가장 많은 샘플의 시계열 선택
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

function parseTagsFromMetricKey(key) {
  const i = key.indexOf("{");
  const j = key.lastIndexOf("}");
  if (i < 0 || j < 0 || j <= i) return {};
  const inside = key.slice(i + 1, j).trim();
  if (!inside) return {};
  const out = {};
  for (const part of inside.split(",")) {
    const p = part.trim();
    if (!p) continue;
    const eq = p.indexOf("=");
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    let v = p.slice(eq + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    out[k] = v;
  }
  return out;
}

function sumCounterAllSeries(data, base) {
  const metrics = data?.metrics || {};
  let sum = 0;
  for (const [k, m] of Object.entries(metrics)) {
    if (k === base || k.startsWith(base + "{")) {
      sum += m?.values?.count ?? m?.count ?? 0;
    }
  }
  return sum;
}

function collectRoomSeriesCounters(data, base) {
  // returns map roomIdx -> sumCount, also store by (room,graph)
  const metrics = data?.metrics || {};
  const byRoom = new Map(); // room -> {count, byGraph: Map(graph->count)}
  for (const [k, m] of Object.entries(metrics)) {
    if (!(k === base || k.startsWith(base + "{"))) continue;
    const tags = parseTagsFromMetricKey(k);
    const room = tags.room;
    const graph = tags.graph;
    const cnt = m?.values?.count ?? m?.count ?? 0;
    if (room == null) continue;

    if (!byRoom.has(room)) byRoom.set(room, { count: 0, byGraph: new Map() });
    const obj = byRoom.get(room);
    obj.count += cnt;

    if (graph != null) {
      obj.byGraph.set(graph, (obj.byGraph.get(graph) || 0) + cnt);
    }
  }
  return byRoom;
}

export function handleSummary(data) {
  const durS = (data?.state?.testRunDurationMs ?? HOLD_MS) / 1000;

  // ---------------- Global (단일룸 비교용) ----------------
  const mConn = metric(data, "raw_connect_ms");
  const mLat = metric(data, "raw_latency_ms");
  const mLatSend = metric(data, "raw_latency_during_send_ms");
  const mLatAfter = metric(data, "raw_latency_after_send_ms");

  const open = sumCounterAllSeries(data, "raw_open");
  const close = sumCounterAllSeries(data, "raw_close");
  const errs = sumCounterAllSeries(data, "raw_errors");

  const sent = sumCounterAllSeries(data, "raw_sent");
  const recvEvents = sumCounterAllSeries(data, "raw_recv");
  const recvFrames = sumCounterAllSeries(data, "raw_recv_frames");

  const ok = sumCounterAllSeries(data, "raw_lat_le_200ms");
  const warn = sumCounterAllSeries(data, "raw_lat_le_1s");
  const bad = sumCounterAllSeries(data, "raw_lat_gt_1s");
  const bucketTotal = ok + warn + bad;

  const phaseDuring = sumCounterAllSeries(data, "raw_phase_during_cnt");
  const phaseAfter = sumCounterAllSeries(data, "raw_phase_after_cnt");

  // ---------------- Room Diagnostic ----------------
  const rSent = collectRoomSeriesCounters(data, "rawr_sent");
  const rRecv = collectRoomSeriesCounters(data, "rawr_recv");
  const rFrames = collectRoomSeriesCounters(data, "rawr_recv_frames");
  const rOk = collectRoomSeriesCounters(data, "rawr_lat_le_200ms");
  const rWarn = collectRoomSeriesCounters(data, "rawr_lat_le_1s");
  const rBad = collectRoomSeriesCounters(data, "rawr_lat_gt_1s");

  const roomsArr = [];
  for (let r = 0; r < ROOMS; r++) {
    const room = String(r);
    const size = roomSize(r);
    const senders = MODE === "cursor" ? senderCountInRoom(r) : 0;

    const sentR = rSent.get(room)?.count || 0;
    const recvR = rRecv.get(room)?.count || 0;
    const framesR = rFrames.get(room)?.count || 0;

    const okR = rOk.get(room)?.count || 0;
    const warnR = rWarn.get(room)?.count || 0;
    const badR = rBad.get(room)?.count || 0;
    const totR = okR + warnR + badR;
    const okPctR = totR > 0 ? (okR / totR) * 100 : null;

    roomsArr.push({
      room: r,
      graph: GRAPH_ID_BASE + r,
      size,
      senders,
      sent: sentR,
      recvEvents: recvR,
      recvFrames: framesR,
      ok200: okR,
      totalLatSamples: totR,
      ok200Pct: okPctR,
    });
  }

  // show top few rooms by worst ok200Pct (lower is worse), but keep stable if null
  const roomsSorted = roomsArr
    .slice()
    .sort((a, b) => {
      const av = a.ok200Pct == null ? 1e9 : a.ok200Pct;
      const bv = b.ok200Pct == null ? 1e9 : b.ok200Pct;
      return av - bv;
    });

  const pct = (x) => (bucketTotal > 0 ? num((x / bucketTotal) * 100, 2) : "—");
  const lines = [];

  lines.push(`=== RAW MultiRoom Summary (MODE=${MODE}) ===`);
  lines.push(`rooms=${ROOMS} total_vus=${TOTAL_VUS} base_per_room=${BASE_PER_ROOM} remainder=${REMAINDER}`);
  lines.push(
    `room distribution: ` +
      Array.from({ length: Math.min(ROOMS, 10) }, (_, r) => `#${r}:size=${roomSize(r)},senders=${MODE === "cursor" ? senderCountInRoom(r) : 0}`).join(" | ") +
      (ROOMS > 10 ? ` ...(+${ROOMS - 10} rooms)` : "")
  );

  lines.push(`duration: ${num(durS, 2)}s`);
  lines.push(`open: ${open} / close: ${close} / errors: ${errs}`);
  lines.push(`sent: ${sent} / received(events): ${recvEvents} / received(frames): ${recvFrames}`);
  lines.push(`sent/s: ${num(sent / durS, 2)} / recv_events/s: ${num(recvEvents / durS, 2)} / recv_frames/s: ${num(recvFrames / durS, 2)}`);

  if (mConn && vCount(mConn) > 0) {
    lines.push(
      `connect(ms) count=${vCount(mConn)} avg=${num(t(mConn, "avg"), 1)} p50=${num(t(mConn, "p(50)"), 1)} p95=${num(
        t(mConn, "p(95)"),
        1
      )} p99=${num(t(mConn, "p(99)"), 1)}`
    );
  }

  if (MODE === "cursor") {
    if (mLat && vCount(mLat) > 0) {
      lines.push(
        `latency(all) count=${vCount(mLat)} avg=${num(t(mLat, "avg"), 1)} p50=${num(t(mLat, "p(50)"), 1)} p95=${num(
          t(mLat, "p(95)"),
          1
        )} p99=${num(t(mLat, "p(99)"), 1)}`
      );
    }
    if (mLatSend && vCount(mLatSend) > 0) {
      lines.push(
        `latency(send-window ${SEND_DURATION_S}s) count=${vCount(mLatSend)} p50=${num(t(mLatSend, "p(50)"), 1)} p95=${num(
          t(mLatSend, "p(95)"),
          1
        )} p99=${num(t(mLatSend, "p(99)"), 1)}`
      );
    }
    if (mLatAfter && vCount(mLatAfter) > 0) {
      lines.push(
        `latency(after-send) count=${vCount(mLatAfter)} p50=${num(t(mLatAfter, "p(50)"), 1)} p95=${num(
          t(mLatAfter, "p(95)"),
          1
        )} p99=${num(t(mLatAfter, "p(99)"), 1)}`
      );
    }

    lines.push(
      `<=${LAT_OK_MS}ms: ${ok} (${pct(ok)}%) / <=${LAT_WARN_MS}ms: ${warn} (${pct(warn)}%) / >${LAT_WARN_MS}ms: ${bad} (${pct(bad)}%) / total_samples=${bucketTotal}`
    );
    lines.push(`phase samples: during=${phaseDuring} / after=${phaseAfter}`);

    // room highlights (worst few)
    const showN = Math.min(5, roomsSorted.length);
    lines.push(`--- room ok<=${LAT_OK_MS}ms + recv volume (worst ${showN}) ---`);
    for (let i = 0; i < showN; i++) {
      const r = roomsSorted[i];
      const okPct = r.ok200Pct == null ? "—" : num(r.ok200Pct, 2) + "%";
      lines.push(
        `room#${r.room} graph=${r.graph} size=${r.size} senders=${r.senders} ` +
          `ok<=${LAT_OK_MS}=${r.ok200}/${r.totalLatSamples} (${okPct}) ` +
          `recvEvents=${r.recvEvents} recvFrames=${r.recvFrames} sent=${r.sent}`
      );
    }
  }

  return {
    [SUMMARY_OUT]: JSON.stringify(data, null, 2),
    stdout: lines.join("\n") + "\n",
  };
}