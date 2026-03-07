- jmc 본부하만
  30RPS -> 100RPS
  INFO[0222] [DEBUG] mainCount=8498 source=console
  INFO[0222] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0222] [DEBUG] testRunDurationMs=221689.1267 source=console  
  INFO[0222] [DEBUG] mainRps_active=94.42222222222222 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 6968.06 ms  
  p95 latency: 10103.76 ms  
  throughput: 38.33 req/s (avg over test)  
  throughput(active): 94.42 req/s (active-window)
  fail rate: 0.00%

- V1 30 -> 60RPS
  INFO[0221] [DEBUG] mainCount=5380 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0221] [DEBUG] testRunDurationMs=220897.3634 source=console  
  INFO[0221] [DEBUG] mainRps_active=59.77777777777778 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 2020.30 ms  
  p95 latency: 7317.39 ms  
  throughput: 24.36 req/s (avg over test)  
  throughput(active): 59.78 req/s (active-window)
  fail rate: 0.00%

- V1-re 30 -> 60RPS - 이걸로 jmc문서
  INFO[0222] [DEBUG] mainCount=5355 source=console
  INFO[0222] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
   INFO[0222] [DEBUG] testRunDurationMs=221221.5564 source=console  
   INFO[0222] [DEBUG] mainRps_active=59.5 source=console  
   === k6 Summary (phase:main) ===
  avg latency: 2010.29 ms
  p95 latency: 7419.67 ms
  throughput: 24.21 req/s (avg over test)
  throughput(active): 59.50 req/s (active-window)
  fail rate: 0.00%
- V1-re2 30 -> 60RPS
  INFO[0221] [DEBUG] mainCount=5342 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0221] [DEBUG] testRunDurationMs=220747.4442 source=console  
  INFO[0221] [DEBUG] mainRps_active=59.355555555555554 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 2547.28 ms  
  p95 latency: 8515.43 ms  
  throughput: 24.20 req/s (avg over test)  
  throughput(active): 59.36 req/s (active-window)
  fail rate: 0.00%

- V2 30 -> 60RPS
  INFO[0222] [DEBUG] mainCount=5384 source=console
  INFO[0222] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
   INFO[0222] [DEBUG] testRunDurationMs=221326.8029 source=console  
   INFO[0222] [DEBUG] mainRps_active=59.82222222222222 source=console  
   === k6 Summary (phase:main) ===  
   avg latency: 1677.57 ms  
   p95 latency: 7027.21 ms  
   throughput: 24.33 req/s (avg over test)  
   throughput(active): 59.82 req/s (active-window)
  fail rate: 0.00%

- V2-re2 30 -> 60RPS - 이걸로 jmc문서
  INFO[0222] [DEBUG] mainCount=5392 source=console
  INFO[0222] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
   INFO[0222] [DEBUG] testRunDurationMs=221878.1091 source=console  
   INFO[0222] [DEBUG] mainRps_active=59.91111111111111 source=console  
   === k6 Summary (phase:main) ===  
   avg latency: 1614.43 ms  
   p95 latency: 6908.74 ms  
   throughput: 24.30 req/s (avg over test)  
   throughput(active): 59.91 req/s (active-window)
  fail rate: 0.00%
- V2-re3 30 -> 60RPS - 이건 삭제
  INFO[0221] [DEBUG] mainCount=5363 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0221] [DEBUG] testRunDurationMs=220469.4585 source=console  
  INFO[0221] [DEBUG] mainRps_active=59.58888888888889 source=console  
  === k6 Summary (phase:main) ===
  avg latency: 2170.87 ms
  p95 latency: 7597.39 ms
  throughput: 24.33 req/s (avg over test)
  throughput(active): 59.59 req/s (active-window)
  fail rate: 0.00%
- V2-re4 30 -> 60RPS
  INFO[0221] [DEBUG] mainCount=5391 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0221] [DEBUG] testRunDurationMs=220956.7257 source=console  
  INFO[0221] [DEBUG] mainRps_active=59.9 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 1488.63 ms  
  p95 latency: 6460.37 ms  
  throughput: 24.40 req/s (avg over test)  
  throughput(active): 59.90 req/s (active-window)
  fail rate: 0.00%

- V0 30 -> 60RPS
  INFO[0221] [DEBUG] mainCount=5365 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
   INFO[0221] [DEBUG] testRunDurationMs=220913.9701 source=console  
   INFO[0221] [DEBUG] mainRps_active=59.611111111111114 source=console  
   === k6 Summary (phase:main) ===  
   avg latency: 2164.54 ms  
   p95 latency: 7622.90 ms  
   throughput: 24.29 req/s (avg over test)  
   throughput(active): 59.61 req/s (active-window)
  fail rate: 0.00%

- V0-re 30 -> 60RPS
  INFO[0221] [DEBUG] mainCount=5334 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
   INFO[0221] [DEBUG] testRunDurationMs=220867.1964 source=console  
   INFO[0221] [DEBUG] mainRps_active=59.266666666666666 source=console  
   === k6 Summary (phase:main) ===  
   avg latency: 2634.84 ms  
   p95 latency: 8488.78 ms  
   throughput: 24.15 req/s (avg over test)  
   throughput(active): 59.27 req/s (active-window)
  fail rate: 0.00%

- V0-re2 30 -> 60RPS
  INFO[0221] [DEBUG] mainCount=5368 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
   INFO[0221] [DEBUG] testRunDurationMs=221102.9093 source=console  
   INFO[0221] [DEBUG] mainRps_active=59.644444444444446 source=console  
   === k6 Summary (phase:main) ===  
   avg latency: 2099.21 ms  
   p95 latency: 7348.87 ms  
   throughput: 24.28 req/s (avg over test)  
   throughput(active): 59.64 req/s (active-window)
  fail rate: 0.00%
- V0-re3 30 -> 60RPS
  INFO[0221] [DEBUG] mainCount=5362 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0221] [DEBUG] testRunDurationMs=220495.5812 source=console  
  INFO[0221] [DEBUG] mainRps_active=59.577777777777776 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 2266.20 ms  
  p95 latency: 7595.34 ms  
  throughput: 24.32 req/s (avg over test)  
  throughput(active): 59.58 req/s (active-window)
  fail rate: 0.00%

- 2step 30->60
  INFO[0222] [DEBUG] mainCount=5389 source=console
  INFO[0222] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0222] [DEBUG] testRunDurationMs=221786.561 source=console  
  INFO[0222] [DEBUG] mainRps_active=59.87777777777778 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 1975.87 ms  
  p95 latency: 7260.43 ms  
  throughput: 24.30 req/s (avg over test)  
  throughput(active): 59.88 req/s (active-window)
  fail rate: 0.00%

- 2step-re1 30->60
  INFO[0220] [DEBUG] mainCount=5393 source=console
  INFO[0220] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0220] [DEBUG] testRunDurationMs=220408.4723 source=console  
  INFO[0220] [DEBUG] mainRps_active=59.922222222222224 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 2020.98 ms  
  p95 latency: 7313.08 ms  
  throughput: 24.47 req/s (avg over test)  
  throughput(active): 59.92 req/s (active-window)
  fail rate: 0.00%
- 2step-re2 30->60
  INFO[0221] [DEBUG] mainCount=5366 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0221] [DEBUG] testRunDurationMs=220788.0027 source=console  
  INFO[0221] [DEBUG] mainRps_active=59.62222222222222 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 1796.53 ms  
  p95 latency: 7011.09 ms  
  throughput: 24.30 req/s (avg over test)  
  throughput(active): 59.62 req/s (active-window)
  fail rate: 0.00%

- 2step-re3 30->60
  INFO[0221] [DEBUG] mainCount=5368 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0221] [DEBUG] testRunDurationMs=220641.704 source=console  
  INFO[0221] [DEBUG] mainRps_active=59.644444444444446 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 1975.89 ms  
  p95 latency: 7452.96 ms  
  throughput: 24.33 req/s (avg over test)  
  throughput(active): 59.64 req/s (active-window)
  fail rate: 0.00%

- 30 -> 50RPS

INFO[0221] [DEBUG] mainCount=4500 source=console
INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
INFO[0221] [DEBUG] testRunDurationMs=220800.37 source=console  
INFO[0221] [DEBUG] mainRps_active=50 source=console  
=== k6 Summary (phase:main) ===  
avg latency: 1114.80 ms  
p95 latency: 5706.16 ms  
throughput: 20.38 req/s (avg over test)  
throughput(active): 50.00 req/s (active-window)
fail rate: 0.00%
\

- 1만자 실패 8 -> 20
  INFO[0223] [DEBUG] mainCount=1800 source=console
  INFO[0223] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0223] [DEBUG] testRunDurationMs=223102.1498 source=console  
  INFO[0223] [DEBUG] mainRps_active=20 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 6307.46 ms  
  p95 latency: 11257.29 ms  
  throughput: 8.07 req/s (avg over test)  
  throughput(active): 20.00 req/s (active-window)
  fail rate: 0.00%

=== k6 Summary (overall) ===
avg latency: 3606.82 ms
p95 latency: 10680.70 ms
throughput: 15.07 req/s
fail rate: 0.83%

- 1만자 성공 8->15
  INFO[0221] [DEBUG] mainCount=1350 source=console
  INFO[0221] [DEBUG] expectedCount(rate\*duration)=1200 source=console  
  INFO[0221] [DEBUG] testRunDurationMs=220809.2718 source=console  
  INFO[0221] [DEBUG] mainRps_active=15 source=console  
  === k6 Summary (phase:main) ===  
  avg latency: 453.84 ms  
  p95 latency: 2271.19 ms  
  throughput: 6.11 req/s (avg over test)  
  throughput(active): 15.00 req/s (active-window)
  fail rate: 0.00%
