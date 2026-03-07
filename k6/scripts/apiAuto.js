import http from "k6/http";
import { check } from "k6";
import { SharedArray } from "k6/data";
import { Trend } from "k6/metrics";

/**
 * HTTP Runner (endpoints.json 기반) + params.json 기반 파라미터 분배
 * ✅ AUTH: Cookie 기반 (Bearer 토큰 제거)
 *
 * - setup(): 1회 로그인 → cookie 확보 (summary anchor용 testStartTs 포함)
 * - VU별: 최초 1회 로그인 → VU_COOKIE 저장 → 모든 요청에 Cookie 헤더 부여
 */

// ──────────────────────────────────────────────────────────────────────────────
//  RNG helper
// ──────────────────────────────────────────────────────────────────────────────
function seededPick(n, seed) {
  let x = seed >>> 0;
  x = (1664525 * x + 1013904223) >>> 0;
  return x % n;
}

// ──────────────────────────────────────────────────────────────────────────────
//  Users CSV (loginId,password,id)
// ──────────────────────────────────────────────────────────────────────────────
const USERS = new SharedArray("users", () => {
  const text = open("../data/users.csv");
  const lines = text.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i === 0 && line.toLowerCase().startsWith("loginid,")) continue; // header
    const [loginId, password, id] = line.split(",");
    if (loginId && password) out.push({ loginId, password, id });
  }
  if (!out.length) throw new Error("users.csv 로드 실패: 유효한 행이 없습니다.");
  return out;
});

// ──────────────────────────────────────────────────────────────────────────────
//  Params JSON  (Controller.endpoint -> { userId | const: [ {k:v}, ... ] })
// ──────────────────────────────────────────────────────────────────────────────
let PARAMS = {};
try {
  PARAMS = JSON.parse(open("../data/params.json"));
} catch (_) {
  PARAMS = {};
}

// ──────────────────────────────────────────────────────────────────────────────
//  ENV
// ──────────────────────────────────────────────────────────────────────────────
// const BASE = __ENV.BASE_URL || "http://172.30.1.78:8080";
const BASE = __ENV.BASE_URL || "http://trading-replay.duckdns.org:8080";
const VUS = Number(__ENV.VUS || 5);
const DURATION = __ENV.DURATION || "10s";
const EXECUTOR = (__ENV.EXECUTOR || "constant-vus").trim();
const CONTROLLERS = (__ENV.CONTROLLERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ENDPOINTS = (__ENV.ENDPOINTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const VARIANTS = (__ENV.VARIANTS || "light")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const RATE = Number(__ENV.RATE || 20);
const MAX_VUS = Number(__ENV.MAX_VUS || VUS * 5);
const SUMMARY_OUT = __ENV.SUMMARY || "outputs/summary.json";
const DISTRIBUTE_RATE = String(__ENV.DISTRIBUTE_RATE || "1") === "1";
const DROP_BODIES = String(__ENV.DROP_BODIES || "1") === "1";
const STRICT_PARAMS = String(__ENV.STRICT_PARAMS || "1") === "1";
const DEBUG = String(__ENV.DEBUG || "0") === "1";

// 🔥 Auto warmup controls (works even if endpoints.json has no warmup)
const NO_WARMUP = String(__ENV.NO_WARMUP || "0") === "1";
const WARMUP_EXECUTOR = (
  __ENV.WARMUP_EXECUTOR || "constant-arrival-rate"
).trim();
const WARMUP_RATE = Number(__ENV.WARMUP_RATE || 50);
const WARMUP_PRE = Number(__ENV.WARMUP_PREVUS || 20);
const WARMUP_MAX = Number(__ENV.WARMUP_MAXVUS || Math.max(60, WARMUP_PRE * 3));
const WARMUP_DURATION = __ENV.WARMUP_DURATION || "1m";
const WARMUP_EXTRA_GAP_S = Number(__ENV.WARMUP_GAP_S || 10); // warmup → main 완충

// ──────────────────────────────────────────────────────────────────────────────
const cfg = new SharedArray("endpoints", () =>
  JSON.parse(open("../data/endpoints.json"))
);

// ──────────────────────────────────────────────────────────────────────────────
//  Helpers
// ──────────────────────────────────────────────────────────────────────────────
const RT_STAGE = new Trend("rt_stage", true);

function extractFirstVar(pathTpl, qsTpl) {
  const both = `${pathTpl || ""} ${qsTpl || ""}`;
  const m = both.match(/{{\s*([\w]+)\s*}}/);
  return m ? m[1] : null;
}
function renderTemplate(tpl, ctx) {
  if (!tpl) return "";
  return tpl.replace(/{{\s*([\w]+)\s*}}/g, (_, k) => {
    const v = ctx[k];
    return encodeURIComponent(v == null ? "" : String(v));
  });
}
function hasTemplateBraces(s) {
  return typeof s === "string" && /{{\s*[\w]+\s*}}/.test(s);
}
function cartesianParams(params) {
  const keys = Object.keys(params || {});
  if (!keys.length) return [{}];
  const values = keys.map((k) =>
    Array.isArray(params[k]) ? params[k] : [params[k]]
  );
  const out = [];
  (function dfs(i, acc) {
    if (i === keys.length) return void out.push({ ...acc });
    const k = keys[i];
    for (const v of values[i]) {
      acc[k] = v;
      dfs(i + 1, acc);
    }
  })(0, {});
  return out;
}
function comboLabel(ctx, order) {
  const keys = Array.isArray(order) && order.length ? order : Object.keys(ctx);
  return keys
    .map((k) => `${k}_${String(ctx[k]).replace(/[^A-Za-z0-9._-]/g, "_")}`)
    .join("__");
}
function normalizePath(p) {
  if (!p) return "";
  return p.startsWith("/") ? p : `/${p}`;
}
function toSeconds(dur) {
  if (!dur) return 0;
  const m = String(dur).match(/^(\d+)(ms|s|m|h)$/);
  if (!m) return 0;
  const n = Number(m[1]),
    u = m[2];
  if (u === "ms") return Math.floor(n / 1000);
  if (u === "s") return n;
  if (u === "m") return n * 60;
  if (u === "h") return n * 3600;
  return 0;
}
function sanitize(s) {
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}

// ✅ STOMP에서 쓰던 쿠키 추출 (res.cookies → "a=b; c=d")
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

// ──────────────────────────────────────────────────────────────────────────────
//  Setup (bootstrap cookie for summary timeline anchor)
// ──────────────────────────────────────────────────────────────────────────────
export function setup() {
  const jar = http.cookieJar();
  const res = http.post(
    `${BASE}/api/login/signin`,
    JSON.stringify({
      loginId: __ENV.USER || "login_34",
      password: __ENV.PASS || "pw_e369853df766fa44e1ed0ff613f563bd",
    }),
    { headers: { "Content-Type": "application/json" }, jar, tags: { phase: "auth" } }
  );
  if (res.status !== 200)
    throw new Error(`로그인 실패: ${res.status} ${res.body}`);

  const cookie = cookieHeaderFromResponse(res);
  if (!cookie) throw new Error(`setup 쿠키 비어있음 status=${res.status} body=${res.body}`);

  return {
    cookie, // (필요하면 활용 가능)
    testStartTs: Date.now(),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  VU-local auth (each VU logs in once, from users.csv filtered pool)
// ──────────────────────────────────────────────────────────────────────────────
let VU_COOKIE = null;
let VU_USER = null; // {loginId,password,id}
const VU_PARAM_IDX = {}; // rr counters per endpoint scope
let ACTIVE_USER_SET = null,
  FILTERED_USERS = null;

function loginPerVUFromCSV() {
  if (VU_COOKIE) return;

  const pool = FILTERED_USERS || USERS;
  const idx = (__VU - 1) % pool.length;
  const { loginId, password, id } = pool[idx];

  const jar = http.cookieJar();
  const res = http.post(
    `${BASE}/api/login/signin`,
    JSON.stringify({ loginId, password }),
    { headers: { "Content-Type": "application/json" }, jar, tags: { phase: "auth" } }
  );
  if (res.status !== 200)
    throw new Error(
      `로그인 실패(VU=${__VU}, loginId=${loginId}): ${res.status} ${res.body}`
    );

  const cookie = cookieHeaderFromResponse(res);
  if (!cookie)
    throw new Error(
      `쿠키 비어있음(VU=${__VU}, loginId=${loginId}): ${res.status} ${res.body}`
    );

  VU_COOKIE = cookie;
  VU_USER = { loginId, password, id: String(id ?? "").trim() };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Flatten endpoints (+ auto-inject warmup if missing)
// ──────────────────────────────────────────────────────────────────────────────
const all = [];

for (const c of cfg) {
  if (CONTROLLERS.length && !CONTROLLERS.includes(c.controller)) continue;

  for (const ep of c.endpoints) {
    if (ENDPOINTS.length && !ENDPOINTS.includes(ep.name)) continue;

    const baseItem = {
      controller: c.controller,
      base: c.base,
      name: ep.name,
      method: (ep.method || "GET").toUpperCase(),
      body: ep.body || null,
      rawPath: ep.path || "",
      rawQsTemplate: ep.qsTemplate || "",
      rawParams: ep.params || null,
      _defaults: {
        executor: ep.executor,
        rate: ep.rate,
        preAllocatedVUs: ep.preAllocatedVUs,
        vus: ep.vus,
        maxVUs: ep.maxVUs,
        duration: ep.duration,
        thresholds: ep.thresholds,
        headers: ep.headers,
        startRate: ep.startRate,
        timeUnit: ep.timeUnit,
        stages: ep.stages,
      },
      paramLabels: ep.paramLabels || null,
    };

    const needsTemplate =
      ep.params &&
      (hasTemplateBraces(ep.qsTemplate) || hasTemplateBraces(ep.path));
    const combos = needsTemplate ? cartesianParams(ep.params) : [{}];

    for (const combo of combos) {
      const renderedPath = normalizePath(
        hasTemplateBraces(ep.path) ? renderTemplate(ep.path, combo) : ep.path
      );
      const qs = hasTemplateBraces(ep.qsTemplate)
        ? renderTemplate(ep.qsTemplate, combo)
        : ep.qs || "";
      const url = `${BASE}${c.base}${renderedPath}${qs ? "?" + qs : ""}`;
      const comboName = needsTemplate ? comboLabel(combo, ep.paramLabels) : null;

      const variants = Array.isArray(ep.variants) ? ep.variants : [];
      const picked = [];

      for (const v of variants) {
        const wantThisVariant =
          !VARIANTS.length ||
          VARIANTS.includes(v.name) ||
          (!NO_WARMUP && v.name === "warmup");
        if (!wantThisVariant) continue;

        picked.push(v);
        const item = {
          ...baseItem,
          url,
          combo: comboName,
          variant: v.name || null,
          _overrides: {
            executor: v.executor,
            rate: v.rate,
            preAllocatedVUs: v.preAllocatedVUs,
            vus: v.vus,
            maxVUs: v.maxVUs,
            duration: v.duration,
            thresholds: v.thresholds,
            headers: v.headers,
            body: v.body,
            startTime: v.startTime,
            tags: v.tags,
            startRate: v.startRate,
            timeUnit: v.timeUnit,
            stages: v.stages,
          },
        };
        item.key = [
          `${item.controller}.${item.name}`,
          item.combo || "-",
          item.variant || "-",
        ].join("::");
        all.push(item);
      }

      // 🔧 Auto-inject warmup if missing (and user didn't disable it)
      const hasWarmup = picked.some(
        (v) => String(v?.name).toLowerCase() === "warmup"
      );
      const hasAnyMain = picked.some(
        (v) => String(v?.name).toLowerCase() !== "warmup"
      );
      if (!NO_WARMUP && !hasWarmup && hasAnyMain) {
        const item = {
          ...baseItem,
          url,
          combo: comboName,
          variant: "warmup",
          _overrides: {
            executor: WARMUP_EXECUTOR,
            rate: WARMUP_RATE,
            preAllocatedVUs: WARMUP_PRE,
            maxVUs: WARMUP_MAX,
            duration: WARMUP_DURATION,
            thresholds: null,
            headers: null,
            body: null,
            startTime: null,
            tags: {
              phase: "warmup",
              ctrl: baseItem.controller,
              ep: baseItem.name,
            },
          },
        };
        item.key = [
          `${item.controller}.${item.name}`,
          item.combo || "-",
          item.variant,
        ].join("::");
        all.push(item);
        if (DEBUG)
          console.log(
            `[AUTO] warmup injected for ${baseItem.controller}.${baseItem.name} (${WARMUP_DURATION})`
          );
      }
    }
  }
}

// Fast lookup + active users filtering
const allMap = {};
for (const it of all) allMap[it.key] = it;

if (STRICT_PARAMS) {
  const activeMapKeys = new Set(all.map((it) => `${it.controller}.${it.name}`));
  ACTIVE_USER_SET = new Set();
  for (const mapKey of activeMapKeys) {
    const userMap = PARAMS[mapKey];
    if (!userMap || typeof userMap !== "object") continue;
    for (const uid of Object.keys(userMap)) ACTIVE_USER_SET.add(String(uid));
  }
  const tmp = [];
  for (const u of USERS) if (ACTIVE_USER_SET.has(String(u.id))) tmp.push(u);
  FILTERED_USERS = tmp.length ? tmp : USERS;
} else {
  FILTERED_USERS = USERS;
}

// RPS distribution within groups
const groupCounts = {},
  groupBaseRate = {};
for (const ep of all) {
  const g = `${ep.controller}.${ep.name}::${ep.variant || "-"}`;
  groupCounts[g] = (groupCounts[g] || 0) + 1;
  const baseRate = Number(ep._overrides?.rate ?? ep._defaults.rate ?? RATE);
  groupBaseRate[g] = baseRate;
}
const perRateMap = {};
if (DISTRIBUTE_RATE) {
  const grouped = {};
  for (const ep of all) {
    const g = `${ep.controller}.${ep.name}::${ep.variant || "-"}`;
    (grouped[g] ||= []).push(ep);
  }
  for (const [g, eps] of Object.entries(grouped)) {
    const baseRate = Number(groupBaseRate[g] || 0);
    const n = eps.length;
    const q = Math.floor(baseRate / n);
    let r = baseRate - q * n;
    for (const ep of eps) {
      const add = r > 0 ? 1 : 0;
      perRateMap[ep.key] = Math.max(1, q + add);
      r -= add;
    }
  }
}

// Warmup offset map (sec) per Controller.endpoint
const warmupOffsetByTarget = {};
for (const it of all) {
  if (String(it.variant).toLowerCase() !== "warmup") continue;
  const mapKey = `${it.controller}.${it.name}`;
  let sec = 0;

  const stages = it._overrides?.stages || it._defaults?.stages || null;
  if (Array.isArray(stages) && stages.length) {
    sec = stages.reduce((acc, s) => acc + toSeconds(s.duration || "0s"), 0);
  } else {
    const dur = it._overrides?.duration || it._defaults?.duration || "";
    sec = toSeconds(dur) || 0;
  }

  if (sec > 0) {
    warmupOffsetByTarget[mapKey] = Math.max(
      warmupOffsetByTarget[mapKey] || 0,
      sec + WARMUP_EXTRA_GAP_S
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Build scenarios + thresholds
// ──────────────────────────────────────────────────────────────────────────────
const scenarios = {};
const thresholds = {
  http_req_failed: ["rate<0.01"],
  http_req_duration: ["p(95)<800"],
  // ▼ 아래 3줄: 태그달린 서브메트릭을 Summary에 강제로 생성
  "http_req_duration{phase:main}": ["p(95)<100000"], // 더미
  "http_reqs{phase:main}": ["rate>0"], // 더미
  "rt_stage{phase:main}": ["p(95)<100000"], // 더미
};

function mergeThresholds(thrObj, scenarioName, thrSpec) {
  if (!thrSpec || typeof thrSpec !== "object") return;
  for (const [metric, arr] of Object.entries(thrSpec)) {
    const key = metric.includes("{")
      ? metric
      : `${metric}{scenario:${scenarioName}}`;
    thrObj[key] = arr;
  }
}

for (const ep of all) {
  const baseName = sanitize(`${ep.controller}_${ep.name}`);
  const scenarioName = sanitize(
    [baseName, ep.combo || null, ep.variant || null].filter(Boolean).join("__")
  );

  const execType = (
    ep._overrides?.executor ||
    ep._defaults.executor ||
    EXECUTOR
  ).trim();

  const baseRate = Number(ep._overrides?.rate ?? ep._defaults.rate ?? RATE);
  const rate =
    execType === "constant-arrival-rate" && DISTRIBUTE_RATE
      ? Number(perRateMap[ep.key] ?? baseRate)
      : baseRate;

  const pre = Number(
    ep._overrides?.preAllocatedVUs ??
      ep._defaults.preAllocatedVUs ??
      ep._overrides?.vus ??
      ep._defaults.vus ??
      VUS
  );

  const maxVUs = Number(
    ep._overrides?.maxVUs ?? ep._defaults.maxVUs ?? MAX_VUS
  );

  const duration = ep._overrides?.duration || ep._defaults.duration || DURATION;
  const startTime = ep._overrides?.startTime;

  const mapKey = `${ep.controller}.${ep.name}`;
  const autoStartTime =
    !startTime &&
    !NO_WARMUP &&
    String(ep.variant).toLowerCase() !== "warmup" &&
    warmupOffsetByTarget[mapKey]
      ? `${warmupOffsetByTarget[mapKey]}s`
      : null;

  // ✅ phase 태그 강제
  const isWarmVariant = String(ep.variant || "").toLowerCase() === "warmup";
  const phaseTag = isWarmVariant ? "warmup" : "main";

  const env = {
    KEY: ep.key,
    TARGET: mapKey,
    VARIANT: ep.variant || "",
    COMBO: ep.combo || "",
    SCENARIO: scenarioName,
  };

  const common = {
    exec: "dispatch",
    env,
    tags: {
      ...(ep._overrides?.tags || {}),
      controller: ep.controller,
      endpoint: mapKey,
      variant: ep.variant || "",
      scenario: scenarioName,
      phase: phaseTag,
    },
    ...(startTime || autoStartTime
      ? { startTime: startTime || autoStartTime }
      : {}),
  };

  if (execType === "constant-arrival-rate") {
    scenarios[scenarioName] = {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration,
      preAllocatedVUs: pre,
      maxVUs,
      ...common,
    };
  } else if (execType === "ramping-arrival-rate") {
    const rawStages =
      ep._overrides?.stages ??
      ep._defaults?.stages ?? [{ target: rate, duration: "1m" }];
    const startRate = Number(
      ep._overrides?.startRate ?? ep._defaults?.startRate ?? 10
    );
    const timeUnit = ep._overrides?.timeUnit ?? ep._defaults?.timeUnit ?? "1s";
    const stageDurS = rawStages.map((s) => toSeconds(s.duration));
    const stageTargets = rawStages.map((s) => Number(s.target));

    scenarios[scenarioName] = {
      executor: "ramping-arrival-rate",
      startRate,
      timeUnit,
      preAllocatedVUs: pre,
      maxVUs,
      stages: rawStages,
      ...common,
      env: {
        ...env,
        STAGE_DURS: stageDurS.join(","),
        STAGE_TARGETS: stageTargets.join(","),
        START_OFFSET_S: "0",
      },
    };

    for (let i = 0; i < rawStages.length; i++) {
      thresholds[`rt_stage{stage:${i},scenario:${scenarioName}}`] = [
        "p(95)<100000",
      ];
    }
  } else {
    scenarios[scenarioName] = {
      executor: "constant-vus",
      vus: pre,
      duration,
      ...common,
    };
  }

  mergeThresholds(thresholds, scenarioName, ep._defaults.thresholds);
  mergeThresholds(thresholds, scenarioName, ep._overrides.thresholds);
}

if (DEBUG) {
  console.log("=== Scenario effective config ===");
  for (const [name, sc] of Object.entries(scenarios)) {
    if (sc.tags?.phase === "main") {
      console.log(
        `${name} | executor=${sc.executor} | rate=${sc.rate} | timeUnit=${sc.timeUnit} | duration=${sc.duration} | pre=${sc.preAllocatedVUs} | max=${sc.maxVUs}`
      );
    }
  }
}

// ✅ 커스텀 Trend의 퍼센타일을 summary에 확실히 포함
export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ["avg", "min", "max", "p(90)", "p(95)"],
};

if (DEBUG) console.log("SCENARIOS:", Object.keys(scenarios).join(", "));

// ──────────────────────────────────────────────────────────────────────────────
//  Dispatcher
// ──────────────────────────────────────────────────────────────────────────────
export function dispatch(data) {
  loginPerVUFromCSV();

  const key = __ENV.KEY;
  const ep = allMap[key];
  if (!ep) throw new Error(`No endpoint matched KEY=${key}`);

  const mapKey = `${ep.controller}.${ep.name}`;
  const userId = String((VU_USER && VU_USER.id) || "");
  const needsTpl =
    hasTemplateBraces(ep.rawPath) || hasTemplateBraces(ep.rawQsTemplate);

  const firstVar = extractFirstVar(ep.rawPath, ep.rawQsTemplate);
  const defaultCombos = cartesianParams(ep.rawParams || {});
  const userMap = PARAMS[mapKey] || {};

  function toObj(v) {
    if (v == null) return null;
    if (typeof v === "object" && !Array.isArray(v)) return v;
    if (Array.isArray(v)) return null;
    if (firstVar) return { [firstVar]: String(v) };
    const keys = Object.keys(ep.rawParams || {});
    if (keys.length === 1) return { [keys[0]]: String(v) };
    return { id: String(v) };
  }

  let candidates = null;
  const perUser = userMap[userId];

  if (Array.isArray(perUser) && perUser.length) candidates = perUser.slice();
  else if (perUser && typeof perUser === "object") candidates = [perUser];
  else if (perUser != null) {
    const o = toObj(perUser);
    if (o) candidates = [o];
  }

  if (!candidates) {
    const cst = userMap.const;
    if (Array.isArray(cst) && cst.length) {
      const arr = cst
        .map((v) => (typeof v === "object" ? v : toObj(v)))
        .filter(Boolean);
      if (arr.length) candidates = arr;
    } else if (cst && typeof cst === "object") candidates = [cst];
    else if (cst != null) {
      const o = toObj(cst);
      if (o) candidates = [o];
    }
  }

  if (!candidates) {
    if (STRICT_PARAMS && needsTpl) {
      console.warn(`[SKIP] no params for user=${userId} on ${mapKey}`);
      return;
    }
    candidates = defaultCombos.length ? defaultCombos : [{}];
  }

  // 워밍/메인 분기: 메인은 시드 고정 선택(재현성), 워밍은 랜덤 그대로
  let chosen, pickIdx;
  const isWarm = String(__ENV.VARIANT || "").toLowerCase() === "warmup";

  if (isWarm || !__ENV.MAIN_SEED) {
    pickIdx = Math.floor(Math.random() * candidates.length);
    chosen = candidates[pickIdx];
  } else {
    const seedBase = Number(__ENV.MAIN_SEED) || 12345;
    const seed = (seedBase ^ (__VU * 1_000_003) ^ __ITER) >>> 0;
    pickIdx = seededPick(candidates.length, seed);
    chosen = candidates[pickIdx];
  }

  const renderedPath = needsTpl
    ? renderTemplate(ep.rawPath, chosen)
    : ep.rawPath;

  const qs = needsTpl
    ? renderTemplate(ep.rawQsTemplate, chosen)
    : ep.rawQsTemplate || "";

  const finalUrl = `${BASE}${ep.base}${normalizePath(renderedPath)}${
    qs ? "?" + qs : ""
  }`;

  // ── Stage index 계산(요청 태그에 반영)
  const testStartTs = data?.testStartTs || 0;
  const startOffset = Number(__ENV.START_OFFSET_S || 0);
  const elapsedS = Math.max(
    0,
    Math.floor((Date.now() - testStartTs) / 1000) - startOffset
  );

  const dursStr = __ENV.STAGE_DURS || "";
  const durs = dursStr ? dursStr.split(",").map(Number) : [];
  let stageIdx = 0;

  if (durs.length) {
    let acc = 0;
    for (let i = 0; i < durs.length; i++) {
      acc += durs[i];
      if (elapsedS < acc) {
        stageIdx = i;
        break;
      }
      stageIdx = i;
    }
  }

  // ✅ 요청 단위에도 항상 phase 부여
  const isWarmVariant = String(__ENV.VARIANT || "").toLowerCase() === "warmup";
  const phaseTag = isWarmVariant ? "warmup" : "main";

  // ✅ Cookie 기반 헤더 주입 (Authorization 제거)
  const params = {
    headers: {
      Cookie: VU_COOKIE,
      ...(ep._defaults.headers || {}),
      ...(ep._overrides?.headers || {}),
    },
    tags: {
      controller: ep.controller,
      endpoint: mapKey,
      combo: __ENV.COMBO || "",
      variant: __ENV.VARIANT || "",
      stage: String(stageIdx),
      scenario: __ENV.SCENARIO || "",
      phase: phaseTag,
    },
    responseType: DROP_BODIES ? "none" : "text",
    redirects: 0,
  };

  let res;
  switch (ep.method) {
    case "GET":
      res = http.get(finalUrl, params);
      break;
    case "POST":
      res = http.post(finalUrl, ep._overrides?.body ?? ep.body, params);
      break;
    case "PUT":
      res = http.put(finalUrl, ep._overrides?.body ?? ep.body, params);
      break;
    case "DELETE":
      res = http.del(finalUrl, null, params);
      break;
    default:
      throw new Error(`Unsupported method: ${ep.method}`);
  }

  RT_STAGE.add(res.timings.duration, params.tags);
  check(res, { "status is 200": (r) => r.status === 200 });

  if (res.status >= 400) {
    const e = extractError(res);
    const variantStr = params.tags.variant ? ` / ${params.tags.variant}` : "";
    const meta = [
      `status=${res.status}`,
      e.path ? `path=${e.path}` : null,
      e.ts ? `ts=${e.ts}` : null,
      e.trace ? `reqId=${e.trace}` : null,
    ]
      .filter(Boolean)
      .join(" ");

    console.error(
      `[FAIL] ${params.tags.endpoint}${variantStr ? ` [${variantStr}]` : ""} ${meta}\n→ ${e.msg}\nBODY=${res.body}`
    );
  }
}

// ──────────────────────────────────────────────────────────────────────────────
//  Summary (safe)
// ──────────────────────────────────────────────────────────────────────────────
export function handleSummary(data) {
  if (String(__ENV.DEBUG || "0") === "1") {
    const metrics = data.metrics || {};
    console.log(
      "ALL METRIC KEYS (first 30):",
      Object.keys(metrics).slice(0, 30)
    );
    console.log(
      "DURATION series:",
      Object.keys(metrics).filter((k) => k.startsWith("http_req_duration{"))
    );
    console.log(
      "RPS series:",
      Object.keys(metrics).filter((k) => k.startsWith("http_reqs{"))
    );
    console.log(
      "RT_STAGE series:",
      Object.keys(metrics).filter((k) => k.startsWith("rt_stage{"))
    );
  }

  if (data.setup_data) data.setup_data = { redacted: true };

  const get = (path, fb) =>
    path.split(".").reduce((o, k) => (o && k in o ? o[k] : undefined), data) ??
    fb;

  function pickMetricByTags(metricBase, includeTags = [], scenario = null) {
    const metrics = data.metrics || {};
    const keys = Object.keys(metrics).filter((k) => {
      if (!k.startsWith(metricBase + "{")) return false;
      const ok = includeTags.every((t) => k.includes(t));
      if (!ok) return false;
      return scenario ? k.includes(`scenario:${scenario}`) : true;
    });
    return keys.map((k) => ({ key: k, v: metrics[k] }));
  }

  function readNum(v, paths) {
    for (const p of paths) {
      const x = p
        .split(".")
        .reduce((o, k) => (o && k in o ? o[k] : undefined), v);
      if (typeof x === "number") return x;
    }
    return null;
  }

  function toMs(n) {
    return typeof n === "number" ? n.toFixed(2) : "n/a";
  }
  function toNum(n) {
    return typeof n === "number" ? n.toFixed(2) : "n/a";
  }
  function toPct(n) {
    return typeof n === "number" ? (n * 100).toFixed(2) + "%" : "n/a";
  }

  const scenario = __ENV.SUMMARY_SCENARIO || null;

  const overall = {
    avg:
      get("metrics.http_req_duration.values.avg") ??
      get("metrics.http_req_duration.avg"),
    p95:
      get("metrics.http_req_duration.values.p(95)") ??
      get("metrics.http_req_duration.percentiles.95") ??
      get("metrics.http_req_duration.p(95)"),
    rps: get("metrics.http_reqs.values.rate") ?? get("metrics.http_reqs.rate"),
    failRate:
      get("metrics.http_req_failed.values.rate") ??
      get("metrics.http_req_failed.value"),
  };

  const tagFilters = ["phase:main"];
  const tagFiltersWithSc = scenario
    ? [...tagFilters, `scenario:${scenario}`]
    : tagFilters;

  const durSeries = pickMetricByTags(
    "http_req_duration",
    tagFiltersWithSc,
    scenario
  );
  durSeries.sort(
    (a, b) => (b.v?.values?.count ?? 0) - (a.v?.values?.count ?? 0)
  );
  const dur = durSeries[0]?.v?.values || durSeries[0]?.v || null;

  const mainAvg = readNum(dur, ["avg"]) ?? readNum(dur, ["values.avg"]) ?? null;

  const mainP95 =
    readNum(dur, ["p(95)"]) ??
    readNum(dur, ["percentiles.95"]) ??
    readNum(dur, ["values.p(95)"]) ??
    null;

  const rpsSeries = pickMetricByTags("http_reqs", tagFiltersWithSc, scenario);
  rpsSeries.sort(
    (a, b) => (b.v?.values?.count ?? 0) - (a.v?.values?.count ?? 0)
  );
  const rpsVal = rpsSeries[0]?.v?.values || rpsSeries[0]?.v || null;

  const mainRps_testAvg = readNum(rpsVal, ["rate", "values.rate"]);

  function toSecondsStr(d) {
    const m = String(d).match(/^(\d+)(ms|s|m|h)$/);
    if (!m) return 0;
    const n = Number(m[1]),
      u = m[2];
    return u === "ms"
      ? Math.floor(n / 1000)
      : u === "s"
      ? n
      : u === "m"
      ? n * 60
      : n * 3600;
  }

  let activeMainSeconds = 0;
  for (const [, sc] of Object.entries(scenarios)) {
    const isMain = sc?.tags?.phase === "main";
    if (isMain) activeMainSeconds += toSecondsStr(sc.duration || "0s");
  }

  const mainCount =
    (rpsVal && (rpsVal.count ?? rpsVal.values?.count)) ??
    data.metrics?.["http_reqs{phase:main}"]?.values?.count ??
    0;

  const mainRps_active =
    activeMainSeconds > 0 ? mainCount / activeMainSeconds : null;

  const failSeries = pickMetricByTags(
    "http_req_failed",
    tagFiltersWithSc,
    scenario
  );
  failSeries.sort(
    (a, b) => (b.v?.values?.count ?? 0) - (a.v?.values?.count ?? 0)
  );
  const failVal = failSeries[0]?.v?.values || failSeries[0]?.v || null;
  const mainFailRate = readNum(failVal, [
    "rate",
    "value",
    "values.rate",
    "values.value",
  ]);
  const safeMainFailRate = mainFailRate == null ? 0 : mainFailRate;

  const stageBest = {};
  const metrics = data.metrics || {};
  for (const [key, v] of Object.entries(metrics)) {
    if (!key.startsWith("rt_stage{")) continue;
    if (!key.includes("stage:")) continue;
    if (!key.includes("phase:main")) continue;
    if (scenario && !key.includes(`scenario:${scenario}`)) continue;

    const m = key.match(/stage:(\d+)/);
    if (!m) continue;
    const idx = Number(m[1]);
    const values = v?.values || {};
    const count = values.count ?? v?.count ?? 0;
    const p95v = values["p(95)"] ?? values.percentiles?.["95"];
    if (!count || typeof p95v !== "number") continue;
    stageBest[idx] = Math.max(stageBest[idx] ?? 0, p95v);
  }
  const stageIdxs = Object.keys(stageBest)
    .map(Number)
    .sort((a, b) => a - b);

  const lines = [];
  lines.push("=== k6 Summary (phase:main) ===");
  lines.push(`avg latency: ${toMs(mainAvg)} ms`);
  lines.push(`p95 latency: ${toMs(mainP95)} ms`);
  lines.push(`throughput: ${toNum(mainRps_testAvg)} req/s (avg over test)`);
  if (mainRps_active != null)
    lines.push(
      `throughput(active): ${toNum(mainRps_active)} req/s (active-window)`
    );
  lines.push(`fail rate: ${toPct(safeMainFailRate)}`);
  lines.push("");

  if (stageIdxs.length) {
    lines.push("per-stage p95 (phase:main):");
    for (const i of stageIdxs) lines.push(`  stage ${i}: ${toMs(stageBest[i])}`);
    lines.push("");
  }

  lines.push("=== k6 Summary (overall) ===");
  lines.push(`avg latency: ${toMs(overall.avg)} ms`);
  lines.push(`p95 latency: ${toMs(overall.p95)} ms`);
  lines.push(`throughput: ${toNum(overall.rps)} req/s`);
  lines.push(`fail rate: ${toPct(overall.failRate)}`);
  lines.push("");

  const cloned = JSON.parse(JSON.stringify(data));
  if (cloned.setup_data) cloned.setup_data = { redacted: true };

  return {
    [__ENV.SUMMARY || SUMMARY_OUT]: JSON.stringify(cloned, null, 2),
    stdout: lines.join("\n"),
  };
}

// ──────────────────────────────────────────────────────────────────────────────
//  Error extractor
// ──────────────────────────────────────────────────────────────────────────────
function short(s, n = 400) {
  if (!s) return "";
  const str = String(s);
  return str.length > n ? str.slice(0, n) + "…" : str;
}

function extractError(res) {
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch (_) {}

  const msg =
    (json &&
      (json.message ||
        json.error_description ||
        json.error ||
        json.detail ||
        json.title ||
        json.reason)) ||
    (json && json.errors && short(JSON.stringify(json.errors), 300)) ||
    short(res.body, 300);

  const path = json && (json.path || json.instance);
  const ts = json && (json.timestamp || json.time);

  const trace =
    (json && (json.traceId || json.trace || json.errorId)) ||
    res.headers["x-request-id"] ||
    res.headers["x-amzn-requestid"] ||
    res.headers["x-correlation-id"];

  return { msg, path, ts, trace };
}