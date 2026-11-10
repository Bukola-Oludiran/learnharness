"use client";

import { useEffect, useState } from "react";
import { TopBar } from "@/components/top-bar";
import { cleanPlotDoc, emptyPlotDoc, type PlotDoc } from "@/src/core";
import { Grapher } from "./grapher";

/**
 * The grapher as a scratchpad (fork, phase 5b — see FORK.md): /grapher. One
 * scratch graph, kept in this browser's local storage; it belongs to no
 * session and is sent nowhere. To answer with a graph, use the Graph
 * button in a session.
 */

export const SCRATCH_KEY = "lh.grapher.scratch";

export function GrapherPage() {
	const [doc, setDoc] = useState<PlotDoc | null>(null);

	// Read after mount: local storage does not exist during server render.
	useEffect(() => {
		let stored: PlotDoc | null = null;
		try {
			stored = cleanPlotDoc(JSON.parse(window.localStorage.getItem(SCRATCH_KEY) ?? "null"));
		} catch {
			// a corrupt scratch graph starts blank
		}
		setDoc(stored && stored.lines.length > 0 ? stored : emptyPlotDoc());
	}, []);

	useEffect(() => {
		if (!doc) return;
		try {
			window.localStorage.setItem(SCRATCH_KEY, JSON.stringify(doc));
		} catch {
			// storage full or unavailable: the graph still works for this visit
		}
	}, [doc]);

	return (
		<div className="flex h-dvh min-w-0 flex-col" data-testid="grapher-page">
			<TopBar>
				<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Grapher</span>
				<span className="flex-1" />
				<button
					type="button"
					data-testid="grapher-clear"
					onClick={() => setDoc(emptyPlotDoc())}
					className="rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
				>
					Clear
				</button>
			</TopBar>
			{doc && <Grapher doc={doc} onChange={setDoc} className="flex-1" />}
		</div>
	);
}
