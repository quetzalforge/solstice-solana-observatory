import { collectPulse, snapshotToMarkdown } from "../../../lib/pulse";

export const runtime = "edge";

export async function GET(request: Request) {
  const snapshot = await collectPulse();
  const format = new URL(request.url).searchParams.get("format");

  if (format === "json") {
    return new Response(JSON.stringify(snapshot, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="solstice-snapshot.json"',
      },
    });
  }

  return new Response(snapshotToMarkdown(snapshot), {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": 'attachment; filename="solstice-report.md"',
    },
  });
}
