"use client";

import { useState } from "react";
import { useImageSnapshot } from "@/components/artifacts/use-image-snapshot";
import { cn } from "@/lib/utils";

/**
 * The transcript's thumbnails for an answer's photos (fork, phase 2 — see
 * FORK.md). Each id resolves through the session's existing image-snapshot
 * route; clicking a thumbnail opens the photo full size.
 */

function Thumb({ snapshotId }: { snapshotId: string }) {
	const { image, failed } = useImageSnapshot(snapshotId);
	const [open, setOpen] = useState(false);
	if (failed) {
		return (
			<span data-testid="attachment-thumb-missing" className="flex size-20 items-center justify-center rounded-md border border-border/70 text-xs text-muted-foreground">
				Photo unavailable
			</span>
		);
	}
	if (!image) return <span className="size-20 rounded-md border border-border/70 bg-muted/40" aria-hidden />;
	const src = `data:${image.mimeType};base64,${image.data}`;
	return (
		<>
			<button
				type="button"
				data-testid="attachment-thumb"
				aria-label="Open the attached photo"
				onClick={() => setOpen(true)}
				className="size-20 overflow-hidden rounded-md border border-border/70"
			>
				{/* eslint-disable-next-line @next/next/no-img-element -- a session snapshot served as data */}
				<img src={src} alt="Attached photo of your work" className="size-full object-cover" />
			</button>
			{open && (
				<div
					role="dialog"
					aria-modal="true"
					aria-label="Attached photo"
					className="fixed inset-0 z-50 flex items-center justify-center bg-background/90 p-6"
					onClick={() => setOpen(false)}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							event.stopPropagation();
							setOpen(false);
						}
					}}
				>
					{/* eslint-disable-next-line @next/next/no-img-element -- a session snapshot served as data */}
					<img src={src} alt="Attached photo of your work" className="max-h-full max-w-full rounded-lg border object-contain" />
				</div>
			)}
		</>
	);
}

/** The transcript's thumbnails for an answer's photos. Renders nothing when none. */
export function AttachmentThumbs({ ids, className }: { ids?: readonly string[]; className?: string }) {
	if (!ids || ids.length === 0) return null;
	return (
		<div data-testid="attachment-thumbs" className={cn("flex flex-wrap gap-2", className)}>
			{ids.map((id) => (
				<Thumb key={id} snapshotId={id} />
			))}
		</div>
	);
}
