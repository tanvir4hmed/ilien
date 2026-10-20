/** Model/command view only. The full provider text remains immutable evidence. */
export function authoredReplyText(text: string) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const boundary = lines.findIndex(
    (line, i) =>
      /^\s*>/.test(line) ||
      /^\s*-{2,}\s*(Original Message|Forwarded message)/i.test(line) ||
      (/^\s*On\s/.test(line) &&
        lines
          .slice(i, i + 4)
          .join(" ")
          .includes("wrote:")),
  );
  return (boundary < 0 ? lines : lines.slice(0, boundary)).join("\n").trim();
}
