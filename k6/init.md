# Performance Testing Report

## 1. API별 초기 테스트 (Baseline)

- StockController.range: avg 120ms, p95 420ms ❌
- AuthController.login: avg 30ms, p95 50ms ✅
- ...

## 2. 병목 분석 & 개선

- StockController.range 쿼리 인덱스 미비 발견
- 개선: (symb, timestamp DESC) 인덱스 추가
- 결과: p95 420ms → 95ms로 개선

## 3. 리팩토링 적용 후 API별 재테스트

- StockController.range: avg 40ms, p95 95ms ✅
- ...

## 4. 혼합 워크로드 최종 테스트

- 50 RPS: avg 10ms, p95 30ms, 오류율 0%
- 100 RPS: avg 20ms, p95 60ms, 오류율 <1%
- 200 RPS: avg 35ms, p95 120ms, 오류율 <1%

## 5. 결론

- 모든 API 성능 안정화 완료
- 혼합 워크로드 200 RPS까지 목표 SLO 달성
