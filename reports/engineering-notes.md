---

## Repository Goal

이 저장소는 단순한 구현 결과가 아니라,  
다음 과정을 기록하기 위해 작성되었습니다.

- 병목이 발생한 지점
- 이를 어떻게 측정했는지
- 어떤 실험을 했는지
- 어떤 선택을 했고, 왜 버렸는지
- 그 결과 수치가 어떻게 달라졌는지

즉,  
**분석 → 실험 → 검증 → 의사결정**  
전체 흐름을 담은 엔지니어링 노트입니다.

---

## Topics Covered

### 1. Database Performance (PostgreSQL / TimescaleDB)
- 시계열 데이터 조회 병목 분석
- 인덱스, 하이퍼테이블, 청크 튜닝 단계별 적용
- P95 기준 성능 개선 검증

[문서 링크 바로가기](./StockController/stock_range_k6_report.md)

### 2. JPA / Fetch Strategy
- Lazy / Fetch Join / Projection / 2-step 비교
- 응답 payload와 GC 영향까지 포함한 분석
- Fetch 구조 변경 PoC → GC 증가 및 성능 악화로 미채택

[문서 링크 바로가기](./NodeController/JPA%20Fetch%20전략별%20조회%20성능%20테스트%20(NodeController).md)

### 3. Profiling (JFR / JMC)
- GC 및 CPU hot path 분석
- Stack Trace 기반 병목 원인 식별
- 구조 변경과 GC 발생 패턴의 관계 분석

[문서 링크 바로가기](./NodeController/JFR/JMC를%20활용한%20Allocation%20기반%20성능%20병목%20분석.md)
### 4. Real-time System (WebSocket)
- 동시성 이슈(TEXT_PARTIAL_WRITING) 분석
- Dirty Flag 기반 최신값 전송 구조 설계
- E2E 지연 기준 성능 검증

[문서 링크 바로가기](./GroupController/WebSocket.md)
### 5. Distributed Architecture PoC

#### PoC 1 — Sharding
- groupId 기반 샤딩
- fanout 부하 분산 확인

[문서 링크 바로가기](./GroupController/poc1-websocket-sharding-load-distribution.md)
#### PoC 2 — Failover & Fallback
- 장애 시 다른 인스턴스로 라우팅
- Redis 기반 편집 상태 유지 및 충돌 제어

[문서 링크 바로가기](./GroupController/poc2-fallback-state-sync-conflict-resolution.md)

#### PoC 3 — Failback
- Kafka Replay 기반 이벤트 복구
- catch-up → broadcast 전환 구조
- 이벤트 유실 없이 복구되는 흐름 검증

[문서 링크 바로가기](./GroupController/poc3-failback-kafka-replay-recovery.md.md)

### 6. Performance Engineering (Thread / Connection / OS)

- Thread 수와 Context Switching 관계 분석
- HikariCP pool size와 scheduling overhead 영향 검증
- nvcswch / cswch 기반 latency 상승 원인 분석
- 최적 Thread / Hikari 설정 도출

[문서 링크 바로가기](./쓰레드와%20커넥션%20풀%20설정에%20따른%20컨텍스트%20스위칭%20분석.md)

### 7. Infrastructure Optimization & SLO

- AWS 환경에서 SLO(p95 ≤ 300ms) 기준 성능 검증
- App-DB 분리 효과 분석
- 다운사이징 실험 (4/16 → 2/8 → 2/4)
- 비용 대비 최적 운영 사양 도출

[문서 링크 바로가기](./SLO%20기반%20운영%20사양%20산정%20실험.md)

### 8. Failure Handling & Recovery Design

- Redis / Kafka / DB 장애 시 대응 전략
- Degraded Mode 설계 및 동작 정의
- Replay 기반 정합성 복구 구조
- Failover / Fallback / Failback 분리 설계

[문서 링크 바로가기](./시스템%20장애%20대응%20및%20복구%20전략.md)

---

## Tech Stack

- Backend: Spring Boot, JPA, Hibernate
- Database: PostgreSQL, TimescaleDB
- Messaging: Redis, Kafka
- Infra: Docker, AWS, GitHub Actions
- Observability: k6, Prometheus, Grafana, JFR, JMC

---

## Design Principles

### Measure First
추측이 아닌 실측 기반으로 병목을 확인합니다.

### Validate with Metrics
모든 개선은 수치(P95, GC, RPS 등)로 검증합니다.

### Trade-off Awareness
성능 개선뿐 아니라 부작용(GC 증가 등)까지 고려합니다.

### Failure-Oriented Design
확장뿐 아니라 장애 상황과 복구 흐름까지 설계합니다.

---

## Why This Matters

이 레포지토리는 단순히 “빠르게 만드는 것”이 아니라,

- 왜 느린지 이해하고
- 어떤 선택이 실제로 효과가 있는지 검증하고
- 운영 환경에서도 유지 가능한 구조를 선택하는

과정을 담고 있습니다.

---

## Related Links

- Portfolio: https://kosw6.github.io/
- Reports: 포트폴리오 Engineering Reports 섹션
- Projects: 포트폴리오 Projects 섹션

---

## Notes

일부 실험은 최종적으로 미채택되었습니다.

이는 결과를 포장하기보다,  
실제 엔지니어링 의사결정 과정을 그대로 남기기 위함입니다.

본 레포지토리는 단순히 “성능을 개선한 결과”가 아니라,

- 어떤 가설을 세웠고
- 어떤 방식으로 측정하고 검증했으며
- 어떤 선택을 했고, 왜 버렸는지
- 그리고 그 선택이 시스템 전체(성능, 비용, 안정성)에 어떤 영향을 주었는지

를 기록하는 것을 목표로 합니다.

또한,

- Thread / Connection / GC와 같은 런타임 레벨의 튜닝
- 인프라 다운사이징 및 SLO 기반 운영 사양 도출
- 장애 상황에서의 Degraded Mode 및 복구 전략

까지 포함하여,

**단일 기술 최적화가 아닌, 시스템 전체 관점에서의 균형점 탐색 과정**을 담고 있습니다.

따라서 일부 결과는 "더 빠른 방법"이 존재하더라도  
GC 증가, context switching 비용, 운영 복잡도, 장애 대응 한계 등의 이유로  
최종적으로 채택되지 않았습니다.

이러한 선택 과정 역시 실제 운영 환경에서는 중요한 의사결정 요소라고 판단했습니다.