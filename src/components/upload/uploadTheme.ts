/**
 * Dark theme tokens shared by the Import page (DataUploadPage) and its
 * sub-components (HomeStep, RecentProjectCard). Ported from the design handoff.
 */

export interface Tokens {
  bg: string;
  surface: string;
  surfaceHi: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textFaint: string;
  accent: string;
  accentHi: string;
  accentMuted: string;
  ok: string;
  warn: string;
  danger: string;
  hover: string;
  chipBg: string;
  s1: string;
  s2: string;
  s3: string;
  s4: string;
}

export const DARK: Tokens = {
  bg: "#0a0a0b",
  surface: "#101012",
  surfaceHi: "#16161a",
  border: "rgba(255,255,255,0.07)",
  borderStrong: "rgba(255,255,255,0.12)",
  text: "#ededef",
  textMuted: "#8c8c94",
  textFaint: "#5b5b63",
  accent: "oklch(0.68 0.17 245)",
  accentHi: "oklch(0.74 0.17 245)",
  accentMuted: "oklch(0.4 0.1 245 / 0.18)",
  ok: "oklch(0.72 0.15 150)",
  warn: "oklch(0.78 0.14 75)",
  danger: "oklch(0.68 0.2 25)",
  hover: "rgba(255,255,255,0.04)",
  chipBg: "rgba(255,255,255,0.05)",
  s1: "oklch(0.72 0.16 245)",
  s2: "oklch(0.74 0.15 155)",
  s3: "oklch(0.78 0.14 70)",
  s4: "oklch(0.7 0.15 310)",
};

export const mono = 'JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, monospace';
