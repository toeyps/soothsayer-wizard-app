// @vitest-environment node
/**
 * Wording guard for everything a user can read (fe-ui-agent, 2026-10-10).
 *
 * User decision 2026-10-10: the whole app says "Relation model" — never
 * "Relationship" / "Relationship model" — and the words of the machinery
 * ("sidecar", "Python") and the confidential algorithm name never reach the
 * screen (CLAUDE.md: "the UI must say Relation model").
 *
 * This parses the REAL app source (every `.ts`/`.tsx` under `src/`, tests
 * excluded) with the TypeScript compiler and reads only what can end up on
 * screen: string literals, template-literal text and JSX text. Comments,
 * identifiers, type names (`RelationshipPreviewResult`), import paths and
 * type-position literals are never looked at, so they stay free.
 *
 * What stays allowed on purpose:
 *  - the kind VALUE `'relationship'` (types, saved workspaces, wire values) and
 *    names built from it without a space: command names
 *    (`preview_relationship_model`), CSS classes (`kind-badge--relationship`),
 *    test ids (`model-fit-relationship`);
 *  - the error CODE `SIDECAR_OUTDATED` (compared, never shown — its text is
 *    `HEALTH_ERROR_TEXT.SIDECAR_OUTDATED`, "The Relation model engine …").
 *
 * A new hit means a user-facing string regressed: fix the string. Only add to
 * `ALLOWED` for a literal that is provably never rendered, with the reason
 * (today: the one legacy word `utils/modelNames.ts` compares saved names with).
 */
import { describe, it, expect } from 'vitest';
import ts from 'typescript';
// @ts-expect-error - @types/node is not installed; vitest runs in Node so this resolves at runtime
import { readFileSync, readdirSync } from 'node:fs';
// @ts-expect-error - same
import { join } from 'node:path';

const readText = (p: string): string => readFileSync(p, 'utf8');
const listDir = (p: string): { name: string; isDirectory: () => boolean }[] => readdirSync(p, { withFileTypes: true });
const joinPath = (...a: string[]): string => (join(...a) as string).replace(/\\/g, '/');

/** vitest runs with the repo root as cwd. */
const SRC = 'src';

function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of listDir(dir)) {
        const p = joinPath(dir, e.name);
        if (e.isDirectory()) {
            if (e.name === '__tests__' || e.name === 'node_modules') continue;
            out.push(...sourceFiles(p));
        } else if (/\.(ts|tsx)$/.test(e.name) && !e.name.endsWith('.d.ts')) {
            out.push(p);
        }
    }
    return out;
}

interface Literal { file: string; line: number; text: string }

/** Every piece of text in `code` that could be rendered: string literals, template text, JSX text. */
function renderableText(file: string, code: string): Literal[] {
    const sf = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const out: Literal[] = [];
    const add = (node: ts.Node, text: string) => {
        out.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text });
    };
    const visit = (node: ts.Node): void => {
        // `import … from '…'` / `export … from '…'` / `import('…')` type queries: a path, never shown.
        if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
            return;
        }
        // A literal in TYPE position (`kind: 'relationship' | 'clustering'`) is never a value.
        if (ts.isLiteralTypeNode(node)) return;
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
        else if (node.kind === ts.SyntaxKind.TemplateHead || node.kind === ts.SyntaxKind.TemplateMiddle || node.kind === ts.SyntaxKind.TemplateTail) {
            add(node, (node as ts.TemplateHead).text);
        } else if (ts.isJsxText(node)) {
            if (node.text.trim() !== '') add(node, node.text);
        }
        ts.forEachChild(node, visit);
    };
    visit(sf);
    return out;
}

interface Rule { name: string; test: (text: string) => boolean }

/** Characters that glue `relationship` into a name (class, id, command, path) instead of a word of a sentence. */
const GLUE = "[\\w\\-.:/$]";

const RULES: Rule[] = [
    // The kind is "Relation model". A capital-R "Relationship" in rendered text is the old label
    // (identifiers and type names are not rendered text and are never scanned).
    { name: 'says "Relationship" (the kind is "Relation model")', test: t => /Relationship|RELATIONSHIP/.test(t) },
    // …and the lower-case form used as a WORD of a sentence ("the relationship model", "a relationship
    // fit"). The bare kind value and names built on it (`kind-badge--relationship`,
    // `preview_relationship_model`) are glued to other characters and pass.
    {
        name: 'says "relationship" as a word (the kind is "Relation model")',
        test: t => t !== 'relationship' && new RegExp(`(?<!${GLUE})relationship(?!${GLUE})`).test(t),
    },
    // The machinery behind the Relation model: users read "Relation model engine".
    { name: 'says "sidecar" (users read "Relation model engine")', test: t => /sidecar/i.test(t.replace(/\bSIDECAR_OUTDATED\b/g, '')) },
    { name: 'says "Python"', test: t => /python/i.test(t) },
    // The confidential algorithm name, spelled out or abbreviated.
    { name: 'names the algorithm', test: t => /linear[\s_-]*gam/i.test(t) || /(?<![A-Za-z])gams?(?![A-Za-z])/i.test(t) },
];

/**
 * Literals that match a rule but are provably never rendered. `file` is the path from the repo
 * root, `text` the exact literal. Add an entry only when there is no other way — and say why.
 */
const ALLOWED: Array<{ file: string; text: string; why: string }> = [
    {
        file: 'src/utils/modelNames.ts',
        text: 'Relationship',
        why: 'LEGACY_KIND_WORD: only COMPARED against names saved before 2026-10-10 ("X (Relationship)") so a new suggestion skips their twin; it is never rendered or written',
    },
];

function violationsIn(literals: Literal[]): string[] {
    const out: string[] = [];
    for (const lit of literals) {
        if (ALLOWED.some(a => a.file === lit.file && a.text === lit.text)) continue;
        for (const rule of RULES) {
            if (rule.test(lit.text)) out.push(`${lit.file}:${lit.line}  ${rule.name}  ->  ${JSON.stringify(lit.text.trim().slice(0, 140))}`);
        }
    }
    return out;
}

describe('user-facing wording: "Relation model" everywhere, never the machinery or the algorithm', () => {
    const files = sourceFiles(SRC);
    const literals = files.flatMap(f => renderableText(f, readText(f)));

    it('scans the real app source (not vacuous)', () => {
        expect(files.length).toBeGreaterThan(80);
        expect(files).toContain('src/components/windows/BuildModelWindow.tsx');
        expect(files).toContain('src/components/dashboard/FailureGroupAssignSheet.tsx');
        expect(files).toContain('src/utils/modelNames.ts');
        expect(files.some(f => f.includes('__tests__'))).toBe(false);
        expect(literals.length).toBeGreaterThan(3000);
        // the scanner really reads the strings users see…
        expect(literals.some(l => l.text === 'Relation model')).toBe(true);
        // …and the kind value it must leave alone
        expect(literals.some(l => l.text === 'relationship')).toBe(true);
    });

    it('no string literal, template text or JSX text of the app says a forbidden word', () => {
        expect(violationsIn(literals)).toEqual([]);
    });

    it('every ALLOWED entry still exists and has a reason (a stale exemption hides nothing)', () => {
        for (const a of ALLOWED) {
            expect(a.why.trim().length, `${a.file}: reason`).toBeGreaterThan(10);
            expect(literals.some(l => l.file === a.file && l.text === a.text), `${a.file}: ${a.text}`).toBe(true);
        }
    });

    // The guard itself: it must be able to fail, and must not cry wolf.
    describe('the scanner', () => {
        const scan = (code: string, file = 'x.tsx'): string[] => violationsIn(renderableText(file, code));

        it('flags the old kind label wherever it can be rendered', () => {
            expect(scan(`const L = { relationship: 'Relationship' };`)).toHaveLength(1);
            expect(scan('const t = `${n} (Relationship)`;')).toHaveLength(1);
            expect(scan(`const a = <span title="Remove Relationship from G">x</span>;`)).toHaveLength(1);
            expect(scan(`const a = <b>Relationship model</b>;`)).toHaveLength(1);
            expect(scan(`const m = 'this relationship model has no fit';`)).toHaveLength(1);
            expect(scan(`const m = 'Individual, relationship or clustering';`)).toHaveLength(1);
        });

        it('flags the machinery words and the algorithm name', () => {
            expect(scan(`const m = 'The sidecar crashed';`)).toHaveLength(1);
            expect(scan(`const m = 'Sidecar not found';`)).toHaveLength(1);
            expect(scan(`const m = 'Python traceback';`)).toHaveLength(1);
            expect(scan(`const a = <p>Fitted with python</p>;`)).toHaveLength(1);
            expect(scan(`const m = 'LinearGAM did not converge';`)).toHaveLength(1);
            expect(scan(`const m = 'Linear GAM';`)).toHaveLength(1);
            expect(scan(`const m = 'The GAM did not converge';`)).toHaveLength(1);
            expect(scan('const m = `Fitting ${n} GAMs`;')).toHaveLength(1);
        });

        it('leaves the kind value, names built on it, codes, identifiers, types, imports and comments alone', () => {
            expect(scan(`
                // Relationship model: the sidecar runs Python (LinearGAM) - a comment is not UI
                /** Relationship */
                import type { RelationshipPreviewResult } from '../types/commands';
                type K = 'individual' | 'relationship' | 'clustering';
                interface RelationshipStats { kind: 'relationship' }
                const RelationshipRows = () => null;
                const isRel = (k: K) => k === 'relationship';
                const cmd = 'preview_relationship_model';
                const cls = 'kind-badge kind-badge--relationship';
                const id = <div data-testid="model-fit-relationship" className={\`fg-sheet-cell--\${k} set-relationship\`} />;
                const code = 'SIDECAR_OUTDATED';
                const ok = 'The Relation model engine could not fit this model.';
                const word = 'gamma'; const game = 'A game'; const gamut = 'gamut';
            `)).toEqual([]);
        });
    });
});
