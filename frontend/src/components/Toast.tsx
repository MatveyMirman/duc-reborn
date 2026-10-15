import { create } from "zustand";

type ToastItem = { id: number; message: string };

interface ToastState {
	toasts: ToastItem[];
	push: (message: string) => void;
	dismiss: (id: number) => void;
}

const AUTO_DISMISS_MS = 5000;
const MAX_VISIBLE = 3;

export const useToastStore = create<ToastState>((set) => ({
	toasts: [],
	push: (message) => {
		const id = Date.now() + Math.random();
		set((s) => ({
			toasts: [...s.toasts.slice(-(MAX_VISIBLE - 1)), { id, message }],
		}));
		window.setTimeout(
			() => useToastStore.getState().dismiss(id),
			AUTO_DISMISS_MS,
		);
	},
	dismiss: (id) =>
		set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

export function toast(message: string) {
	useToastStore.getState().push(message);
}

function CloseIcon() {
	return (
		<svg
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			aria-hidden="true"
		>
			<path d="M18 6 6 18" />
			<path d="m6 6 12 12" />
		</svg>
	);
}

export function Toasts() {
	const toasts = useToastStore((s) => s.toasts);
	const dismiss = useToastStore((s) => s.dismiss);
	if (toasts.length === 0) return null;
	return (
		<div className="toast-stack" aria-live="polite">
			{toasts.map((t) => (
				<div key={t.id} className="toast">
					<span>{t.message}</span>
					<button
						type="button"
						className="toast-close"
						onClick={() => dismiss(t.id)}
						aria-label="Dismiss"
					>
						<CloseIcon />
					</button>
				</div>
			))}
		</div>
	);
}
