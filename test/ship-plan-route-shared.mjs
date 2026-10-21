// What more than one of the plan-route suites stages a spec with: a change that
// stops at finish for a person on the plan route as well as on the base.
//
// It lives outside any `*.test.mjs` for the reason `stage.mjs` gives:
// importing a suite to borrow a helper runs that suite's tests a second time.

// A change that waits for a person on a plan route too: touching a CI workflow
// is an approval wherever the spec lands, so `finish` stops with the pull
// request open, and the person's own merge is what these tests go on to make.
export const WAITS = { ".github/workflows/ci.yml": "on: push\n" };
