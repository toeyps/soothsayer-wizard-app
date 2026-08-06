import { useCallback, useRef, useState } from 'react';

interface ColorPlatePickerProps {
    color: string; // '#rrggbb'
    onChange: (hex: string) => void;
}

function hexToRgb(hex: string): [number, number, number] {
    return [
        parseInt(hex.slice(1, 3), 16) || 0,
        parseInt(hex.slice(3, 5), 16) || 0,
        parseInt(hex.slice(5, 7), 16) || 0,
    ];
}

function rgbToHex(r: number, g: number, b: number): string {
    return `#${[r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
}

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d) % 6;
        else if (max === g) h = (b - r) / d + 2;
        else h = (r - g) / d + 4;
        h *= 60;
        if (h < 0) h += 360;
    }
    const s = max === 0 ? 0 : d / max;
    return [h, s, max];
}

function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0, g = 0, b = 0;
    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

// Minimal HSV picker: a saturation/value square (hue held fixed while
// dragging) plus a hue slider — deliberately no numeric RGB/hex fields, no
// swatch presets. Built from scratch (no external lib) after react-colorful
// failed to resolve its CSS import in this project's Vite setup.
export default function ColorPlatePicker({ color, onChange }: ColorPlatePickerProps) {
    // Hue/saturation/value are tracked as local state rather than re-derived
    // from `color` on every render. RGB can't losslessly round-trip HSV at
    // its wrap-around boundary: pure red is hue 0 AND hue 360 depending on
    // which direction you approach it from, but `rgbToHsv` always normalizes
    // it back to 0. Re-deriving on every render meant dragging the hue slider
    // to the far right (hue 360, still pure red) rendered the thumb back at
    // hue 0 — the far left — on the very next render.
    //
    // `lastEmittedColor` tracks the hex WE last sent via `onChange`. Only
    // re-derive h/s/v from the incoming `color` prop when it does NOT match
    // that — i.e. the picker is now showing a genuinely different color
    // (opened for a different sensor), not just React echoing back the exact
    // value this component itself just emitted.
    const [hsv, setHsv] = useState<[number, number, number]>(() => rgbToHsv(...hexToRgb(color)));
    const [lastEmittedColor, setLastEmittedColor] = useState(color);
    if (color !== lastEmittedColor) {
        setLastEmittedColor(color);
        setHsv(rgbToHsv(...hexToRgb(color)));
    }
    const [h, s, v] = hsv;

    const squareRef = useRef<HTMLDivElement>(null);
    const hueRef = useRef<HTMLDivElement>(null);

    const emit = useCallback((nextHsv: [number, number, number]) => {
        setHsv(nextHsv);
        const hex = rgbToHex(...hsvToRgb(...nextHsv));
        setLastEmittedColor(hex);
        onChange(hex);
    }, [onChange]);

    const handleSquare = useCallback((clientX: number, clientY: number) => {
        const el = squareRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        const y = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
        emit([h, x, 1 - y]);
    }, [h, emit]);

    const handleHue = useCallback((clientX: number) => {
        const el = hueRef.current;
        if (!el) return;
        const rect = el.getBoundingClientRect();
        const x = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
        emit([x * 360, s, v]);
    }, [s, v, emit]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div
                ref={squareRef}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); handleSquare(e.clientX, e.clientY); }}
                onPointerMove={(e) => { if (e.buttons === 1) handleSquare(e.clientX, e.clientY); }}
                style={{
                    position: 'relative', width: '100%', height: '120px', borderRadius: '6px',
                    cursor: 'crosshair', touchAction: 'none',
                    backgroundColor: `hsl(${h}, 100%, 50%)`,
                    backgroundImage:
                        'linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, rgba(255,255,255,0))',
                }}
            >
                <div style={{
                    position: 'absolute', left: `${s * 100}%`, top: `${(1 - v) * 100}%`,
                    width: '12px', height: '12px', borderRadius: '50%',
                    border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
                    transform: 'translate(-50%, -50%)', pointerEvents: 'none',
                }} />
            </div>
            <div
                ref={hueRef}
                onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); handleHue(e.clientX); }}
                onPointerMove={(e) => { if (e.buttons === 1) handleHue(e.clientX); }}
                style={{
                    position: 'relative', width: '100%', height: '12px', borderRadius: '6px',
                    cursor: 'pointer', touchAction: 'none',
                    background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)',
                }}
            >
                <div style={{
                    position: 'absolute', left: `${(h / 360) * 100}%`, top: '50%',
                    width: '14px', height: '14px', borderRadius: '50%',
                    border: '2px solid #fff', boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
                    transform: 'translate(-50%, -50%)', pointerEvents: 'none', background: color,
                }} />
            </div>
        </div>
    );
}
