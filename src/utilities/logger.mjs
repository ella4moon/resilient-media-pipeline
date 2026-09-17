const levels = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
export function createLogger(level = 'info', stream = process.stdout) {
  return Object.fromEntries(['debug', 'info', 'warn', 'error'].map(name => [name, (event, fields = {}) => {
    if (levels[name] >= (levels[level] ?? levels.info)) {
      stream.write(JSON.stringify({ time: new Date().toISOString(), level: name, event, ...fields }) + '\n');
    }
  }]));
}
