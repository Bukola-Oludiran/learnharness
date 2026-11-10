import { evidenceView } from "@/src/server";

export const dynamic = "force-dynamic";

/** Every idea's derived state and the results behind it (fork, phase 3b).
 *  The graph view joins this to upstream's snapshot; upstream's own graph
 *  endpoint is unchanged. */
export async function GET() {
	return Response.json(evidenceView());
}
