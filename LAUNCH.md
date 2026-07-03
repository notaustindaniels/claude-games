# LAUNCH.md — how to fire this (for the human)

## 0. What this is
A clean-slate scaffold: curated reference stills, the Wallace caustics study,
Greenheck's webgpu-threejs-tsl skill vendored at .claude/skills/, pinned
package.json, a deliberately-inadequate placeholder scene in src/, and the two
governing docs (REBUILD.md, VERIFY.md). The agent builds verify.mjs first,
then replaces src/ per REBUILD.md.

## 1. Put it on a clean branch of your existing repo
    cd /path/to/claude-games
    git checkout --orphan v2
    git rm -rf . 2>/dev/null
    tar xzf /path/to/openocean-v2.tar.gz --strip-components=1
    git add -A
    git commit -m "OpenOcean v2: clean scaffold + VERIFY contract"
    git push -u origin v2
(The orphan branch starts empty; main and all history are untouched.)

## 2. Sanity check (optional, 60s)
    npm install && npm run dev     # placeholder renders: magenta + flat disc
    ls .claude/skills/webgpu-threejs-tsl/SKILL.md

## 3. Launch (Claude Code in the repo root, auto-accept on)
Paste exactly this, as one message:

/goal verify.mjs implements the full VERIFY.md contract (camera matrix M1–M10 across all three presets, 24-frame sweep sheet, numeric gates G1–G6 with committed gate table) and was proven end-to-end against the placeholder scene before any water code; the latest reply prints the current gate table with ALL of G1–G6 PASS for all three presets, plus an R-item status table (R1–R8 from REBUILD.md, item / status / evidence file) with all items PASS or BLOCKED-with-diagnosis per the 8-attempt rule; progress.html contains a sweep-review entry (anomalies found or "none") for every pass. No item or gate may be marked PASS if its cited evidence visibly fails the stated criterion.

## 4. Walk away
First turns will be reading + harness work against the placeholder (all gates
FAIL — that is correct). Do not nudge. Bring back progress.html and shots/.
