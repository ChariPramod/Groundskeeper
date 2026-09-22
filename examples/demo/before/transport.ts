export function connect(host: string, timeout = 30): string {
  return `${host}:${timeout}`;
}
