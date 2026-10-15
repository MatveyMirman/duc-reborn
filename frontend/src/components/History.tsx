import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useScanStore } from "../stores/scanStore";

function HistoryIcon() {
	return (
		<svg
			width="16"
			height="16"
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

function SpinnerGlyph() {
	return (
		<svg
			className="spin"
			width="12"
			height="12"
			viewBox="0 0 16 16"
			fill="none"
			aria-hidden="true"
		>
			<circle
				cx="8"
				cy="8"
				r="6"
				stroke="currentColor"
				strokeWidth="2"
				strokeOpacity="0.25"
			/>
			<path
				d="M14 8a6 6 0 0 0-6-6"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
			/>
		</svg>
	);
}

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

function formatDate(dateStr: string): string {
	return new Date(dateStr).toLocaleString();
}

function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function truncatePath(p: string, max = 48): string {
	if (p.length <= max) return p;
	return `…${p.slice(p.length - max + 1)}`;
}

function formatDisks(disks: string): string {
	try {
		const parsed = JSON.parse(disks) as string[];
		if (parsed.length === 0) return "—";
		return parsed.map((d) => d.replace("/dev/", "")).join(", ");
	} catch {
		return "—";
	}
}

const STATUS_LABEL: Record<string, { text: string; badge: string }> = {
	running: { text: "Running", badge: "badge-running" },
	completed: { text: "Done", badge: "badge-completed" },
	failed: { text: "Failed", badge: "badge-failed" },
};

export default function History() {
	const {
		loadScan,
		loadHistory,
		history,
		deleteScan,
		isScanning,
		pollRunningScans,
	} = useScanStore();
	const navigate = useNavigate();
	const [viewingId, setViewingId] = useState<string | null>(null);
	const [now, setNow] = useState(Date.now());

	useEffect(() => {
		loadHistory();
	}, [loadHistory]);

	// Tick once a second so elapsed time updates smoothly for running scans.
	// This is independent of the 2s polling cadence; it does not fetch anything.
	const hasRunning = history.some((item) => item.status === "running");
	useEffect(() => {
		if (!hasRunning) return;
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, [hasRunning]);

	useEffect(() => {
		if (hasRunning) {
			const interval = setInterval(() => {
				pollRunningScans();
			}, 2000);
			return () => clearInterval(interval);
		}
	}, [hasRunning, pollRunningScans]);

	const handleView = async (id: string) => {
		setViewingId(id);
		await loadScan(id);
		setViewingId(null);
		navigate({ pathname: "/", search: "" });
	};

	const handleDelete = async (id: string, e: React.MouseEvent) => {
		e.stopPropagation();
		if (confirm("Delete this scan?")) {
			await deleteScan(id);
		}
	};

	if (isScanning && history.length === 0) {
		return (
			<div className="loading">
				<div className="spinner" style={{ margin: "0 auto 1rem" }} />
				Loading history…
			</div>
		);
	}

	if (history.length === 0) {
		return (
			<div className="card">
				<div className="empty-state">
					<svg
						className="empty-art"
						width="72"
						height="72"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="1.5"
						strokeLinecap="round"
						strokeLinejoin="round"
						aria-hidden="true"
					>
						<path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
						<path d="M3 3v5h5" />
						<path d="M12 7v5l3 3" />
					</svg>
					<h3>No scan history</h3>
					<p>Run a scan to see it here</p>
				</div>
			</div>
		);
	}

	return (
		<div className="card">
			<div className="card-header">
				<h2 className="card-title">
					<HistoryIcon />
					Scan History
				</h2>
				<span className="hint num">
					{history.length} scan{history.length === 1 ? "" : "s"}
				</span>
			</div>
			<div style={{ overflowX: "auto" }}>
				<table className="table">
					<thead>
						<tr>
							<th>Status</th>
							<th>Path</th>
							<th>Disks</th>
							<th>Size</th>
							<th>Files</th>
							<th>Dirs</th>
							<th>Progress</th>
							<th>Time</th>
							<th>Date</th>
							<th></th>
						</tr>
					</thead>
					<tbody>
						{history.map((item) => {
							const elapsed = now - new Date(item.created_at).getTime();
							const status = STATUS_LABEL[item.status] || {
								text: item.status,
								badge: "",
							};
							return (
								<tr
									key={item.id}
									className={item.status === "running" ? "running" : undefined}
								>
									<td>
										<span className={`badge ${status.badge}`}>
											{item.status === "running" && <SpinnerGlyph />}
											{status.text}
										</span>
									</td>
									<td className="cell-path">{item.path}</td>
									<td
										className="cell-dim truncate-cell"
										style={{ maxWidth: 160 }}
										title={formatDisks(item.disks)}
									>
										{formatDisks(item.disks)}
									</td>
									<td className="num cell-dim">
										{item.status === "running"
											? formatBytes(item.progress_size || 0)
											: item.status === "failed"
												? "N/A"
												: formatBytes(item.total_size)}
									</td>
									<td className="num cell-dim">
										{item.status === "running"
											? `${(item.progress_files || 0).toLocaleString()}`
											: item.total_files.toLocaleString()}
									</td>
									<td className="num cell-dim">
										{item.status === "running"
											? `${(item.progress_dirs || 0).toLocaleString()}`
											: item.total_dirs.toLocaleString()}
									</td>
									<td className="truncate-cell">
										{item.status === "running" ? (
											<span
												className="cell-dim"
												style={{
													display: "flex",
													alignItems: "center",
													gap: "0.375rem",
													fontSize: "0.75rem",
												}}
											>
												<span
													style={{
														display: "inline-flex",
														color: "var(--primary-strong)",
														flexShrink: 0,
													}}
												>
													<SpinnerGlyph />
												</span>
												<span
													style={{
														fontFamily: "var(--font-mono)",
														overflow: "hidden",
														textOverflow: "ellipsis",
														whiteSpace: "nowrap",
													}}
													title={item.current_path}
												>
													{item.current_path
														? truncatePath(item.current_path)
														: "…"}
												</span>
											</span>
										) : (
											<span className="cell-dim">—</span>
										)}
									</td>
									<td className="num cell-dim">
										{item.status === "running"
											? formatDuration(elapsed)
											: item.status === "failed"
												? "N/A"
												: `${(item.scan_time_ms / 1000).toFixed(2)}s`}
									</td>
									<td className="cell-dim" style={{ fontSize: "0.8125rem" }}>
										{formatDate(item.created_at)}
									</td>
									<td>
										{item.status === "completed" && (
											<button
												type="button"
												onClick={() => handleView(item.id)}
												className="btn btn-secondary"
												style={{
													padding: "0.25rem 0.5625rem",
													fontSize: "0.75rem",
													marginRight: "0.25rem",
												}}
												disabled={viewingId === item.id}
											>
												{viewingId === item.id ? (
													<>
														<SpinnerGlyph />
														Loading…
													</>
												) : (
													"View"
												)}
											</button>
										)}
										<button
											type="button"
											onClick={(e) => handleDelete(item.id, e)}
											className="btn btn-secondary btn-danger-text"
											style={{
												padding: "0.25rem 0.5625rem",
												fontSize: "0.75rem",
											}}
										>
											Delete
										</button>
									</td>
								</tr>
							);
						})}
					</tbody>
				</table>
			</div>
		</div>
	);
}
