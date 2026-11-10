import { materials } from "@/src/server";

/** POST /api/materials/retry (fork, phase 3b2): restart every failed or
 *  interrupted material — after a usage limit, or a restart mid-folder. */
export async function POST() {
	return Response.json({ retried: materials.retryAllMaterials() });
}
