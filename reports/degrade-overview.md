# 실시간 협업 시스템 장애 대응 및 Degraded Mode 검증

> **검증 기간**: 2026-05-06 ~ 2026-05-08  
> **환경**: EC2 멀티 인스턴스 (app × 2, PostgreSQL, Kafka, Redis), k6 부하 테스트

---


## Summary

### 목표
- 장애를 5xx가 아닌 성능 저하 수준으로 제한
- 실시간 협업 UX 유지
- 이벤트 유실 방지
- 자동 복구 및 failback 검증

### 핵심 전략 요약

| 장애 | 클라이언트 영향 | fallback | 복구 방식 |
|------|--------------|---------|---------|
| Kafka 완전 다운 | **없음** (Redis 경로 독립) | Outbox DB 저장 | 복구 후 스케줄러 자동 replay → SENT |
| Redis Pub/Sub 다운 | 커서 이벤트 일시 단절 | gRPC relay | Redis 복구 후 자동 복귀 |
| Redis 상태 저장소 다운 | **없음** (DB fallback 투명) | DB UNIQUE / upsert / history | markUp() 즉시 Redis 경로 복귀 |
| Redis 응답 지연 (500ms) | **없음** | timeout(100ms) 기준 DB fallback | latency 제거 후 약 5s 이내 복귀 |

---

## 목차

1. [문제 정의](#1-문제-정의)
2. [전체 장애 대응 아키텍처](#2-전체-장애-대응-아키텍처)
3. [Kafka 장애 대응 — Outbox Pattern](#3-kafka-장애-대응--outbox-pattern)
4. [Redis Pub/Sub 장애 대응 — gRPC Fallback](#4-redis-pubsub-장애-대응--grpc-fallback)
5. [Redis 상태 저장소 장애 대응 — DB Fallback](#5-redis-상태-저장소-장애-대응--db-fallback)
6. [사용자 경험 관점 영향](#6-사용자-경험-관점-영향)
7. [운영 관점 Trade-off](#7-운영-관점-trade-off)
8. [남은 한계와 개선 계획](#8-남은-한계와-개선-계획)
9. [결론](#9-결론)

---

## 1. 문제 정의

분산 환경에서 실시간 캔버스 협업 시스템은 **세 가지 인프라 컴포넌트**에 의존한다.

| 컴포넌트 | 역할 |
|---------|------|
| Redis Pub/Sub | Volatile 이벤트(커서·협업) 인스턴스 간 전파 |
| Kafka | Reliable 이벤트(편집 로그) durable 저장 및 replay |
| Redis Cache/Lock/Session | 노드 락, auto-save draft, 버전 충돌 감지 |

이 중 **어느 하나가 장애**가 나면 편집 흐름이 중단되거나 데이터가 유실될 수 있다.

목표는 단순 failover가 아니라 **장애 범위 제한 + 자동 복구**다.

- 5xx 없이 편집 지속
- 이벤트 유실 방지
- 복구 시 자동 catch-up
- MTTR 최소화

---

## 2. 전체 장애 대응 아키텍처

```
PATCH /api/.../nodes/{id}
        │
        ├── [Volatile] 커서·협업 이벤트
        │       ├── 기본: Redis Pub/Sub → 전체 인스턴스 fanout
        │       └── Redis 장애: gRPC relay fallback (직접 peer 전송)
        │
        ├── [Reliable] 편집 이벤트 (EDIT_START / EDIT_END / NODE_UPDATED)
        │       ├── 경로 A: Redis Pub/Sub → 즉시 WebSocket 전파 (항상 동작)
        │       └── 경로 B: Kafka → durable log
        │               └── Kafka 장애: Outbox DB 저장 → 복구 후 replay
        │
        └── [상태 저장소] 락·세션·충돌 감지
                ├── 기본: Redis (락 Lua script / TTL key / MGET hint)
                └── Redis 장애: DB fallback
                        ├── canvas_lock (UNIQUE 제약)
                        └── edit_session / node_history
```

핵심 설계 원칙: **hot path(클라이언트 응답)와 durable path(이벤트 로그/상태)를 분리**한다.  
어느 인프라가 내려가도 클라이언트 편집 흐름은 유지되고, 복구 범위만 제한된다.

---

## 3. Kafka 장애 대응 — Outbox Pattern

> 상세 문서: [kafka-degrade.md](./kafka-degrade.md)

**전략**: Kafka는 hot path에서 분리한다. Redis Pub/Sub(경로 A)이 항상 WebSocket 전파를 담당하고,  
Kafka(경로 B)는 durable log 계층으로만 사용한다. Kafka 장애 시 outbox에 이벤트를 저장하고,  
복구 후 스케줄러가 자동 replay한다.

**핵심 수치 (실측)**

| 항목 | 값 |
|------|----|
| Kafka 장애 중 Edit flow error rate | **0** |
| Kafka 장애 시간 | 약 5분 38초 |
| 복구 감지 정밀도 | 544ms |
| 드레인 완료 (370건) | 복구 후 약 25s |
| 이벤트 유실 | **0건** |
| 최종 상태 | 전량 SENT (PENDING=0, FAILED=0) |

**발견한 문제**
- `@Lob` + PostgreSQL OID → 트랜잭션 밖 접근 불가 → `columnDefinition = "TEXT"` 로 수정
- Circuit Breaker 영구 잠김 → 헬스체크 스케줄러에서 외부 `markUp()` 호출로 해제
- Kafka Consumer Redis 타임아웃 미처리 → try-catch + `isDuplicate=false` 반환으로 listener 보호

---

## 4. Redis Pub/Sub 장애 대응 — gRPC Fallback

> 상세 문서: [pubsub-degrade.md](./pubsub-degrade.md)

**전략**: Redis Pub/Sub을 기본 Volatile relay 경로로 유지한다 (broker 기반 fanout, O(1) 확장).  
Redis 장애 시 gRPC relay로 degrade한다. HTTP relay는 비교 검증 및 최후 fallback 후보로 유지.

**경로별 비교 (~500 ops/s, 2노드)**

| 경로 | p95 latency | drop rate | 노드 확장 복잡도 | 브로커 의존 |
|------|------------|----------|----------------|-----------|
| gRPC | **14.5 ms** | ~0 | O(N²) mesh | 없음 |
| Redis Pub/Sub | 22.7 ms | ~0 | **O(1)** | 있음 |
| HTTP | 59.2 ms | 간헐적 | O(N) | 없음 |

**선택 근거**: 2노드 환경에서는 gRPC p95가 가장 낮다. 노드 확장 시 Redis의 fanout 단순성이 운영 우위를 가지므로, Redis를 기본으로 하고 장애 시만 gRPC로 degrade한다.

**주의**: `REALTIME_GRPC_ENABLED=true` 없이 gRPC 모드 설정 시 silently dropped.

---

## 5. Redis 상태 저장소 장애 대응 — DB Fallback

> 상세 문서: [redis-degrade.md](./redis-degrade.md)

**전략**: Redis를 1차 고속 경로로 두되, 각 도메인별로 독립적인 DB fallback 경로를 구성한다.  
`RedisHealthState`가 3회 연속 실패 시 `available=false`로 전환하고, 복구 시 `markUp()`으로 즉시 복귀.

**도메인별 fallback**

| 도메인 | Redis 경로 | DB fallback | 성능 차이 |
|--------|----------|------------|---------|
| 노드 락 | Lua ACQUIRE script | `canvas_lock` UNIQUE 제약 | — |
| Auto-save | TTL key upsert | `edit_session` table upsert | 977μs → 5.58ms (+5.7배) |
| Version Hint | MGET 배치 조회 | `node_history` SELECT | 3.60ms vs 5.27ms |

**최적화 발견**: 장애 검증 과정에서 Redis 정상 경로의 비효율 발견 — N회 순차 GET → 단일 MGET으로 변경 후 p95 44% 감소 (9ms → 5ms).

**Toxiproxy 지연 주입 검증**: 500ms latency 주입 → 100ms timeout 기준 fallback 전환, 지연 제거 후 약 5s 이내 복귀. 전환 전후 API 5xx = 0.

---

## 6. 사용자 경험 관점 영향

| 장애 | 사용자가 느끼는 변화 |
|------|-----------------|
| Kafka 다운 | 없음 — 편집, 커서, 실시간 반응 모두 정상 |
| Redis Pub/Sub 다운 | 커서 이동이 잠시 느려질 수 있음 (gRPC fallback 전환 시) |
| Redis 상태 저장소 다운 | 없음 — 락, autosave, 충돌 감지 모두 투명하게 DB fallback |
| Redis 응답 지연 | 없음 — autosave latency 약 5ms 상승, SLO 범위 내 |

핵심: **장애는 성능 저하로 제한되고, 5xx나 편집 중단으로 확산되지 않는다.**

---

## 7. 운영 관점 Trade-off

| 항목 | 선택 | 이유 |
|------|------|------|
| Kafka를 hot path에서 분리 | Redis 즉시 전파 + Kafka durable log | Kafka 지연이 UX 전체로 전파되는 것을 방지 |
| Outbox 저장 방식 | DB synchronous write | Kafka보다 느리지만(1~2ms → 5ms+) durability 우선 |
| gRPC vs HTTP fallback | gRPC 선택 | p95 14.5ms vs 59.2ms, drop rate 차이 |
| Redis timeout 100ms | timeout 기준 fallback 전환 | 완전 다운 외 지연 장애도 대응 |
| DB UNIQUE 제약으로 멀티 인스턴스 락 | 별도 분산 락 없이 DB 보장 | Redis 없이도 경합 보장, 구현 단순 |

---

## 8. 남은 한계와 개선 계획

| 항목 | 현재 상태 | 영향 | 개선 방향 |
|------|---------|------|---------|
| Auto-save fallback 시 `baseVersion` 복구 불가 | DB upsert 시 `baseVersion=0` 초기화 | draft 내용은 보존, 충돌 기준점 손실 | EDIT_START 세션 DB 저장 추가 |
| Event Dedup Redis 의존 | Redis 장애 시 비활성화 | 중복 이벤트 처리 가능 | DB 기반 처리 여부 체크로 전환 ([auto-scaling.md](./auto-scaling.md) 참고) |
| DB 락 만료 정리 주기 | 30초 스케줄러 | 장애 종료 후 최대 30초 만료 레코드 잔존 | — |
| Redis Pub/Sub → gRPC fallback 전환 시간 | 3회 실패 감지 기준 | 짧은 단절 가능 | 감지 threshold 튜닝 |

---

## 9. 결론

| 검증 항목 | 결과 |
|----------|------|
| Kafka 장애 중 클라이언트 실시간 반응성 | **유지** |
| Kafka 장애 중 이벤트 보존 | **outbox DB 100%** |
| Kafka 복구 후 자동 replay | **≤ 25s, 전량 SENT** |
| Redis Pub/Sub 장애 시 Volatile 이벤트 전파 | **gRPC relay 유지** |
| Redis 상태 저장소 장애 시 편집 지속 | **DB fallback 투명 전환** |
| Redis 응답 지연(500ms) 시 fallback 전환 | **timeout 기준 자동 전환, 5xx=0** |
| 멀티 인스턴스 협조 복구 | **검증** (app-1 저장 → app-2 replay) |
| 이벤트 유실 | **0건** |

단순 장애 동작 확인을 넘어, **장애 범위를 제한하고 복구를 자동화하는 설계 검증**을 목표로 했다.  
각 인프라 컴포넌트의 장애가 hot path로 전파되지 않도록 경로를 분리하고,  
복구 시 수동 개입 없이 자동으로 원래 경로로 복귀하는 것이 핵심이다.
이를 통해 장애 상황에서도 사용자 편집 흐름과 시스템 정합성을 동시에 유지하는 것을 목표로 하였다.
