# Feature: [Feature Name]

> This is an example plan template for ralph-helper. Plans are created in Claude Code
> before running ralph-helper. Delete this comment block when using.
>
> Two formats work:
> - **Well-structured**: Use `## Phase` headings with `### Tests` and `### Done When`
> - **Flat**: Just describe what you want. ralph-helper will suggest phases.

## Phase 1: [Foundation Layer]
Describe what to build in this phase. Focus on the lowest-level components
that other phases will depend on — data models, core utilities, configuration.

### Tests
- [Testable assertion about what Phase 1 produces]
- [Another testable assertion]
- [Edge case to verify]

### Done When
[Concrete completion criteria — what must be true for this phase to be done.]

## Phase 2: [Core Logic]
Build on Phase 1. This is typically the business logic, API endpoints,
or processing layer that connects the foundation to the user-facing parts.

### Tests
- [Testable assertion]
- [Integration test between Phase 1 and Phase 2 components]
- [Error handling case]

### Done When
[Concrete completion criteria.]

## Phase 3: [User-Facing Layer]
The frontend, CLI, or interface that users interact with. Depends on
Phases 1 and 2 being solid.

### Tests
- [Testable assertion about the UI/interface]
- [User flow test]
- Browser: [E2E test if applicable — ralph-helper uses browser MCP for these]

### Done When
[Concrete completion criteria. If there's a browser test, mention it here.]
