// Classification of a single HTTP attempt, shared by the adaptive throttle and
// the circuit breaker.
export const Outcome = Object.freeze({
  OK: 'ok', //               2xx / expected 404 etc. (server healthy)
  RATE_LIMITED: 'rate_limited', // 429
  SERVER_ERROR: 'server_error', // 5xx, 408
  NETWORK: 'network', //     timeout, reset, DNS...
});

export function isFailure(outcome) {
  return outcome === Outcome.RATE_LIMITED || outcome === Outcome.SERVER_ERROR || outcome === Outcome.NETWORK;
}

export function classifyStatus(status) {
  if (status === 429) return Outcome.RATE_LIMITED;
  if (status === 408 || status >= 500) return Outcome.SERVER_ERROR;
  return Outcome.OK;
}
