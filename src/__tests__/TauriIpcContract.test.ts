// @vitest-environment node
/**
 * Static IPC contract between the frontend and `src-tauri/src/lib.rs`
 * (qa-agent, 2026-10-04 final sweep after health score phase 4).
 *
 * Mocked `invoke` in component tests can never notice that a command is not
 * registered, or that an argument key has the wrong casing (CLAUDE.md: "the
 * #1 silent-failure trap" — Tauri v2 expects camelCase keys unless the command
 * says `rename_all = "snake_case"`, and a hook may swallow the rejection).
 * This reads the real Rust source and the real TS call sites:
 *
 *  1. every command the frontend calls is in `generate_handler![...]`;
 *  2. every registered command is either called or on the explicit
 *     "intentionally unused" list (so a removal like phase 4's leaves no
 *     silently dead command behind without a decision);
 *  3. at every call site that passes an object literal, every top-level key
 *     is a parameter of the Rust command in the casing Tauri will accept, and
 *     every non-`Option` parameter is present;
 *  4. every window label the frontend creates has a capability file and a
 *     `main.tsx` route, and every capability window label is still created.
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync, readdirSync } from 'node:fs';
// @ts-expect-error - same
import { join, relative } from 'node:path';

// Typed wrappers (the node imports above are untyped without @types/node).
const readText = (p: string): string => readFileSync(p, 'utf8');
const listDir = (p: string): { name: string; isDirectory: () => boolean }[] => readdirSync(p, { withFileTypes: true });
const listNames = (p: string): string[] => readdirSync(p);
const joinPath = (...a: string[]): string => join(...a);
const relPath = (from: string, to: string): string => relative(from, to);

/** vitest runs with the repo root as cwd (the same assumption BuildModelWindow.test.tsx makes). */
const ROOT = '.';
const LIB = readText(joinPath(ROOT, 'src-tauri', 'src', 'lib.rs'));

/** Registered but intentionally not called from the frontend (decide before adding here). */
const INTENTIONALLY_UNCALLED = new Set([
    // The standalone train-and-save commands. Mark complete writes the model files via
    // `export_model_files`; these three are kept registered as that export's public twins
    // (same training code, direct entry points) and for future use — not dead code, don't delete.
    'train_individual_model', 'train_clustering_model', 'train_relationship_model',
    // Diagnostic; no caller since the upload page stopped re-checking loaded paths.
    'get_loaded_paths',
]);

// ── Rust side ────────────────────────────────────────────────────────────

const registered = (() => {
    const m = LIB.match(/generate_handler!\[([\s\S]*?)\]/);
    if (!m) throw new Error('generate_handler! not found');
    return m[1].split(',').map(s => s.replace(/\/\/.*$/gm, '').trim()).filter(Boolean).map(s => s.split('::').pop()!);
})();

interface RustParam { name: string; optional: boolean }
interface RustCommand { name: string; snake: boolean; params: RustParam[] }

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

const commands: Map<string, RustCommand> = (() => {
    const out = new Map<string, RustCommand>();
    const re = /#\[tauri::command(\(([^)]*)\))?\]\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(/g;
    for (const m of LIB.matchAll(re)) {
        const snake = /rename_all\s*=\s*"snake_case"/.test(m[2] ?? '');
        // parameter list: from the '(' to its matching ')'
        let i = m.index! + m[0].length, depth = 1;
        const start = i;
        while (depth > 0 && i < LIB.length) {
            const c = LIB[i++];
            if (c === '(' || c === '<' || c === '[') depth++;
            else if (c === ')' || c === '>' || c === ']') depth--;
        }
        const body = LIB.slice(start, i - 1).replace(/\/\/.*$/gm, '');
        // split on top-level commas
        const parts: string[] = [];
        let d = 0, cur = '';
        for (const c of body) {
            if (c === '<' || c === '(' || c === '[') d++;
            if (c === '>' || c === ')' || c === ']') d--;
            if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c;
        }
        if (cur.trim()) parts.push(cur);
        const params: RustParam[] = [];
        for (const p of parts) {
            const pm = p.replace(/\/\/.*$/gm, '').trim().match(/^(?:mut\s+)?(\w+)\s*:\s*([\s\S]+)$/);
            if (!pm) continue;
            const type = pm[2].replace(/\s+/g, '');
            if (/^(tauri::)?(State|AppHandle|Window|WebviewWindow|Webview)\b/.test(type)) continue;
            params.push({ name: pm[1], optional: /^Option</.test(type) });
        }
        out.set(m[3], { name: m[3], snake, params });
    }
    return out;
})();

const expectedKey = (c: RustCommand, p: RustParam) => (c.snake ? p.name : camel(p.name));

// ── TS side ──────────────────────────────────────────────────────────────

function sourceFiles(dir: string, out: string[] = []): string[] {
    for (const e of listDir(dir)) {
        const p = joinPath(dir, e.name);
        if (e.isDirectory()) { if (e.name !== '__tests__') sourceFiles(p, out); }
        else if (/\.(tsx|ts)$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
    return out;
}
const FILES = sourceFiles(joinPath(ROOT, 'src')).map(f => ({ rel: relPath(ROOT, f).replace(/\\/g, '/'), code: readText(f) }));
const COMMAND_NAMES = new Set(registered);

interface CallSite { file: string; line: number; cmd: string; keys: string[] | null; spread: boolean }

/** `<fn>(<T>)?('cmd'` where cmd is a known/registered name or looks like one, plus its object-literal keys. */
const callSites: CallSite[] = (() => {
    const out: CallSite[] = [];
    const re = /\b(\w*[iI]nvoke\w*|inv|call|bound|run)\s*(?:<(?:[^<>()]|<[^<>]*>)*>)?\(\s*(['"])([a-z][a-z0-9_]*)\2\s*(,\s*)?/g;
    for (const { rel, code } of FILES) {
        for (const m of code.matchAll(re)) {
            const cmd = m[3];
            if (!COMMAND_NAMES.has(cmd) && !/_/.test(cmd)) continue;
            const line = code.slice(0, m.index).split('\n').length;
            let keys: string[] | null = null;
            let spread = false;
            const after = m.index! + m[0].length;
            if (m[4] && code[after] === '{') {
                let i = after + 1, depth = 1;
                while (depth > 0 && i < code.length) {
                    const c = code[i++];
                    if (c === '{' || c === '(' || c === '[') depth++;
                    else if (c === '}' || c === ')' || c === ']') depth--;
                }
                const body = code.slice(after + 1, i - 1);
                const parts: string[] = [];
                let d = 0, cur = '';
                for (const c of body) {
                    if ('{([' .includes(c)) d++;
                    if ('})]'.includes(c)) d--;
                    if (c === ',' && d === 0) { parts.push(cur); cur = ''; } else cur += c;
                }
                if (cur.trim()) parts.push(cur);
                keys = [];
                for (const p of parts.map(x => x.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '').trim()).filter(Boolean)) {
                    if (p.startsWith('...')) { spread = true; continue; }
                    const km = p.match(/^['"]?([A-Za-z_$][\w$]*)['"]?\s*(:|$)/);
                    if (km) keys.push(km[1]);
                }
            }
            out.push({ file: rel, line, cmd, keys, spread });
        }
    }
    return out;
})();

describe('Tauri IPC contract (static: lib.rs <-> TS call sites)', () => {
    it('sanity: the parser sees the handler list, the command signatures and the call sites', () => {
        expect(registered.length).toBeGreaterThan(20);
        expect(registered.every(c => commands.has(c)), `no #[tauri::command] fn for: ${registered.filter(c => !commands.has(c))}`).toBe(true);
        expect(commands.get('get_chart_data')!.snake).toBe(true);
        expect(commands.get('get_chart_data')!.params.map(p => p.name)).toEqual(expect.arrayContaining(['filter', 'max_points']));
        expect(callSites.length).toBeGreaterThan(15);
    });

    it('every command the frontend calls is registered in generate_handler!', () => {
        const unregistered = callSites.filter(c => !COMMAND_NAMES.has(c.cmd)).map(c => `${c.cmd} (${c.file}:${c.line})`);
        expect(unregistered).toEqual([]);
    });

    it('every registered command is called somewhere, or is on the explicit intentionally-uncalled list', () => {
        const called = new Set(callSites.map(c => c.cmd));
        const dead = registered.filter(c => !called.has(c) && !INTENTIONALLY_UNCALLED.has(c));
        expect(dead).toEqual([]);
        const staleAllowList = [...INTENTIONALLY_UNCALLED].filter(c => called.has(c) || !COMMAND_NAMES.has(c));
        expect(staleAllowList).toEqual([]);
    });

    it('every object-literal call site sends only keys Tauri will deserialize, and every required parameter', () => {
        const problems: string[] = [];
        for (const site of callSites) {
            const cmd = commands.get(site.cmd);
            if (!cmd || site.keys === null) continue;
            const allowed = new Set(cmd.params.map(p => expectedKey(cmd, p)));
            for (const k of site.keys) {
                if (!allowed.has(k)) problems.push(`${site.file}:${site.line} ${site.cmd}: key '${k}' is not one of [${[...allowed].join(', ')}]${cmd.snake ? '' : ' (no rename_all -> camelCase)'}`);
            }
            if (!site.spread) {
                for (const p of cmd.params.filter(x => !x.optional)) {
                    if (!site.keys.includes(expectedKey(cmd, p))) problems.push(`${site.file}:${site.line} ${site.cmd}: missing required key '${expectedKey(cmd, p)}'`);
                }
            }
        }
        expect(problems).toEqual([]);
    });

    it('every multi-word-parameter command a call site reaches with snake_case keys carries rename_all = "snake_case"', () => {
        const bad = callSites.filter(s => {
            const c = commands.get(s.cmd);
            return c && !c.snake && (s.keys ?? []).some(k => k.includes('_'));
        }).map(s => `${s.cmd} (${s.file}:${s.line})`);
        expect(bad).toEqual([]);
    });

    it('window labels: every label the frontend creates has a capability and a main.tsx route; every capability label is still created', () => {
        const capDir = joinPath(ROOT, 'src-tauri', 'capabilities');
        const capLabels = new Set(listNames(capDir).filter(f => f.endsWith('.json'))
            .flatMap(f => (JSON.parse(readText(joinPath(capDir, f))).windows ?? []) as string[]));
        const all = FILES.map(f => f.code).join('\n');
        const created = new Set<string>(['main']);
        for (const m of all.matchAll(/new WebviewWindow\(\s*['"]([\w-]+)['"]/g)) created.add(m[1]);
        // `const label = 'x'; ... new WebviewWindow(label, ...)` (Dashboard's build-model spawn)
        for (const m of all.matchAll(/const label = ['"]([\w-]+)['"];[\s\S]{0,1500}?new WebviewWindow\(label/g)) created.add(m[1]);
        const mainTsx = readText(joinPath(ROOT, 'src', 'main.tsx'));
        expect([...created].filter(l => !capLabels.has(l)), 'created without a capability').toEqual([]);
        expect([...created].filter(l => l !== 'main' && !mainTsx.includes(`"${l}"`) && !mainTsx.includes(`'${l}'`)), 'created without a main.tsx route').toEqual([]);
        expect([...capLabels].filter(l => !created.has(l)), 'capability for a window nothing creates').toEqual([]);
        expect(created).toEqual(new Set(['main', 'build-model', 'add-sensor']));
    });
});
