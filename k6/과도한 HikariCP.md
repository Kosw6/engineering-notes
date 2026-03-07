# 배포서버 부하 테스트 구축 보고서

**시행일자:** 2025-10-17  
**테스트 목적:** 배포 서버 환경에서 k6 부하 테스트를 통한 응답 지연(p95) 원인 분석 및 임계점 탐색

---

## 1. 서버 환경

| 항목    | 사양                       |
| ------- | -------------------------- |
| 모델    | FIREBAT                    |
| CPU     | 4 Core                     |
| RAM     | 4 GB                       |
| Storage | 512 GB SSD                 |
| OS      | Ubuntu 24.04 (Docker 기반) |

---

## 2. 시스템 구성

**배포 프로세스**

- Java Spring Boot 애플리케이션을 빌드하여 Docker Hub에 이미지로 Push
- 배포 서버에서 `docker-compose.yml` 기반으로 Pull 및 실행

**서비스 구성 컨테이너**

1. Java / Tomcat / Spring
2. PostgreSQL (Timescale Extension)
3. Prometheus + Grafana + Exporters
   - postgres-exporter
   - node-exporter (호스트/컨테이너 메트릭)
   - cAdvisor (컨테이너별 CPU/메모리)

---

## 3. Grafana Dashboard 구성

### 3.1 Application (Spring)

- RPS
- Error Rate
- P95 / P99 Latency
- JVM Heap Usage (%)
- Tomcat Thread (Busy / Current / Max)
- HikariCP (Active / Idle / Max)
- GC Pause Count / Time

### 3.2 Container (cAdvisor)

- Container CPU Usage
- Container Memory Usage
- Container Filesystem Usage

### 3.3 Database (Postgres Exporter)

- Cache Hit Ratio
- Deadlocks
- TPS (Transactions per Second)
- Active / Idle / Total Connections

### 3.4 Node (Node Exporter)

- CPU Usage
- CPU IO Wait
- Memory Usage
- Filesystem Usage
- Disk IO Time

### 3.5 Overview

- 주요 Application / Container / Node 지표를 종합 모니터링

---

## 4. 네트워크 환경

- 테스트 클라이언트: 노트북 (8Core / 64GB RAM)
- 서버: FIREBAT (4Core / 4GB)
- 연결: CAT6 LAN 케이블 직접 연결 (유선)
- 왕복 지연 시간: 평균 **0.7 ms** — 네트워크 영향 미미

---

## 5. 문제점 요약

- 동일한 Docker 이미지 및 설정 환경에서 **노트북과 서버 간 p95 응답속도 차이 약 7~10배**
- 네트워크 지연은 무시 가능한 수준임(avg:~2ms)
- ***

## 6. 1차 원인 가설

1. **서버 사양 한계로 인한 CPU 및 Thread 포화**
   - 대부분의 스레드가 DB I/O 대기로 묶이며 큐잉 발생
2. **Docker CPU / Memory 제한**
   - Compose 설정에서 `cpus`, `mem_limit` 혹은 `deploy.resources.limits` 존재 가능
3. **PostgreSQL (Timescale) I/O 지연**
   - HDD 또는 low IOPS 환경에서 read latency 증가

---

## 7. 원인 해결 시나리오 및 개선

1. 서버 사양 비교
   - 비교적 가벼운 테스트로도 서버의 CPU 100% 사용
   - 같은 매트릭으로 노트북의 경우 9.32%
   - CPU,Disk,Memory 사용률은 각 노드마다 비율은 비슷함
   - 결론 : 서버 사양으로 인한 문제는 아니라고 판단
2. Docker CPU / Memory 제한
   - 같은 도커 설정으로 실행
   - 직접 서버의 컨테이너 메모리 제한 확인 결과 제한 없음
   - 결론 : 컨테이너 자원 제한으로 인한 문제는 아니라고 판단
3. DB지연
   - 애플리케이션 Error Rate 증가
   - HikariCP Connections active 폭등하여 Max에 막힘, Idle 0 -> 풀이 꽉 차서 병목 발행
   - 동시에 GC count/second 급등
   - Tomcat Thread의 current,busy 급등하여 Max에 막힘
   - 결론 : DB포화로 진단

### 8.해결방법

- DB포화로 진단하였기 때문에 Postgres설정 변경
- 커넥션 150개 -> 이전에도 매트릭에 130언저리여서 큰 체감없음
- 버퍼 1GB + 캐쉬 사이즈 3GB -> 매모리 캐시가 커져 디스크I/O감소, 같은 쿼리여도 성능 향상 -> 커넥션 점유시간 하락
- work_mem=16MB -> 정렬/해시 조인/집계가 메모리 내에서 끝나서 임시 파일 크게 줄임 -> 쿼리 속도 향상
- effective_cache_size 향상으로 인덱스/조인 전략 선택이 좋아져 쿼리 성능 향상

### 9.결론

- work_mem,effective_cache_size,buffer 설정을 변경해가면서 테스트 경과 work_mem, effective_cache_size는 성능 소폭 상향
- 주된 해결책 : buffer size 상향 -> 에러율 0, GC count 0.0847ops/s -> 0.00339ops/s 25배 줄임
- Tomcat 쓰레드 정상화, HikariCP 커넥션 정상화

![개선 그래프](../image/1.db_before_after.png)

- before:1시10분경, after:1시40분경

## 10. 향후 계획 (요약)

| 단계 | 목표           | 주요 작업                                             |
| ---- | -------------- | ----------------------------------------------------- |
| 1차  | 임계점 탐색    | constant-arrival-rate RPS 스윕 테스트로 한계 RPS 측정 |
| 2차  | 임계 근방 튜닝 | CPU/GC/DB 쿼리 등 병목별 성능 개선 및 비교 문서화     |

---
