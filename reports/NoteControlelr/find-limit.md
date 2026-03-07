# Find-Limit 리포트 — 2025-10-08 (Asia/Seoul)

## 1) 목적/범위

- 목적: 각 엔드포인트의 **안정 한계 rps**(무릎점) 파악 및 이후 **heavy 고정 부하 기준** 확정
- 방식: `ramping-arrival-rate`(RAR)로 40→80→120→160→200 rps, **각 30s**
- 임계치(탐색용, 완화):
  - `http_req_failed < 5%`
  - `http_req_duration p(95) < 3000ms` (엔드포인트별 상향/하향 가능)

## 2) 환경

- 대상 서비스: `<서비스/모듈명>`
- 빌드/커밋: `<tag/SHA>`
- 인스턴스 스펙: `<vCPU/RAM/개수/Region>`
  - d
  - 16GB
  - 단일
  - seoul
- 서버 설정(테스트 시점):
  - Tomcat `maxThreads = <값>`
  - HikariCP
    - `maximum-pool-size = 120`
    - `minimum-idle = 20`
    - `connection-timeout = 2000ms` _(부하 구간에선 3000~5000ms도 검토)_
    - `max-lifetime = 1800000ms (30m)`
    - `idle-timeout = 30000ms` _(지속 트래픽이면 120000~300000ms 권장)_
- k6: `v<버전>` / 실행 호스트: `<로컬/CI>`
- 스크립트: `k6/scripts/api.js` / 설정: `k6/data/endpoints.json`

## 3) k6 실행 (재현 커맨드)

```bash
# TickerController.list (find-limit)
k6 run -e BASE_URL=http://localhost:8080        -e CONTROLLERS=TickerController        -e ENDPOINTS=list        -e VARIANTS=find-limit        scripts/api.js

# PageController.list (find-limit)
k6 run -e BASE_URL=http://localhost:8080        -e CONTROLLERS=PageController        -e ENDPOINTS=list        -e VARIANTS=find-limit        scripts/api.js
```

## 4) 결과 (핵심 지표)

### 4.1 TickerController.list (q=TS, 스테이지 30s)

**Summary**

- avg: **~1.29s**
- p95: **~3.75s**
- throughput: **~76.8 rps**
- fail: **~1.57%**

**per-stage p95 (ms)**

- 40 rps: **~90**
- 80 rps: **~115**
- 120 rps: **~1188 ~ 2867** ⬅️ **무릎점 시작**
- 160 rps: **~3527 ~ 4258**
- 200 rps: **~4118 ~ 4500**

**관찰**

- 120 rps부터 큐잉이 급증, 160~200 rps 구간은 포화
- 목표 rps 미달(평균 70~90대), 일부 실패 발생

**판단**

- 안정 한계(capacity): **~100–120 rps**
- heavy 기준:
  - **비교용(튜닝 전/후)**: **200 rps**(의도적으로 포화 재현)
  - **지속 가능 기준선**: **120–150 rps**(안정성 지표 확인용)

---

### 4.2 PageController.list (id mix, 스테이지 30s)

**Summary**

- avg: **~57 ms**
- p95: **~198 ms**
- throughput: **~101.9 rps**
- fail: **0%**

**per-stage p95 (ms)**

- 40 rps: **~204**
- 80 rps: **~210**
- 120 rps: **~181**
- 160 rps: **~174**
- 200 rps: **~196**

**관찰**

- 전 스테이지 **안정(170–210ms)**, 실패/드랍 없음

**판단**

- 안정 한계(capacity): **≥ 200 rps**
- heavy 기준: **200 rps**로 확정(필요시 250–300 rps 추가 검증)

## 5) 결정 및 후속 액션

- **Heavy(고정 부하) 재현**
  - Ticker: **200 rps, 5m**, `preAllocatedVUs ≈ rps × p95(s) × 1.2`
    - 예) p95 4.0s 가정 → 200×4.0×1.2 ≈ **960**(최대치 진단용),
      안정 비교는 **120–150 rps**에서 별도 수행
  - Page: **200 rps, 5m** (여유 확인되면 250→300 시도)
- **서버 튜닝 포인트**
  - Tomcat `maxThreads ≈ rps × p95(s) × 1.2` (Ticker 기준 300±로 시작)
  - HikariCP `maximum-pool-size` 120–150(요청 DB 사용비율 고려)
  - 느린 쿼리/인덱스/캐시·외부HTTP 풀/타임아웃 점검
- **재측정**
  - 튜닝 전/후 **동일 heavy 조건**으로 p95/실패율/드랍/VU 사용률 비교
  - 리포트에 전/후 수치 병기

## 6) 아티팩트

- k6 원본 요약: `outputs/summary.json`
- 실행 로그: `<경로/링크>`
- 설정 스냅샷: `application.yml`, `endpoints.json`, `api.js`

---

## 📌 부록: thresholds 제안

- 탐색(find-limit):
  - `http_req_failed: ["rate<0.05"]`
  - `http_req_duration: ["p(95)<3000"]`
- 비교(heavy, 목표 품질):
  - `http_req_failed: ["rate<0.01"]`
  - `http_req_duration: ["p(95)<300"]` (엔드포인트 특성에 맞춰 조정)

---

## 👀 .md 보기 (VS Code/Visual Studio)

- **VS Code**: `Ctrl+Shift+V` (미리보기), `Ctrl+K` → `V` (편집/미리보기 나란히)
- **Visual Studio 2019/2022**: 솔루션 탐색기 → `.md` 우클릭 **Open With…** → _Markdown Editor_ (없으면 확장 설치)
