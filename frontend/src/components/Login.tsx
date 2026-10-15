import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";

const SECRET_SEQUENCE = "duc";

const CRT_BANNER = [
	"  ____  ____  _____ ",
	" |  _ \\|  _ \\|  ___|",
	" | | | | |_) | |_   ",
	" | |_| |  _ <|  _|  ",
	" |____/|_| \\_\\_|     v2.0",
];

const CRT_LINES = [
	...CRT_BANNER,
	"",
	' DUC REBORN BIOS v2.0 — "The Bytes Strike Back"',
	" Copyright (c) Nobody. All bytes reversed.",
	"",
	"> initializing byte-tracker ............. OK",
	"> mounting curiosity .................... OK",
	"> warming up treemap engine ............. OK",
	"> interrogating node_modules ............ CONFESSED",
	"> scanning operator soul ................ DONE",
	"",
	" SCAN REPORT",
	" ------------------------------------------",
	" total bytes lost ............ 42,000,000,000",
	" total bytes found ........... all of them",
	" favorite hiding spot ........ /var/lib/docker",
	" prime suspect ............... node_modules",
	" charges filed ............... 0 (they're innocent)",
	"",
	"> dude, your bytes were here all along.",
];

function AlertIcon() {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			style={{ flexShrink: 0, marginTop: 2 }}
		>
			<circle cx="12" cy="12" r="10" />
			<path d="M12 8v4" />
			<path d="M12 16h.01" />
		</svg>
	);
}

function CrtTerminal({ onClose }: { onClose: () => void }) {
	const fullText = CRT_LINES.join("\n");
	const [shown, setShown] = useState(0);
	const preRef = useRef<HTMLPreElement>(null);

	useEffect(() => {
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			setShown(fullText.length);
			return;
		}
		const interval = window.setInterval(() => {
			setShown((n) => {
				if (n >= fullText.length) {
					window.clearInterval(interval);
					return n;
				}
				return n + 1;
			});
		}, 8);
		return () => window.clearInterval(interval);
	}, [fullText]);

	useEffect(() => {
		if (shown === 0) return;
		const el = preRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [shown]);

	return (
		<div
			className="crt-overlay"
			role="dialog"
			aria-modal="true"
			aria-label="Hidden DUC terminal"
			onClick={onClose}
			onKeyDown={(e) => {
				if (e.key === "Escape") onClose();
			}}
		>
			<div className="crt-screen">
				<pre ref={preRef} className="crt-text">
					{fullText.slice(0, shown)}
					<span className="crt-cursor">▊</span>
				</pre>
				<button type="button" className="crt-exit">
					esc / click anywhere to exit
				</button>
			</div>
		</div>
	);
}

export default function Login() {
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [showTerminal, setShowTerminal] = useState(false);
	const keyBufferRef = useRef("");
	const { isAuthenticated, checkAuth, setAuth, credentialsRequired } =
		useAuthStore();
	const navigate = useNavigate();
	const location = useLocation();
	const from = (location.state as { from?: string })?.from || "/";

	useEffect(() => {
		checkAuth();
	}, [checkAuth]);

	useEffect(() => {
		if (isAuthenticated) {
			navigate(from, { replace: true });
		}
	}, [isAuthenticated, navigate, from]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				setShowTerminal(false);
				return;
			}
			if (
				showTerminal ||
				e.key.length !== 1 ||
				e.ctrlKey ||
				e.metaKey ||
				e.altKey
			) {
				return;
			}
			keyBufferRef.current = (keyBufferRef.current + e.key.toLowerCase()).slice(
				-SECRET_SEQUENCE.length,
			);
			if (keyBufferRef.current === SECRET_SEQUENCE) {
				keyBufferRef.current = "";
				setShowTerminal(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [showTerminal]);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		setLoading(true);

		const endpoint = "/api/auth/login";

		try {
			const fetchOptions: RequestInit = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ username, password }),
			};
			if (credentialsRequired) {
				fetchOptions.credentials = "include";
			}

			const res = await fetch(endpoint, fetchOptions);
			const data = await res.json();

			if (data.success) {
				if (data.data?.user) {
					setAuth(data.data.user);
					navigate(from, { replace: true });
				}
			} else {
				setError(data.error || "Authentication failed");
			}
		} catch {
			setError("Network error");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="login-page">
			<div className="card login-card">
				<div className="login-brand">
					<img src="/favicon.svg" width={52} height={52} alt="" />
					<h1 className="login-title">DUC Reborn</h1>
					<p className="login-subtitle">Dude, where are my bytes?</p>
				</div>

				{error && (
					<div
						className="alert alert-error"
						role="alert"
						style={{ marginBottom: "1rem" }}
					>
						<AlertIcon />
						<span>{error}</span>
					</div>
				)}

				<form onSubmit={handleSubmit}>
					<div className="form-group">
						<label className="form-label" htmlFor="login-username">
							Username
						</label>
						<input
							id="login-username"
							type="text"
							className="input"
							value={username}
							onChange={(e) => setUsername(e.target.value)}
							disabled={loading}
							autoComplete="username"
							required
						/>
					</div>
					<div className="form-group">
						<label className="form-label" htmlFor="login-password">
							Password
						</label>
						<input
							id="login-password"
							type="password"
							className="input"
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							disabled={loading}
							autoComplete="current-password"
							required
						/>
					</div>
					<button
						type="submit"
						className="btn btn-primary"
						style={{ width: "100%", marginTop: "0.25rem" }}
						disabled={loading}
					>
						{loading ? (
							<>
								<span
									className="spinner spin"
									style={{ width: 14, height: 14, borderWidth: 2 }}
								/>
								Signing in…
							</>
						) : (
							"Sign In"
						)}
					</button>
				</form>
			</div>
			{showTerminal && <CrtTerminal onClose={() => setShowTerminal(false)} />}
		</div>
	);
}
