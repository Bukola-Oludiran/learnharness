/**
 * Material contracts (fork, phase 3a — see FORK.md). A material is one
 * uploaded file the app keeps its OWN copy of (data/materials/<id>/), so a
 * moved or deleted original breaks nothing. Phase 3a ingests notes; tests
 * (3b) and books (phase 4) extend the same record.
 */

export const CURRENT_MATERIAL_VERSION = 1;
export const MATERIAL_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
/** One upload's size cap — upstream's notes-import bound. */
export const MAX_MATERIAL_BYTES = 25 * 1024 * 1024;

export type MaterialKind = "book" | "notes" | "test";
export type MaterialFormat = "pdf" | "pptx" | "epub" | "text" | "image";
/**
 * processing — converting to text, or extracting into the graph (`stage`)
 * review     — a vision model read part of it; waiting for the learner
 * ready      — extracted into the graph
 * failed     — `error` says why; Retry starts over from the stored original
 */
export type MaterialStatus = "processing" | "review" | "ready" | "failed";

export interface MaterialSection {
	id: string;
	title: string;
	level: number;
	pageStart?: number;
	pageEnd?: number;
}

export interface MaterialRecord {
	id: string;
	/** Display name — the original file name without its extension. */
	title: string;
	kind: MaterialKind;
	format: MaterialFormat;
	/** The course it was uploaded to. */
	courseId: string;
	/** The original file's name, as uploaded. */
	fileName: string;
	/** Empty until the books phase splits material into sections. */
	sections: MaterialSection[];
	status: MaterialStatus;
	/** While processing: which half is running. */
	stage?: "converting" | "extracting";
	/** How many parts a vision model had to read (photos, scanned pages,
	 *  slide pictures). Above zero, the transcript waits for review. */
	aiReadParts: number;
	/** A caveat shown beside the material (skipped pictures, capped decks). */
	notice?: string;
	error?: string;
	/** The graph source path — `<course>/<file>`, fixed at upload so a later
	 *  course rename never changes the source's identity. */
	sourcePath: string;
	/** Set once the notes are extracted into the graph. */
	graphSourceId?: string;
	/** Marked tests only. */
	score?: { earned: number; possible: number };
	/** Marked tests only: questions whose result matched no idea. */
	unplaced?: number;
	/** Set when the learner approved the review (or none was needed). A
	 *  retry after this point resumes at extraction and keeps their edits. */
	approvedAt?: string;
	createdAt: string;
	updatedAt: string;
	version?: number;
}

/** What the materials list and the review dialog read. */
export interface MaterialView extends MaterialRecord {
	/** Runtime truth the record cannot hold: a `processing` record whose
	 *  worker is gone (the app restarted) reads as failed. */
	interrupted: boolean;
}

export const MATERIAL_ACCEPT = ".pptx,.pdf,.md,.markdown,.txt,.jpg,.jpeg,.png,.gif,.webp,.bmp,.heic,.heif";
/** A marked test is photographed pages or one scanned PDF. */
export const TEST_ACCEPT = ".pdf,.jpg,.jpeg,.png,.gif,.webp,.bmp,.heic,.heif";
