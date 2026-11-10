"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LibraryIcon, PlusIcon } from "lucide-react";
import { CourseFormDialog } from "@/components/course-dialogs";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { cn } from "@/lib/utils";
import type { CourseSummary } from "@/src/core";

/**
 * The sidebar's Courses section (fork, phase 1; owner choice 2026-11-09:
 * a separate section ABOVE the unchanged session list). Each row opens the
 * course home (/course/<id>), the only place a course's sessions are
 * grouped. Freshness follows the sidebar's own rule: notify → fetch, no
 * polling.
 */

function sessionCountLabel(count: number): string {
	return count === 1 ? "1 session" : `${count} sessions`;
}

/** One course row — a pure function of the summary, exported for render tests. */
export function CourseRow({ course, active }: { course: CourseSummary; active: boolean }) {
	return (
		<Link
			href={`/course/${course.id}`}
			data-testid="course-row"
			aria-current={active ? "page" : undefined}
			className={cn(
				"mb-0.5 flex w-full items-baseline gap-2 rounded-lg px-3 py-1.5 text-left transition-colors hover:bg-accent",
				active && "bg-accent",
			)}
		>
			<span className="min-w-0 flex-1 truncate font-prose text-(length:--lh-prose-size)">{course.title}</span>
			<span className="shrink-0 text-xs text-muted-foreground">{sessionCountLabel(course.sessionCount)}</span>
		</Link>
	);
}

export function CoursesSection({ open }: { open: boolean }) {
	const [courses, setCourses] = useState<CourseSummary[] | null>(null);
	const [creating, setCreating] = useState(false);
	const pathname = usePathname();
	const router = useRouter();

	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/courses", { cache: "no-store" });
			const body = (await res.json()) as { courses: CourseSummary[] };
			setCourses(body.courses);
		} catch {
			setCourses((prev) => prev ?? []); // a transient failure keeps the last snapshot
		}
	}, []);

	// Session counts move with the session list, so chats-changed refetches too.
	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleRefresh = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			void refresh();
		}, 250);
	};
	useServerEvent("courses-changed", scheduleRefresh);
	useServerEvent("chats-changed", scheduleRefresh);
	useServerResync(() => void refresh());
	useEffect(
		() => () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		},
		[],
	);

	useEffect(() => {
		if (open) void refresh();
	}, [open, refresh]);

	return (
		<div className="mb-3" data-testid="courses-section">
			{/* The library (phase 3b2): every uploaded material, in or out of a course. */}
			<Link
				href="/library"
				data-testid="library-link"
				aria-current={pathname === "/library" ? "page" : undefined}
				className={cn(
					"mx-3 mb-2 flex items-center gap-1.5 rounded-md px-2 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
					pathname === "/library" && "bg-accent text-foreground",
				)}
			>
				<LibraryIcon className="size-3" />
				Library
			</Link>
			<div className="mx-3 mb-1 flex items-center justify-between">
				<span className="text-xs uppercase tracking-widest text-muted-foreground/70">Courses</span>
				<button
					type="button"
					data-testid="new-course"
					aria-label="New course"
					onClick={() => setCreating(true)}
					className="flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
				>
					<PlusIcon className="size-3" />
				</button>
			</div>
			{courses !== null && courses.length > 0 && (
				<div className="max-h-40 overflow-y-auto px-2">
					{courses.map((course) => (
						<CourseRow key={course.id} course={course} active={pathname === `/course/${course.id}`} />
					))}
				</div>
			)}
			<CourseFormDialog
				open={creating}
				onClose={() => setCreating(false)}
				onSaved={(course) => {
					setCreating(false);
					void refresh();
					router.push(`/course/${course.id}`);
				}}
			/>
		</div>
	);
}
