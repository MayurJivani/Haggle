import { monitorEventLoopDelay } from 'node:perf_hooks';

const loop = monitorEventLoopDelay({ resolution: 20 });
loop.enable();

export const metrics = {
  sockets: 0,
  players: 0,
  ticks: 0,
  tickLagMs: 0,
  orders: { filled: 0, rejected: 0, duplicate: 0, failed: 0 },
  orderLatencyMs: { sum: 0, count: 0 },
  bytesOut: 0,
  dbErrors: 0,
};

/** Prometheus text exposition, written by hand: a dozen gauges do not need a client library. */
export function renderMetrics(): string {
  const m = metrics;
  return [
    `lb_sockets ${m.sockets}`,
    `lb_players ${m.players}`,
    `lb_ticks_total ${m.ticks}`,
    `lb_tick_lag_ms ${m.tickLagMs}`,
    ...Object.entries(m.orders).map(([k, v]) => `lb_orders_total{result="${k}"} ${v}`),
    `lb_order_latency_ms_sum ${m.orderLatencyMs.sum}`,
    `lb_order_latency_ms_count ${m.orderLatencyMs.count}`,
    `lb_bytes_out_total ${m.bytesOut}`,
    `lb_db_errors_total ${m.dbErrors}`,
    `lb_event_loop_delay_p99_ms ${(loop.percentile(99) / 1e6).toFixed(2)}`,
    `lb_heap_used_bytes ${process.memoryUsage().heapUsed}`,
    '',
  ].join('\n');
}
