// Tiny structured JSON logger (one line per event; journald friendly).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(level = 'info', base = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl, msg, fields) => {
    if (LEVELS[lvl] < threshold) return;
    const line = { ts: new Date().toISOString(), level: lvl, msg, ...base, ...fields };
    const out = lvl === 'error' || lvl === 'warn' ? process.stderr : process.stdout;
    out.write(JSON.stringify(line, errorReplacer) + '\n');
  };
  return {
    debug: (msg, f) => emit('debug', msg, f),
    info: (msg, f) => emit('info', msg, f),
    warn: (msg, f) => emit('warn', msg, f),
    error: (msg, f) => emit('error', msg, f),
    child: (extra) => createLogger(level, { ...base, ...extra }),
  };
}

function errorReplacer(_key, value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, code: value.code };
  }
  return value;
}

export const silentLogger = {
  debug() {}, info() {}, warn() {}, error() {},
  child() { return silentLogger; },
};
