# 장애 시나리오별 UX 영향 분석 — Kafka / Redis / degrade mode

> 본 문서는 수치 측정보다 **설계 의사결정**에 초점을 둔다.  
> Kafka와 Redis를 어떻게 구성하느냐에 따라 사용자 편집 흐름이 어떻게 달라지는지를  
> 4가지 케이스로 비교한다.  
> 실제 측정 결과는 → [Kafka 장애 대응 전략 — Outbox Pattern](./kafka-fault-tolerance.md)

---

## 1. 문제 정의

실시간 협업 환경에서는 단순 장애 여부보다,  
**사용자 편집 흐름이 어떻게 영향을 받는지**가 중요하다.

같은 Kafka 장애라도 아키텍처에 따라:
- 요청이 즉시 실패하거나 (사용자가 직접 인지)
- 내부적으로 처리되거나 (사용자 무관)
- 지연 후 복구되거나 (MTTR 내 자동 해결)

UX 결과가 완전히 달라진다.

---

## 2. 비교 케이스 개요

| 케이스 | 구조 | 핵심 리스크 |
|--------|------|------------|
| **Case 1** | Kafka 없음 (Redis only) | Redis 장애 시 복구 불가 |
| **Case 2** | Kafka hot-path 직접 사용 | Kafka 지연/장애 → UX 전파 |
| **Case 3** | Kafka log용 + degrade 없음 | Kafka 장애 → 요청 실패 |
| **Case 4** | 현재 구조 (Redis + Kafka + Outbox) | Kafka 장애 → recovery 지연으로 제한 |

---

## 3. Case 1 — Kafka 없음 (Redis only)

### 흐름

```
Client PATCH
    ↓
Redis Pub/Sub 발행
    ↓
양 인스턴스 WS 브로드캐스트
```

### Redis 장애 시

```
Redis 장애
    ↓
Pub/Sub 발행 실패
    ↓
이벤트 유실 (저장 없음)
    ↓
reconnect 후 상태 복구 불가
```

### UX 영향

| 항목 | 영향 |
|------|------|
| 실시간 커서/편집 | 즉시 끊김 |
| edit 상태 | 손실 가능 |
| reconnect 후 | 최신 상태 복구 어려움 |
| replay | 불가능 (log 없음) |

> **장애 범위**: Redis 장애 = 실시간 전파 전체 중단. 복구 수단 없음.

---

## 4. Case 2 — Kafka hot-path 직접 사용

### 흐름

```
Client PATCH
    ↓
Kafka publish (동기 대기)
    ↓
KafkaConsumer
    ↓
WS 브로드캐스트
```

### Kafka 지연/장애 시

```
Kafka broker slow / timeout
    ↓
publish 지연 또는 producer retry
    ↓
HTTP 응답 지연
    ↓
클라이언트 edit latency 증가
    ↓
(장애 시) request fail → UX 전체 영향
```

### UX 영향

| 항목 | 영향 |
|------|------|
| edit latency | Kafka 지연에 직접 비례 |
| cursor 이벤트 | 지연 가능 |
| autosave | Kafka 장애 시 중단 |
| broker 장애 | UX 전체 영향 (hot-path dependency) |

> **장애 범위**: Kafka 성능/가용성이 실시간 UX에 직접 전파.  
> broker가 느리면 사용자가 느끼고, broker가 죽으면 편집이 멈춤.

---

## 5. Case 3 — Kafka log용 + degrade mode 없음

### 흐름

```
Client PATCH
    ↓
Redis Pub/Sub (실시간 전파)  ← 분리됨
Kafka publish (log 저장)     ← 분리됨
    ↓
Kafka publish 실패 시
    ↓
예외 처리 없음 → request fail (5xx)
```

### Kafka 장애 시

```
Kafka publish 실패
    ↓
DegradableReliablePublisher에 fallback 없음
    ↓
HTTP 5xx 반환
    ↓
사용자 저장 실패 인지
```

### UX 영향

| 항목 | 영향 |
|------|------|
| 실시간 전파 | Redis 경로로 유지 |
| 저장/autosave | 실패 (5xx) |
| 협업 continuity | 중단 가능 |
| 사용자 경험 | 즉시 악화 (에러 노출) |
| replay | 불가 (저장 안됨) |

> **장애 범위**: 실시간 전파는 살아있지만 저장이 실패하므로  
> 사용자는 편집 중 오류를 직접 마주함.

---

## 6. Case 4 — 현재 구조 (Redis + Kafka + Outbox)

### 흐름

```
Client PATCH
    ↓
DegradableReliablePublisher
    ├── [경로 A] Redis Pub/Sub → 즉시 WS 브로드캐스트
    └── [경로 B] Kafka publish
                    ├── 성공 → topic 저장 → consumer → WS (중복 제거)
                    └── 실패 → Outbox DB 저장 (PENDING)
                                    ↓
                              복구 후 스케줄러 재발행 → SENT
```

### Kafka 장애 시

```
Kafka publish 실패
    ↓
[경로 A] Redis 정상 → 클라이언트 즉시 반영 유지
[경로 B] Outbox 저장 → PENDING 보관
    ↓
Kafka 복구 감지 (≤ 5s)
    ↓
스케줄러 재발행 → 전량 SENT
    ↓
이벤트 유실 0건
```

### UX 영향

| 항목 | 영향 |
|------|------|
| 실시간 편집/커서 | **유지** (Redis 경로 독립) |
| autosave / save | **유지** (HTTP 응답 정상) |
| replay | **가능** (복구 후 자동 재발행) |
| Kafka 장애 영향 | recovery 지연으로 제한 |
| 사용자 인지 | 없음 (투명한 복구) |

> **장애 범위**: Kafka 장애가 UX로 전파되지 않음.  
> 사용자는 장애 사실을 인지하지 못한 채 편집을 계속할 수 있음.

---

## 7. 케이스 종합 비교

| 항목 | Case 1 (Redis only) | Case 2 (Kafka hot-path) | Case 3 (no degrade) | Case 4 (현재) |
|------|--------------------|-----------------------|--------------------|--------------|
| 실시간 전파 | Redis 의존 | Kafka 의존 | Redis 분리 ✅ | Redis 분리 ✅ |
| Kafka 장애 영향 | 해당 없음 | UX 전체 ❌ | 저장 실패 ❌ | recovery 지연만 ✅ |
| 이벤트 유실 | Redis 장애 시 ❌ | Kafka 장애 시 ❌ | Kafka 장애 시 ❌ | 없음 ✅ |
| 자동 복구 | 불가 | 불가 | 불가 | Outbox 재발행 ✅ |
| 사용자 오류 노출 | Redis 장애 시 | Kafka 장애 시 | Kafka 장애 시 | 없음 ✅ |
| 구현 복잡도 | 낮음 | 중간 | 중간 | 높음 |

---

## 8. 설계 결론

핵심은 **장애 영향 범위를 어디서 끊느냐**이다.

```
Case 2: Kafka 장애 → UX 전체 중단
                ↕
Case 4: Kafka 장애 → recovery 지연만 (UX 유지)
```

현재 구조는 Kafka를 hot-path에서 제거함으로써  
Kafka 가용성과 실시간 UX를 **디커플링**하였다.  
복잡도가 높아지는 trade-off가 있지만,  
협업 중 사용자가 오류를 마주하는 시나리오를 제거하는 것이 우선 목표였다.

> 실제 장애 대응 검증 결과 → [Kafka 장애 대응 전략 — Outbox Pattern](./kafka-fault-tolerance.md)
