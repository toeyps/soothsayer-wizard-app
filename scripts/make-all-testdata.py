# Makes every test-data folder the manual test plan (docs/testing/MANUAL_TEST_PLAN.md) needs, in one go.
# Which plan item uses which file: docs/testing/TEST_DATA_GUIDE.md.
#
# Usage (standard library only, run from the project folder):
#   python scripts/make-all-testdata.py                      # -> C:\WizardTestData (a few seconds, ~45 MB)
#   python scripts/make-all-testdata.py D:\SomeFolder        # another root folder
#   python scripts/make-all-testdata.py --big                # + the big files in IMP\big and IMP\wfg
#                                                            #   (about 8.5 GB of free disk, roughly 3-10 minutes)
#
# Layout (each generator can still be run on its own with a folder argument; the output is the same):
#   <root>\EXP  scripts/make-export-testdata.py   Export results data (BMW-355.., WFJ, WFK)
#   <root>\WF   scripts/make-wf-testdata.py       pump P-101, 6 months (WFA-WFD, WFH)
#   <root>\TS   scripts/make-ts-testdata.py       date/time shapes: formats\, merge\, scenario\ (IMP-89..99, WFI)
#   <root>\IMP  scripts/make-prep-testdata.py     the PREP-6 kit + PREP-5 / MULTI / WFE / WFF files (+ --big: big\, wfg\)
#               (runs last, with --expdata <root>\EXP, so it can also write IMP\exp-variants\)
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
root = args[0] if args else r'C:\WizardTestData'
big = '--big' in sys.argv[1:]

steps = [
    ('EXP', 'make-export-testdata.py', []),
    ('WF', 'make-wf-testdata.py', []),
    ('TS', 'make-ts-testdata.py', []),
    ('IMP', 'make-prep-testdata.py', ['--expdata', os.path.join(root, 'EXP')] + (['--big'] if big else [])),
]
for sub, script, extra in steps:
    out = os.path.join(root, sub)
    print(f'--- {sub}: {script} -> {out}', flush=True)
    r = subprocess.run([sys.executable, os.path.join(HERE, script), out] + extra)
    if r.returncode != 0:
        print(f'{script} failed (exit {r.returncode})', file=sys.stderr)
        sys.exit(r.returncode)

print(f'\nDone. Test data is in {root}:')
for sub, _, _ in steps:
    path = os.path.join(root, sub)
    n = sum(len(files) for _, _, files in os.walk(path))
    print(f'  {sub:4s} {n:3d} files')
print('Which plan item uses which file: docs/testing/TEST_DATA_GUIDE.md')
