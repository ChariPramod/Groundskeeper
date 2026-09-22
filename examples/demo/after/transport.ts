export function connect(host: string, timeout = 60): string {
  return `${host}:${timeout}`;
}
