# Engineering Notes

측정 기반으로 병목을 분석하고, 수치로 개선 여부를 검증한 백엔드 엔지니어링 기록입니다.

Spring Boot, JPA, PostgreSQL/TimescaleDB, Redis, Kafka, WebSocket 환경에서의  
성능 최적화, 실시간 처리, 관측, 장애 복구 설계를 다룹니다.

이 저장소는 단순한 구현 결과가 아니라,

- 병목이 발생한 지점
- 이를 어떻게 측정했는지
- 어떤 실험을 했는지
- 어떤 선택을 했고, 왜 버렸는지
- 그 결과 수치가 어떻게 달라졌는지

를 기록한 엔지니어링 노트입니다.

즉,  
**분석 → 실험 → 검증 → 의사결정**  
전체 흐름을 담는 것을 목표로 합니다.

---

## Highlights

- **TimescaleDB 튜닝**
  - P95 7,247ms → 235ms (약 28× 개선)

- **WebSocket 전송 구조 개선**
  - 수신 성공률 0.38% → 99.97% (≤200ms 기준)

- **JFR/JMC 기반 Hot Path 분석**
  - JWT 중복 검증 제거
  - Fetch 구조 PoC → GC 증가 및 P95 악화로 미채택

- **WebSocket 확장 PoC**
  - Sharding → Fallback → Failback(Kafka Replay) 설계 및 검증

- **관측 및 복구 자동화**
  - Prometheus / Grafana / Loki 기반 관측
  - Alert → Lambda / SSM / ASG 기반 복구 흐름 검증

- **Trader Data Platform**
  - KIS, BLS, SEC 원본 보존 → Kafka Outbox → Python ETL → Lineage 추적
  - Kafka lag와 Worker 상태를 기준으로 AWS ASG **0 → 1 → 0** 자동 조절 검증

---

## Engineering Tracks

이 저장소의 문서는 크게 네 가지 관점으로 나눌 수 있습니다.

---

### 1. Backend Performance Track

API 성능 병목을 측정하고, DB/JPA/JVM/OS 레벨에서 원인을 분석한 기록입니다.

이 트랙에서는 다음 질문을 다룹니다.

- 왜 특정 API의 P95가 높아졌는가?
- DB 인덱스, TimescaleDB hypertable, chunk 설정은 어떤 영향을 주는가?
- JPA Fetch 전략 변경은 항상 성능 개선으로 이어지는가?
- GC, allocation, context switching은 응답 지연에 어떤 영향을 주는가?
- SLO 기준으로 어느 정도의 서버 사양이 적절한가?

#### Main Notes

- [TimescaleDB 기반 시계열 조회 성능 개선](./reports/StockController/stock_range_k6_report.md)
- [JPA Fetch 전략별 조회 성능 테스트](./reports/NodeController/JPA%20Fetch%20전략별%20조회%20성능%20테스트%20(NodeController).md)
- [JFR/JMC를 활용한 Allocation 기반 성능 병목 분석](./reports/NodeController/JFR/JMC를%20활용한%20Allocation%20기반%20성능%20병목%20분석.md)
- [쓰레드와 커넥션 풀 설정에 따른 컨텍스트 스위칭 분석](./reports/쓰레드와%20커넥션%20풀%20설정에%20따른%20컨텍스트%20스위칭%20분석.md)
- [SLO 기반 운영 사양 산정 실험](./reports/SLO%20기반%20운영%20사양%20산정%20실험.md)

---

### 2. Realtime & Distributed System Track

WebSocket 기반 실시간 협업 구조에서 fanout, sharding, fallback, failback, replay를 검증한 기록입니다.

이 트랙에서는 다음 질문을 다룹니다.

- 단일 인스턴스 WebSocket 구조에서 어떤 동시성 문제가 발생하는가?
- groupId 기반 sharding으로 fanout 부하를 어떻게 분산할 수 있는가?
- 특정 인스턴스 장애 시 세션과 라우팅은 어떻게 복구되는가?
- Redis Pub/Sub 장애 시 실시간 UX를 어떻게 유지할 수 있는가?
- Kafka replay는 failback 과정에서 어떤 역할을 하는가?

#### Main Notes

- [WebSocket 전송 구조 개선](./reports/GroupController/WebSocket.md)
- [PoC 1 - WebSocket Sharding Load Distribution](./reports/GroupController/poc1-websocket-sharding-load-distribution.md)
- [PoC 2 - Fallback State Sync & Conflict Resolution](./reports/GroupController/poc2-fallback-state-sync-conflict-resolution.md)
- [PoC 3 - Kafka Replay 기반 Failback Recovery](./reports/GroupController/poc3-failback-kafka-replay-recovery.md.md)
- [Redis Pub/Sub 장애 대응](./reports/pubsub-degrade.md)
- [Kafka 필요성 검증](./reports/kafka-necessity.md)
- [Kafka UX Trade-off](./reports/kafka-ux-tradeoff.md)

---

### 3. Reliability, Observability & Recovery Track

장애 상황을 가정하고, 관측 지표와 복구 경로를 설계/검증한 기록입니다.

이 트랙에서는 다음 질문을 다룹니다.

- 장애를 어떻게 감지할 것인가?
- 장애 발생 시 즉시 실패시킬 것인가, degraded mode로 UX를 유지할 것인가?
- Redis/Kafka/DB 장애 시 각각 어떤 fallback 경로가 필요한가?
- Alert 이후 복구는 수동으로 할 것인가, 자동화할 것인가?
- Scale-out 이후 신규 인스턴스는 정상적으로 합류하는가?

#### Main Notes

- [관측 체계 도입](./reports/관측%20체계%20도입.md)
- [시스템 장애 대응 및 복구 전략](./reports/시스템%20장애%20대응%20및%20복구%20전략.md)
- [Degraded Mode Overview](./reports/degrade-overview.md)
- [Kafka 장애 대응](./reports/kafka-degrade.md)
- [Redis 장애 대응](./reports/redis-degrade.md)
- [Redis Pub/Sub 장애 대응](./reports/pubsub-degrade.md)
- [Auto Recovery & Scale-out Verification](./reports/auto-recovery-scaleout-verification.md)
- [EC2 비용 증가 분석 및 마이그레이션](./reports/ec2-cost-migration.md)

---

### 4. Data Pipeline & Control Plane Track

KIS 주가, BLS 거시경제, SEC 재무 데이터를 수집하고, 원본 보존부터 정규화와 운영 제어까지 연결한 기록입니다.

이 트랙에서는 다음 질문을 다룹니다.

- 외부 API 수집이 실패하거나 Worker가 중단되면 어디부터 다시 처리하는가?
- raw 원본과 정규화된 도메인 레코드를 어떻게 연결하고 추적하는가?
- DB commit과 Kafka offset commit 사이의 불일치를 어떻게 방어하는가?
- 중복 전달된 이벤트를 어떻게 식별하고 안전하게 재처리하는가?
- 처리할 작업이 있을 때만 Worker를 실행하고, 유휴 상태에서는 어떻게 회수하는가?

핵심 구조는 다음과 같습니다.

```text
Admin
→ Go Controller
→ DB Outbox
→ Kafka
→ Python Collector / ETL Worker
→ Raw Storage
→ Normalized Tables
→ Lineage / Processed Event
```

Go Controller는 job, outbox, Kafka lag, Worker heartbeat와 scale command를 관리합니다. Python Worker는 수집과 ETL을 담당하며, raw 원본과 정규화 결과는 `source_object`, `record_lineage`, `processed_event`로 연결합니다.

AWS에서는 `trader.jobs.events` lag가 1이 되자 Python Worker ASG가 **0 → 1**로 확장되고, 작업 완료 후 전체 lag 0과 idle 120초를 확인해 **1 → 0**으로 축소되는 흐름을 검증했습니다.

#### Main Notes

- [Trader Data Platform 문서 인덱스](./reports/Data/00_TRADER_DATA_PLATFORM_INDEX.md)
- [데이터 파이프라인 아키텍처](./reports/Data/01_DATA_PIPELINE_ARCHITECTURE.md)
- [장애 복구 및 재처리 시나리오](./reports/Data/02_FAILURE_RECOVERY_SCENARIOS.md)
- [AWS 배포와 비용 최적화](./reports/Data/03_AWS_DEPLOYMENT_COST_OPTIMIZATION.md)
- [AWS Worker ASG 자동 확장 검증](./reports/Data/04_AWS_WORKER_ASG_AUTO_SCALING_VALIDATION.md)

---

## Recommended Reading Path

지원 직무나 관심사에 따라 아래 순서로 읽을 수 있습니다.

### General Backend

1. [TimescaleDB 기반 시계열 조회 성능 개선](./reports/StockController/stock_range_k6_report.md)
2. [JPA Fetch 전략별 조회 성능 테스트](./reports/NodeController/JPA%20Fetch%20전략별%20조회%20성능%20테스트%20(NodeController).md)
3. [JFR/JMC를 활용한 Allocation 기반 성능 병목 분석](./reports/NodeController/JFR/JMC를%20활용한%20Allocation%20기반%20성능%20병목%20분석.md)
4. [SLO 기반 운영 사양 산정 실험](./reports/SLO%20기반%20운영%20사양%20산정%20실험.md)
5. [관측 체계 도입](./reports/관측%20체계%20도입.md)

### Platform / SRE / Server Infrastructure

1. [관측 체계 도입](./reports/관측%20체계%20도입.md)
2. [시스템 장애 대응 및 복구 전략](./reports/시스템%20장애%20대응%20및%20복구%20전략.md)
3. [Degraded Mode Overview](./reports/degrade-overview.md)
4. [Auto Recovery & Scale-out Verification](./reports/auto-recovery-scaleout-verification.md)
5. [SLO 기반 운영 사양 산정 실험](./reports/SLO%20기반%20운영%20사양%20산정%20실험.md)

### Realtime / Distributed Backend

1. [WebSocket 전송 구조 개선](./reports/GroupController/WebSocket.md)
2. [PoC 1 - WebSocket Sharding Load Distribution](./reports/GroupController/poc1-websocket-sharding-load-distribution.md)
3. [PoC 2 - Fallback State Sync & Conflict Resolution](./reports/GroupController/poc2-fallback-state-sync-conflict-resolution.md)
4. [PoC 3 - Kafka Replay 기반 Failback Recovery](./reports/GroupController/poc3-failback-kafka-replay-recovery.md.md)
5. [Redis Pub/Sub 장애 대응](./reports/pubsub-degrade.md)
6. [Kafka 장애 대응](./reports/kafka-degrade.md)

### Data Platform / Pipeline

1. [Trader Data Platform 문서 인덱스](./reports/Data/00_TRADER_DATA_PLATFORM_INDEX.md)
2. [데이터 파이프라인 아키텍처](./reports/Data/01_DATA_PIPELINE_ARCHITECTURE.md)
3. [장애 복구 및 재처리 시나리오](./reports/Data/02_FAILURE_RECOVERY_SCENARIOS.md)
4. [AWS 배포와 비용 최적화](./reports/Data/03_AWS_DEPLOYMENT_COST_OPTIMIZATION.md)
5. [AWS Worker ASG 자동 확장 검증](./reports/Data/04_AWS_WORKER_ASG_AUTO_SCALING_VALIDATION.md)

---

## Key Approach

### Measure First

추측이 아닌 실측 기반으로 병목을 확인합니다.

- k6 기반 부하 테스트
- JFR/JMC 기반 allocation 분석
- Prometheus/Grafana 기반 지표 수집
- p95, RPS, GC, context switching, error rate 기반 판단

### Compare Before / After

개선 전후를 수치로 비교합니다.

- P95 latency
- Average latency
- RPS
- GC count/time
- CPU / memory
- context switching
- delivery success rate
- replay / recovery result

### Record Trade-offs

최종적으로 채택하지 않은 실험도 기록합니다.

예를 들어 Fetch 구조 변경 PoC는 쿼리 수를 줄이는 효과가 있었지만,  
응답 payload 증가와 GC 증가로 인해 최종적으로 미채택했습니다.

### Design for Failure

정상 상황뿐 아니라 장애 상황을 기준으로 구조를 검증합니다.

- Redis 장애
- Kafka 장애
- Redis Pub/Sub 장애
- App instance down
- Scale-out 이후 신규 인스턴스 합류
- Degraded mode
- Replay 기반 복구

---

## Tech Stack

- Backend: Spring Boot, JPA, Hibernate
- Database: PostgreSQL, TimescaleDB
- Messaging: Redis, Kafka
- Realtime: WebSocket
- Data Pipeline: Go Controller, Python Collector/ETL, DB Outbox, Lineage
- Infra: Docker, AWS, GitHub Actions
- Observability: k6, Prometheus, Grafana, Loki, JFR, JMC
- Recovery Automation: Grafana Alert, Lambda, SSM, Auto Scaling Group
- Worker Orchestration: Kafka lag, heartbeat, AWS ASG

---

## Design Principles

### 1. Measure First

추측이 아니라 측정으로 병목을 확인합니다.

### 2. Validate with Metrics

모든 개선은 P95, GC, RPS, error rate 등 수치로 검증합니다.

### 3. Trade-off Awareness

성능 개선뿐 아니라 GC 증가, 운영 복잡도, 장애 대응 한계까지 함께 고려합니다.

### 4. Failure-Oriented Design

확장뿐 아니라 장애 상황과 복구 흐름까지 설계합니다.

### 5. SLO-Based Decision Making

가장 빠른 구성이 아니라, 목표 SLO를 만족하면서 비용과 복잡도를 줄이는 구성을 찾습니다.

---

## Why This Matters

이 레포지토리는 단순히 “빠르게 만드는 것”이 아니라,

- 왜 느린지 이해하고
- 어떤 선택이 실제로 효과가 있는지 검증하고
- 장애 상황에서도 사용자 경험을 어디까지 유지할 수 있는지 확인하고
- 운영 비용과 복잡도를 고려해 현실적인 구조를 선택하는

과정을 담고 있습니다.

일부 실험은 최종적으로 미채택되었습니다.

이는 결과를 포장하기보다,  
실제 엔지니어링 의사결정 과정을 그대로 남기기 위함입니다.

---

## Portfolio

- Portfolio: https://kosw6.github.io/
- Detailed Notes: [Engineering Notes](./reports/engineering-notes.md)
