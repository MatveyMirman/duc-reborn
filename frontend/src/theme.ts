import { create } from "zustand";

export type Theme = "dark" | "light";

const STORAGE_KEY = "duc-theme";

function readStoredTheme(): Theme {
	try {
		const saved = window.localStorage.getItem(STORAGE_KEY);
		if (saved === "light" || saved === "dark") return saved;
	} catch {
		return "dark";
	}
	return "dark";
}

function applyToDocument(theme: Theme) {
	document.documentElement.dataset.theme = theme;
}

const initialTheme = readStoredTheme();
applyToDocument(initialTheme);

interface ThemeState {
	theme: Theme;
	toggleTheme: () => void;
}

export const useThemeStore = create<ThemeState>((set, get) => ({
	theme: initialTheme,
	toggleTheme: () => {
		const next: Theme = get().theme === "dark" ? "light" : "dark";
		try {
			window.localStorage.setItem(STORAGE_KEY, next);
		} catch {
			// Storage unavailable (private mode) — theme still applies per session.
		}
		applyToDocument(next);
		set({ theme: next });
	},
}));

export interface ChartTheme {
	palette: string[];
	treemap: {
		border: string;
		emphasisBorder: string;
		labelShadow: string;
		upperLabelColor: string;
		breadcrumbBg: string;
		breadcrumbBorder: string;
		breadcrumbText: string;
		breadcrumbEmphasisBg: string;
	};
	tooltip: { bg: string; border: string; text: string };
	sunburst: {
		palettes: string[][];
		sectorBorder: string;
		innerLabelColor: string;
		outerLabelColor: string;
		hintColor: string;
	};
	titleColor: string;
	subtitleColor: string;
	freeSpaceColor: string;
}

// Vivid jewel tones that read well against each surface.
const DARK_PALETTE = [
	"#6366f1",
	"#22d3ee",
	"#34d399",
	"#f59e0b",
	"#fb7185",
	"#a78bfa",
	"#38bdf8",
	"#f472b6",
	"#a3e635",
];

const LIGHT_PALETTE = [
	"#6366f1",
	"#0ea5e9",
	"#10b981",
	"#f59e0b",
	"#f43f5e",
	"#8b5cf6",
	"#06b6d4",
	"#ec4899",
	"#84cc16",
];

const DARK_SUNBURST_PALETTES = [
	[
		"#6366f1",
		"#22d3ee",
		"#34d399",
		"#f59e0b",
		"#fb7185",
		"#a78bfa",
		"#38bdf8",
		"#f472b6",
		"#a3e635",
	],
	[
		"#818cf8",
		"#67e8f9",
		"#6ee7b7",
		"#fcd34d",
		"#fda4af",
		"#c4b5fd",
		"#7dd3fc",
		"#f9a8d4",
		"#bef264",
	],
	[
		"#a5b4fc",
		"#a5f3fc",
		"#a7f3d0",
		"#fde68a",
		"#fecdd3",
		"#ddd6fe",
		"#bae6fd",
		"#fbcfe8",
		"#d9f99d",
	],
	[
		"#c7d2fe",
		"#cffafe",
		"#d1fae5",
		"#fef3c7",
		"#ffe4e6",
		"#ede9fe",
		"#e0f2fe",
		"#fce7f3",
		"#ecfccb",
	],
];

const LIGHT_SUNBURST_PALETTES = [
	[
		"#5470c6",
		"#91cc75",
		"#fac858",
		"#ee6666",
		"#73c0de",
		"#3ba272",
		"#fc8452",
		"#9a60b4",
		"#ea7ccc",
	],
	[
		"#7b9ce1",
		"#bd6d6c",
		"#75d874",
		"#e0bc78",
		"#dc77dc",
		"#9ec5e8",
		"#e0918a",
		"#87b087",
		"#d3a3bc",
	],
	[
		"#94b6e4",
		"#d9a3a2",
		"#93d68c",
		"#d8bd85",
		"#d489d4",
		"#a5c3ea",
		"#dd9d96",
		"#93b393",
		"#cba2ba",
	],
	[
		"#b7d0f2",
		"#e5c6a5",
		"#bce0ae",
		"#ecc0c0",
		"#e0cdb8",
		"#c5daf5",
		"#ecd0bb",
		"#eccfd4",
		"#dccbe8",
	],
];

const CHART_THEMES: Record<Theme, ChartTheme> = {
	dark: {
		palette: DARK_PALETTE,
		treemap: {
			border: "rgba(11, 14, 23, 0.9)",
			emphasisBorder: "rgba(231, 235, 244, 0.65)",
			labelShadow: "rgba(0, 0, 0, 0.4)",
			upperLabelColor: "rgba(255, 255, 255, 0.85)",
			breadcrumbBg: "#171c2e",
			breadcrumbBorder: "#303a58",
			breadcrumbText: "#c7cede",
			breadcrumbEmphasisBg: "#232b45",
		},
		tooltip: { bg: "#171c2e", border: "#303a58", text: "#e7ebf4" },
		sunburst: {
			palettes: DARK_SUNBURST_PALETTES,
			sectorBorder: "#0b0e17",
			innerLabelColor: "#fff",
			outerLabelColor: "#0b0e17",
			hintColor: "#939cb3",
		},
		titleColor: "#e7ebf4",
		subtitleColor: "#939cb3",
		freeSpaceColor: "#475569",
	},
	light: {
		palette: LIGHT_PALETTE,
		treemap: {
			border: "rgba(255, 255, 255, 0.95)",
			emphasisBorder: "rgba(71, 85, 105, 0.55)",
			labelShadow: "rgba(15, 23, 42, 0.25)",
			upperLabelColor: "#fff",
			breadcrumbBg: "#f1f5f9",
			breadcrumbBorder: "#cbd5e1",
			breadcrumbText: "#475569",
			breadcrumbEmphasisBg: "#e2e8f0",
		},
		tooltip: { bg: "#ffffff", border: "#cbd5e1", text: "#334155" },
		sunburst: {
			palettes: LIGHT_SUNBURST_PALETTES,
			sectorBorder: "#ffffff",
			innerLabelColor: "#fff",
			outerLabelColor: "#334155",
			hintColor: "#64748b",
		},
		titleColor: "#182034",
		subtitleColor: "#64748b",
		freeSpaceColor: "#94a3b8",
	},
};

export function getChartTheme(theme: Theme): ChartTheme {
	return CHART_THEMES[theme];
}
