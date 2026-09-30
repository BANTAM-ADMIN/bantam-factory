import test from 'node:test';
import assert from 'node:assert/strict';
import { permitsWholeAssertionCoverage as permits } from '../src/assertion-execution-scope.js';

test('admits plainly executing single scripts and complete inline code', () => {
  for (const command of [
    'node in/ui/src/state.test.js', 'node ./check.cjs', '/usr/bin/node check.mjs',
    'node -- check.js', 'node --no-warnings check.js', 'node --trace-warnings check.js',
    "node -e 'const assert=require(\"assert\"); assert.equal(1,1);'",
    "node --eval 'const x = 1;'", "node --input-type=module -e 'import assert from \"node:assert\";'",
    "node --input-type module --eval 'const x = 1;'", "node --input-type=commonjs -e 'require(\"assert\");'",
    'node --test check.test.js', 'node --test --test-timeout=5000 check.test.js',
    'node --test-timeout=5000 --test check.test.js',
    'python check.py', 'python3.11 -B -u check.py', 'python3 -E -I -s -S check.py',
    "python3 -c 'assert 1 == 1'", 'ruby check.rb', "ruby -w -e 'raise unless 1 == 1'",
    "node -e 'const $value = 1;'", 'node "path with spaces/check.js"',
    'node check.js 2>&1',
  ]) assert.equal(permits(command), true, command);
});

test('syntax, listing, optimization, and compile-only commands cannot credit source assertions', () => {
  for (const command of [
    'node --check check.js', 'node -c check.js', 'node --version check.js', 'node --help check.js',
    'node --print check.js', 'node -p check.js', 'node --v8-options check.js',
    'python -m py_compile check.py', 'python -m compileall check.py', 'python --version check.py',
    'python -O check.py', "python -OO -c 'assert False'", 'python -h check.py',
    'ruby -c check.rb', 'ruby --version check.rb', 'ruby --help check.rb',
  ]) assert.equal(permits(command), false, command);
});

test('filtered or multi-target execution does not claim whole-file coverage', () => {
  for (const command of [
    'node --test --test-name-pattern=unit check.test.js',
    'node --test --test-name-pattern unit check.test.js',
    'node --test --test-skip-pattern=slow check.test.js',
    'node --test --test-only check.test.js', 'node --test --test-shard=1/2 check.test.js',
    'node --test check.test.js --test-name-pattern=unit',
    'node --test check-a.test.js check-b.test.js', 'node --test', 'node --test checks/*.js',
    'node check.js --only unit', 'node check.js extra.js',
    'python -m pytest check.py', 'python -m pytest --collect-only check.py',
    'python -m unittest check.py', 'pytest check.py::test_one', 'python check.py -k unit',
    "node -e 'const x=1;' selected", "ruby -e 'true' -e 'false'", 'ruby check.rb --name unit',
  ]) assert.equal(permits(command), false, command);
});

test('wrappers, expansions, unknown options, and incomplete invocations fail closed', () => {
  for (const command of [
    'node check.js && node other.js', 'node check.js | tail', 'node check.js; true',
    'env node check.js', 'NODE_OPTIONS=--require=shim.js node check.js', 'sh -c "node check.js"',
    'node --require shim.js check.js', 'node --loader hook.mjs check.js', 'node --unknown check.js',
    'node "$CHECK.js"', 'node check*.js', 'node check?.js', 'node check[12].js',
    'node -e "$CHECK"', 'node -e "$(echo check)"',
    'node', 'node -e', 'node -e ""', 'node --input-type=invalid -e "true"',
    'node --input-type=module check.js', 'node --test-timeout=5000 check.js',
    'node --test --test-timeout=0 check.js', 'node --test --test-timeout=unknown check.js',
    'node --test -e "true"', 'node --test-timeout=5000 -e "true"',
    'node -- -e "true"', 'node -', 'node check.txt', null,
  ]) assert.equal(permits(command), false, String(command));
});
