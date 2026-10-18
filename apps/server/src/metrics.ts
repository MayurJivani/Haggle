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
    `hg_sockets ${m.sockets}`,
    `hg_players ${m.players}`,
    `hg_ticks_total ${m.ticks}`,
    `hg_tick_lag_ms ${m.tickLagMs}`,
    ...Object.entries(m.orders).map(([k, v]) => `hg_orders_total{result="${k}"} ${v}`),
    `hg_order_latency_ms_sum ${m.orderLatencyMs.sum}`,
    `hg_order_latency_ms_count ${m.orderLatencyMs.count}`,
    `hg_bytes_out_total ${m.bytesOut}`,
    `hg_db_errors_total ${m.dbErrors}`,
    `hg_event_loop_delay_p99_ms ${(loop.percentile(99) / 1e6).toFixed(2)}`,
    `hg_heap_used_bytes ${process.memoryUsage().heapUsed}`,
    '',
  ].join('\n');
}
