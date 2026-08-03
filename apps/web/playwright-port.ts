export function resolvePlaywrightPort(defaultPort: number, value: string | undefined): number {
  if (value === undefined) {
    return defaultPort;
  }

  if (!/^[1-9]\d{0,4}$/.test(value)) {
    throw new Error('AIQ_PLAYWRIGHT_PORT must be a canonical TCP port from 1 to 65535.');
  }

  const port = Number(value);
  if (port > 65_535) {
    throw new Error('AIQ_PLAYWRIGHT_PORT must be a canonical TCP port from 1 to 65535.');
  }

  return port;
}

export function resolvePlaywrightCompanionPort(port: number): number {
  return port === 65_535 ? port - 1 : port + 1;
}
