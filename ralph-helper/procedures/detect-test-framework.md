# Procedure: Detect Test Framework

This is a shared procedure called by ralph-helper commands. It detects the project's test framework and testing patterns.

---

## Procedure Steps

Read the codebase to identify the test runner and testing conventions:

### Python
- Look for `pytest.ini`, `pyproject.toml` (pytest section), `setup.cfg` (tool:pytest section)
- Check for `unittest` patterns if no pytest config found
- Note: `python -m pytest` or `pytest` as the run command

### JavaScript / TypeScript
- Look for `jest.config.*` (js, ts, mjs, cjs) -> run with `npx jest` or `npm test`
- Look for `vitest.config.*` -> run with `npx vitest run`
- Check `package.json` for `test` script and test dependencies
- Check for `.mocharc.*` for Mocha

### Go
- `go.mod` present means `go test ./...`
- Check for test files matching `*_test.go`

### Other Languages
- Rust: `Cargo.toml` -> `cargo test`
- Ruby: `Gemfile` with rspec -> `bundle exec rspec`
- Java/Kotlin: `pom.xml` or `build.gradle` -> `mvn test` or `gradle test`

### Also Detect
- Project language(s) and structure
- Existing test patterns and naming conventions
- Test directory locations (e.g., `tests/`, `__tests__/`, `spec/`)
- Whether tests exist at all (if no tests found, note this)

Return the detected framework, run command, and patterns to the calling command.
