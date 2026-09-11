/** Minimal assertion reporter. No dependencies — `node test/run-all.js` and done. */

export function createReporter(suiteName, { mode = 'verbose' } = {}) {
  let pass = 0;
  const failures = [];
  const verbose = mode === 'verbose';

  return {
    suiteName,

    section(name) {
      if (verbose) console.log(`\n  ${name}`);
    },

    /**
     * @param {string} label     what is being asserted
     * @param {boolean} condition
     * @param {string} [detail]  actual value, shown only on failure
     */
    check(label, condition, detail = '') {
      if (condition) {
        pass++;
        if (verbose) console.log(`    ✓ ${label}`);
      } else {
        failures.push({ label, detail });
        if (verbose) console.log(`    ✗ ${label}${detail ? `  (got: ${detail})` : ''}`);
      }
    },

    summary() {
      return { suiteName, pass, fail: failures.length, failures };
    },
  };
}
