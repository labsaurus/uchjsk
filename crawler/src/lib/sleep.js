/** Abortable sleep. Rejects with the signal's reason when aborted. */
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    if (ms <= 0) return resolve();
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Uniform random integer in [0, max]. */
export function jitter(max) {
  return max > 0 ? Math.floor(Math.random() * (max + 1)) : 0;
}
