import http from "k6/http";
import { check, sleep } from "k6";
import { SharedArray } from "k6/data";
import { Trend } from "k6/metrics";

// ── users.csv 로드 (헤더 1줄 포함)
const USERS = new SharedArray("users", () => {
  const text = open("../data/users.csv"); // k6 실행 위치 기준: k6/scripts/에서 실행 시 ../data/users.csv
  const lines = text.split(/\r?\n/).filter(Boolean);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    if (i === 0 && line.toLowerCase().startsWith("loginid,")) continue; // 헤더 스킵
    const [loginId, password, id] = line.split(",");
    if (loginId && password) out.push({ loginId, password, id });
  }
  if (!out.length)
    throw new Error("users.csv 로드 실패: 유효한 행이 없습니다.");
  return out;
});
// 템플릿에서 변수명 뽑기 (path, qsTemplate 합쳐서 첫 변수명 사용)
function extractFirstVar(pathTpl, qsTpl) {
  const both = `${pathTpl || ""} ${qsTpl || ""}`;
  const m = both.match(/{{\s*([\w]+)\s*}}/);
  return m ? m[1] : null;
}
let LAST_STAGE_LOGGED = -1; // __VU==1에서만 사용
// params.json: { "Controller.endpoint": { "<userId>": [ {k:v}, ... ] } }
// NOTE: SharedArray는 배열만 가능. params는 객체라 그냥 로드.
let PARAMS = {};
try {
  PARAMS = JSON.parse(open("../data/params.json"));
} catch (_) {
  PARAMS = {};
}
// === 활성 endpoints에 대해 params가 있는 user만 모아 로그인 풀을 최소화 ===
const STRICT_PARAMS = String(__ENV.STRICT_PARAMS || "1") === "1"; // 켜두는 걸 권장

// all[] 만들기 전에 endpoints.json만 보고 mapKey 후보를 미리 알 수 없으니,
// all[] 만든 다음 union으로 활성 mapKey를 모읍니다.
// (아래 all[] 생성 이후에 실행)
let ACTIVE_USER_SET = null; // Set<string> of userId
let FILTERED_USERS = null; // users.csv에서 ACTIVE_USER_SET에 속하는 행만

/** ===== 커스텀 메트릭: 스테이지별 응답시간 ===== */
const RT_STAGE = new Trend("rt_stage", true); // tag별(submetric) 집계 허용

/** ===== 실행 파라미터 (ENV) ===== */
// const BASE = __ENV.BASE_URL || "http://172.30.1.78:8080";
const BASE = __ENV.BASE_URL || "http://trading-replay.duckdns.org:8080";
const VUS = Number(__ENV.VUS || 5);
const DURATION = __ENV.DURATION || "10s";
const EXECUTOR = (__ENV.EXECUTOR || "constant-vus").trim(); // "constant-vus" | "constant-arrival-rate" | "ramping-arrival-rate"
const CONTROLLERS = (__ENV.CONTROLLERS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const ENDPOINTS = (__ENV.ENDPOINTS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const RATE = Number(__ENV.RATE || 20);
const MAX_VUS = Number(__ENV.MAX_VUS || VUS * 5);
const VARIANTS = (__ENV.VARIANTS || "light") // 예: "light", "heavy", "light,heavy"
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const SUMMARY_OUT = __ENV.SUMMARY || "outputs/summary.json";
const DISTRIBUTE_RATE = String(__ENV.DISTRIBUTE_RATE || "1") === "1"; // 🔴 그룹 내 조합별 rate 분배 ON/OFF
const DROP_BODIES = String(__ENV.DROP_BODIES || "1") === "1"; // 요청 단위 바디 폐기 여부

/** ===== 엔드포인트 설정 로드 =====
 * 파일 위치: k6/data/endpoints.json
 * 실행 위치: k6/ 폴더에서 실행 (권장)
 */
const cfg = new SharedArray("endpoints", () =>
  JSON.parse(open("../data/endpoints.json"))
);

export function setup() {
  const url = `${BASE}/api/login/signin`; // 로그인 엔드포인트
  const payload = JSON.stringify({
    loginId: __ENV.USER || "login_34",
    password: __ENV.PASS || "pw_e369853df766fa44e1ed0ff613f563bd",
  });
  const res = http.post(url, payload, {
    headers: { "Content-Type": "application/json" },
  });
  if (res.status !== 200) {
    throw new Error(`로그인 실패: ${res.status} ${res.body}`);
  }
  const token = JSON.parse(res.body).accessToken; // 응답 키 이름은 서버 응답에 맞춰 수정
  return {
    token,
    headers: { Authorization: `Bearer ${token}` },
    testStartTs: Date.now(), // 스테이지 경과 시간 계산용 앵커
  };
}
// ── VU 로컬 토큰/헤더 (각 VU 런타임은 분리됨)
let VU_TOKEN = null;
let VU_HEADERS = null;
let VU_USER = null; // ✅ { loginId, password, id }
const VU_PARAM_IDX = {}; // ✅ per-endpoint 라운드로빈용 카운터 (key=controller.name)

// ── 각 VU가 자신의 계정으로 1회 로그인
function loginPerVUFromCSV() {
  if (VU_TOKEN) return;
  const pool = FILTERED_USERS || USERS;
  const idx = (__VU - 1) % pool.length;
  const { loginId, password, id } = pool[idx];
  const res = http.post(
    `${BASE}/api/login/signin`,
    JSON.stringify({ loginId, password }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
  if (res.status !== 200) {
    throw new Error(
      `로그인 실패(VU=${__VU}, loginId=${loginId}): ${res.status} ${res.body}`
    );
  }
  const token = JSON.parse(res.body).accessToken; // 서버 응답 키 이름에 맞게 유지
  VU_TOKEN = token;
  VU_HEADERS = { Authorization: `Bearer ${token}` };
  VU_USER = { loginId, password, id: String(id ?? "").trim() }; // ✅ 사용자 id 확보
  // 필요하면 디버그 로깅:
  // console.log(`VU ${__VU} logged in as ${loginId}`);
}

export function handleSummary(data) {
  // 민감정보 제거
  if (data.setup_data) data.setup_data = { redacted: true };

  // 안전한 값 추출 헬퍼
  const get = (path, fallback = undefined) =>
    path.split(".").reduce((o, k) => (o && k in o ? o[k] : undefined), data) ??
    fallback;

  const p95 =
    get("metrics.http_req_duration.values.p(95)") ??
    get("metrics.http_req_duration.percentiles.95") ??
    get("metrics.http_req_duration.p(95)");

  const avg =
    get("metrics.http_req_duration.values.avg") ??
    get("metrics.http_req_duration.avg");

  const rps =
    get("metrics.http_reqs.values.rate") ?? get("metrics.http_reqs.rate");

  const failRate =
    get("metrics.http_req_failed.values.rate") ??
    get("metrics.http_req_failed.value");

  const toMs = (v) => (typeof v === "number" ? v.toFixed(2) : "n/a");
  const toNum = (v) => (typeof v === "number" ? v.toFixed(2) : "n/a");
  const toPct = (v) =>
    typeof v === "number" ? (v * 100).toFixed(2) + "%" : "n/a";

  const lines = [
    "=== k6 Summary (safe) ===",
    `avg latency: ${toMs(avg)} ms`,
    `p95 latency: ${toMs(p95)} ms`,
    `throughput: ${toNum(rps)} req/s`,
    `fail rate: ${toPct(failRate)}`,
    "",
  ];

  // ===== 스테이지별 p95 출력 (실샘플 있는 서브메트릭만 집계) =====
  {
    const metrics = data.metrics || {};
    const stageBest = {}; // stageIdx -> 그 stage에서 관측된 p95의 최댓값(ms)

    for (const [key, v] of Object.entries(metrics)) {
      if (!key.startsWith("rt_stage{")) continue;
      if (__ENV.SCENARIO && !key.includes(`scenario:${__ENV.SCENARIO}`))
        continue; // ✅ 같은 시나리오만 우선 집계
      const m = key.match(/stage:(\d+)/);
      if (!m) continue;

      const idx = Number(m[1]);

      // k6 버전에 따라 값 경로가 다를 수 있어 넉넉히 가져옴
      const values = v?.values || {};
      const count = values.count ?? v?.count ?? 0;

      // p95 추출(일부 버전은 percentiles.95에 있을 수 있음)
      const p95 = values["p(95)"] ?? values.percentiles?.["95"];

      if (!count || typeof p95 !== "number") continue; // 샘플 없는 빈 서브메트릭은 스킵

      stageBest[idx] = Math.max(stageBest[idx] ?? 0, p95);
    }

    const stageIdxs = Object.keys(stageBest)
      .map(Number)
      .sort((a, b) => a - b);
    if (stageIdxs.length) {
      lines.push("per-stage p95 (ms):");
      for (const i of stageIdxs) {
        lines.push(`  stage ${i}: ${toMs(stageBest[i])}`);
      }
      lines.push("");
    }
  }

  // 출력 파일 경로
  const outFile = SUMMARY_OUT;

  // summary.json에는 원본 전체를 남기되 setup_data는 마스킹
  const cloned = JSON.parse(JSON.stringify(data));
  if (cloned.setup_data) cloned.setup_data = { redacted: true };

  return {
    [outFile]: JSON.stringify(cloned, null, 2),
    stdout: lines.join("\n"),
  };
}

/** ===== 템플릿/카르테시안 헬퍼 ===== */
function renderTemplate(tpl, ctx) {
  if (!tpl) return "";
  return tpl.replace(/{{\s*([\w]+)\s*}}/g, (_, k) => {
    const v = ctx[k];
    return encodeURIComponent(v == null ? "" : String(v));
  });
}

// "{{...}}" 포함 여부
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
  function dfs(i, acc) {
    if (i === keys.length) {
      out.push({ ...acc });
      return;
    }
    const k = keys[i];
    for (const v of values[i]) {
      acc[k] = v;
      dfs(i + 1, acc);
    }
  }
  dfs(0, {});
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

/** ===== 선택된 엔드포인트 평탄화 ===== */
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
      rawPath: ep.path || "", // ✅ 원본 템플릿 보존
      rawQsTemplate: ep.qsTemplate || "", // ✅ 원본 템플릿 보존
      rawParams: ep.params || null, // ✅ 원본 파라미터 보존
      _defaults: {
        executor: ep.executor,
        rate: ep.rate,
        preAllocatedVUs: ep.preAllocatedVUs, // 우선 사용
        vus: ep.vus, // 백워드 호환
        maxVUs: ep.maxVUs,
        duration: ep.duration,
        thresholds: ep.thresholds,
        headers: ep.headers,
        // ✅ ramping-arrival-rate 관련 필드도 저장
        startRate: ep.startRate,
        timeUnit: ep.timeUnit,
        stages: ep.stages,
      },
    };

    // 템플릿 필요 여부: params가 있고, qsTemplate 또는 path에 {{...}}가 있는 경우
    const needsTemplate =
      ep.params &&
      (hasTemplateBraces(ep.qsTemplate) || hasTemplateBraces(ep.path));

    const combos = needsTemplate ? cartesianParams(ep.params) : [{}];

    for (const combo of combos) {
      // path/qs 각각 템플릿 치환
      const renderedPath = normalizePath(
        hasTemplateBraces(ep.path) ? renderTemplate(ep.path, combo) : ep.path
      );

      const qs = hasTemplateBraces(ep.qsTemplate)
        ? renderTemplate(ep.qsTemplate, combo)
        : ep.qs || "";

      const url = `${BASE}${c.base}${renderedPath}${qs ? "?" + qs : ""}`;
      const comboName = needsTemplate
        ? comboLabel(combo, ep.paramLabels)
        : null;

      if (Array.isArray(ep.variants) && ep.variants.length) {
        for (const v of ep.variants) {
          const NO_WARMUP = String(__ENV.NO_WARMUP || "0") === "1";
          const wantThisVariant =
            !VARIANTS.length ||
            VARIANTS.includes(v.name) ||
            (!NO_WARMUP && v.name === "warmup");
          if (!wantThisVariant) continue;

          const item = {
            ...baseItem,
            url,
            combo: comboName,
            variant: v.name || null,
            _overrides: {
              executor: v.executor,
              rate: v.rate,
              preAllocatedVUs: v.preAllocatedVUs,
              vus: v.vus, // 백워드 호환
              maxVUs: v.maxVUs,
              duration: v.duration,
              thresholds: v.thresholds,
              headers: v.headers,
              body: v.body,
              startTime: v.startTime,
              tags: v.tags,
              // ✅ ramping-arrival-rate 관련 필드 반영
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
      } else {
        const item = {
          ...baseItem,
          url,
          combo: comboName,
          variant: null,
          _overrides: {},
        };
        item.key = [
          `${item.controller}.${item.name}`,
          item.combo || "-",
          "-",
        ].join("::");
        all.push(item);
      }
    }
  }
}

// 빠른 조회 맵
const allMap = {};
for (const it of all) allMap[it.key] = it;

// ---- 웜업 오프셋 계산: 같은 endpoint의 warmup variant duration(초)+10s
const warmupOffsetByTarget = {}; // key = "Controller.endpoint" -> seconds
for (const it of all) {
  if (String(it.variant).toLowerCase() !== "warmup") continue;
  const mapKey = `${it.controller}.${it.name}`;
  const dur = it._overrides?.duration || it._defaults?.duration || "";
  const sec = toSeconds(dur) || 0;
  if (sec > 0) {
    // 여러 warmup이 있어도 가장 긴 걸 기준(보수적)
    warmupOffsetByTarget[mapKey] = Math.max(
      warmupOffsetByTarget[mapKey] || 0,
      sec + 10
    );
  }
}
// === 여기서 활성화된 mapKey들의 유저 집합을 계산
if (STRICT_PARAMS) {
  const activeMapKeys = new Set(
    all.map((it) => `${it.controller}.${it.name}`) // 예: "GraphController.list"
  );
  ACTIVE_USER_SET = new Set();
  for (const mapKey of activeMapKeys) {
    const userMap = PARAMS[mapKey];
    if (!userMap || typeof userMap !== "object") continue;
    for (const uid of Object.keys(userMap)) {
      // 배열/const 상관없이 키만 수집
      ACTIVE_USER_SET.add(String(uid));
    }
  }
  // users.csv에서 활성 유저만 필터링 (없으면 전체 유지)
  const temp = [];
  for (const u of USERS) {
    if (ACTIVE_USER_SET.has(String(u.id))) temp.push(u);
  }
  FILTERED_USERS = temp.length ? temp : USERS;
} else {
  FILTERED_USERS = USERS;
}
/** ===== (신규) 그룹별 조합 수/기준 rate 집계 & 분배 =====
 * 그룹 키: controller.name + variant (콤보들은 같은 그룹으로 간주)
 * - 같은 그룹 내 여러 combo가 있으면 per-combo rate로 나눠 총 RPS 유지
 * - baseRate < combos면 perRate=1로 올리므로 총합이 baseRate보다 커질 수 있음(간단 전략)
 *   → 엄밀 분배(총합 동일) 원하면 remainder 분배 방식으로 교체 가능
 */
const groupCounts = {};
const groupBaseRate = {};
for (const ep of all) {
  const g = `${ep.controller}.${ep.name}::${ep.variant || "-"}`;
  groupCounts[g] = (groupCounts[g] || 0) + 1;
  const baseRate = Number(ep._overrides?.rate ?? ep._defaults.rate ?? RATE);
  groupBaseRate[g] = baseRate; // 같은 그룹이면 동일하다고 가정
}

const perRateMap = {};
if (DISTRIBUTE_RATE) {
  for (const ep of all) {
    const g = `${ep.controller}.${ep.name}::${ep.variant || "-"}`;
    const baseRate = Number(groupBaseRate[g] || 0);
    const count = Number(groupCounts[g] || 1);
    // 간단 분배: Math.max(1, floor(base/count))
    // (주의: base<count면 총합이 base보다 커질 수 있음)
    perRateMap[ep.key] = Math.max(1, Math.floor(baseRate / count));
  }
}

/** ===== 시나리오 생성 + per-scenario thresholds 병합 ===== */
const scenarios = {};
const thresholds = {
  http_req_failed: ["rate<0.01"],
  http_req_duration: ["p(95)<800"],
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
  const parts = [baseName];
  if (ep.combo) parts.push(ep.combo);
  if (ep.variant) parts.push(ep.variant);
  const scenarioName = sanitize(parts.join("__"));

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

  // preAllocatedVUs 우선 -> 없으면 vus 사용 -> 마지막으로 글로벌 VUS
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
  const NO_WARMUP = String(__ENV.NO_WARMUP || "0") === "1";
  const mapKey = `${ep.controller}.${ep.name}`;
  const autoStartTime =
    !startTime &&
    !NO_WARMUP &&
    String(ep.variant).toLowerCase() !== "warmup" &&
    warmupOffsetByTarget[mapKey]
      ? `${warmupOffsetByTarget[mapKey]}s`
      : null;
  const env = {
    KEY: ep.key, // 🔴 유니크 매핑 키
    TARGET: `${ep.controller}.${ep.name}`,
    VARIANT: ep.variant || "",
    COMBO: ep.combo || "",
    SCENARIO: scenarioName,
  };

  if (execType === "constant-arrival-rate") {
    scenarios[scenarioName] = {
      executor: "constant-arrival-rate",
      rate,
      timeUnit: "1s",
      duration, // CAR에서는 duration 사용
      preAllocatedVUs: pre,
      maxVUs,
      exec: "dispatch",
      env,
      tags: {
        ...(ep._overrides?.tags || {}),
        controller: ep.controller,
        endpoint: `${ep.controller}.${ep.name}`,
        variant: ep.variant || "",
      },
      ...(startTime || autoStartTime
        ? { startTime: startTime || autoStartTime }
        : {}),
    };
  } else if (execType === "ramping-arrival-rate") {
    // ✅ JSON에 넣은 stages/startRate/timeUnit을 최우선 사용
    const rawStages = ep._overrides?.stages ??
      ep._defaults?.stages ?? [{ target: rate, duration: "1m" }]; // 최후 fallback

    const startRate = Number(
      ep._overrides?.startRate ?? ep._defaults?.startRate ?? 10
    );

    const timeUnit = ep._overrides?.timeUnit ?? ep._defaults?.timeUnit ?? "1s";

    // 스테이지 정보 env로 내려보내기 (내장 보고서용)
    const stageDurS = rawStages.map((s) => toSeconds(s.duration));
    const stageTargets = rawStages.map((s) => Number(s.target));

    scenarios[scenarioName] = {
      executor: "ramping-arrival-rate",
      startRate,
      timeUnit,
      preAllocatedVUs: pre,
      maxVUs,
      stages: rawStages, // 길이는 stages로만 제어 (duration 넣지 말 것)
      exec: "dispatch",
      env: {
        ...env,
        STAGE_DURS: stageDurS.join(","), // "30,30,30,30,30"
        STAGE_TARGETS: stageTargets.join(","), // "40,80,120,160,200"
        START_OFFSET_S: String(startTime ? toSeconds(startTime) : 0),
      },
      tags: {
        ...(ep._overrides?.tags || {}),
        controller: ep.controller,
        endpoint: `${ep.controller}.${ep.name}`,
        variant: ep.variant || "",
      },
      ...(startTime || autoStartTime
        ? { startTime: startTime || autoStartTime }
        : {}),
    };
    // ✅ 여기 추가: 스테이지별 더미 threshold를 자동 주입해 summary에 서브메트릭 노출
    for (let i = 0; i < rawStages.length; i++) {
      // mergeThresholds는 태그가 없는 키에만 {scenario:...}를 붙입니다.
      // 여기서는 태그를 명시하지 않고 넣어도 되고, 명시하고 싶다면 아래처럼:
      const key = `rt_stage{stage:${i},scenario:${scenarioName}}`;
      thresholds[key] = ["p(95)<100000"]; // 아주 느슨한 더미 기준
    }
  } else {
    scenarios[scenarioName] = {
      executor: "constant-vus",
      vus: pre,
      duration, // CV에서는 duration 사용
      exec: "dispatch",
      env,
      ...(startTime || autoStartTime
        ? { startTime: startTime || autoStartTime }
        : {}),
      tags: {
        ...(ep._overrides?.tags || {}),
        controller: ep.controller,
        endpoint: `${ep.controller}.${ep.name}`,
        variant: ep.variant || "",
      },
    };
  }

  // per-variant/endpoint thresholds 적용 (scenario 태그로 scope 좁힘)
  mergeThresholds(thresholds, scenarioName, ep._defaults.thresholds);
  mergeThresholds(thresholds, scenarioName, ep._overrides.thresholds);
}

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ["avg", "min", "max", "p(90)", "p(95)"], // ✅ 추가
};

/** ===== 공통 검증 ===== */
function ok(res) {
  return check(res, { "status is 200": (r) => r.status === 200 });
}

/** ===== 실행 함수(모든 시나리오가 이걸 호출) ===== */
export function dispatch(data) {
  loginPerVUFromCSV();

  const key = __ENV.KEY;
  const ep = allMap[key];
  if (!ep) throw new Error(`No endpoint matched KEY=${key}`);

  // ── 4-1. params.json 오버라이드 조회 (키: "Controller.endpoint")
  const mapKey = `${ep.controller}.${ep.name}`; // e.g. "GraphController.list"
  const userId = String(VU_USER?.id || "");

  const needsTpl =
    hasTemplateBraces(ep.rawPath) || hasTemplateBraces(ep.rawQsTemplate);

  // 템플릿의 첫 변수명 (예: "pageId" 또는 "id")
  const firstVar = extractFirstVar(ep.rawPath, ep.rawQsTemplate);

  // endpoints.json 기본 파라미터(카르테시안)
  const defaultCombos = cartesianParams(ep.rawParams || {});

  const userMap = PARAMS[mapKey] || {};

  // primitive → {firstVar: value} 로 변환(필요 시)
  function toObj(v) {
    if (v == null) return null;
    if (typeof v === "object" && !Array.isArray(v)) return v;
    if (Array.isArray(v)) return null; // 배열은 상위에서 순회
    if (firstVar) return { [firstVar]: String(v) };
    // fallback: endpoints.json에 단일키가 있으면 그 키로 매핑
    const keys = Object.keys(ep.rawParams || {});
    if (keys.length === 1) return { [keys[0]]: String(v) };
    // 최후 수단
    return { id: String(v) };
  }

  // === 후보 풀 만들기 (우선순위: per-user > const > endpoints.json 기본)
  let candidates = null;

  // 1) per-user
  const perUser = userMap[userId];
  if (Array.isArray(perUser) && perUser.length) {
    candidates = perUser.slice(); // [{...}, ...]
  } else if (perUser && typeof perUser === "object") {
    candidates = [perUser];
  } else if (perUser != null) {
    const o = toObj(perUser);
    if (o) candidates = [o];
  }

  // 2) const (모든 유저가 공유)
  if (!candidates) {
    const cst = userMap.const;
    if (Array.isArray(cst) && cst.length) {
      const arr = cst
        .map((v) => (typeof v === "object" ? v : toObj(v)))
        .filter(Boolean);
      if (arr.length) candidates = arr;
    } else if (cst && typeof cst === "object") {
      candidates = [cst];
    } else if (cst != null) {
      const o = toObj(cst);
      if (o) candidates = [o];
    }
  }

  // 3) 폴백: endpoints.json 기본(params) 또는 스킵
  if (!candidates) {
    if (STRICT_PARAMS && needsTpl) {
      console.warn(`[SKIP] no params for user=${userId} on ${mapKey}`);
      return; // 템플릿 치환이 필요한데 값이 없으면 안전하게 스킵
    }
    candidates = defaultCombos.length ? defaultCombos : [{}];
  }

  // 라운드로빈 인덱스 (per-user > const > fallback 그룹 구분)
  const rrScope = userMap[userId]
    ? `user:${userId}`
    : userMap.const
    ? "const"
    : "fallback";
  const idxKey = `${mapKey}::${rrScope}`;
  const cur = VU_PARAM_IDX[idxKey] || 0;
  const chosen = candidates[cur % candidates.length];
  VU_PARAM_IDX[idxKey] = cur + 1;

  // 최종 URL 조립 (항상 원본 템플릿 기준)
  const renderedPath = needsTpl
    ? renderTemplate(ep.rawPath, chosen)
    : ep.rawPath;
  const qs = needsTpl
    ? renderTemplate(ep.rawQsTemplate, chosen)
    : ep.rawQsTemplate || "";
  const path = normalizePath(renderedPath);
  const finalUrl = `${BASE}${ep.base}${path}${qs ? "?" + qs : ""}`;

  console.log(
    `[DBG] ${mapKey} user=${userId} url=${finalUrl} chosen=${JSON.stringify(
      chosen
    )}`
  );

  // ── 이하 그대로
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

  const params = {
    headers: {
      ...(VU_HEADERS || {}),
      ...(ep._defaults.headers || {}),
      ...(ep._overrides?.headers || {}),
    },
    tags: {
      controller: ep.controller,
      endpoint: `${ep.controller}.${ep.name}`,
      combo: __ENV.COMBO || "",
      variant: __ENV.VARIANT || "",
      stage: String(stageIdx),
      // 시나리오(tags)로도 이미 붙지만, 확실히 하기 위해 요청에도 phase 덧붙임
      scenario: __ENV.SCENARIO || "",
      ...(ep._overrides?.tags?.phase
        ? { phase: ep._overrides.tags.phase }
        : {}),
    },
    responseType: DROP_BODIES ? "none" : "text",
  };
  // ✅ 진행 로그(옵션): find-limit 같은 램핑부하에서 스테이지 바뀔 때 1번만 출력
  if (String(__ENV.LOG_PROGRESS || "0") === "1" && __VU === 1) {
    if (stageIdx !== LAST_STAGE_LOGGED) {
      const targets = String(__ENV.STAGE_TARGETS || "")
        .split(",")
        .map((s) => Number(s));
      const targetRps = Number.isFinite(targets[stageIdx])
        ? targets[stageIdx]
        : null;
      const mins = (elapsedS / 60).toFixed(1);
      console.log(
        `[PROGRESS] t=${mins}m stage=${stageIdx}` +
          (targetRps ? ` target≈${targetRps}/s` : "") +
          ` scenario=${__ENV.SCENARIO || "n/a"}`
      );
      LAST_STAGE_LOGGED = stageIdx;
    }
  }

  const bodyToUse = ep._overrides?.body ?? ep.body;
  let res;
  switch (ep.method) {
    case "GET":
      res = http.get(finalUrl, params);
      break;
    case "POST":
      res = http.post(finalUrl, bodyToUse, params);
      break;
    case "PUT":
      res = http.put(finalUrl, bodyToUse, params);
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
    const comboStr = params.tags.combo || "";
    const variantStr = params.tags.variant ? ` / ${params.tags.variant}` : "";

    // ✅ URL과 메서드 정보 추가
    const meta = [
      `${ep.method} ${finalUrl}`,
      `status=${res.status}`,
      e.path ? `path=${e.path}` : null,
      e.ts ? `ts=${e.ts}` : null,
      e.trace ? `reqId=${e.trace}` : null,
    ]
      .filter(Boolean)
      .join(" | ");

    // ✅ 에러 메시지가 없을 경우 응답 본문 일부 표시
    const errorMsg =
      e.msg || `(no error message, body: ${short(res.body, 200)})`;

    console.error(
      `[FAIL] ${params.tags.endpoint}${
        comboStr || variantStr ? ` [${comboStr}${variantStr}]` : ""
      }\n${meta}\n→ ${errorMsg}`
    );
  }
  /** ===== 에러 메시지/메타 추출 ===== */
  function short(s, n = 400) {
    if (!s) return "";
    const str = String(s);
    return str.length > n ? str.slice(0, n) + "…" : str;
  }
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

/** ===== 유틸 ===== */
function sanitize(s) {
  // k6 시나리오 이름 허용 문자만 남기기 (숫자/영문/언더스코어/대시)
  return s.replace(/[^A-Za-z0-9_-]/g, "_");
}
