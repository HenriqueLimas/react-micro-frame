#!/bin/bash
set -euo pipefail

rm -rf coverage
npm run test:coverage -- --coverage.reporter=text-summary --coverage.reporter=json-summary >&2
node <<'NODE'
const fs = require("node:fs");
const summary = JSON.parse(fs.readFileSync("coverage/coverage-summary.json", "utf8")).total;
for (const [coverageKey, metricName] of [
  ["branches", "branch_coverage"],
  ["statements", "statement_coverage"],
  ["functions", "function_coverage"],
  ["lines", "line_coverage"],
]) {
  console.log(`METRIC ${metricName}=${summary[coverageKey].pct}`);
}
NODE
