#!/bin/sh
# Every measurement in README.md, on the node named by $NODE (default: node).
# From the repository's root:
#
#   NODE=/path/to/node-v26.12.1/bin/node sh experiments/wasm-shared/run.sh

set -e
NODE=${NODE:-node}
cd "$(dirname "$0")/../.."
X=experiments/wasm-shared
W=--experimental-wasm-shared

echo "# $($NODE --version), V8 $($NODE -p process.versions.v8)"
node src/compiler/cli.ts compile -p $X/ts/tsconfig.json --outDir $X/fast
node src/compiler/cli.ts compile -p $X/ts/tsconfig.json --outDir $X/proxy --no-fast
node src/compiler/cli.ts compile -p examples/nbody/tsconfig.json

echo "## sharing"
$NODE $W $X/share.js || true

echo "## inlining"
$NODE $W $X/inline.js unshared || true
$NODE $W $X/inline.js shared || true

echo "## micro"
$NODE $X/micro.js plain
$NODE --harmony-struct $X/micro.js js-shared
for k in wasm wasm-shared xwasm xwasm-shared; do $NODE $W $X/micro.js $k || true; done
$NODE $X/fast/micro.js fast
$NODE $X/proxy/micro.js proxy

echo "## nbody, 1M steps"
$NODE build/nbody/nbody.js | tail -1
for k in plain typed typed-shared x x-shared wasm wasm-shared; do
  $NODE $W $X/nbody.js $k | tail -1 || true
done

echo "## nbody-parallel"
$NODE $X/par-ours.js fast | tail -1
for m in wasm js; do $NODE $W $X/par-wasm.js $m | tail -1; done
