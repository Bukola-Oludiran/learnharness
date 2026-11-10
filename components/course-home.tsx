"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { DumbbellIcon, PlusIcon } from "lucide-react";
import { CourseFormDialog, DeleteCourseDialog } from "@/components/course-dialogs";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { SessionRow } from "@/components/sidebar";
import { TopBar } from "@/components/top-bar";
import { Input } from "@/components/ui/input";
import { fuzzyScore, type ChatListItem, type CourseRecord } from "@/src/core";

/**
 * The course home (fork, phase 1): /course/<id>. Shows the course's goal
 * and sessions, starts new sessions inside the course, and adds existing
 * sessions to it. The course record is the source of truth for membership;
 * session rows are joined from the ordinary session list.
 */

const ACTION = "flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs uppercase tracking-wider text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40";
const QUIET = "rounded-sm px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40";
const SECTION = "text-xs uppercase tracking-widest text-muted-foreground/70";

/** The course's sessions, in the session list's own order (newest activity first). */
export function courseSessions(course: CourseRecord, chats: readonly ChatListItem[]): ChatListItem[] {
	const ids = new Set(course.sessions.map((s) => s.chatId));
	return chats.filter((chat) => ids.has(chat.id));
}

/** Sessions that can be added: everything not already in this course, filtered by the query. */
export function addableSessions(course: CourseRecord, chats: readonly ChatListItem[], query: string): ChatListItem[] {
	const ids = new Set(course.sessions.map((s) => s.chatId));
	const outside = chats.filter((chat) => !ids.has(chat.id));
	const q = query.trim();
	if (!q) return outside;
	return outside
		.map((chat) => ({ chat, score: fuzzyScore(q, chat.title) }))
		.filter((r): r is { chat: ChatListItem; score: number } => r.score !== null)
		.sort((a, b) => b.score - a.score)
		.map((r) => r.chat);
}

/** The pure page body — exported for render tests. */
export function CourseHomeBody({
	course,
	chats,
	adding,
	query,
	error,
	onStart,
	onOpenSession,
	onRemoveSession,
	onToggleAdding,
	onQuery,
	onAddSession,
	onEdit,
	onDelete,
}: {
	course: CourseRecord;
	/** null while the session list loads. */
	chats: ChatListItem[] | null;
	adding: boolean;
	query: string;
	error: string | null;
	onStart: (mode: "teach" | "practice") => void;
	onOpenSession: (chatId: string) => void;
	onRemoveSession: (chatId: string) => void;
	onToggleAdding: () => void;
	onQuery: (next: string) => void;
	onAddSession: (chatId: string) => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const sessions = chats ? courseSessions(course, chats) : null;
	const addable = chats && adding ? addableSessions(course, chats, query) : [];
	return (
		<div className="mx-auto w-full max-w-[46rem] px-4 py-6" data-testid="course-home">
			<section>
				<div className="flex items-center justify-between">
					<h2 className={SECTION}>Goal</h2>
					<button type="button" data-testid="course-edit" onClick={onEdit} className={QUIET}>
						Edit
					</button>
				</div>
				{course.goal ? (
					<p data-testid="course-goal" className="mt-1 whitespace-pre-wrap font-prose text-(length:--lh-prose-size)">
						{course.goal}
					</p>
				) : (
					<p data-testid="course-goal-empty" className="mt-1 text-sm text-muted-foreground">
						No goal yet. Add one and the tutor will keep each session in service of it.
					</p>
				)}
			</section>

			<section className="mt-8">
				<h2 className={SECTION}>Start a session</h2>
				<div className="mt-2 flex gap-2">
					<button type="button" data-testid="course-start-teach" onClick={() => onStart("teach")} className={ACTION}>
						<PlusIcon className="size-3" />
						Teaching
					</button>
					<button type="button" data-testid="course-start-practice" onClick={() => onStart("practice")} className={ACTION}>
						<DumbbellIcon className="size-3" />
						Practice
					</button>
				</div>
			</section>

			<section className="mt-8">
				<div className="flex items-center justify-between">
					<h2 className={SECTION}>Sessions</h2>
					<button type="button" data-testid="course-add-existing" onClick={onToggleAdding} className={QUIET}>
						{adding ? "Done" : "Add existing session"}
					</button>
				</div>
				{error && (
					<p role="alert" data-testid="course-error" className="mt-2 text-xs text-destructive">
						{error}
					</p>
				)}
				{adding && (
					<div data-testid="course-add-panel" className="mt-2 rounded-lg border border-border/60 p-2">
						<Input
							data-testid="course-add-search"
							value={query}
							onChange={(e) => onQuery(e.target.value)}
							placeholder="Search sessions…"
							aria-label="Search sessions to add"
							className="h-7 text-xs"
						/>
						<p className="mt-1.5 px-1 text-xs text-muted-foreground">A session already in another course moves here.</p>
						<div className="mt-1 max-h-64 overflow-y-auto">
							{addable.length === 0 ? (
								<div className="px-2 py-3 text-xs text-muted-foreground">
									{query.trim() ? "No sessions match." : "Every session is already in this course."}
								</div>
							) : (
								addable.map((chat) => (
									<SessionRow key={chat.id} chat={chat} active={false} onOpen={() => onAddSession(chat.id)} />
								))
							)}
						</div>
					</div>
				)}
				<div className="mt-2">
					{sessions === null ? (
						<div className="px-2 py-3 text-xs text-muted-foreground">Loading…</div>
					) : sessions.length === 0 ? (
						<div data-testid="course-sessions-empty" className="px-2 py-3 text-xs text-muted-foreground">
							No sessions yet. Start one above, or add an existing session.
						</div>
					) : (
						sessions.map((chat) => (
							<div key={chat.id} className="flex items-center gap-1" data-testid="course-session">
								<div className="min-w-0 flex-1">
									<SessionRow chat={chat} active={false} onOpen={() => onOpenSession(chat.id)} />
								</div>
								<button
									type="button"
									data-testid="course-remove-session"
									aria-label={`Remove ${chat.title} from this course`}
									onClick={() => onRemoveSession(chat.id)}
									className={QUIET}
								>
									Remove
								</button>
							</div>
						))
					)}
				</div>
			</section>

			<section className="mt-10 border-t border-border/60 pt-4">
				<button
					type="button"
					data-testid="course-delete"
					onClick={onDelete}
					className="rounded-sm px-2 py-1 text-xs text-muted-foreground/80 transition-colors hover:text-destructive"
				>
					Delete course…
				</button>
			</section>
		</div>
	);
}

export function CourseHome({ initialCourse }: { initialCourse: CourseRecord }) {
	const router = useRouter();
	const [course, setCourse] = useState(initialCourse);
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const [adding, setAdding] = useState(false);
	const [query, setQuery] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const courseId = initialCourse.id;

	const refresh = useCallback(async () => {
		try {
			const [courseRes, chatsRes] = await Promise.all([
				fetch(`/api/courses/${courseId}`, { cache: "no-store" }),
				fetch("/api/chats", { cache: "no-store" }),
			]);
			if (courseRes.status === 404) {
				router.push("/"); // deleted elsewhere
				return;
			}
			if (courseRes.ok) setCourse(((await courseRes.json()) as { course: CourseRecord }).course);
			if (chatsRes.ok) setChats(((await chatsRes.json()) as { chats: ChatListItem[] }).chats);
		} catch {
			setChats((prev) => prev ?? []); // a transient failure keeps the last snapshot
		}
	}, [courseId, router]);

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
	useServerEvent("turn-started", scheduleRefresh);
	useServerEvent("turn-settled", scheduleRefresh);
	useServerResync(() => void refresh());
	useEffect(() => {
		void refresh();
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [refresh]);

	/** Membership edits: the response carries the stored course — adopt it. */
	const changeMembership = useCallback(
		async (request: () => Promise<Response>, failure: string) => {
			setError(null);
			try {
				const res = await request();
				const body = (await res.json()) as { course?: CourseRecord; error?: string };
				if (!res.ok || !body.course) {
					setError(body.error ?? failure);
					return;
				}
				setCourse(body.course);
			} catch {
				setError(failure);
			}
		},
		[],
	);

	const handlers = useMemo(
		() => ({
			onStart: (mode: "teach" | "practice") =>
				router.push(`/chat/new?course=${courseId}${mode === "practice" ? "&mode=practice" : ""}`),
			onOpenSession: (chatId: string) => router.push(`/chat/${chatId}`),
			onAddSession: (chatId: string) =>
				void changeMembership(
					() =>
						fetch(`/api/courses/${courseId}/sessions`, {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ chatId }),
						}),
					"Could not add the session. Try again.",
				),
			onRemoveSession: (chatId: string) =>
				void changeMembership(
					() => fetch(`/api/courses/${courseId}/sessions?chatId=${encodeURIComponent(chatId)}`, { method: "DELETE" }),
					"Could not remove the session. Try again.",
				),
		}),
		[router, courseId, changeMembership],
	);

	return (
		<div className="flex h-dvh min-w-0 flex-col">
			<TopBar>
				<h1 data-testid="course-title" className="min-w-0 truncate font-title text-3xl tracking-tight">
					{course.title}
				</h1>
			</TopBar>
			<div className="min-h-0 flex-1 overflow-y-auto">
				<CourseHomeBody
					course={course}
					chats={chats}
					adding={adding}
					query={query}
					error={error}
					{...handlers}
					onToggleAdding={() => {
						setAdding((v) => !v);
						setQuery("");
					}}
					onQuery={setQuery}
					onEdit={() => setEditing(true)}
					onDelete={() => setDeleting(true)}
				/>
			</div>
			<CourseFormDialog
				open={editing}
				course={course}
				onClose={() => setEditing(false)}
				onSaved={(saved) => {
					setEditing(false);
					setCourse(saved);
				}}
			/>
			<DeleteCourseDialog
				course={deleting ? course : null}
				onClose={() => setDeleting(false)}
				onDeleted={() => {
					setDeleting(false);
					router.push("/");
				}}
			/>
		</div>
	);
}
