"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";
import type { EvidenceOutcome, EvidenceView, IdeaResult, IdeaState } from "@/src/core";

/**
 * Learner evidence in the graph view (fork, phase 3b — see FORK.md): the
 * state tint each idea carries on the map, and the dated results list in
 * its detail card. The data comes from the fork's own endpoint
 * (/api/graph/evidence) and is joined to upstream's snapshot here, in the
 * view — upstream's graph endpoint and read model are untouched.
 */

/** Map tints, as hex (the canvas renderer takes resolved colours). Ideas
 *  without results keep the map's own single colour. */
export const STATE_TINT: Partial<Record<IdeaState, string>> = {
	demonstrated: "#55d3a4",
	shaky: "#f2c14e",
	missed: "#ff8f85",
};

const STATE_LABEL: Record<IdeaState, string> = {
	unseen: "Unseen",
	taught: "Taught",
	demonstrated: "Demonstrated",
	shaky: "Shaky",
	missed: "Missed",
};
const STATE_HINT: Record<IdeaState, string> = {
	unseen: "From uploaded material. No session has covered it and there are no results.",
	taught: "A session covered it. No results yet.",
	demonstrated: "Your latest result is correct and your recent results are strong.",
	shaky: "Your recent results are mixed.",
	missed: "Your latest result is wrong and your recent results are weak.",
};
const OUTCOME_LABEL: Record<EvidenceOutcome, string> = { correct: "Correct", partial: "Partial", wrong: "Wrong" };
const ORIGIN_LABEL: Record<IdeaResult["from"], string> = { test: "Test", practice: "Practice", quiz: "Quiz", probe: "Probe" };

/** The tint for a map node, or undefined to keep the default colour. */
export function stateTint(view: EvidenceView | null, nodeId: string): string | undefined {
	const state = view?.states[nodeId];
	return state ? STATE_TINT[state] : undefined;
}

/** The evidence view, refetched when the ledger or the graph changes. */
export function useEvidenceView(refreshTick: unknown): EvidenceView | null {
	const [view, setView] = useState<EvidenceView | null>(null);
	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/graph/evidence", { cache: "no-store" });
			if (res.ok) setView((await res.json()) as EvidenceView);
		} catch {
			// a transient failure keeps the last view; the map simply stays untinted
		}
	}, []);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			void refresh();
		}, 250);
	};
	useServerEvent("evidence-changed", schedule);
	useServerResync(() => void refresh());
	useEffect(() => {
		void refresh();
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [refresh, refreshTick]);
	return view;
}

function shortDate(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The detail card's evidence block. Pure — exported for render tests.
 *  Renders nothing until the view has loaded. */
export function IdeaEvidence({ view, nodeId }: { view: EvidenceView | null; nodeId: string }) {
	const state = view?.states[nodeId];
	if (!view || !state) return null;
	const results = view.results[nodeId] ?? [];
	const tint = STATE_TINT[state];
	return (
		<div className="mt-3 border-t border-border/60 pt-3" data-testid="idea-evidence" data-state={state}>
			<div className="flex items-center gap-1.5 text-xs">
				<span
					aria-hidden
					className={cn("size-2 shrink-0 rounded-full", !tint && "bg-muted-foreground/40")}
					style={tint ? { backgroundColor: tint } : undefined}
				/>
				<span className="font-medium text-foreground" data-testid="idea-state">
					{STATE_LABEL[state]}
				</span>
			</div>
			<div className="mt-1 text-xs text-muted-foreground">{STATE_HINT[state]}</div>
			{results.length > 0 && (
				<ul className="mt-2 flex max-h-48 flex-col gap-2 overflow-y-auto" data-testid="idea-results">
					{results.map((result) => (
						<li key={result.id} className="text-xs" data-testid="idea-result" data-outcome={result.outcome}>
							<div className="flex items-baseline gap-1.5">
								<span
									className={cn(
										"shrink-0 font-medium",
										result.outcome === "correct" && "text-good",
										result.outcome === "partial" && "text-warn",
										result.outcome === "wrong" && "text-bad",
									)}
								>
									{OUTCOME_LABEL[result.outcome]}
								</span>
								<span className="shrink-0 text-muted-foreground">
									{ORIGIN_LABEL[result.from]} · {shortDate(result.at)}
								</span>
								{result.source.href ? (
									<Link href={result.source.href} className="min-w-0 truncate text-foreground underline-offset-2 hover:underline">
										{result.source.label}
									</Link>
								) : (
									<span className="min-w-0 truncate text-muted-foreground">{result.source.label}</span>
								)}
							</div>
							{result.summary && <div className="mt-0.5 leading-relaxed text-muted-foreground">{result.summary}</div>}
						</li>
					))}
				</ul>
			)}
		</div>
	);
}
