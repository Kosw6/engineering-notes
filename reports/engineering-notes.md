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
#### PoC 2 — Fallback
- 장애 시 다른 인스턴스로 라우팅
- Redis 기반 편집 상태 유지 및 충돌 제어

[문서 링크 바로가기](./GroupController/poc2-fallback-state-sync-conflict-resolution.md)

#### PoC 3 — Failback
- Kafka Replay 기반 이벤트 복구
- catch-up → broadcast 전환 구조
- 이벤트 유실 없이 복구되는 흐름 검증

[문서 링크 바로가기](./GroupController/poc3-failback-kafka-replay-recovery.md.md)

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