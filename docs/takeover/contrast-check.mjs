// WCAG 2.x contrast check for the Mandovi palette (HSL tokens as in index.css).
function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((x) => Math.round(x * 255));
}
function lum([r, g, b]) {
  const c = [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
const p = (s) => hslToRgb(...s.split(/\s+/).map((x) => parseFloat(x)));
const hex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase();
function ratio(a, b) {
  const [l1, l2] = [lum(p(a)), lum(p(b))].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}
// Tinted chip backgrounds (e.g. bg-warning/12 on white) = mix with background.
function mix(fg, bg, alpha) {
  const A = p(fg), B = p(bg);
  const m = A.map((v, i) => Math.round(v * alpha + B[i] * (1 - alpha)));
  const [r, g, b] = m.map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b); let h = 0, s = 0; const l = (max + min) / 2;
  if (max !== min) { const d = max - min; s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; }
  return `${h} ${s * 100} ${l * 100}`;
}

const themes = {
  light: {
    background: "0 0% 100%", foreground: "200 25% 12%", card: "0 0% 100%",
    muted: "190 20% 96%", "muted-foreground": "200 10% 38%",
    primary: "186 75% 24%", "primary-foreground": "0 0% 100%",
    secondary: "190 20% 94%", accent: "186 35% 93%", "accent-foreground": "186 70% 18%",
    sidebar: "190 25% 97%", "sidebar-foreground": "200 15% 28%",
    destructive: "4 70% 42%", success: "152 60% 26%", warning: "32 95% 29%", info: "210 70% 38%", danger: "4 70% 42%",
    border: "190 15% 85%", input: "190 12% 54%",
  },
  dark: {
    background: "200 20% 9%", foreground: "190 15% 92%", card: "200 18% 12%",
    muted: "200 15% 15%", "muted-foreground": "190 10% 66%",
    primary: "184 55% 55%", "primary-foreground": "200 30% 8%",
    secondary: "200 15% 18%", accent: "186 30% 18%", "accent-foreground": "186 50% 85%",
    sidebar: "200 22% 7%", "sidebar-foreground": "190 12% 78%",
    destructive: "4 75% 66%", success: "152 45% 52%", warning: "38 85% 60%", info: "210 80% 70%", danger: "4 75% 66%",
    border: "200 12% 24%", input: "200 10% 45%",
  },
};

let fails = 0;
for (const [name, t] of Object.entries(themes)) {
  const pairs = [
    ["foreground", "background"], ["foreground", "card"], ["muted-foreground", "background"],
    ["muted-foreground", "muted"], ["primary-foreground", "primary"], ["primary", "background"],
    ["accent-foreground", "accent"], ["sidebar-foreground", "sidebar"],
    ["destructive", "background"], ["success", "background"], ["warning", "background"], ["info", "background"],
    ["destructive", "card"], ["success", "card"], ["warning", "card"],
  ];
  console.log(`\n${name.toUpperCase()}`);
  for (const [fg, bg] of pairs) {
    const r = ratio(t[fg], t[bg]);
    if (r < 4.5) fails++;
    console.log(`${(fg + " on " + bg).padEnd(36)} ${hex(p(t[fg]))} / ${hex(p(t[bg]))}  ${r.toFixed(2)}:1 ${r >= 4.5 ? "AA" : "FAIL"}`);
  }
  // Status chips: text-X on bg-X/10 or /12 over the page background.
  for (const s of ["success", "warning", "danger", "info"]) {
    const chip = mix(t[s], t.background, 0.12);
    const r = ratio(t[s], chip);
    if (r < 4.5) fails++;
    console.log(`${(s + " text on " + s + "/12 chip").padEnd(36)} ${r.toFixed(2)}:1 ${r >= 4.5 ? "AA" : "FAIL"}`);
  }
  // Non-text: input border vs background needs 3:1 (WCAG 1.4.11).
  const ib = ratio(t.input, t.background);
  if (ib < 3) fails++;
  console.log(`${"input border on background (3:1)".padEnd(36)} ${ib.toFixed(2)}:1 ${ib >= 3 ? "OK" : "FAIL"}`);
}
console.log(`\n${fails} failing pair(s)`);

