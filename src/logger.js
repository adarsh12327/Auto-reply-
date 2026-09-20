const levels = { debug: 10, info: 20, warn: 30, error: 40 };

function write(level, message, meta = {}) {
  const configured = levels[process.env.LOG_LEVEL || 'info'] ?? 20;
  if (levels[level] < configured) return;
  console.log(JSON.stringify({ time: new Date().toISOString(), level, message, ...meta }));
}

export const logger = {
  debug: (m, x) => write('debug', m, x),
  info: (m, x) => write('info', m, x),
  warn: (m, x) => write('warn', m, x),
  error: (m, x) => write('error', m, x)
};
