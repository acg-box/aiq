export function nextWebServerCommand(port: number): string {
  const start = `npm run start -- --hostname 127.0.0.1 --port ${String(port)}`;
  return process.env.AIQ_PLAYWRIGHT_PREBUILT === '1' ? start : `npm run build && ${start}`;
}
