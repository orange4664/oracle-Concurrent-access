# Oracle Multi-Tab (Modified)

Fork of [oracle](https://github.com/orange4664/oracle) with multi-tab concurrent support.

## What Changed

Only 2 files modified from the original:

- `src/remote/server.ts` — `busy` boolean replaced with `activeRuns` counter + `maxConcurrent` limit
- `bin/oracle-cli.ts` — added `--max-concurrent <number>` flag to `oracle serve`

## Usage

```bash
# Install
cd oracle-multi-tab
pnpm install --ignore-scripts

# Run with 3 concurrent tabs
oracle serve --port 3080 --token your-token --max-concurrent 3
```

Each request opens an isolated Chrome tab. The profile lock serializes the submission phase (typing + send), but response waiting runs in parallel across all tabs.

## Install globally from this directory

```bash
cd oracle-multi-tab
npm install -g .
```
