import * as echarts from "echarts";
import { useEffect, useMemo, useRef } from "react";
import type { FileNode } from "../stores/scanStore";
import { useScanStore } from "../stores/scanStore";
import type { ChartTheme } from "../theme";
import { getChartTheme, useThemeStore } from "../theme";

interface TreemapProps {
	data: FileNode;
	onDrillDown?: (path: string) => void;
}

interface TreemapDatum {
	name: string;
	id: string;
	value: number;
	path: string;
	isDir: boolean;
	navigable: boolean;
	fileCount?: number;
	isFreeSpace?: boolean;
	itemStyle?: { color: string };
	children?: TreemapDatum[];
}

const OTHERS_SUFFIX = "__others__";

// Marker for treemapRootToNode dispatches issued by this component, so the
// breadcrumb listener can tell them apart from genuine breadcrumb clicks.
const FOCUS_TAG = "duc-treemap-focus";

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(k));
	return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

function basename(path: string): string {
	const trimmed = path.replace(/\/+$/, "");
	if (!trimmed) return "/";
	const idx = trimmed.lastIndexOf("/");
	if (idx === -1) return trimmed;
	return trimmed.slice(idx + 1) || "/";
}

function normalizePath(path: string): string {
	if (!path || path === "/") return "/";
	return path.replace(/\/+$/, "") || "/";
}

// Paths from scan root down to (but not including) target.
function ancestorPaths(scanRoot: string, target: string): string[] {
	const root = normalizePath(scanRoot);
	const node = normalizePath(target);
	if (node === root) return [];
	const prefix = root === "/" ? "" : root;
	if (root !== "/" && !node.startsWith(`${root}/`) && node !== root) {
		return [root];
	}
	const rel =
		root === "/"
			? node.replace(/^\/+/, "")
			: node.slice(root.length).replace(/^\/+/, "");
	const parts = rel.split("/").filter(Boolean);
	if (parts.length === 0) return [];
	const result: string[] = [root];
	let cur = prefix;
	// Stop before the last part (the target itself).
	for (let i = 0; i < parts.length - 1; i++) {
		cur = cur === "" ? `/${parts[i]}` : `${cur}/${parts[i]}`;
		result.push(cur);
	}
	return result;
}

// Convert a FileNode (the current focus) into ECharts datum with real children.
function transform(node: FileNode): TreemapDatum {
	const children = node.children?.map(transform);
	let size = node.size;
	if (!size && children && children.length > 0) {
		size = 0;
		for (let i = 0; i < children.length; i++) {
			size += children[i].value;
		}
	}
	const navigable = node.is_dir && !node.path.endsWith(OTHERS_SUFFIX);
	return {
		name: node.name || "/",
		id: node.path,
		value: size || 0,
		path: node.path,
		isDir: node.is_dir,
		navigable,
		fileCount: node.file_count,
		isFreeSpace: node.is_free_space,
		children,
	};
}

// Build a linear spine scanRoot → … → current, where only `current` carries
// its real children. Keeps the tree tiny and the built-in breadcrumb correct
// at any depth without merging the entire visited forest.
//
// Color assignment (ECharts treemap inherits visuals down the tree, so only
// the rendered top level may carry a color — deeper levels must stay clean or
// every depth re-picks hues by sibling index):
//   - root view: one palette hue per top-level directory, by index.
//   - drilled view: the whole spine is tinted with the hue of the top-level
//     ancestor the user drilled through, keeping the family color consistent.
function buildSpine(
	scanRootPath: string,
	current: FileNode,
	cache: Record<string, FileNode>,
	palette: string[],
	freeSpaceColor: string,
): TreemapDatum {
	const currentDatum = transform(current);
	const ancestors = ancestorPaths(scanRootPath, current.path);

	if (ancestors.length === 0) {
		// Root view: distinct hue per top-level directory, by index. The
		// synthetic "Free space" tile gets a neutral gray and does not
		// consume a palette index so directory hues stay stable when the
		// toggle flips.
		let paletteIdx = 0;
		for (const child of currentDatum.children ?? []) {
			child.itemStyle = {
				color: child.isFreeSpace
					? freeSpaceColor
					: palette[paletteIdx++ % palette.length],
			};
		}
		return currentDatum;
	}

	// Drilled view: find the top-level ancestor to pick the family hue.
	const rootCache = cache[normalizePath(scanRootPath)];
	const root = normalizePath(scanRootPath);
	const node = normalizePath(current.path);
	const prefix = root === "/" ? "" : root;
	const rel =
		root === "/"
			? node.replace(/^\/+/, "")
			: node.slice(root.length).replace(/^\/+/, "");
	const firstSeg = rel.split("/").filter(Boolean)[0];
	const firstSegPath = root === "/" ? `/${firstSeg}` : `${prefix}/${firstSeg}`;
	const topIdx =
		rootCache?.children?.findIndex((c) => c.path === firstSegPath) ?? -1;
	const hue = palette[(topIdx >= 0 ? topIdx : 0) % palette.length];

	let child = currentDatum;
	for (let i = ancestors.length - 1; i >= 0; i--) {
		const p = ancestors[i];
		const cached = cache[p];
		child = {
			name: cached?.name || basename(p),
			id: p,
			value: Math.max(child.value, cached?.size || 0),
			path: p,
			isDir: true,
			navigable: true,
			itemStyle: { color: hue },
			children: [child],
		};
	}
	return child;
}

// levels[0] = the rendered top level (forest data: the top directories).
// ECharts fills a parent's band with its *stroke*, so every level derives its
// border from the node color via borderColorSaturation — that is what makes
// the parent directory bands tinted instead of black. Deeper levels carry no
// `color` list: children inherit the parent hue and vary it via
// colorSaturation (classic WizTree-style family shading).
const MAX_LEVELS = 12;

function buildLevels(ct: ChartTheme) {
	const levels: unknown[] = [
		{
			color: ct.palette,
			itemStyle: {
				borderWidth: 3,
				gapWidth: 1,
				borderColorSaturation: 0.6,
			},
			emphasis: {
				itemStyle: {
					borderColor: ct.treemap.emphasisBorder,
				},
			},
			upperLabel: { show: true, height: 30 },
		},
	];
	for (let depth = 1; depth < MAX_LEVELS; depth++) {
		const satLow = Math.min(0.65, 0.3 + depth * 0.06);
		const satHigh = Math.min(0.8, 0.45 + depth * 0.06);
		levels.push({
			colorSaturation: [satLow, satHigh],
			itemStyle: {
				borderWidth: Math.max(2, 4 - depth),
				gapWidth: 1,
				borderColorSaturation: Math.min(0.75, 0.55 + depth * 0.03),
			},
			emphasis: {
				itemStyle: {
					borderColor: ct.treemap.emphasisBorder,
				},
			},
			upperLabel: { show: true, height: 30 },
		});
	}
	return levels;
}

const tooltipFormatter = (info: unknown): string => {
	const params = info as {
		value?: number | string;
		name?: string;
		data?: TreemapDatum;
	};
	const datum = params.data;
	if (datum?.isFreeSpace) {
		return [
			`<div style="font-weight:600;margin-bottom:4px">${echarts.format.encodeHTML(datum.name)}</div>`,
			formatBytes(Number(params.value) || 0),
			`<div style="opacity:0.7;font-size:11px">Unused space on this filesystem</div>`,
		].join("");
	}
	const title = datum?.path ?? params.name ?? "";
	const parts = [
		`<div style="font-weight:600;margin-bottom:4px">${echarts.format.encodeHTML(title)}</div>`,
		formatBytes(Number(params.value) || 0),
	];
	// fileCount is only meaningful on the synthetic "Others" node.
	if (datum?.fileCount != null && datum.fileCount > 0) {
		parts.push(`${datum.fileCount.toLocaleString()} items`);
	}
	return parts.join("");
};

function buildOption(
	seriesName: string,
	data: TreemapDatum[],
	ct: ChartTheme,
): echarts.EChartsOption {
	return {
		animation: false,
		tooltip: {
			transitionDuration: 0,
			backgroundColor: ct.tooltip.bg,
			borderColor: ct.tooltip.border,
			textStyle: { color: ct.tooltip.text, fontSize: 12 },
			formatter: tooltipFormatter,
		},
		series: [
			{
				name: seriesName,
				type: "treemap",
				visibleMin: 300,
				// Non-null leafDepth makes the breadcrumb tail follow the
				// actual view root (not the tile under the canvas center).
				leafDepth: 999,
				label: {
					show: true,
					formatter: "{b}",
					overflow: "truncate",
					color: "#fff",
					fontWeight: 600,
					textShadowColor: ct.treemap.labelShadow,
					textShadowBlur: 2,
				},
				upperLabel: {
					show: false,
				},
				itemStyle: {
					borderColor: ct.treemap.border,
				},
				levels: buildLevels(ct) as NonNullable<
					echarts.TreemapSeriesOption["levels"]
				>,
				roam: false,
				nodeClick: false,
				breadcrumb: {
					show: true,
					height: 30,
					itemStyle: {
						color: ct.treemap.breadcrumbBg,
						borderColor: ct.treemap.breadcrumbBorder,
						borderWidth: 1,
						textStyle: { color: ct.treemap.breadcrumbText },
					},
					emphasis: {
						itemStyle: { color: ct.treemap.breadcrumbEmphasisBg },
					},
				},
				data,
			},
		],
	};
}

export default function Treemap({ data, onDrillDown }: TreemapProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<echarts.ECharts | null>(null);
	const drillDownRef = useRef(onDrillDown);
	drillDownRef.current = onDrillDown;
	const dataRef = useRef(data);
	dataRef.current = data;

	const treeCache = useScanStore((s) => s.treeCache);
	const scanRootPath = useScanStore((s) => s.currentScan?.path || "/");
	const theme = useThemeStore((s) => s.theme);
	const scanRootRef = useRef(scanRootPath);
	scanRootRef.current = scanRootPath;

	const ct = useMemo(() => getChartTheme(theme), [theme]);

	const spine = useMemo(
		() =>
			buildSpine(scanRootPath, data, treeCache, ct.palette, ct.freeSpaceColor),
		[scanRootPath, data, treeCache, ct],
	);
	// Feed the spine's children so the series-name virtual root becomes the
	// natural "scan root" breadcrumb crumb (no duplicated first level).
	const chartData = useMemo(
		() =>
			spine.children && spine.children.length > 0 ? spine.children : [spine],
		[spine],
	);
	const seriesName = useMemo(
		() => basename(normalizePath(scanRootPath)),
		[scanRootPath],
	);
	const focusPath = data.path;
	const atRoot = normalizePath(focusPath) === normalizePath(scanRootPath);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const chart = echarts.init(el, null, { renderer: "canvas" });
		chartRef.current = chart;

		const handleClick = (params: echarts.ECElementEvent) => {
			const datum = params.data as unknown as TreemapDatum | undefined;
			if (
				datum?.navigable &&
				datum.path !== dataRef.current.path &&
				drillDownRef.current
			) {
				drillDownRef.current(datum.path);
			}
		};
		chart.on("click", handleClick);

		const handleBreadcrumbSelect = (params: unknown) => {
			const p = params as {
				targetNode?: { getId?: () => unknown };
				from?: unknown;
			};
			if (p.from === FOCUS_TAG) return;
			// ECharts 6 TreeNodes carry their datum id behind getId(), not an
			// .id property: spine crumbs resolve to their absolute path while
			// the series-name virtual root resolves to a bare name.
			const rawId =
				typeof p.targetNode?.getId === "function"
					? p.targetNode.getId()
					: undefined;
			const id = typeof rawId === "string" ? rawId : undefined;
			if (id?.startsWith("/")) {
				if (normalizePath(id) !== normalizePath(dataRef.current.path)) {
					drillDownRef.current?.(id);
				}
				return;
			}
			// Name-derived id => series-name virtual root => scan root.
			if (
				normalizePath(scanRootRef.current) !==
				normalizePath(dataRef.current.path)
			) {
				drillDownRef.current?.(scanRootRef.current);
			}
		};
		chart.on("treemapRootToNode", handleBreadcrumbSelect);

		let frame = 0;
		const observer = new ResizeObserver(() => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => chart.resize());
		});
		observer.observe(el);

		return () => {
			observer.disconnect();
			cancelAnimationFrame(frame);
			chart.off("click", handleClick);
			chart.off("treemapRootToNode", handleBreadcrumbSelect);
			chart.dispose();
			chartRef.current = null;
		};
	}, []);

	useEffect(() => {
		const chart = chartRef.current;
		if (!chart) return;
		chart.setOption(buildOption(seriesName, chartData, ct), {
			notMerge: true,
		});
		// Only treemapRootToNode actually moves the internal view root.
		if (!atRoot) {
			chart.dispatchAction({
				type: "treemapRootToNode",
				targetNodeId: focusPath,
				from: FOCUS_TAG,
			});
		}
	}, [seriesName, chartData, focusPath, atRoot, ct]);

	return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
