import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/authStore";
import { useThemeStore } from "../theme";

function SunIcon() {
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
		>
			<circle cx="12" cy="12" r="4" />
			<path d="M12 2v2" />
			<path d="M12 20v2" />
			<path d="m4.93 4.93 1.41 1.41" />
			<path d="m17.66 17.66 1.41 1.41" />
			<path d="M2 12h2" />
			<path d="M20 12h2" />
			<path d="m6.34 17.66-1.41 1.41" />
			<path d="m19.07 4.93-1.41 1.41" />
		</svg>
	);
}

function MoonIcon() {
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
		>
			<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
		</svg>
	);
}

function ScanIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<circle cx="11" cy="11" r="7" />
			<path d="m20 20-3.5-3.5" />
		</svg>
	);
}

function HistoryIcon() {
	return (
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
			<path d="M3 3v5h5" />
			<path d="M12 7v5l3 3" />
		</svg>
	);
}

function LogoutIcon() {
	return (
		<svg
			width="13"
			height="13"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
			<path d="m16 17 5-5-5-5" />
			<path d="M21 12H9" />
		</svg>
	);
}

export default function Layout() {
	const { user, logout } = useAuthStore();
	const { theme, toggleTheme } = useThemeStore();
	const navigate = useNavigate();

	const handleLogout = async () => {
		await logout();
		navigate("/login");
	};

	return (
		<div
			style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}
		>
			<header className="header">
				<div style={{ display: "flex", alignItems: "center" }}>
					<a href="/" className="brand">
						<img src="/favicon.svg" width={30} height={30} alt="" />
						<div>
							<h1 className="brand-title">DUC Reborn</h1>
							<span className="brand-subtitle">Dude, where are my bytes?</span>
						</div>
					</a>
					<nav className="nav">
						<NavLink
							to="/"
							className={({ isActive }) =>
								`nav-link ${isActive ? "active" : ""}`
							}
							end
						>
							<ScanIcon />
							Scan
						</NavLink>
						<NavLink
							to="/history"
							className={({ isActive }) =>
								`nav-link ${isActive ? "active" : ""}`
							}
						>
							<HistoryIcon />
							History
						</NavLink>
					</nav>
				</div>
				<div className="user-chip">
					<button
						type="button"
						onClick={toggleTheme}
						className="icon-btn"
						title={
							theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
						}
						aria-label={
							theme === "dark" ? "Switch to light mode" : "Switch to dark mode"
						}
					>
						{theme === "dark" ? <SunIcon /> : <MoonIcon />}
					</button>
					<span className="avatar" title={user?.username}>
						{(user?.username || "?").charAt(0).toUpperCase()}
					</span>
					<button
						type="button"
						onClick={handleLogout}
						className="btn btn-secondary"
						style={{ padding: "0.375rem 0.75rem", fontSize: "0.7813rem" }}
					>
						<LogoutIcon />
						Logout
					</button>
				</div>
			</header>
			<main style={{ flex: 1 }}>
				<div className="container">
					<Outlet />
				</div>
			</main>
		</div>
	);
}
