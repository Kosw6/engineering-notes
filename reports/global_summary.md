# API Performance Overview (k6 Benchmark Summary)

엔드포인트
목표 성능 : 600RPS, P95 < 300ms, ErrorRate=0
<br>

| Controller          | Endpoint             | Avg (ms) | P95 (ms) | Fail % | Drop % | Status |
| ------------------- | -------------------- | -------- | -------- | ------ | ------ | ------ |
| StockController     | `/api/stock/range`   | 13.5     | 33.8     | 0.0    | 0.2    | ✅     |
| StockController     | `/api/stock/latest`  | 11.2     | 22.7     | 0.0    | 0.1    | ✅     |
| UserController      | `/api/user/register` | 18.4     | 41.5     | 0.1    | 0.3    | ✅     |
| PortfolioController | `/api/portfolio/get` | 16.8     | 38.9     | 0.0    | 0.1    | ✅     |

> ✅ All tests conducted without caching.  
> Average P95 across 20 endpoints: **31.7 ms**

각 api마다 보고서 링크 걸기
[Report](/k6/controllers/StockController/stock_range_k6_report.md)
