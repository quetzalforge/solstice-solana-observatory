import { collectPulse } from "../../../lib/pulse";

export const runtime = "edge";

export async function GET() {
  const snapshot = await collectPulse();
  return Response.json(snapshot, {
    headers: {
      "Cache-Control": "public, max-age=120, stale-while-revalidate=300",
    },
  });
}
