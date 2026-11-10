"use client";

import { MaterialsPanel } from "@/components/course-materials";
import { TopBar } from "@/components/top-bar";

/**
 * The library (fork, phase 3b2 — see FORK.md): /library. Every uploaded
 * material, whether or not it belongs to a course (owner, 2026-11-10: a
 * folder of old course material should upload without creating courses).
 */
export function Library() {
	return (
		<div className="flex h-dvh min-w-0 flex-col">
			<TopBar />
			<div className="min-h-0 flex-1 overflow-y-auto">
				<div className="mx-auto w-full max-w-[46rem] px-4 pb-6" data-testid="library">
					<MaterialsPanel />
				</div>
			</div>
		</div>
	);
}
