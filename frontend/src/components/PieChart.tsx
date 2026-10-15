import * as echarts from "echarts";
import { useEffect, useMemo, useRef } from "react";
import type { FileNode } from "../stores/scanStore";
import type { ChartTheme } from "../theme";
import { getChartTheme, useThemeStore } from "../theme";

interface PieChartProps {
	data: FileNode;
	onDrillDown: (path: string) => void;
	onNavigateUp?: () => void;
}

function formatBytes(bytes: number): string {
	if (!bytes || bytes <= 0) return "0 B";
	const k = 1024;
	const sizes = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(
		Math.floor(Math.log(bytes) / Math.log(k)),
		sizes.length - 1,
	);
	return `${parseFloat((bytes / k ** i).toFixed(2))} ${sizes[i]}`;
}

function hashName(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) {
		h = (h * 31 + name.charCodeAt(i)) | 0;
	}
	return Math.abs(h);
}

type SunburstDatum = NonNullable<
	echarts.SunburstSeriesOption["data"]
>[number] & {
	path: string;
	is_dir: boolean;
	children?: SunburstDatum[];
	label?: Record<string, unknown>;
};

function toEChartsData(
	node: FileNode,
	depth: number,
	ct: ChartTheme,
): SunburstDatum {
	// Sunburst computes sector angles automatically from each child's
	// `value` relative to its siblings - no manual fraction math needed.
	const palettes = ct.sunburst.palettes;
	const isFreeSpace = node.is_free_space === true;
	const result: SunburstDatum = {
		name: node.name || "/",
		path: node.path,
		is_dir: node.is_dir,
		value: node.size > 0 ? node.size : 0.001,
		itemStyle: {
			color: isFreeSpace
				? ct.freeSpaceColor
				: palettes[Math.min(depth, palettes.length - 1)][
						hashName(node.name || "/") % palettes[0].length
					],
		},
	};

	if (node.children && node.children.length > 0) {
		result.children = node.children.map((c) => toEChartsData(c, depth + 1, ct));
	} else {
		// Leaf: show name inside when there's room, otherwise hide.
		result.label = { show: true, overflow: "truncate", width: 70 };
	}

	return result;
}

export default function PieChart({
	data,
	onDrillDown,
	onNavigateUp,
}: PieChartProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const chartRef = useRef<echarts.ECharts | null>(null);
	const onDrillDownRef = useRef(onDrillDown);
	const onNavigateUpRef = useRef(onNavigateUp);
	onDrillDownRef.current = onDrillDown;
	onNavigateUpRef.current = onNavigateUp;

	const theme = useThemeStore((s) => s.theme);
	const ct = useMemo(() => getChartTheme(theme), [theme]);

	const option: echarts.EChartsOption = useMemo(() => {
		const totalSize =
			data.size || (data.children?.reduce((s, c) => s + c.size, 0) ?? 0);
		const outerLabelColor = ct.sunburst.outerLabelColor;

		return {
			animation: false,
			tooltip: {
				backgroundColor: ct.tooltip.bg,
				borderColor: ct.tooltip.border,
				textStyle: { color: ct.tooltip.text, fontSize: 12 },
				formatter: (info: unknown) => {
					const p = info as {
						name?: string;
						value?: number | string;
						data?: { is_dir?: boolean };
					};
					return `<div style="font-weight:600">${p.name ?? ""}</div><div>${formatBytes(
						Number(p.value) || 0,
					)}</div>${p.data?.is_dir ? `<div style="color:${ct.sunburst.hintColor};font-size:11px">Click to drill down</div>` : ""}`;
				},
			},
			title: {
				text: formatBytes(totalSize),
				subtext: data.name || "/",
				left: "center",
				top: "middle",
				textStyle: {
					fontSize: 20,
					fontWeight: "bold",
					color: ct.titleColor,
				},
				subtextStyle: {
					fontSize: 11,
					color: ct.subtitleColor,
					width: 110,
					overflow: "truncate",
				},
			},
			series: [
				{
					type: "sunburst",
					radius: ["22%", "92%"],
					nodeClick: false,
					itemStyle: {
						borderColor: ct.sunburst.sectorBorder,
						borderWidth: 2,
					},
					emphasis: {
						focus: "ancestor",
					},
					levels: [
						{},
						{
							r0: "22%",
							r: "48%",
							label: {
								rotate: "tangential",
								fontSize: 13,
								fontWeight: "bold",
								color: ct.sunburst.innerLabelColor,
								minAngle: 12,
								overflow: "truncate",
								width: 90,
							},
						},
						{
							r0: "48%",
							r: "68%",
							label: {
								rotate: "radial",
								fontSize: 11,
								minAngle: 8,
								color: outerLabelColor,
								fontWeight: 600,
								overflow: "truncate",
								width: 60,
							},
						},
						{
							r0: "68%",
							r: "82%",
							label: {
								rotate: "radial",
								fontSize: 10,
								minAngle: 6,
								color: outerLabelColor,
								overflow: "truncate",
								width: 50,
							},
						},
						{
							r0: "82%",
							r: "92%",
							label: {
								rotate: "radial",
								fontSize: 9,
								minAngle: 5,
								color: outerLabelColor,
								overflow: "truncate",
								width: 40,
							},
						},
					],
					// Hide any labels that would physically overlap after layout
					// (the main cause of stacked/cluttered labels near small sectors).
					labelLayout: { hideOverlap: true },
					data: [toEChartsData(data, 0, ct)],
				},
			],
		};
	}, [data, ct]);

	useEffect(() => {
		if (!containerRef.current) return;
		const chart = echarts.init(containerRef.current, undefined, {
			renderer: "canvas",
		});
		chartRef.current = chart;

		const handleResize = () => chart.resize();
		window.addEventListener("resize", handleResize);
		// Container can resize without a window resize (view toggle, sidebar)
		const ro = new ResizeObserver(handleResize);
		ro.observe(containerRef.current);

		const handleClick = (params: unknown) => {
			const p = params as {
				data?: { path?: string; is_dir?: boolean };
			};
			if (p?.data?.path === data.path) {
				onNavigateUpRef.current?.();
			} else if (p?.data?.is_dir && p.data.path) {
				onDrillDownRef.current(p.data.path);
			}
		};
		chart.on("click", handleClick);

		return () => {
			window.removeEventListener("resize", handleResize);
			ro.disconnect();
			chart.off("click", handleClick);
			chart.dispose();
			chartRef.current = null;
		};
	}, [data.path]);

	useEffect(() => {
		if (chartRef.current) {
			chartRef.current.setOption(option, true);
		}
	}, [option]);

	return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
}
