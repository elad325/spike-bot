import pino from 'pino';

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m',
};

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function format(level, color, args) {
  const ts = `${COLORS.gray}[${timestamp()}]${COLORS.reset}`;
  const lvl = `${color}${level.padEnd(5)}${COLORS.reset}`;
  return [ts, lvl, ...args];
}

export const log = {
  info: (...args) => console.log(...format('INFO', COLORS.cyan, args)),
  warn: (...args) => console.warn(...format('WARN', COLORS.yellow, args)),
  error: (...args) => console.error(...format('ERROR', COLORS.red, args)),
  success: (...args) => console.log(...format('OK', COLORS.green, args)),
  debug: (...args) => {
    if (process.env.LOG_LEVEL === 'debug') {
      console.log(...format('DEBUG', COLORS.gray, args));
    }
  },
};

export const baileysLogger = pino({ level: 'silent' });
