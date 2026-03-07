## 통합 관점

### 요청 흐름

요청
<br>->Tomcat Thread <-> Thread pool(max-threads, timeout, concurrency등으로 쓰레드 개수, 대기 시간등 제어)
<br>->쓰레드가 앱 로직 처리 후 DB작업 구간 진입
<br>->Hikari Connection <-> Connection pool(maximumPoolSize, minimumIdle, maxLifetime등으로 풀 사이즈, 커넥션 시간등 제어)
<br>->PostgreSQL Backend Process에서 쿼리작업(MVCC, VACUUM으로 버전 관리 및 처리)

### 파트별 주요 발생 리스크

| 요소               | 주요 리스크                    | 완화 포인트                                    |
| ------------------ | ------------------------------ | ---------------------------------------------- |
| Tomcat Thread 고갈 | Thread < Connection mismatch   | `maxThreads vs maxPoolSize` 조정               |
| Hikari Pool 고갈   | Connection leak / timeout      | `leakDetectionThreshold` 및 적절한 idleTimeout |
| DB Backend 고갈    | max_connections 초과, long txn | Connection 재순환, VACUUM, 모니터링            |

### 환경설정 스니펫

Tomcat: max-threads, connection-timeout, acceptCount 예시.

Hikari: maximumPoolSize, minimumIdle, connectionTimeout, idleTimeout, maxLifetime, keepaliveTime 샘플.

Postgres: max_connections, shared_buffers, work_mem, autovacuum 파라미터, idle_in_transaction_session_timeout

### 트러블슈팅 플로우차트(요약)

에러율↑ or p95↑ → Tomcat busy? Hikari active? DB wait_event?

풀 고갈이면: 쿼리 슬로우/락/캐시 적중률 확인 → 필요 시 scale-out & 제한

DB wait이면: long txn/락 해소 → autovacuum/인덱스 점검

정상화 후: 타임아웃/용량 수치 재보정, 재발 방지 액션 기록

### 모니터링 매트릭

| 구분           | 주요 Metric (Prometheus 이름)                                                          | 의미 / 연결 설정                                      | 임계값(p95·비율 등)             | 조치 가이드                          |
| -------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------- | ------------------------------------ |
| **Tomcat**     | `tomcat_threads_busy`, `tomcat_threads_current`, `tomcat_threads_config_max`           | 현재 요청을 처리 중인 스레드 수와 전체 설정 스레드 수 | busy/max ≥ 0.9 → 경고           | Thread < Connection 유지 / scale-out |
|                | `http_server_requests_seconds_bucket`                                                  | 요청 지연도(p95, p99)                                 | p95 > 800 ms → 주의             | 특정 URI 슬로우 로그 확인            |
| **HikariCP**   | `hikaricp_connections_active`, `hikaricp_connections_idle`, `hikaricp_connections_max` | active vs idle vs pool max 비율                       | active/max ≥ 0.9 → 풀 고갈 의심 | DB 슬로우 / 풀 증설 검토             |
|                | `hikaricp_connections_borrowed` (또는 custom Trend)                                    | 커넥션 대여 시간 (ms)                                 | p95 > 50 ms → 경고              | connectionTimeout 짧음 or DB 지연    |
| **JVM / App**  | `jvm_memory_used_bytes`, `process_cpu_usage`, `system_load_average_1m`                 | 메모리·CPU 사용률                                     | CPU > 80 % → 주의               | GC 튜닝 or 스레드 조절               |
| **PostgreSQL** | `pg_stat_activity_count`, `pg_connections`                                             | 현재 연결 수 / DB 백엔드 상태                         | connections/max > 0.85 → 경고   | max_connections or pool 조정         |
|                | `pg_stat_database_xact_commit`, `pg_stat_database_xact_rollback`                       | 트랜잭션 commit/rollback 비율                         | rollback > 5 % → 주의           | 오류 원인 점검                       |
|                | `pg_stat_all_tables_n_dead_tup`                                                        | dead tuple 누적량                                     | 급증 → VACUUM 지연 의심         | long txn 확인                        |
|                | `pg_locks` / `pg_stat_activity_wait_event`                                             | 락 대기 상황                                          | waiting 세션 > 0 지속 → 주의    | 락 원인 SQL kill or 튜닝             |
