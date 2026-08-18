# PoC 4 - Rendezvous Hashing 기반 Failover / Failback 라우팅 검증

## Summary

### 목적
Rendezvous Hashing + Redis capacity 예약 구조에서  
인스턴스 장애 시 기존 세션이 올바르게 failover되고,  
복구 후 신규 연결이 원래 hash 대상 인스턴스로 자연스럽게 복귀하는지 검증한다.

---

## 라우팅 구조

Gateway는 WebSocket 연결 대상 인스턴스를 아래 순서로 결정한다.

```
1. Eureka에서 trader 서비스 인스턴스 목록 조회
2. GatewayHealthPoller가 UP 상태로 마킹한 인스턴스만 후보에 포함
   - ready=true (HEALTHY) 인스턴스만 신규 연결 허용
   - DOWN / DRAINING 제외
3. Rendezvous Hashing으로 groupId별 후보 순위 결정
   score = SHA-256(groupId + ":" + instanceId) → 내림차순 정렬
4. 1순위 인스턴스에 Redis capacity 예약 시도 (Lua 원자적 처리)
   active + reserved < limit(50) 이면 예약 성공 → 해당 인스턴스 반환
   capacity full이면 2순위로 이동
```

### Rendezvous Hashing 예시

인스턴스 A, B, C가 있을 때 `groupId=1`의 hash score가 아래와 같다면:

```
hash("1:A") = 892  →  1순위
hash("1:C") = 451  →  2순위
hash("1:B") = 234  →  3순위
```

정상 상태에서 `groupId=1`의 신규 연결은 항상 **A**로 배정된다.  
인스턴스가 추가·제거되어도 영향받지 않는 그룹은 그대로 유지된다.

---

## Failover / Failback 정책

| 상황 | 동작 |
|------|------|
| A 정상 | 신규 연결 → A |
| A 장애 | A 제외, 다음 순위 C로 failover |
| A 복구 | 기존 C 세션 유지, **신규 연결부터** A로 복귀 |
| A capacity full | A 예약 실패 → C로 이동 |

**자동 failback은 하지 않는다.**  
WebSocket은 장기 연결이므로 복구된 인스턴스로 강제 이동하면  
불필요한 reconnect / room rejoin 비용과 사용자 체감 불안정이 발생한다.  
신규 연결부터 자연스럽게 원래 hash 결과로 수렴하는 방식을 채택한다.

### PoC 3 정책과의 차이

PoC 3에서는 복구 lifecycle을 검증하기 위해 fallback 서버를 Drain하고
기존 세션에 reconnect를 요청하는 강제 failback 흐름을 실험했다.
이 PoC 4에서는 그 후속 판단으로, 강제 reconnect가 만드는 room rejoin 비용과
사용자 체감 불안정을 줄이기 위해 **기존 세션 유지 + 신규 연결부터 자연 failback**을
최종 라우팅 정책으로 선택했다. 따라서 두 문서는 서로 다른 검증 단계이며,
현재 정책을 설명할 때는 이 문서의 자연 failback을 기준으로 한다.

---

## 검증 환경

- 인스턴스: **`i-0dcd42b78eca3f93e`** (A), **`i-06e7c5a0f7118a0a8`** (B)
- k6 시나리오 2개 동시 실행
  - `hold_session`: 장기 WebSocket 세션 유지, 장애 감지 시 재연결
  - `probe_new`: 30초마다 새 연결 시도 후 15초 유지 → 종료

---

## 테스트 로그

```
# 초기 — 두 연결 모두 A로 배정
INFO[0000] [HOLD][ROUTE] instanceId=i-0dcd42b78eca3f93e
INFO[0000] [PROBE][ROUTE] instanceId=i-0dcd42b78eca3f93e
INFO[0000] [HOLD][WS #1] connected instance=i-0dcd42b78eca3f93e latency=75ms
INFO[0000] [PROBE #1] connected instance=i-0dcd42b78eca3f93e latency=74ms

# t=15s — PROBE #1 정상 종료 (15s 유지 후 close 1001)
INFO[0015] [PROBE #1] closed code=1001 instance=i-0dcd42b78eca3f93e

# t=19s — A 장애 (docker stop), HOLD 세션 1006 감지
ERRO[0019] [HOLD][WS #1] error=websocket: close 1006 (abnormal closure): unexpected EOF
INFO[0019] [HOLD][WS #1] closed code=1006 instance=i-0dcd42b78eca3f93e

# t=20s — health poller 아직 DOWN 마킹 전, 1회 재시도 실패
INFO[0020] [HOLD][ROUTE] instanceId=i-0dcd42b78eca3f93e

# t=23s — health poller DOWN 마킹 완료, B로 failover
INFO[0023] [HOLD][ROUTE] instanceId=i-06e7c5a0f7118a0a8
INFO[0023] [HOLD][FAILOVER] i-0dcd42b78eca3f93e → i-06e7c5a0f7118a0a8
INFO[0023] [HOLD][WS #3] connected instance=i-06e7c5a0f7118a0a8 latency=21ms

# t=45s — A 장애 중 PROBE 신규 연결도 B로 배정
INFO[0045] [PROBE][ROUTE] instanceId=i-06e7c5a0f7118a0a8
INFO[0045] [PROBE #2] instance changed: i-0dcd42b78eca3f93e → i-06e7c5a0f7118a0a8

# t=90s — A 복구, PROBE 신규 연결이 다시 A로 복귀
INFO[0090] [PROBE][ROUTE] instanceId=i-0dcd42b78eca3f93e
INFO[0090] [PROBE #3] instance changed: i-06e7c5a0f7118a0a8 → i-0dcd42b78eca3f93e

# t=105s — PROBE #3 정상 종료
INFO[0105] [PROBE #3] closed code=1001 instance=i-0dcd42b78eca3f93e

# t=135s — PROBE 신규 연결 A 안정 유지 / HOLD 세션은 B 그대로 유지
INFO[0135] [PROBE #4] instance=i-0dcd42b78eca3f93e (유지)
# HOLD 로그 없음 = B 세션 변경 없이 유지 중
```

---

## 핵심 지표

| 항목 | 결과 |
|------|------|
| 최초 연결 대상 | `i-0dcd42b78eca3f93e` (A) |
| 장애 감지 | t=19s, close 1006 |
| 기존 세션 failover | t=23s → **`i-06e7c5a0f7118a0a8`** (B) |
| failover 소요 시간 | **약 4초** (health poller 1 cycle 이내) |
| 장애 중 신규 연결 | t=45s → `i-06e7c5a0f7118a0a8` (B) |
| 복구 후 신규 연결 복귀 | t=90s → **`i-0dcd42b78eca3f93e`** (A) |
| 복구 후 라우팅 안정화 | t=135s → `i-0dcd42b78eca3f93e` 유지 |
| 기존 B 세션 강제 failback | 없음 (의도된 동작) |

---

## 해석

초기에는 두 연결 모두 Rendezvous Hashing 결과에 따라 `i-0dcd42b78eca3f93e`(A)로 배정되었다.

A 장애 후 HOLD 세션에서 close 1006이 발생했고,  
GatewayHealthPoller가 DOWN을 마킹한 뒤 첫 번째 재시도(t=20s)는 실패,  
두 번째 요청(t=23s)부터 `i-06e7c5a0f7118a0a8`(B)로 failover되었다.

장애 중 PROBE 신규 연결(t=45s)도 B로 라우팅되었다.

A가 복구된 후 t=90s 신규 연결부터 다시 A로 라우팅되었으며,  
이미 B에 붙어 있던 HOLD 세션은 강제 이동 없이 B에 그대로 유지되었다.

이를 통해 아래 정책이 실제로 동작함을 확인했다.

```
장애 시  : 기존 세션 → 다음 순위 후보로 failover
복구 후  : 신규 연결부터 원래 hash 대상으로 자연 복귀
          기존 세션은 강제 failback하지 않음
```

---

## 구현 포인트

**GatewayHealthPoller** — 5초 주기로 `/internal/health` 폴링  
→ `ready=true`인 경우에만 `HEALTHY`로 마킹

**WsShardRouter.isRoutable()** — `HEALTHY` 상태 인스턴스만 라우팅 후보에 포함  
→ `DOWN` / `DRAINING` / `UP(ready=false)` 제외

**Eureka** — `registry-fetch-interval-seconds: 5`로 인스턴스 목록 갱신 주기 단축  
→ lease-expiration 15s + fetch 5s 조합으로 죽은 인스턴스 최대 ~20s 내 제거

**Redis Lua** — capacity 예약을 원자적으로 처리하여 동시 요청 시 과밀 방지
