# EC2 비용 급증 분석 및 Linux 기반 마이그레이션

---

## 1. 문제 상황

AWS 비용 분석 중, 동일한 App/DB 서버 구조임에도 특정 EC2 인스턴스의 시간당 비용이 비정상적으로 높게 청구되는 현상을 확인하였다.

### 비용 예시

| 인스턴스                            | 시간당 비용        |
| ------------------------------- | ------------- |
| c6i.large (일반 Linux)            | 약 0.096 USD/h |
| c6i.large + SQL Server Standard | 약 0.287 USD/h |

약 3배 수준의 비용 차이가 발생하였다.

---

## 2. 원인 분석

AWS Billing 및 EC2 Platform 정보를 분석한 결과,
기존 인스턴스가 일반 Linux AMI가 아닌 다음 이미지 기반으로 생성된 상태였다.

```text
Linux with SQL Server Standard
```

즉,

* EC2 비용
* Microsoft SQL Server Standard 라이선스 비용

이 함께 과금되고 있었다.

실제 서비스는 PostgreSQL 기반으로 운영 중이었기 때문에,
SQL Server 라이선스 비용은 불필요한 상태였다.

---

## 3. 기존 구조의 문제점

기존 구조는 다음과 같은 특징을 가지고 있었다.

* OS와 상태 데이터가 강하게 결합
* Docker Image / Volume / DB Data가 인스턴스 내부에 의존
* 인스턴스 교체 시 데이터 이전 부담 존재
* 특정 Marketplace 이미지 의존 발생 가능

이 구조에서는:

* 비용 최적화
* 인스턴스 교체
* 장애 복구
* 운영 표준화

가 어렵다고 판단하였다.

---

## 4. 개선 방향

운영 환경을 다음과 같이 재구성하였다.

## Stateless OS + Stateful EBS 구조

### OS(AMI)

실행 환경만 포함:

* Docker
* Docker Compose
* Monitoring Agent
* Runtime Package
* 기본 설정

### EBS Volume

상태 데이터 저장:

* `/data/docker`
* Docker Image / Layer Cache
* Docker Volume
* `docker-compose.yml`
* `.env`
* PostgreSQL Data

---

## 5. 마이그레이션 절차

### 1) 기존 인스턴스 종료 준비

```bash
docker compose down
systemctl stop docker
umount /data
```

이후 기존 EBS를 detach하였다.

---

### 2) 일반 Linux 기반 신규 EC2 생성

* Ubuntu 기반 일반 AMI 사용
* SQL Server 포함 이미지 제거

---

### 3) Runtime 환경만 구성

```text
Docker
Docker Compose
AWS CLI
기본 운영 패키지
```

만 설치하였다.

---

### 4) EBS 재부착

기존 `/data` 볼륨을 attach 후 mount하였다.

```bash
mount /dev/nvme1n1p1 /data
```

이후 Docker data-root를 연결하였다.

```json
{
  "data-root": "/data/docker"
}
```

---

### 5) 서비스 복구

```bash
docker compose up -d
```

만으로 기존 환경을 복구하였다.

---

## 6. 구조 개선 효과

### 비용 절감

불필요한 SQL Server 라이선스 제거를 통해
시간당 비용을 크게 절감하였다.

| 항목      | 이전          | 이후          |
| ------- | ----------- | ----------- |
| App EC2 | 0.576 USD/h | 0.096 USD/h |
| DB EC2  | SQL 포함 이미지  | 일반 Linux    |

---

### 운영 구조 개선

기존:

```text
OS + 상태 데이터 결합
```

개선 후:

```text
Stateless OS
+
Stateful EBS
```

구조로 분리하였다.

이를 통해:

* 인스턴스 교체 단순화
* 장애 복구 시간 감소
* 비용 최적화 용이
* 환경 표준화
* 운영 자동화 기반 확보

가 가능해졌다.

---

## 7. EBS 기반 운영의 장점

### 스냅샷 기반 복제 가능

EBS Snapshot을 통해:

* 동일 환경 복제
* 테스트 서버 생성
* 운영 백업
* 장애 복구

를 빠르게 수행할 수 있다.

---

### AMI와 상태 데이터 분리

AMI는 실행 환경만 담당하고,
실제 상태 데이터는 EBS에서 관리하도록 분리하였다.

따라서:

* OS 재생성
* AMI 교체
* Auto Scaling
* Blue/Green 배포

등이 훨씬 단순해졌다.

---

## 8. 결과

이번 작업을 통해:

* 불필요한 라이선스 비용 제거
* 운영 환경 표준화
* 상태 데이터 분리
* EBS 기반 복구 구조 확보

를 수행하였다.

또한 단순 비용 절감뿐 아니라,

> 운영 가능한 최소 실행 환경과 상태 데이터를 분리하여,
> 인프라 교체 및 복구를 단순화하는 방향으로 구조를 개선하였다.
