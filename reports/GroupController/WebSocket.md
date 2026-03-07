## 테스트 환경

| 항목                   | 설정                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------- |
| 서버사양 #1 (개발 환경,로컬 노트북)                | 6 Core / 32GB / SSD <br>-> 기능 비교 및 부하 패턴 분석용                                                                                 |
| 서버사양 #2 (배포 서버,실험 최종)| 4 Core/16GB/SSD <br>-> Capacity 및 병목 분석용|
| DB                   | PostgreSQL 17 + TimescaleDB                                                                                   |
| 커넥션 풀                | HikariCP `maximumPoolSize=150`, `minimumIdle=80`                                                              |
| 테스트 도구               | k6 v0.52                                                                                                      |
| 부하 모델                | 동일 룸 서로 다른 200명 동시 접속, 송신자 20명만 20Hz 전송(= 인바운드 400 msg/s), 서버는 룸 전체 브로드캐스트(= 아웃바운드 최대 200 × 400 = 80,000 send/s 시도) |
| 네트워크                 | 내부 브릿지 (Docker Compose)                                                                                       |
| JVM                  | OpenJDK Temurin 17 (64-bit, JDK)                                                                              |
| GC                   | G1GC                                                                                                          |
| 힙 초기/최대              | `-Xms248m`, `-Xmx3942m` (컨테이너 메모리 기반 자동 산정)                                                                   |
| G1 Region Size       | 2MB                                                                                                           |
| Parallel GC Workers  | 4                                                                                                             |
| Max Pause Target     | 200ms (`-XX:MaxGCPauseMillis=200`, 기본값)                                                                       |
| String Deduplication | Disabled (명시 옵션 미사용)                                                                                          |
| SLO                  | **E2E 수신 지연 200ms 이하 성공률** (`<=200ms`)                                                                        |

※ 로컬 환경은 상대 비교(구조/패턴 분석)에 사용하였으며, 최종 capacity 및 병목 분석은 배포 서버에서 수행하였다.

---

1. 문제 발생 (RAW 동시성)
2. 원인 분석
3. 해결 (Decorator)
4. 안정성 확보 결과
5. 그러나 실시간성 붕괴 발견
6. Drop 전략 도입
7. 성능 개선 결과
8. RAW vs STOMP 비교 (JFR 근거)
9. 최종 결론 및 트레이드오프

## 1. 실험 배경

본 프로젝트는 실시간 협업 캔버스 기능을 제공하며,
마우스 커서, 드래그 미리보기, 하이라이트, 편집 중 표시와 같은
휘발성(Ephemeral) 이벤트를 다수 사용자에게 브로드캐스트한다.

이러한 데이터는 영구 저장이 목적이 아니며,
중간 상태의 완전한 전달보다 **최신 상태가 빠르게 도달하는 것**이 중요하다.

따라서 본 실험에서는
Spring STOMP 기반 메시징 방식과
직접 구현한 RAW WebSocket 방식을 비교하여,

- 동시성 안정성
- 실시간성(SLO: 200ms 이하 수신 성공률)
- GC 및 Allocation 오버헤드
- Backpressure 설계 가능성

측면에서 어떤 구조가 휘발성 데이터에 적합한지 검증하고자 한다.

본 실험에서는 단순한 최대 처리량 비교가 아니라,
**전부 전달**과 **최신성 보장**이라는 반대되는 설계의
트레이드오프를 검증하는 과정을 보여주려고 한다.

## 개선 전 RAW WebSocket 구조

* 동일 팀/동일 그래프에 접속한 사용자는 **동일 브로드캐스트 전파 범위(room)** 에 포함된다.
* **WebSocketSession은 연결(소켓) 1개당 1개**이며, 같은 계정이라도 **브라우저 탭이 다르면 세션이 별도로 생성**된다. 각 세션은 인바운드/아웃바운드 전송을 모두 담당한다.
* **핸드쉐이크 단계에서** 쿠키로 전달된 JWT를 파싱하여 인증하고, 이후 `TextWebSocketHandler.handleTextMessage()`에서 메시지를 처리한다.

## 개선 전 STOMP 구조

* 마찬가지로 **핸드쉐이크 단계에서 JWT 인증**을 수행한다.
* 핸드쉐이크 이후에는 **STOMP 프로토콜 흐름(CONNECT → SUBSCRIBE → SEND)** 에 따라 메시지를 처리한다.

## 실험 목적

본 실험은 커서/포인터/하이라이트와 같은 **휘발성(실시간) 이벤트 브로드캐스트**를 대상으로,
프레임워크 기반으로 **안정적인 STOMP**와 직접 구현한 **경량 RAW WebSocket**의 성능을 비교/분석하여

* 동시성 안정성(세션 이탈/예외 발생 여부)
* 실시간성(SLO: `<=200ms` 수신 성공률)
* GC/할당 및 호출 스택 오버헤드(JFR/JMC 근거)

관점에서 **트레이드오프를 확인**하고, 요구 성능 및 품질 기준에 맞는 방식을 선택하기 위함이다.



## 2. 문제 발생 (RAW 동시성)

부하 테스트용 배포 서버에서 테스트 전에 의도한 대로 수신,송신이 되는지 확인을 위해 개발용 노트북에서 부하 테스트를 진행하였다.

### RAW 동시성 개선 전 성능 비교 표(RAW VS STOMPS)

- 송신자의 송신 시간은 테스트 후 30초 가량 진행, 수신자는 60초 가량 진행하였다. 

| Type     | Duration | Errors | Received  | Recv/s    | ≤200ms     | ≤1000ms |
| -------- | -------- | ------ | --------- | --------- | ---------- | ------- |
| RAW #1   | 65.93s   | 0      | 6,509     | 99.52    | **1.03%** | 82.89% |
| RAW #2   | 64.69s   | 0      | 5,346     | 82.64     | **5.76%**  | 100.00% |
| STOMP #1 | 62.53s   | 0      | 1,948,286 | 31,156.87 | **0.01%**  | 0.46%   |
| STOMP #2 | 62.66s   | 0      | 1,799,164 | 28,713.92 | **0.30%**  | 1.19%   |

### 문제 발생
위 두가지 테스트를 진행한 결과 RAW의 수신량이 STOMP에 비해 현저히 낮은 것을 확인 할 수 있었다.

- 이상적인 수신량 : 20Hz * 20send * 30s*  200recive = 2,400,000events
- STOMP또한 이상적인 수신량에 미치지 못하지만 RAW는 그에 훨씬 못미치는 수치이다. 중앙값 기준 : **6000 VS 1,800,000**

### 원인 분석
이를 확인하기 위해 RAW쪽 핸들러 코드에 디버깅 로그를 넣어 확인하였다.

```java

@Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        try {
            log.info("[RAW] open session={} uri={} principal={} cookie={}",
                    session.getId(),
                    session.getUri(),
                    (session.getPrincipal() != null ? session.getPrincipal().getName() : null),
                    session.getHandshakeHeaders().getFirst("Cookie")
            );

            ...
            ...

            registry.join(roomKey, session);
            // (옵션) 로그: 현재 room size
            log.info("[RAW] joined roomKey={} size={}", roomKey, registry.size(roomKey));

        } catch (Exception e) {
            log.error("[RAW] afterConnectionEstablished failed session={} uri={}",
                    session.getId(), session.getUri(), e);
            try { session.close(CloseStatus.SERVER_ERROR); } catch (Exception ignore) {}
        }
    }


public void leave(String roomKey, WebSocketSession session) {
        Set<WebSocketSession> set = rooms.get(roomKey);
        if (set == null) return;

        boolean removed = set.remove(session);
        int size = set.size();
        if (removed) log.info("[RAW] left session={} roomKey={} size={}", session.getId(),roomKey, size);

        set.remove(session);

        // ✅ race 방지: remove할 때 "아직 같은 set"일 때만 제거
        if (set.isEmpty()) {
            rooms.remove(roomKey, set);
        }
    }

```

- 위의 코드에서는 같은 토픽(룸)에 들어간 사용자의 수를 로깅하고 있으며 예외가 발생할 경우 원인을 출력하도록 되어있다.
- leave()메서드는 세션 연결 종료 및 예외 발생시 실행하게 되어있으며 해당 메서드에도 로깅 처리하였다.

```
# 동시 send 실패 발생
17:02:24.353 WARN [exec-144] [RAW] send fail roomKey=1:1 session=b508ac... ex=IllegalStateException: TEXT_PARTIAL_WRITING
17:02:24.353 WARN [exec-21 ] [RAW] send fail roomKey=1:1 session=c1e70c... ex=IllegalStateException: TEXT_PARTIAL_WRITING
17:02:24.354 WARN [exec-112] [RAW] send fail roomKey=1:1 session=5f57c2... ex=IllegalStateException: TEXT_PARTIAL_WRITING
17:02:24.357 WARN [exec-119] [RAW] send fail roomKey=1:1 session=dbd197... ex=IllegalStateException: TEXT_PARTIAL_WRITING


# 실패 직후 room size 감소(세션 닫힘)
17:02:24.353 INFO [exec-24 ] [RAW] left session=59c431... roomKey=1:1 size=13
17:02:24.356 INFO [exec-144] [RAW] left session=0c951d... roomKey=1:1 size=5
17:02:24.357 INFO [exec-24 ] [RAW] left session=3b9f54... roomKey=1:1 size=2
17:02:24.359 INFO [exec-144] [RAW] left session=ccdec1... roomKey=1:1 size=0

# 이후 네트워크 오류(세션 불안정 및 클라이언트 연결 리셋 발생)
17:02:31 WARN [exec-5 ] [RAW] transport error session=a80cce... ex=Connection reset
17:02:31 WARN [exec-129] [RAW] transport error session=661cae... ex=Connection reset

```

#### 원인 분석 결과
- 200명 동시 접속 환경에서 브로드캐스트 수행 중, 동일 세션에 대한 동시 sendMessage() 호출로 인해 TEXT_PARTIAL_WRITING 예외가 다수 발생하였다.
예외 직후 leave()가 연쇄적으로 호출되며 room size가 13 → 0까지 급격히 감소하였다.
이는 WebSocketSession의 비동기 동시 write 재진입이 세션 제거를 유발하고, 결과적으로 브로드캐스트 전파 범위를 붕괴시키는 현상을 보여준다.
- 이 때문에 k6 성능 결과에서 raw가 더 낮은 수신량을 가진다는 것을 알 수 있다.

### RAW 동시성 해결
1. 문제의 핵심은 동일 WebSocketSession 에 대해 멀티스레드 환경에서 sendMessage()가 같은 세션에 동시에 호출되며, Tomcat RemoteEndpoint가 TEXT_PARTIAL_WRITING 상태에서 재진입을 허용하지 않아 예외가 발생하는 것이다.
2. 해결 방향은 “세션 단위로 send를 직렬화”하는 것이며, 대표적으로 다음 두 가지 접근이 가능하다.
    1. ```sendMessage``` 호출을 ```synchronized```로 보호
    2. 세션을 ```ConcurrentWebSocketSessionDecorator```로 감싸 전송을 직렬화 + 버퍼링

#### 차이점
- synchronized 
    - 동일 세션에 대한 sendMessage()를 락 기반으로 직렬화한다.
    - 해당 세션 전송이 느려지면 다른 스레드들은 락을 기다리며 대기(block) 하게 되고, 특히 브로드캐스트 호출이 많이 겹치는 상황에서는 요청 처리 지연이 누적되고 전체 처리량이 떨어질 수 있다.
- ConcurrentWebSocketSessionDecorator
    - 세션 단위로 전송을 직렬화하되, 동시에 들어온 전송 요청은 세션별 버퍼에 적재한다.
    - 버퍼가 쌓이거나 전송이 오래 걸리는 경우, 설정 값(sendTimeLimit, bufferSizeLimit)을 초과하면 예외를 발생시키거나 세션을 종료하여, 특정 느린 세션이 전체 브로드캐스트/시스템 안정성을 끌어내리는 상황을 제한할 수 있다(백프레셔).

따라서 현재 구조에서는 세션을 ConcurrentWebSocketSessionDecorator로 감싸 쓰기 작업을 진행하였다.

#### 변경된 코드
```java
int sendTimeLimitMs = 5000;         //시간 제한
int bufferSizeLimitBytes = 512 * 1024; //버퍼 사이즈 제한

WebSocketSession safeSession = new ConcurrentWebSocketSessionDecorator(session, sendTimeLimitMs, bufferSizeLimitBytes);   

registry.join(roomKey, safeSession);
```

### RAW 동시성 문제 개선 후 결과

| Type   | Duration | Errors | Received  | Recv/s    | ≤200ms | ≤1000ms |
| ------ | -------- | ------ | --------- | --------- | ------ | ------- |
| 개선 전 RAW #1   | 65.93s   | 0      | 6,509     | 99.52    | **1.03%** | 82.89% |
| 개선 전 RAW #2   | 64.69s   | 0      | 5,346     | 82.64     | **5.76%**  | 100.00% |
| 개선 후 RAW #3 | 64.61s   | 0      | 2,399,800 | 37,140.33 | 0.00%  | 0.39%   |
| 개선 후 RAW #4 | 62.90s   | 0      | 2,396,399 | 38,100.29 | 0.38%  | 2.11%   |

- 테스트 결과 RAW또한 예상한 이상적인 수치에 근접하게 수신량이 늘어난 것을 확인할 수 있다.

#### 개선 전 오류량에 대하여
- 추가로 개선 전 RAW 테스트에서 k6 기준 errors는 0으로 집계되었다.
- 이는 TextWebSocketHandler의 handleTransportError()를 오버라이드하여, 전송 중 예외 발생 시 세션을 1011(Server Error)로 강제 종료하지 않고 해당 세션만 room registry에서 제거하도록 처리했기 때문이다.
- 대량 접속 환경에서 1011 close는 연쇄 종료 및 재접속을 유발할 수 있으므로, 문제 세션만 격리하는 전략을 사용하였다.
- 그 결과 k6에서는 비정상 종료로 판단되지 않아 error는 0으로 집계되었으나, 내부적으로는 세션 격리가 수행되었다.

## 수신 메세지 지연과 구조적 한계

* 두 가지의 테스트 결과, 동일 인스턴스 내 부하 환경에서도 대부분의 수신 메세지가 **1000ms 이상 지연**되는 것으로 확인되었다.
* 해당 WebSocket 구조는 커서 이동, 하이라이트, 노드 드래그와 같이 **즉각적인 반응성이 요구되는 휘발성 이벤트**에 적용되어 있다.
* 그러나 현재 구조는 모든 이벤트를 동일하게 브로드캐스트하며, 세션 단위 직렬화 및 버퍼링으로 인해 지연이 누적되는 구조적 한계를 가진다.

### 문제점

* 휘발성 데이터임에도 불구하고 **전량 전파(All-delivery)** 방식을 사용하고 있다.
* 그 결과, 최신 상태만 중요함에도 이전 이벤트까지 모두 전송되어 **지연이 누적**된다.
* 실시간 UX 기준(≈200ms 이하)을 충족하는 비율이 매우 낮다.

### 개선 방향

* 모든 데이터를 보장 전달하는 구조에서 벗어나,
* **최신 상태만 유지하는 전송 전략(Last-value or Drop strategy)** 으로 전환하여
* 200ms 이하 응답 비율을 높이고자 한다.

## 1차 개선 DROP, ONLY-LATEST
- raw,stomp 둘다 CURSOR와 같은 최신 정보만 필요한 데이터는 들어오는 메세지를 방에 따라 ConcurrentHashMap에 담는다.
- CONTROL과 같이 노드 이동 후 드랍, 노드 수정과 같은 메세지는 LinkedQueue에 담아 순서를 보장하며 전부 보내도록 한다.
- 이후 각각의 스케쥴러에서 100ms(10HZ),50ms(20HZ),33ms(30HZ)등에 따라 담았던 메세지를 전파한다.

### DROP,Latest-Only + Scheduler 적용 후 테스트 결과
- 두 테스트 모두 DROP, ONLY-LATEST를 적용 후 테스트 결과 아래와 같이 나왔다.

| Type                      | Duration | Errors | Received             | Recv/s                 | ≤200ms     | ≤1000ms |
| ------------------------- | -------- | ------ | -------------------- | ---------------------- | ---------- | ------- |
| RAW | 64.61s   | 0      | 2,399,800 | 37,140.33 | 0.00%  | 0.39%   |
| STOMP | 62.66s   | 0      | 1,799,164 | 28,713.92 | **0.30%**  | 1.19%   |
| RAW(drop)   | 64.00s   | 0      | 2,392,680            | 37,386.23              | **48.55%** | 2.89%  |
| STOMP(drop) | 64.03s   | 0      | 2,396,660 *(events)* | 37,431.44 *(events/s)* | **48.21%** | 3.20%  |


- 두 테스트 모두 drop을 적용 후 200ms내로 들어오는 메세지 비율이 증가 및 동일한 Hz로 서버에서 브로드캐스팅 작업을 하여 항상 안정적인 수신량을 확인할 수 있다.

### 문제점
- ≤200ms가 48%대로 붕괴
- 중복 flush 구조로 tail latency 왜곡

#### 1차 개선 구조 및 원인
- 현재는 다음과 같은 구조를 가진다
 1. 메세지 수신 후 키값 생성후 버퍼 전달
 2. 버퍼 적재(휘발성,최신->ConcurrentHashMap 적재, 노드 수정 등 메세지 유실X->LinkedQueue적재)
 3. 스케쥴링 및 Flush
<details>
  <summary>📜 1. 메세지 수신 시에 버퍼 적재(Coalescing) (클릭하여 보기)</summary>

```java
// 메시지를 모아두는 버퍼 레이어
public class RoomPresenceCoalescer<T> {

    // roomKey → (senderKey → latestMessage)
    private final ConcurrentHashMap<String, ConcurrentHashMap<String, T>> latestByRoom
            = new ConcurrentHashMap<>();

    // 메시지 수신 시 roomKey + senderKey 기준으로 덮어씀
    public void publishLatest(String roomKey, String key, T msg) {
        latestByRoom
            .computeIfAbsent(roomKey, rk -> new ConcurrentHashMap<>())
            .put(key, msg); // 동일 sender는 항상 최신 1개만 유지
    }
}
```
</details>

- 같은 유저가 보내도 맵에는 ```ex)key = CURSOR:101``` 1개만 남는다.


<details>
  <summary>📜 2. WebSocket 수신부에서 버퍼로 전달 (클릭하여 보기)</summary>

```java
@Override
protected void handleTextMessage(WebSocketSession session, TextMessage message) {

    RawCursorMessage out = new RawCursorMessage(...);

    if (TYPE_CONTROL.equals(out.type())) {
        // Drop 금지 (신뢰 전송)
        broadcaster.publishReliable(roomKey, safeMessage);
    } else {
        // sender별 key 생성
        String key = makeLatestKey(out.type(), out.userId(), out.nodeId());

        // 최신 메시지 버퍼에 저장 (즉시 전송 X)
        broadcaster.publishLatest(roomKey, key, safeMessage);
    }
}
```

</details>


<details>
  <summary>3️⃣ 스케줄링 + Flush (실제 배치 전송 구간) (클릭하여 보기)</summary>


```java
// RawPresenceBroadcaster
private final ScheduledExecutorService flusher =
        Executors.newSingleThreadScheduledExecutor();

{
    // 33ms마다 전체 룸 flush (≈ 30Hz)
    flusher.scheduleAtFixedRate(
            this::flushAllRoomsSafe,
            0,
            33,
            TimeUnit.MILLISECONDS
    );
}
```

</details>


<details>
  <summary>4. Flush구현 (클릭하여 보기)</summary>


```java

//flsuh작업이 도는 도중에 다른 쓰레드에서 룸 생성,삭제등 충돌 문제를 막기 위해 짧게 복사하여 처리
private void flushAllRoomsSafe() {
        try {
            for (String roomKey : registry.roomKeysSnapshot()) {
                flushRoom(roomKey);
            }
        } catch (Exception e) {
            log.warn("[RAW] flushAllRoomsSafe error: {}", e.toString());
        }
    }

private void flushRoom(String roomKey) {

    List<WebSocketSession> sessions = registry.snapshot(roomKey);
    if (sessions.isEmpty()) return;

    coalescer.flushRoom(roomKey, (TextMessage msg) -> {

        for (WebSocketSession s : sessions) {
            if (!s.isOpen()) continue;

            try {
                s.sendMessage(msg);
            } catch (Exception e) {
                registry.leave(roomKey, s);
            }
        }
    });
}
```

</details>

#### 문제 원인
- 위 구조의 3번 스케줄링 + Flush에서 문제가 발생하게 된다
- HashMap에 들어간 메세지는 지워지지 않으므로 이미 보낸 메세지여도 지정한 시간마다 계속하여 보내게 되는 문제가 발생하게 된다.
1. 불필요한 중복 브로드캐스트 폭증
2. 네트워크/CPU 리소스 낭비 → tail latency 악화
3. 메모리 점유 증가(장기적으로 GC/OutOfMemory 위험)
4. 결과 지표 왜곡(측정 오염)

### 문제 해결 (dirtyFlag추가)

```java
public class RoomPresenceCoalescer<T>{
    //더티 플래그 버퍼 추가
    private final ConcurrentHashMap<String, AtomicBoolean> dirtyByRoom = new ConcurrentHashMap<>();

    /**
     * ✅ Dirty 기반 + DrainLatest
     * - dirty=false면 아무것도 안 보냄
     * - dirty=true면 latest를 "스냅샷 뜨면서 clear" (다음 tick 중복 전송 방지)
     * - dirty는 여기서 false로 원자적으로 내림
     */
    public Collection<T> drainLatestIfDirty(String roomKey) {
        AtomicBoolean dirty = dirtyByRoom.get(roomKey);
        if (dirty == null || !dirty.compareAndSet(true, false)) {
            return List.of();
        }

        var m = latestByRoom.get(roomKey);
        if (m == null || m.isEmpty()) return List.of();

        // snapshot + clear (drain)
        ArrayList<T> out = new ArrayList<>(m.values());
        m.clear();
        return out;
    }

    public void publishLatest(String roomKey, String key, T msg) {
        latestByRoom.computeIfAbsent(roomKey, rk -> new ConcurrentHashMap<>()).put(key, msg);
        //더티플래그 추가
        markDirty(roomKey);
    }

    private void markDirty(String roomKey) {
        dirtyByRoom.computeIfAbsent(roomKey, rk -> new AtomicBoolean(false)).set(true);
    }

    //룸 정리
    public void clearRoom(String roomKey) {
        latestByRoom.remove(roomKey);
        reliableQueueByRoom.remove(roomKey);
        dirtyByRoom.remove(roomKey);
    }
}
```

#### 더티 플래그 추가 후 테스트 결과

## 🔹 Sender=20 (0.1 × 200)

| Type  | Dirty Flag | Duration | Errors | Received (events) | Recv/s    | ≤200ms     | ≤1000ms |
| ----- | ---------- | -------- | ------ | ----------------- | --------- | ---------- | ------- |
| RAW   | ❌ 미적용      | 64.00s   | 0      | 2,392,680         | 37,386.23 | **48.55%** | 51.44%  |
| STOMP | ❌ 미적용      | 64.03s   | 0      | 2,396,660         | 37,431.44 | **48.21%** | 51.41%  |
| RAW   | ✅ 적용       | 64.24s   | 0      | 1,958,600         | 30,487.20 | **99.97%** | 100.00% |
| STOMP | ✅ 적용       | 64.67s   | 0      | 2,028,600         | 31,366.34 | **98.69%** | 100.00% |

---

- 더티 플래그 미적용
![no_dirty](../../image/nodirty_raw_20.png)
- 더티 플래그 적용
![dirty](../../image/dirty_raw_20.png)

- 센더의 메세지 전송이 지난 후 플래그를 적용한 이미지는 Memory, allocation이 전송 후 안정화 되는 것을 확인 할 수 있다.
- 이를 통해 불필요한 중복 브로드캐스트, 메모리 점유, cpu리소스 사용을 제거하였다.

---

### 🔎 Dirty Flag 도입 후 테스트 결과 해석

* 미적용 시 ≤200ms가 **48% 수준으로 붕괴하였다.**
* 적용 후 ≤200ms **99% 이상 회복하였다.**
* 미적용에서는 송신 이후에도 동일 최신값이 매 tick 재전송되어 recv/s가 **성능**이 아니라 **중복**이었다
* 문제의 본질은 최신값 캐시가 아니라 중복 재전송 루프였고, dirty-drain으로 불필요 fanout을 제거해 tail latency가 회복됐다.
# 최종 STOMP VS RAW 비교
두 WebSocket 구조를 동일한 조건(200명 접속, Rate=20Hz)에서 구축하고
부하 및 런타임 분석을 통해 최종 채택 구조를 결정하였다.

## 테스트/비교 목차
1. 송신자 20/40명의 테스트 k6결과
2. 송신자 40명의 테스트 jfr및 jmc를 이용한 런타임 분석
3. 최종 채택과 이유
### 1.송신자 20/40명 테스트 결과(Room=200,Rate=20Hz)
| Sender | Type  | Duration | Errors | Received (events) | Recv/s    | ≤200ms     | ≤1000ms |
| ------ | ----- | -------- | ------ | ----------------- | --------- | ---------- | ------- |
| 20     | RAW   | 64.24s   | 0      | 1,958,600         | 30,487.20 | **99.97%** | 100.00% |
| 20     | STOMP | 64.67s   | 0      | 2,028,600         | 31,366.34 | **98.69%** | 100.00% |
| 40     | RAW   | 62.03s   | 0      | 2,713,236         | 43,744.17 | **89.89%** | 100.00% |
| 40     | STOMP | 61.43s   | 0      | 2,443,877         | 39,785.70 | **78.04%** | 99.94%  |

#### 분석

- 송신자 20명 구간에서는 두 구조가 유사한 성능을 보였다.

- 송신자 40명 고부하 구간에서 차이가 명확하게 발생했다.

- STOMP는 ≤200ms 비율이 약 12%p 하락하였다.

- RAW는 동일 조건에서 더 높은 실시간 응답률을 유지하였다

### 2.송신자 40명 jfr, jmc분석

|Type|Received|≤200ms|CPU Peek(JVM+App)|Byte[] TopAlloc|GC Total|GC Pause|
|-------|-------|-------|-------|-------|-------|-------|
|STOMP|2,443,877|**78.04%**|55.6%|999Mib(37.6%)|473.923ms|260.919ms|
|RAW|2,713,236|**89.89%**|39.7%|1003MiB(46.4%)|820.713ms|301.644ms|

#### 런타임 분석 결과

* **STOMP는 CPU 사용률이 높다 (55.6%)**

  * 프레임 인코딩/디코딩
  * 브로커 라우팅 오버헤드
  * 메시지 매핑 비용

* **RAW는 CPU는 낮지만 GC Total이 더 높음**

  * 직접 fanout 구조
  * JSON 직렬화 과정에서 Byte[] 생성 반복

그러나,

> GC 증가에도 불구하고 RAW는 CPU saturation이 발생하지 않았으며
> 결과적으로 ≤200ms 실시간 응답률을 더 높게 유지하였다.

정리하자면

* STOMP는 CPU-bound 경향
* RAW는 할당이 다소 무겁지만 CPU-light 경향을 보인다.

### 3. 최종 채택 및 이유
#### 채택: **RAW WebSocket 구조**

#### 채택 근거

1. 고부하(40 sender) 환경에서 더 높은 실시간 응답률 유지
2. CPU 사용률이 낮아 확장성 측면에서 유리
3. 프로토콜 계층이 단순하여 처리 경로가 짧다.
4. 요구사항 : **빠르고 가벼운 실시간 전송**

>따라서, 현재 요구사항에 더 적합한 구조는 RAW 방식으로 판단하였다.

다만 RAW는 운영에서 메시지 규약/재시도/개인큐/ACK 등은 직접 구현 비용이 있기에 단순한 알람등의 브로드캐스트는 STOMP를 적용하는 것도 고려된다.

## (부록) 단일룸 환경이 아닌 멀티룸 환경에서 테스트
단일 룸에서의 fanout 집중 현상이 실제 운영 환경에서도 동일하게 발생하는지 확인하기 위해,
총 접속 인원은 동일하게 유지한 채 룸을 분산하여 테스트를 진행하였다.

#### 테스트 조건

- VU = 200
- SenderRatio = 0.2 (총 40명)
- Rate = 20Hz
- Duration = 30s
- Latest-Only + DirtyFlag 적용
- 멀티룸의 유저는 룸 개수에 맞춰 나눠지며 센더 또한 룸의 유저수에 따라 나뉨

### 단일룸(1 Room) VS 멀티룸(5 room)
| Rooms | Users/Room | Senders/Room | Received (events) | Recv/s | ≤200ms      | ≤1000ms |
| ----- | ---------- | ------------ | ----------------- | ------ | ----------- | ------- |
| 1     | 200        | 40           | 2,821,600         | 44,238 | **92.45%**  | 100%    |
| 5     | 40         | 8            | 949,480           | 15,114 | **100.00%** | 100%    |

---

### 🔎 멀티룸 테스트 결과 요약

* 동일 총 접속 인원(200명), 동일 송신률(20Hz) 조건에서
  단일룸(200명)과 팀/그래프 단위로 분리된 멀티룸(40명 × 5개)을 비교하였다.

* 멀티룸 구조에서는 각 팀/그래프별로 브로드캐스트 범위가 분리되므로
  단일룸 대비 fanout 집중도가 낮아진다.

* 그 결과, 단일룸 환경에서는 ≤200ms 비율이 약 92% 수준이었던 반면,
  팀/그래프 단위로 분리된 멀티룸 환경에서는 **≤200ms가 100%로 안정적으로 유지**되었다.

* 수신 이벤트 총량이 감소한 것은 성능 저하가 아니라,
  각 사용자가 해당 팀/그래프의 이벤트만 수신하도록 설계된
  도메인 구조상 정상적인 동작이다.

> 즉, 팀/그래프 단위 룸 분리는 단순한 성능 최적화가 아니라,
> 도메인 경계를 기반으로 브로드캐스트 범위를 자연스럽게 제한하여
> 실시간성을 더 안정적으로 유지하는 구조임을 확인하였다.

## 배포 서버 기준 RAW 20Hz Capacity 테스트 요약

#### 조건
- Rate: 20Hz 고정
- Sender Ratio: ≈ 0.1
- 서버: 배포 서버 (4 Core / 16GB)
- 목표 SLO: ≤200ms ≥ 90%

### 결과 요약 표

| Room Size | Sender | Fanout (room×sender×20) | ≤200ms     | ≤1000ms | 판정    |
| --------- | ------ | ----------------------- | ---------- | ------- | ----- |
| 200       | 20     | 80,000 send/s           | **1.15%**  | 8.20%   | ❌ 붕괴  |
| 150       | 15     | 45,000 send/s           | **0.73%**  | 7.82%   | ❌ 붕괴  |
| 125       | 12~13  | 31,250 send/s           | **22.64%** | 30.96%  | ❌ 불충분 |
| 110       | 11     | 24,200 send/s           | **57.64%** | 95.35%  | ⚠ 경계  |
| 100       | 20     | 40,000 send/s           | **3.15%**  | 29.73%  | ❌ 붕괴  |
| 100       | 10     | 20,000 send/s           | **98.47%** | 99.99%  | ✅ 통과  |

#### 개발환경, 배포환경간 차이
개발 환경은 구조 비교 및 병목 패턴 분석용으로 CPU 여유가 충분했으며,
Dirty + Drop 적용 시 99% 이상 SLO를 만족하였다.
반면 배포 환경은 4 Core 자원 제한 하에서 실제 운영 조건을 가정한 capacity 스윕을 수행하였으며, fanout 20,000 send/s 이상에서 CPU saturation으로 SLO가 붕괴하였다.
### 해석
1. 병목은 Rate가 아닌 Fanout이다
- fanout ≈ roomSize x sender x 20Hz -> 개발환경에서는 80,000 send/s도 무리없었지만 배포환경에서는 해당 SLO가 붕괴되었다.
2. SLO 통과 기준
- 배포 서버는 약 20,000 send/s 수준에서 안정되었다.
3. 동일한 룸 크기여도 Sender가 늘어나면 붕괴되었다.
- 즉, 동시 활성자 수가 더 치명적이었다.

### Capacity관련 
#### 1. SLO 기반 방 인원 상한 정의
배포 서버 기준 fanout 20,000 send/s 이하에서 SLO를 만족하였다. 실제 서비스는 평균 sender 비율을 0.1 이하로 가정할 경우,

roomSize × (roomSize × 0.1) × 20 ≤ 20,000

이를 기반으로 역산하면 roomSize ≈ 100 이하가 안정 범위이며,
안전 마진을 고려하여 50명으로 제한하였다.

#### 2. 네트워크 영향 배제 및 병목 지점 식별
테스트 환경은 클라이언트와 서버가 동일 LAN 환경이 아니므로
실제 인터넷 환경에서는 RTT 변동이 존재할 수 있다.

그러나 본 실험의 병목은 네트워크가 아닌 서버 내부 fanout 처리량에서 발생함을 fanout 스윕 결과를 통해 확인하였다.

#### 3. Worst-Case 가정 및 실제 사용 패턴 고려
실제 사용 패턴에서 커서 이동은 지속적인 20Hz 유지 상태보다 간헐적 burst 형태로 발생할 가능성이 높다.

따라서 본 실험은 worst-case 시나리오를 가정한 것이며, 실제 평균 부하는 이보다 낮을 것으로 예상된다

#### 4. 운영 정책 반영 및 확장 전략
본 실험을 통해 단순 최대 접속자 수가 아닌, room fanout 기반 SLO 안정 구간(≈ 20,000 send/s 이하) 을 정의하였다.

이를 바탕으로 다음과 같은 운영 정책을 수립하였다.

1. 방 인원 상한 설정
    - 20Hz 유지
    - 평균 Sender 비율 0.1 가정
    - fanout ≤ 20,000 send/s 유지
이를 토대로 안정 마진을 잡아 방당 50명으로 제한하였다.

2. 확장 전략 (Scale-out)
현재 구조는 단일 인스턴스 기준으로 잡은 운영 정책이며 차후 다음과 같이 확장이 가능하다.
    - 룸 단위 분산
    - WebSocket 인스턴스 수평 확장
    - Redis Pub/Sub 또는 Broker 기반 fanout 분산

3. 실시간 UX 보완 전략
Worst-case 부하 상황에서도 사용자 경험을 유지하기 위해 다음과 같이 전략 적용하였다.
    - 클라이언트 측 cursor interpolation 적용(클라에서 좌표를 선처럼 이어주는 방식)
    - Drop/Latest-only 전략 유지
