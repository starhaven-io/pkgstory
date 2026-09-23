// Ruby call arguments may continue onto later lines after a trailing comma, with any
// alignment, so follow the comma chain rather than trusting indent.
export function continuedStatement(src: string, start: number): string {
  const lines = src.slice(start).split("\n");
  const stanza = [lines[0] ?? ""];
  let continuation = stanza[0]?.trimEnd().endsWith(",") ?? false;
  for (const line of lines.slice(1)) {
    if (!continuation) break;
    stanza.push(line);
    if (/^\s*(?:#.*)?$/.test(line)) continue;
    continuation = line.trimEnd().endsWith(",");
  }
  return stanza.join("\n");
}
