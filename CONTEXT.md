# PROJECT CONTEXT — Goal-Driven Adaptive Agent Optimization Layer

**Version:** 0.5  
**Date:** October 26, 2026  
**Status:** Architecture Revision — Ready for Engineering  
**Project Type:** Agentic AI Infrastructure / Optimization Layer / Research System  
**Document Role:** Project-wide source of context for engineers and AI coding agents.

---

# 1. Project Vision

We are developing a **Goal-Driven Adaptive Agent Optimization Layer** that helps existing AI agents achieve user-defined goals with the lowest practical total resource cost while preserving correctness, user intent, and required quality.

Our system is not another autonomous coding agent or an alternative to Claude Code, Codex, or OpenHands.

It is an optimization and coordination layer that operates around existing working agents.

The system must understand the intended outcome, determine which information is necessary, evaluate available execution decisions, detect inefficient or unsuccessful strategies, coordinate replanning, and verify whether the goal has actually been achieved.

## Central Research Question

**Can an external, cooperative optimization layer improve the verified goal-completion rate and resource efficiency of existing AI agents by intelligently managing goals, context, decisions, execution strategies, and verification?**

## Core Principle

> Optimize the entire path to a verified goal, not merely the cost of individual LLM calls.

A system that reduces token consumption but causes additional retries, missing requirements, or incorrect results is not necessarily an improvement.

The optimizer's own overhead must be included in performance measurements.

---

# 2. Primary Research Objective

We aim to minimize the resources required to reach an acceptable, verified outcome.

Relevant resources include:

- LLM input/output tokens
- End-to-end execution time
- Tool execution cost
- Repeated operations
- Failed approaches
- Rework
- Context retrieval overhead
- Unnecessary model reasoning
- Human waiting and intervention
- Optimizer computation and coordination overhead

## Optimization Formulation

Conceptually:

Minimize:

**Total Cost = Agent Execution + Optimizer Overhead + Verification + Rework + Human Coordination**

Subject to:

1. The user-authorized goal is preserved.
2. Mandatory requirements are satisfied.
3. Required verification evidence exists.
4. Safety and authorization constraints are respected.
5. Optimization does not reduce required quality.

Token usage, time, monetary cost, and human effort are distinct measurements. Their trade-offs may depend on user preferences.

We should study both weighted objectives and Pareto trade-offs rather than assuming one universal cost function.

**Verified goal satisfaction is the primary outcome; resource efficiency is the optimization target subject to that outcome.**

The system must not claim to guarantee 100% correctness for arbitrary tasks.

---

# 3. System Philosophy

## 3.1 Goal Is Not Strategy

The user's goal defines what must be achieved.

The strategy defines how the working agent attempts to achieve it.

Strategies may change without modifying the original goal.

No agent or optimizer component may silently remove, weaken, or reinterpret an explicit mandatory requirement.

## 3.2 Intelligence Is Not Always LLM Inference

Different decisions require different mechanisms.

Use:

- Deterministic algorithms for predictable operations
- Local search/indexing for structured evidence retrieval
- Existing tools for routine technical tasks
- LLM reasoning for semantic or complex uncertainty
- Optional specialized ML when demonstrated to outperform simpler methods
- Human judgment for consequential user-owned decisions

We do not intend to create multiple continuously communicating LLM agents.

## 3.3 Cooperative Optimization

The optimizer and working agent are separate cooperating roles.

The working agent owns implementation reasoning and executes work.

The optimizer manages the goal contract, decision policies, relevant evidence, runtime observations, strategy evaluation, and intervention coordination.

Both may challenge each other using evidence.

## 3.4 Evidence-Driven Decisions

The optimizer should prefer observable evidence over unsupported predictions.

Unknown information must be represented as unknown.

A failed search is not proof of absence.

An agent's completion claim is not proof of successful goal completion.

## 3.5 Human Authority

The human owns the goal, acceptable trade-offs, subjective preferences, and authorization.

The system should ask the human when an unresolved decision has significant downstream consequences and cannot be resolved from authorized evidence.

Low-impact, reversible decisions should not require unnecessary clarification.

---

# 4. System Architecture

```text
                    HUMAN / USER
                         |
                         v
                 USER GOAL REQUEST
                         |
                         v
             +------------------------+
             |   GOAL INTELLIGENCE    |
             |------------------------|
             | Intent interpretation  |
             | Requirement extraction |
             | Acceptance criteria    |
             | Ambiguity analysis     |
             +------------------------+
                         |
                         v
              GOAL CONTRACT PROPOSAL
                         |
                         v
             +------------------------+
             | GOAL CONTRACT REVIEW   |
             |------------------------|
             | Working agent reviews  |
             | Accept / Challenge     |
             | Clarify with human     |
             +------------------------+
                         |
                         v
                  GOAL CONTRACT
                         |
                         v
             +------------------------+
             |     DECISION ENGINE    |
             |------------------------|
             | Policy evaluation      |
             | Capability routing     |
             | Cost-aware decisions   |
             | Intervention decisions |
             +------------------------+
                         |
             +-----------+-----------+
             |                       |
             v                       v
     CONTEXT INTELLIGENCE      WORKING AGENT
     --------------------      -------------
     Repository evidence       Claude Code
     Documentation             Codex
     Historical decisions      OpenHands
     Relationship graph        Future adapters
     Context sufficiency            |
             |                       |
             +-----------+-----------+
                         |
                         v
                 EXECUTION TOOLS
                         |
                         v
             +------------------------+
             | RUNTIME STATE OBSERVER |
             |------------------------|
             | Events and outcomes    |
             | Time and token usage   |
             | Progress ledger        |
             | Failure signals        |
             +------------------------+
                         |
              +----------+----------+
              |                     |
              v                     v
     ADAPTIVE STRATEGY         GOAL VERIFIER
         EVALUATOR             -------------
     -----------------         Test evidence
     Strategy health           Behavioral checks
     Failure patterns          Semantic evaluation
     Expected progress         Human acceptance
              |                     |
              +----------+----------+
                         |
                         v
                  DECISION ENGINE
                         |
              Continue / Repair /
            Investigate / Reconsider /
               Escalate / Complete

Shared infrastructure:
- Persistent Event Store
- Goal & Strategy Versioning
- Context Relationship Graph
- Evidence and Verification Store
- Adapter Capability Registry
```

The architecture is logically modular and event-driven.

Components are not required to be independent services or independent LLM instances.

---

# 5. Core Component A — Goal Intelligence

## Purpose

Translate user intent into an explicit, evidence-backed, verifiable representation of the intended outcome.

Goal Intelligence is responsible for understanding **what must be true for the task to be considered successful**.

It is not responsible for directly implementing the task.

## Responsibilities

1. Interpret natural-language user requests.
2. Extract explicit requirements.
3. Identify implicit assumptions without treating them as confirmed user instructions.
4. Identify constraints and dependencies.
5. Propose acceptance criteria.
6. Identify missing or contradictory information.
7. Retrieve relevant evidence through Context Intelligence.
8. Maintain a versioned Goal Contract.
9. Reevaluate affected portions when new evidence or user instructions arrive.

## Intelligence Strategy

Primary approach:

**LLM-assisted interpretation + deterministic contract validation.**

An existing LLM may interpret natural language and propose a structured contract.

Deterministic validation checks schema consistency, required fields, source references, conflicting states, and authorized changes.

We do not plan to train a separate Goal Intelligence model initially.

We should evaluate whether reusing the working agent's initial interpretation is more efficient than making an additional LLM call.

## Goal Contract

Each Goal Contract should contain:

- Goal identifier and version
- User intent summary
- Explicit requirements
- Constraints
- Acceptance criteria
- Source evidence
- Known assumptions
- Unresolved questions
- Requirement dependencies
- Authorization information
- Review status

Requirements must have authority classifications.

Suggested categories:

- Explicit user requirement
- Confirmed historical user decision
- Evidence-backed technical constraint
- Proposed inference
- Unresolved assumption

The latter two must not silently become authoritative user requirements.

## Goal Contract Negotiation

**Confirmed architecture decision: The Goal Contract must support review and challenge by the working agent.**

Protocol:

1. Goal Intelligence proposes a contract.
2. Working agent performs a focused technical review.
3. Working agent accepts, challenges, or requests clarification.
4. Evidence-backed technical challenges are investigated.
5. Consequential user-dependent questions are returned to the human.
6. The contract is marked ready when sufficient for the authorized work.

A challenge must identify the requirement, reason, and supporting evidence.

The working agent may propose technical revisions but cannot independently change user intent.

## Efficiency Requirements

Avoid unlimited negotiation loops.

Review should be focused on meaningful technical inconsistencies, critical missing context, and high-impact assumptions.

Do not require multiple agents to debate every ordinary requirement.

---

# 6. Core Component B — Context Intelligence

## Purpose

Retrieve and connect the evidence necessary to understand and accomplish the current goal.

Context Intelligence must not simply load the entire repository or conversation history into the LLM.

It must support progressive, goal-aware retrieval.

## Evidence Sources

- Source code
- Repository dependencies
- Architecture documentation
- Project specifications
- Historical decisions
- Previous authorized harness conversations
- Execution history
- Test results
- Runtime outcomes
- User-provided materials

Access to previous conversations depends on data availability, user authorization, and the host integration. It must not assume unrestricted access to conversation history.

## Context Relationship Graph

Store relationships between:

- Goals
- Requirements
- Code symbols
- Files
- Documents
- Decisions
- Tests
- Execution events
- Verification results

Suggested relationships:

- DEPENDS_ON
- IMPLEMENTS
- DOCUMENTED_BY
- DECIDED_IN
- VERIFIED_BY
- CONTRADICTS
- SUPERSEDES

Each evidence record retains provenance, project scope, and relevant timestamps.

## Context Sufficiency

The system must evaluate whether the available evidence is sufficient for the next consequential action.

Possible outcomes:

- Sufficient — proceed
- Technical evidence missing — retrieve
- Impact uncertain — investigate within a bounded budget
- Critical user-dependent decision — request clarification
- Low-impact reversible uncertainty — proceed with a documented assumption
- Conflicting evidence — investigate or escalate

**Context sufficiency is not measured by the percentage of repository files retrieved.**

One missing requirement can invalidate an entire implementation.

Impact, dependencies, reversibility, and cost of being wrong matter more than raw context volume.

---

# 7. Core Component C — Decision Engine

## Purpose

Determine the most appropriate next system-level action using the current goal, evidence, runtime state, available capabilities, and resource constraints.

The Decision Engine is the **control-policy layer**, not a second coding agent.

## Responsibilities

- Evaluate whether execution can proceed
- Route information requests
- Trigger context retrieval
- Decide when LLM reasoning is necessary
- Request human clarification
- Schedule verification
- Monitor strategy concerns
- Request reconsideration
- Enforce hard constraints
- Determine when verified completion can be reported

## Decision Mechanism

Primary approach:

**Deterministic policy engine with optional LLM-assisted investigation.**

Initial policies should be explicit, testable, and inspectable.

Model-based recommendations may inform decisions, but should not automatically override authorization constraints or verified evidence.

## Typed Actions

Proposed action vocabulary:

```text
PROCEED
RETRIEVE_CONTEXT
INVESTIGATE
ASK_LLM
ASK_HUMAN
RUN_VERIFICATION
EXECUTE_RECOVERY
REQUEST_RECONSIDERATION
BLOCK_ACTION
COMPLETE
```

Every nontrivial decision should contain:

- Action
- Trigger
- Relevant evidence
- Reason
- Budget or limits, when appropriate
- Required execution capability
- Expected result or reevaluation condition

## Cost-Aware Routing

The Decision Engine should consider:

- Expected usefulness
- Tool capability
- Reliability
- Execution time
- LLM token cost
- Failure risk
- Reversibility
- Consequence of incorrect decisions

Local tools should be preferred when sufficient and efficient, but not used reflexively if they are unlikely to solve the problem.

The engine should avoid additional reasoning when existing evidence already supports a reliable decision.

## Responsibility Boundary

The Decision Engine decides **what type of system action should occur next**.

The working agent decides how to implement the software change within the authorized goal and policy boundaries.

---

# 8. Core Component D — Adaptive Strategy Evaluation and Replanning

## Purpose

Identify when the working agent's current strategy may be ineffective, unnecessarily expensive, or inconsistent with available evidence.

The optimizer should not automatically replace the working agent's strategy whenever it predicts a better alternative.

Instead, it coordinates evidence-based reconsideration.

## Observed Signals

Potential signals include:

- Repeated failed attempts
- Identical unresolved errors
- No verified progress
- Unexpected cost growth
- Excessive context retrieval
- Repeated investigation without new information
- Changes that invalidate previous work
- Contradictory implementation evidence
- Newly discovered critical requirements
- Verification failures
- Exceeded resource budgets

No single simple threshold is universally sufficient.

Three repeated errors may justify an advisory, but should not automatically prove the strategy is wrong.

## Strategy Reconsideration Protocol

**Pause → Reconsider → Resolve**

1. Detect an evidence-backed concern.
2. Identify an available safe intervention point.
3. Provide the working agent with a concise evidence packet.
4. Request a strategy review.
5. Allow the agent to defend its existing approach or propose a revision.
6. Validate any proposed revision against the Goal Contract.
7. Continue execution under the resolved strategy.

The optimizer may enforce mandatory safety and authorization constraints.

For ordinary strategic disagreements, it should not force an unproven alternative.

## Strategy Revision

A strategy revision should specify:

- Current plan version
- Triggering evidence
- Why reconsideration is justified
- Proposed changes
- Work that remains valid
- Work invalidated by the change
- Additional context requirements
- Required verification
- Estimated switching cost, if available

Preserve completed and verified work whenever possible.

## Intelligence Strategy

Initial implementation:

**Evidence-driven rules + focused working-agent reasoning.**

The optimizer detects when reconsideration is justified.

The working agent supplies implementation-level reasoning and alternative plans.

Specialized ML-based prediction can be researched later using historical execution data, but it is not required initially.

---

# 9. Core Component E — Goal Verification

## Purpose

Determine whether the actual result satisfies the approved Goal Contract.

Goal Verification must be independent of the agent's self-reported progress.

It is responsible for evaluating outcomes rather than selecting implementation strategies.

## Hybrid Verification Architecture

### Level 1 — Deterministic Verification

Use existing technical verification methods whenever possible:

- Compiler checks
- Type checking
- Unit tests
- Schema validation
- Static analysis
- Defined invariants

### Level 2 — Behavioral Verification

Evaluate observable system behavior:

- Integration tests
- API contract tests
- End-to-end tests
- Browser workflow checks
- Regression tests
- Runtime behavior
- Artifact inspection

### Level 3 — Semantic Evaluation

Use an LLM or specialized ML where objective deterministic tests are insufficient.

Examples:

- Does the implementation match the intended design?
- Is generated documentation consistent with requirements?
- Is a user interface semantically appropriate?
- Does an implementation meaningfully satisfy an ambiguous requirement?

Model-generated evaluations must expose evidence and uncertainty.

An LLM judgment alone is not proof of correctness.

### Level 4 — Human Acceptance

Use human review for consequential, subjective, or otherwise unresolved acceptance decisions.

Human review should be requested only when needed, rather than after every routine operation.

## Verification Records

Each acceptance criterion should retain:

- Criterion identifier
- Verification method
- Status
- Supporting evidence
- Execution timestamp
- Tool or evaluator identity
- Relevant artifact version
- Confidence or limitations when applicable

Suggested statuses:

```text
NOT_EVALUATED
PASSED
FAILED
INCONCLUSIVE
NEEDS_HUMAN_REVIEW
```

A test result must be tied to the artifact version that was tested.

Previously passing evidence may become stale when relevant code changes.

## Independence

The working agent must not automatically certify its own work.

Tests written by the working agent can be useful evidence, but should not be treated as independent proof if they merely encode the agent's assumptions.

When practical, acceptance criteria and regression expectations should be established separately from the implementation.

## Intelligence Strategy

**Deterministic-first hybrid verification.**

Use LLM or specialized ML evaluation only for criteria that need semantic judgment.

Do not train a dedicated verification model before collecting sufficient reliable labeled data and demonstrating that specialized training is beneficial.

---

# 10. Runtime State and Evidence Infrastructure

The optimization layer requires a persistent, agent-independent runtime.

## Runtime Responsibilities

- Session management
- Event ingestion
- Event validation
- Persistent storage
- State reconstruction
- Usage and time telemetry
- Requirement progress records
- Strategy versioning
- Verification evidence
- Intervention history
- Adapter capability registration

## Event Model

Events must contain a validated envelope with:

- Event ID
- Project and session scope
- Producer identity
- Event type and typed payload
- Source timestamp
- Local receive timestamp
- Local ingestion sequence
- Correlation IDs where applicable

Persist actual observations without inventing missing information.

For example, unknown token usage must remain unknown.

An agent-completion event must not automatically become verified goal completion.

## Initial Runtime Architecture

Recommended:

- TypeScript / Node.js
- SQLite persistence
- Versioned events
- Transactional ingestion
- Command-line interface
- Public embeddable runtime API
- Provider-specific adapters
- Optional MCP interface

The runtime must be usable independently of an active agent host.

A daemon is not required initially, but the architecture should permit one if live control or performance measurements justify it.

## Runtime API Principle

The CLI, adapters, and MCP integration use the same public runtime application API.

Only the runtime owns persistent state transitions and storage consistency.

Adapters must not reimplement business policy.

---

# 11. Agent Integration Architecture

## Integration Strategy

**Standalone local runtime + thin agent adapters/plugins + optional MCP tools.**

Initial target: Claude Code.

Future targets: Codex, OpenHands, and other working-agent systems.

Adapters translate host-specific events and capabilities into normalized runtime interfaces.

## Capability Contract

Each adapter must explicitly advertise supported operations, such as:

- Lifecycle observation
- Tool-event observation
- Usage reporting
- Advisory feedback
- Context delivery
- Execution interruption
- Tool blocking
- Checkpoint recovery
- Resumable execution

Do not advertise capabilities that have not been implemented and verified.

Interrupting an agent is not necessarily the same as pausing and resuming it.

## Failure Behavior

For optional observational functionality, the working agent should generally continue if the optimizer becomes unavailable.

For mandatory authorization or safety controls, the host must not silently bypass enforcement.

Adapters must avoid unnecessary execution overhead and uncontrolled output injection.

---

# 12. RTK and Headroom Integration

We have identified RTK and Headroom as potential reusable optimization components.

They are **optional candidate dependencies**, not required foundations.

## RTK

Candidate responsibility:

- Command-output filtering
- Tool-output reduction
- Removal of redundant low-value output

## Headroom

Candidate responsibility:

- Context compression
- Selective context delivery
- Recoverable information reduction
- Memory-related capabilities where suitable

## Integration Principles

1. Use existing capabilities instead of unnecessarily rebuilding them.
2. Keep integrations optional and replaceable.
3. Avoid duplicate compression pipelines.
4. Preserve authoritative requirements and original evidence.
5. Allow recovery of compressed information when required.
6. Evaluate whether their combined benefits exceed overhead.
7. Never assume lower input tokens imply better end-to-end results.

The optimizer should retain control over whether and when context optimization is appropriate.

RTK and Headroom do not replace Goal Intelligence, Context Intelligence, or Goal Verification.

Their compatibility, current APIs, and performance must be verified before making them mandatory development dependencies.

---

# 13. Project Execution Lifecycle

```text
1. RECEIVE USER GOAL
          |
          v
2. INTERPRET USER INTENT
          |
          v
3. PROPOSE GOAL CONTRACT
          |
          v
4. RETRIEVE RELEVANT CONTEXT
          |
          v
5. WORKING AGENT REVIEWS CONTRACT
          |
          v
6. RESOLVE MATERIAL CHALLENGES
          |
          v
7. EVALUATE CONTEXT SUFFICIENCY
          |
          v
8. SELECT EXECUTION ACTION
          |
          v
9. WORKING AGENT EXECUTES
          |
          v
10. OBSERVE ACTUAL PROGRESS
          |
          v
11. VERIFY CURRENT OUTCOMES
          |
          v
12. EVALUATE STRATEGY HEALTH
          |
          +-- Effective --> Continue
          |
          +-- Missing context --> Retrieve
          |
          +-- Recoverable failure --> Repair
          |
          +-- Strategy concern --> Reconsider
          |
          +-- Human decision --> Clarify
          |
          +-- All criteria verified --> Complete
```

The process is iterative, not strictly sequential.

The decision engine may trigger context retrieval, verification, or reconsideration at several points in execution.

---

# 14. Initial Functional Prototype — V0.1

Our first implementation must demonstrate a complete, narrow optimization cycle.

**The first milestone must not stop at event collection or generic agent monitoring.**

## Required Functional Capabilities

### Goal Intelligence

- Extract requirements from a real user request.
- Produce a structured Goal Contract.
- Support working-agent challenge and review.
- Preserve explicit user requirements.

### Context Intelligence

- Retrieve relevant repository files and project documents.
- Include historical decisions when available and authorized.
- Connect retrieved evidence to requirements.
- Identify consequential information gaps.

### Decision Engine

- Execute deterministic policies.
- Select retrieval, clarification, execution, verification, or reconsideration actions.
- Track decision evidence.
- Respect permissions and capability limits.

### Adaptive Replanning

- Detect at least one defined ineffective execution pattern.
- Trigger focused reconsideration.
- Preserve valid work.
- Resume or continue through supported agent mechanisms.

### Goal Verification

- Evaluate defined acceptance criteria.
- Execute real deterministic or behavioral checks.
- Distinguish verified completion from completion claims.
- Report failed or inconclusive criteria.

### Runtime and Integration

- Persist execution events.
- Reconstruct state after restart.
- Support one real working-agent integration.
- Record reliable token/time data when available.
- Measure optimizer overhead.

## Prototype Scope

Prefer one supported project category and one agent adapter initially.

For example:

- Working agent: Claude Code
- Project type: TypeScript application
- Context sources: repository, Markdown docs, explicitly available conversation records
- Verification: tests, typecheck, and selected behavioral checks

Scope limitations must be explicit.

The implementation must contain real working functionality rather than placeholders that only simulate success.

---

# 15. Engineering Milestones

## M1 — Runtime and Integration Foundation

Build:

- Shared domain types
- CLI and embeddable runtime API
- Persistent event store
- Session state reconstruction
- Agent adapter
- Telemetry and basic tests

## M2 — Goal and Context Intelligence

Build:

- Goal Contract schema
- LLM-assisted goal interpretation
- Working-agent review protocol
- Basic relationship graph
- Goal-aware context retrieval
- Context sufficiency checks

## M3 — Decision and Strategy Control

Build:

- Typed decision policies
- Capability routing
- Strategy health signals
- Evidence packets
- Reconsideration protocol
- Intervention boundaries

## M4 — Verification and End-to-End Integration

Build:

- Acceptance-criteria verification
- Test and evidence linkage
- End-to-end goal lifecycle
- Targeted repair loop
- Complete vertical-slice demonstration

## M5 — Optimization Evaluation

Compare:

- Unmodified working agent
- Agent with Goal Intelligence
- Agent with Context Intelligence
- Agent with runtime strategy evaluation
- Full optimizer
- Optional RTK/Headroom variants

The milestones describe implementation order, not permission to postpone the entire intelligent system indefinitely.

The first experimental release should contain M1–M4 operating together on a bounded real workflow.

---

# 16. Research and Evaluation

We must demonstrate improvement through controlled experiments.

## Primary Metrics

1. Verified requirement satisfaction
2. Total token consumption per attempt and successful outcome
3. Wall-clock time to verified completion
4. Total optimizer overhead
5. Rework
6. Critical-context recall
7. Unnecessary clarification rate
8. False intervention rate
9. Strategy recovery effectiveness
10. Human coordination cost

## Required Baselines

Compare identical tasks under equivalent conditions.

Important baselines include:

- Working agent alone
- Working agent with token/context optimization
- Working agent with goal/context support
- Working agent with runtime strategy evaluation
- Full cooperative optimizer

Include failed runs, repeated trials, and verification costs.

## Research Hypotheses

**H1:** Explicit, reviewed Goal Contracts reduce incorrect implementation assumptions.

**H2:** Goal-aware context retrieval reduces unnecessary context usage and missed critical requirements.

**H3:** Impact-aware clarification reduces downstream rework without causing excessive human interruption.

**H4:** Evidence-driven strategy reconsideration improves recovery from ineffective agent behavior.

**H5:** Independent goal verification improves the reliability of reported completion.

**H6:** A cooperative decision policy provides better total goal-completion efficiency than an unmodified working agent.

**H7:** Optional RTK/Headroom integration improves resource efficiency for suitable workloads, but may be counterproductive in others.

**H8:** Learned decision policies may outperform deterministic baselines when trained on adequate, representative execution data.

These are hypotheses, not established results.

---

# 17. Technical Direction

Suggested initial stack:

| Area                   | Recommendation                                      |
| ---------------------- | --------------------------------------------------- |
| Runtime language       | TypeScript                                          |
| Runtime environment    | Node.js, version pinned after compatibility checks  |
| Persistent state       | SQLite                                              |
| Structured text search | SQLite FTS5                                         |
| Code relationships     | Tree-sitter, language tooling                       |
| Context graph          | SQLite nodes/edges initially                        |
| Semantic retrieval     | Optional embeddings                                 |
| Goal interpretation    | Existing LLM through replaceable provider interface |
| Decision Engine        | Deterministic policies with optional LLM escalation |
| Adaptive Replanning    | Runtime evidence + working-agent reasoning          |
| Goal Verification      | Hybrid deterministic/behavioral/semantic            |
| Agent integration      | Host-specific adapters                              |
| MCP                    | Optional official SDK integration                   |
| Dashboard              | Optional later                                      |
| Specialized ML         | Research candidate, not initial dependency          |

Avoid introducing heavyweight infrastructure without measured justification.

---

# 18. Security, Trust, and Authority

The system must distinguish user instructions from potentially untrusted retrieved content.

Requirements include:

- Authorized project-scoped access
- Provenance-aware retrieval
- Protection against prompt injection
- Explicit approval for consequential actions
- No silent goal-contract changes
- No unauthorized use of historical conversations
- Bounded resource and intervention policies
- No false claims of test or verification success
- Clear handling of unavailable optimizer components
- Auditability of consequential decisions

Do not persist raw prompts, full conversations, secrets, or tool outputs by default without a defined need and appropriate authorization.

---

# 19. Architectural Decisions

## Confirmed

- Build an external optimization layer, not another general-purpose agent.
- Optimize verified user outcomes, not just token count.
- Preserve user goals while allowing strategy changes.
- Use an independent local runtime.
- Support adapters for multiple working agents.
- Use cooperative, transparent optimization.
- Use a proposed Goal Contract reviewed by the working agent.
- Allow evidence-backed challenges.
- Keep consequential decisions under human authority.
- Use deterministic policies where sufficient.
- Use LLM reasoning selectively.
- Use hybrid goal verification.
- Treat completion claims and verified completion separately.
- Use evidence-driven strategy reconsideration.
- Follow Pause → Reconsider → Resolve.
- Preserve provenance for code, documents, and historical decisions.
- Evaluate optimizer overhead as part of total cost.
- Build a functional end-to-end vertical slice.
- Consider RTK and Headroom as optional reusable integrations.

## Proposed / To Be Validated

- Exact Goal Contract and strategy schemas
- Node.js and SQLite version choices
- Provider abstraction details
- Decision-policy thresholds
- Sufficiency and impact scoring
- Precise strategy health model
- Exact verification routing rules
- RTK/Headroom interoperability
- Future specialized ML training
- Multi-agent integration behavior
- Quantitative benefits relative to baselines

---

# 20. Engineering Instructions for the Working Agent

When implementing this project:

1. Preserve this document's confirmed requirements and authority boundaries.
2. Do not treat architecture proposals as already validated implementations.
3. Do not substitute generic monitoring for the full optimization objective.
4. Build the smallest functional components that demonstrate the complete goal-to-verification loop.
5. Reuse existing tools when they can satisfy requirements reliably.
6. Prefer deterministic processing before additional LLM calls when appropriate.
7. Preserve explicit evidence and failure records.
8. Do not claim verification without executing the required checks.
9. Make reversible, low-risk engineering decisions independently.
10. Escalate consequential unresolved decisions rather than silently changing user intent.
11. Measure actual total cost, including the optimization layer itself.
12. Report implemented functionality, passing tests, incomplete checks, and known limitations.

The worker should challenge technical contradictions using supporting evidence rather than blindly following an unworkable plan.

Avoid unnecessary open-ended design discussions once the decisions required for the next implementation step are sufficiently defined.

---

# 21. Definition of Success

The system is successful when it can demonstrably:

1. Understand the user's intended goal.
2. Produce and review a reliable Goal Contract.
3. Retrieve sufficient and relevant context.
4. Identify important missing information.
5. Choose appropriate execution actions.
6. Observe the working agent's actual progress.
7. Detect evidence of ineffective execution.
8. Coordinate strategy reconsideration when justified.
9. Independently verify goal requirements.
10. Complete comparable tasks with improved verified outcome efficiency.

The improvement must be established empirically, not assumed from architectural complexity.

## Final Vision

**Build an adaptive, goal-aware intelligence layer that enables existing AI agents to make better decisions, avoid unnecessary work, recover from ineffective strategies, and achieve verified user outcomes with the lowest practical total resource cost.**

The system should become more capable without becoming unnecessarily expensive, more autonomous without disregarding user authority, and more efficient without compromising the goal.

**Optimize the path to success—not merely the number of tokens along the way.**
