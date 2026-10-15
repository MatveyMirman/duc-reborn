import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { FileNode } from "../stores/scanStore";
import { findDiskForScanPath, useScanStore } from "../stores/scanStore";
import { toast } from "./Toast";

const Treemap = lazy(() => import("./Treemap"));
const PieChart = lazy(() => import("./PieChart"));

/* ---------- icons (inline SVG, stroke-based) ---------- */

type IconProps = { size?: number };

function makeIcon(path: React.ReactNode, viewBox = "0 0 24 24") {
	return function Icon({ size = 16 }: IconProps) {
		return (
			<svg
				width={size}
				height={size}
				viewBox={viewBox}
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
				aria-hidden="true"
			>
				{path}
			</svg>
		);
	};
}

const DriveIcon = makeIcon(
	<>
		<line x1="22" y1="12" x2="2" y2="12" />
		<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
		<line x1="6" y1="16" x2="6.01" y2="16" />
		<line x1="10" y1="16" x2="10.01" y2="16" />
	</>,
);

const FilesIcon = makeIcon(
	<>
		<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
		<polyline points="14 2 14 8 20 8" />
	</>,
);

const FoldersIcon = makeIcon(
	<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />,
);

const ClockIcon = makeIcon(
	<>
		<circle cx="12" cy="12" r="10" />
		<polyline points="12 6 12 12 16 14" />
	</>,
);

const RadarIcon = makeIcon(
	<>
		<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34" />
		<path d="M4 6h.01" />
		<path d="M2.29 9.62a10 10 0 1 0 19.02-1.27" />
		<path d="M16.24 7.76a6 6 0 1 0-8.01 8.91" />
		<circle cx="12" cy="12" r="2" />
		<path d="m13.41 13.41 4.2 4.2" />
	</>,
);

const SlidersIcon = makeIcon(
	<>
		<line x1="4" y1="21" x2="4" y2="14" />
		<line x1="4" y1="10" x2="4" y2="3" />
		<line x1="12" y1="21" x2="12" y2="12" />
		<line x1="12" y1="8" x2="12" y2="3" />
		<line x1="20" y1="21" x2="20" y2="16" />
		<line x1="20" y1="12" x2="20" y2="3" />
		<line x1="1" y1="14" x2="7" y2="14" />
		<line x1="9" y1="8" x2="15" y2="8" />
		<line x1="17" y1="16" x2="23" y2="16" />
	</>,
);

const ChartIcon = makeIcon(
	<>
		<rect x="3" y="3" width="18" height="18" rx="2" />
		<path d="M3 12h8V3" />
		<path d="M11 21v-6h10" />
		<path d="M11 15 3 21" />
	</>,
);

const PieIcon = makeIcon(
	<>
		<path d="M21.21 15.89A10 10 0 1 1 8 2.83" />
		<path d="M22 12A10 10 0 0 0 12 2v10z" />
	</>,
);

const RowsIcon = makeIcon(
	<>
		<rect x="3" y="3" width="18" height="18" rx="2" />
		<path d="M3 9h18" />
		<path d="M3 15h18" />
	</>,
);

const AlertCircle = makeIcon(
	<>
		<circle cx="12" cy="12" r="10" />
		<path d="M12 8v4" />
		<path d="M12 16h.01" />
	</>,
);

function ChevronRight({ size = 14 }: IconProps) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="2.5"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
		>
			<path d="m9 18 6-6-6-6" />
		</svg>
	);
}

/* ---------- formatters ---------- */

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

function formatDuration(ms: number): string {
	if (ms < 0) return "0s";
	const totalSec = Math.floor(ms / 1000);
	const h = Math.floor(totalSec / 3600);
	const m = Math.floor((totalSec % 3600) / 60);
	const s = totalSec % 60;
	if (h > 0) return `${h}h ${m}m ${s}s`;
	if (m > 0) return `${m}m ${s}s`;
	return `${s}s`;
}

function truncatePath(p: string, max = 64): string {
	if (p.length <= max) return p;
	return `…${p.slice(p.length - max + 1)}`;
}

function Spinner() {
	return (
		<div className="center-screen">
			<div className="spinner" />
		</div>
	);
}

const VIEW_MODES: Array<"list" | "treemap" | "pie"> = [
	"list",
	"treemap",
	"pie",
];

// Path suffix for the synthetic "Free space" node injected into chart data.
const FREE_SPACE_SUFFIX = "__free_space__";

function normalizePath(p?: string | null): string {
	if (!p || p === "/") return "/";
	return p.replace(/\/+$/, "") || "/";
}

function samePath(a?: string | null, b?: string | null): boolean {
	return !!a && !!b && normalizePath(a) === normalizePath(b);
}

function withFreeSpace(
	tree: FileNode,
	scanPath: string,
	bytes: number,
): FileNode {
	const root = normalizePath(scanPath);
	const freeNode: FileNode = {
		path: `${root === "/" ? "" : root}/${FREE_SPACE_SUFFIX}`,
		name: "Free space",
		size: bytes,
		is_dir: false,
		is_free_space: true,
	};
	const children = [...(tree.children ?? []), freeNode];
	children.sort((a, b) => (b.size || 0) - (a.size || 0));
	return { ...tree, children };
}

export default function Dashboard() {
	const [searchParams] = useSearchParams();
	const navigate = useNavigate();
	const [path, setPath] = useState("/");
	const [now, setNow] = useState(Date.now());
	const [selectedDisks, setSelectedDisks] = useState<Set<string>>(new Set());
	const [showDiskSettings, setShowDiskSettings] = useState(false);
	const lastSyncedKeyRef = useRef<{
		scanId: string;
		nodePath: string | undefined;
	} | null>(null);
	const {
		currentScan,
		currentTree,
		breadcrumb,
		treeLoading,
		isScanning,
		scanStatus,
		error,
		viewMode,
		showFreeSpace,
		disks,
		disksLoading,
		startScan,
		loadDisks,
		loadScan,
		loadHistory,
		setViewMode,
		setShowFreeSpace,
		fetchTree,
		drillDown,
		navigateBreadcrumb,
		setBreadcrumb,
		pollScanStatus,
	} = useScanStore();

	// Poll scan status while a background scan is running
	useEffect(() => {
		if (!isScanning || !currentScan) return;
		const scanId = currentScan.id;
		let cancelled = false;

		const tick = async () => {
			if (cancelled) return;
			const done = await pollScanStatus(scanId);
			if (done && !cancelled) {
				// Clear last synced key so the tree reload effect re-runs
				lastSyncedKeyRef.current = null;
			}
		};

		tick();
		const interval = setInterval(tick, 2000);
		return () => {
			cancelled = true;
			clearInterval(interval);
		};
	}, [isScanning, currentScan, pollScanStatus]);

	// Tick for elapsed time display during scan
	useEffect(() => {
		if (!isScanning) return;
		const interval = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(interval);
	}, [isScanning]);

	// Load latest scan on mount if none active
	useEffect(() => {
		if (!currentScan && !isScanning) {
			const doLoad = async () => {
				await loadHistory();
				const state = useScanStore.getState();
				const latest = state.history.find((h) => h.status === "completed");
				if (latest && !state.currentScan && !state.isScanning) {
					await loadScan(latest.id);
				}
			};
			doLoad();
		}
	}, [currentScan, isScanning, loadHistory, loadScan]);

	// Load available disks once
	useEffect(() => {
		if (disks.length === 0 && !disksLoading) {
			loadDisks();
		}
	}, [disks.length, disksLoading, loadDisks]);

	// Sync view mode from URL
	useEffect(() => {
		const vis = searchParams.get("vis");
		if (vis && ["list", "treemap", "pie"].includes(vis) && vis !== viewMode) {
			setViewMode(vis as "list" | "treemap" | "pie");
		}
	}, [searchParams, viewMode, setViewMode]);

	// Sync path / tree from URL (requires a loaded completed scan)
	useEffect(() => {
		if (!currentScan || isScanning) return;
		const nodePath = searchParams.get("path") || undefined;
		const last = lastSyncedKeyRef.current;
		if (last && last.scanId === currentScan.id && last.nodePath === nodePath)
			return;

		lastSyncedKeyRef.current = { scanId: currentScan.id, nodePath };

		if (nodePath) {
			// On a hard reload the cache only receives the target subtree; fetch
			// the scan root first so the treemap breadcrumb has the full trail.
			const ensureRootThenDrill = async () => {
				const cache = useScanStore.getState().treeCache;
				if (!cache[currentScan.path || "/"]) {
					await fetchTree(currentScan.id, undefined);
				}
				drillDown(currentScan.id, nodePath);
			};
			ensureRootThenDrill();
		} else {
			setBreadcrumb([{ name: currentScan.path || "/", path: undefined }]);
			fetchTree(currentScan.id, undefined);
		}
	}, [
		searchParams,
		currentScan,
		isScanning,
		drillDown,
		fetchTree,
		setBreadcrumb,
	]);

	const handleViewChange = (mode: "list" | "treemap" | "pie") => {
		setViewMode(mode);
		const currentNodePath = searchParams.get("path");
		const search = currentNodePath
			? `?path=${encodeURIComponent(currentNodePath)}&vis=${mode}`
			: mode === "list"
				? ""
				: `?vis=${mode}`;
		navigate({ pathname: "/", search }, { replace: true });
	};

	const handleScan = (e: React.FormEvent) => {
		e.preventDefault();
		lastSyncedKeyRef.current = null;
		navigate("/");
		const diskList = Array.from(selectedDisks);
		startScan(path, undefined, diskList.length > 0 ? diskList : undefined);
	};

	const handleToggleDisk = (device: string, primaryMount?: string) => {
		setSelectedDisks((prev) => {
			const next = new Set(prev);
			if (next.has(device)) {
				next.delete(device);
			} else {
				next.add(device);
				if (primaryMount) {
					setPath(primaryMount);
				}
			}
			return next;
		});
	};

	const nodeModulesClicksRef = useRef(0);

	const trackNodeModules = (nodePath?: string) => {
		const isNodeModules =
			!!nodePath && nodePath.split("/").includes("node_modules");
		if (!isNodeModules) {
			nodeModulesClicksRef.current = 0;
			return;
		}
		nodeModulesClicksRef.current += 1;
		if (nodeModulesClicksRef.current >= 3) {
			nodeModulesClicksRef.current = 0;
			toast("You have found the source of all your problems.");
		}
	};

	const handleDrillDown = (nodePath: string) => {
		if (!currentScan) return;
		trackNodeModules(nodePath);
		lastSyncedKeyRef.current = { scanId: currentScan.id, nodePath };
		navigate({
			pathname: "/",
			search: `?path=${encodeURIComponent(nodePath)}&vis=${viewMode}`,
		});
		drillDown(currentScan.id, nodePath);
	};

	const handleNavigateUp = () => {
		if (!currentScan || breadcrumb.length <= 1) return;
		const parentIndex = breadcrumb.length - 2;
		handleBreadcrumbClick(parentIndex);
	};

	const handleBreadcrumbClick = (index: number) => {
		if (!currentScan) return;
		const item = breadcrumb[index];
		const nodePath = item.path;
		lastSyncedKeyRef.current = { scanId: currentScan.id, nodePath };
		if (nodePath) {
			navigate(
				{
					pathname: "/",
					search: `?path=${encodeURIComponent(nodePath)}&vis=${viewMode}`,
				},
				{ replace: true },
			);
		} else {
			navigate(
				{
					pathname: "/",
					search: viewMode === "list" ? "" : `?vis=${viewMode}`,
				},
				{ replace: true },
			);
		}
		navigateBreadcrumb(currentScan.id, index);
	};

	const showTreeLoading =
		treeLoading || (!currentTree && !!currentScan && !isScanning);
	const elapsed = scanStatus
		? now - new Date(currentScan?.created_at || Date.now()).getTime()
		: 0;

	// Free space in visualizations — sourced live from /api/disks and only
	// offered while the whole scanned disk (scan root) is selected.
	const matchedDisk = useMemo(
		() => findDiskForScanPath(disks, currentScan?.path),
		[disks, currentScan],
	);
	const atScanRoot = samePath(currentTree?.path, currentScan?.path);
	const multiRoot = (currentScan?.roots?.length ?? 0) > 1;
	const freeSpaceEligible =
		!!matchedDisk &&
		matchedDisk.available > 0 &&
		atScanRoot &&
		!multiRoot &&
		!!currentTree;
	const freeSpaceHint = !atScanRoot
		? "Available only when viewing the whole scanned disk"
		: multiRoot
			? "Scan covers multiple roots — free space is ambiguous"
			: !matchedDisk || matchedDisk.available <= 0
				? "No live free-space info for this scan's filesystem"
				: "Show unused disk space alongside scanned folders";
	const vizTree = useMemo(() => {
		if (
			!showFreeSpace ||
			!freeSpaceEligible ||
			!currentTree ||
			!currentScan ||
			!matchedDisk
		) {
			return currentTree;
		}
		return withFreeSpace(currentTree, currentScan.path, matchedDisk.available);
	}, [showFreeSpace, freeSpaceEligible, currentTree, currentScan, matchedDisk]);

	return (
		<div>
			{/* ----- New Scan ----- */}
			<div className="card">
				<div className="card-header">
					<h2 className="card-title">
						<RadarIcon />
						New Scan
					</h2>
					<button
						type="button"
						className="btn btn-secondary"
						onClick={() => setShowDiskSettings(!showDiskSettings)}
						style={{ fontSize: "0.7813rem", padding: "0.375rem 0.75rem" }}
						disabled={isScanning}
					>
						<SlidersIcon size={13} />
						{showDiskSettings ? "Hide Settings" : "Settings"}
					</button>
				</div>
				<form onSubmit={handleScan} className="scan-form">
					<input
						type="text"
						className="input mono"
						value={path}
						onChange={(e) => setPath(e.target.value)}
						placeholder="/path/to/scan"
						style={{ flex: 1 }}
						spellCheck={false}
						disabled={isScanning}
					/>
					<button
						type="submit"
						className="btn btn-primary"
						disabled={isScanning}
					>
						<RadarIcon size={15} />
						{isScanning ? "Scanning…" : "Start Scan"}
					</button>
				</form>
				{selectedDisks.size > 0 && path && path !== "/" && (
					<div className="hint" style={{ marginTop: "0.625rem" }}>
						Path is set — only{" "}
						<span style={{ fontFamily: "var(--font-mono)" }}>{path}</span> will
						be scanned (disk selection scopes mount info; does not replace the
						path).
					</div>
				)}
				{showDiskSettings && (
					<div className="disk-panel">
						<div
							style={{
								fontSize: "0.8125rem",
								fontWeight: 600,
								marginBottom: "0.25rem",
							}}
						>
							Physical Disks
						</div>
						<div className="hint" style={{ marginBottom: "0.625rem" }}>
							Selecting a disk fills the path with its mount. A deeper path
							always wins. Scans stay on one filesystem (no overlay/bind spill).
						</div>
						{disksLoading && <div className="hint">Loading disks…</div>}
						{!disksLoading && disks.length === 0 && (
							<div className="hint">
								No physical disks detected. Enter a path manually above.
							</div>
						)}
						{disks.map((disk) => {
							const isChecked = selectedDisks.has(disk.device);
							const usagePct =
								disk.total_size > 0
									? Math.round((disk.used / disk.total_size) * 100)
									: 0;
							const primaryMount = disk.mountpoints[0];
							return (
								<div
									key={disk.device}
									className={`disk-item ${isChecked ? "selected" : ""}`}
								>
									<input
										type="checkbox"
										className="checkbox"
										checked={isChecked}
										onChange={() => handleToggleDisk(disk.device, primaryMount)}
										disabled={isScanning}
										aria-label={`Select ${disk.device}`}
									/>
									<div style={{ flex: 1, minWidth: 0 }}>
										<div
											style={{
												display: "flex",
												alignItems: "center",
												gap: "0.5rem",
												flexWrap: "wrap",
											}}
										>
											<span className="disk-device">{disk.device}</span>
											<span className="tag">{disk.fstype}</span>
											{disk.model && (
												<span
													style={{
														fontSize: "0.6875rem",
														color: "var(--text-secondary)",
													}}
												>
													{disk.model}
												</span>
											)}
										</div>
										<div className="disk-meta">
											<span>{formatBytes(disk.total_size)} total</span>
											<span>
												{formatBytes(disk.used)} used ({usagePct}%)
											</span>
											<span>{formatBytes(disk.available)} free</span>
										</div>
										<div className="disk-bar-track">
											<div
												className={`disk-bar-fill ${usagePct > 85 ? "hot" : ""}`}
												style={{ width: `${usagePct}%` }}
											/>
										</div>
										<div
											style={{
												display: "flex",
												flexWrap: "wrap",
												gap: "0.375rem",
												marginTop: "0.5rem",
											}}
										>
											{disk.mountpoints.map((mp) => (
												<button
													type="button"
													key={mp}
													onClick={() => {
														setPath(mp);
														setSelectedDisks(new Set());
													}}
													disabled={isScanning}
													title={`Use ${mp} as scan path`}
													className="mount-chip"
												>
													{mp}
												</button>
											))}
										</div>
									</div>
								</div>
							);
						})}
						{selectedDisks.size > 0 && (
							<div className="hint" style={{ marginTop: "0.625rem" }}>
								{selectedDisks.size} disk{selectedDisks.size > 1 ? "s" : ""}{" "}
								selected — primary mountpoint(s) will be scanned.
							</div>
						)}
					</div>
				)}
				{error && (
					<div
						className="alert alert-error"
						role="alert"
						style={{ marginTop: "0.875rem" }}
					>
						<AlertCircle size={15} />
						<span>{error}</span>
					</div>
				)}
			</div>

			{/* ----- Live scanning progress ----- */}
			{isScanning && scanStatus && (
				<div className="card">
					<div className="card-header" style={{ marginBottom: 0 }}>
						<h2 className="card-title">
							<span
								className="spinner spin"
								style={{ width: 18, height: 18, borderWidth: 2 }}
							/>
							Scanning…
						</h2>
						<span className="hint num" style={{ fontSize: "0.8438rem" }}>
							{formatDuration(elapsed)} elapsed
						</span>
					</div>
					<div className="progress-track" aria-hidden="true">
						<div className="progress-indeterminate" />
					</div>
					<div
						className="stats-grid"
						style={{ marginTop: "1rem", marginBottom: 0 }}
					>
						<div className="stat-card">
							<div className="stat-icon indigo">
								<DriveIcon />
							</div>
							<div>
								<div className="stat-label">Size so far</div>
								<div className="stat-value">
									{formatBytes(scanStatus.progress_size)}
								</div>
							</div>
						</div>
						<div className="stat-card">
							<div className="stat-icon cyan">
								<FilesIcon />
							</div>
							<div>
								<div className="stat-label">Files</div>
								<div className="stat-value">
									{scanStatus.progress_files.toLocaleString()}
								</div>
							</div>
						</div>
						<div className="stat-card">
							<div className="stat-icon violet">
								<FoldersIcon />
							</div>
							<div>
								<div className="stat-label">Directories</div>
								<div className="stat-value">
									{scanStatus.progress_dirs.toLocaleString()}
								</div>
							</div>
						</div>
						<div className="stat-card">
							<div className="stat-icon emerald">
								<ClockIcon />
							</div>
							<div>
								<div className="stat-label">Elapsed</div>
								<div className="stat-value">{formatDuration(elapsed)}</div>
							</div>
						</div>
					</div>
					{(currentScan?.roots?.length ||
						currentScan?.path ||
						scanStatus.path) && (
						<div className="roots-box">
							<div style={{ fontWeight: 600, marginBottom: "0.25rem" }}>
								Scanning roots
							</div>
							<ul>
								{(currentScan?.roots && currentScan.roots.length > 0
									? currentScan.roots
									: [currentScan?.path || scanStatus.path]
								).map((r) => (
									<li key={r}>{r}</li>
								))}
							</ul>
							{currentScan?.same_filesystem !== false && (
								<div style={{ marginTop: "0.25rem", opacity: 0.85 }}>
									Same filesystem only (won't cross mounts)
								</div>
							)}
						</div>
					)}
					{scanStatus.current_path && (
						<div className="term-line" title={scanStatus.current_path}>
							{truncatePath(scanStatus.current_path)}
						</div>
					)}
				</div>
			)}

			{/* ----- Results ----- */}
			{currentScan && !isScanning && (
				<>
					<div className="stats-grid">
						<div className="stat-card">
							<div className="stat-icon indigo">
								<DriveIcon />
							</div>
							<div>
								<div className="stat-label">Total Size</div>
								<div className="stat-value">
									{formatBytes(currentScan.total_size)}
								</div>
							</div>
						</div>
						<div className="stat-card">
							<div className="stat-icon cyan">
								<FilesIcon />
							</div>
							<div>
								<div className="stat-label">Files</div>
								<div className="stat-value">
									{currentScan.total_files.toLocaleString()}
								</div>
							</div>
						</div>
						<div className="stat-card">
							<div className="stat-icon violet">
								<FoldersIcon />
							</div>
							<div>
								<div className="stat-label">Directories</div>
								<div className="stat-value">
									{currentScan.total_dirs.toLocaleString()}
								</div>
							</div>
						</div>
						<div className="stat-card">
							<div className="stat-icon emerald">
								<ClockIcon />
							</div>
							<div>
								<div className="stat-label">Scan Time</div>
								<div className="stat-value">
									{(currentScan.scan_time_ms / 1000).toFixed(2)}s
								</div>
							</div>
						</div>
					</div>

					<div className="card">
						<div className="card-header">
							<h2 className="card-title">
								<ChartIcon />
								Visualization
							</h2>
							<div
								style={{
									display: "flex",
									alignItems: "center",
									gap: "0.875rem",
								}}
							>
								{viewMode !== "list" && (
									<label
										className={`free-space-toggle ${freeSpaceEligible ? "" : "disabled"}`}
										title={freeSpaceHint}
									>
										<input
											type="checkbox"
											className="checkbox"
											checked={showFreeSpace}
											disabled={!freeSpaceEligible}
											onChange={(e) => setShowFreeSpace(e.target.checked)}
										/>
										Free space
									</label>
								)}
								<div
									className="segmented"
									role="tablist"
									aria-label="View mode"
									style={{ width: "auto" }}
								>
									<div
										className="segmented-thumb"
										style={{
											transform: `translateX(${VIEW_MODES.indexOf(viewMode) * 100}%)`,
										}}
										aria-hidden="true"
									/>
									{VIEW_MODES.map((mode) => (
										<button
											key={mode}
											type="button"
											role="tab"
											aria-selected={viewMode === mode}
											className={viewMode === mode ? "active" : ""}
											onClick={() => handleViewChange(mode)}
										>
											{mode === "list" && <RowsIcon size={13} />}
											{mode === "treemap" && <ChartIcon size={13} />}
											{mode === "pie" && <PieIcon size={13} />}
											{mode === "list"
												? "List"
												: mode === "treemap"
													? "Treemap"
													: "Pie"}
										</button>
									))}
								</div>
							</div>
						</div>

						{breadcrumb.length > 0 && viewMode !== "treemap" && (
							<nav className="crumbs" aria-label="Breadcrumb">
								{breadcrumb.map((item, index) => (
									<span
										key={item.path || item.name || String(index)}
										className="crumb"
									>
										{index > 0 && (
											<span className="crumb-sep" aria-hidden="true">
												<ChevronRight size={11} />
											</span>
										)}
										<button
											type="button"
											onClick={() => handleBreadcrumbClick(index)}
											title={item.path || item.name}
											className={`crumb-btn ${index === breadcrumb.length - 1 ? "current" : ""}`}
										>
											{item.name || "/"}
										</button>
									</span>
								))}
							</nav>
						)}

						{showTreeLoading && (!currentTree || viewMode !== "treemap") && (
							<Spinner />
						)}
						{!showTreeLoading && viewMode === "list" && currentTree && (
							<FileList node={currentTree} onFolderClick={trackNodeModules} />
						)}
						{viewMode === "treemap" && currentTree && (
							<div
								className="chart-container treemap"
								style={{ position: "relative" }}
							>
								<Suspense fallback={<Spinner />}>
									<Treemap
										data={vizTree ?? currentTree}
										onDrillDown={handleDrillDown}
									/>
								</Suspense>
								{treeLoading && (
									<div className="chart-overlay">
										<div className="spinner" />
									</div>
								)}
							</div>
						)}
						{!showTreeLoading && viewMode === "pie" && currentTree && (
							<div className="chart-container pie">
								<Suspense fallback={<Spinner />}>
									<PieChart
										data={vizTree ?? currentTree}
										onDrillDown={handleDrillDown}
										onNavigateUp={handleNavigateUp}
									/>
								</Suspense>
							</div>
						)}
						{!showTreeLoading && !currentTree && (
							<div className="empty-state">
								<EmptyArt />
								<h3>No tree data</h3>
							</div>
						)}
					</div>
				</>
			)}

			{!currentScan && !isScanning && (
				<div className="card">
					<div className="empty-state">
						<EmptyArt />
						<h3>No scan yet</h3>
						<p>Enter a path above to start scanning</p>
					</div>
				</div>
			)}
		</div>
	);
}

function EmptyArt() {
	return (
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
			<line x1="22" y1="12" x2="2" y2="12" />
			<path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
			<line x1="6" y1="16" x2="6.01" y2="16" />
		</svg>
	);
}

function getNodeSize(node: FileNode): number {
	if (node.size) return node.size;
	if (!node.children || node.children.length === 0) return 0;
	return node.children.reduce(
		(acc: number, c: FileNode) => acc + getNodeSize(c),
		0,
	);
}

function FolderGlyph() {
	return (
		<svg
			width="15"
			height="15"
			viewBox="0 0 24 24"
			fill="currentColor"
			aria-hidden="true"
		>
			<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
		</svg>
	);
}

function FileGlyph() {
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
			<path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z" />
			<polyline points="14 2 14 8 20 8" />
		</svg>
	);
}

function FileList({
	node,
	depth = 0,
	onFolderClick,
}: {
	node: FileNode;
	depth?: number;
	onFolderClick?: (path?: string) => void;
}) {
	const [expanded, setExpanded] = useState(depth < 2);

	if (!node.is_dir) return null;

	const visibleChildren = (node.children || []).filter(
		(child: FileNode) => child.is_dir || depth < 3,
	);
	const maxSize = visibleChildren.reduce(
		(max: number, c: FileNode) => Math.max(max, c.size || 0),
		1,
	);

	return (
		<div className={depth === 0 ? "filelist" : undefined}>
			<button
				type="button"
				onClick={() => {
					setExpanded(!expanded);
					if (node.is_dir) onFolderClick?.(node.path);
				}}
				className="fl-row"
				title={`${node.path || "/"} — ${getNodeSize(node) > 0 ? formatBytes(getNodeSize(node)) : ""}`}
			>
				<svg
					className={`fl-chevron ${expanded ? "open" : ""}`}
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<path d="m9 18 6-6-6-6" />
				</svg>
				<span className={`fl-icon ${node.is_dir ? "dir" : "file"}`}>
					{node.is_dir ? <FolderGlyph /> : <FileGlyph />}
				</span>
				<span className={`fl-name ${node.is_dir ? "dir" : ""}`}>
					{node.name || "/"}
				</span>
				<span className="fl-bar-track" aria-hidden="true">
					<span
						className="fl-bar-fill"
						style={{
							width: `${Math.max((getNodeSize(node) / maxSize) * 100, 1.5)}%`,
							opacity: 0.35 + 0.65 * Math.min(getNodeSize(node) / maxSize, 1),
						}}
					/>
				</span>
				<span className="fl-size">{formatBytes(getNodeSize(node))}</span>
			</button>
			{expanded && visibleChildren.length > 0 && (
				<div className="fl-children">
					{visibleChildren.map((child: FileNode) => (
						<FileList
							key={child.path || child.name}
							node={child}
							depth={depth + 1}
							onFolderClick={onFolderClick}
						/>
					))}
				</div>
			)}
		</div>
	);
}
