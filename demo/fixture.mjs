// Builds a self-contained demo: a fake Claude Code config dir with the session
// being worked on, a few older sessions (also of a second project) for the
// Sessions view, and a small C# git repository with uncommitted changes.
import { execFileSync } from "node:child_process";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SESSION = "7f3c2a91-5d4e-4b8a-9c61-0e2f8d4a6b13";

const user = (uuid, time, text) => ({
  type: "user",
  uuid,
  timestamp: `2026-09-26T${time}:00.000Z`,
  message: { role: "user", content: text },
});
const assistant = (uuid, id, text) => ({
  type: "assistant",
  uuid,
  // A text answer ends the turn; without it the chat shows the turn as still running.
  message: { id, role: "assistant", content: [{ type: "text", text }], stop_reason: "end_turn" },
});
const tool = (uuid, id, command) => ({
  type: "assistant",
  uuid,
  message: { id, role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command } }] },
});

const exitPlan = (id, time, plan) => ({
  type: "assistant",
  uuid: `a-${id}`,
  timestamp: `2026-09-26T${time}:00.000Z`,
  message: { id: `m-${id}`, role: "assistant", content: [{ type: "tool_use", id, name: "ExitPlanMode", input: { plan } }] },
});
const planResult = (id, isError, text) => ({
  type: "user",
  uuid: `r-${id}`,
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: text }] },
});

const PLAN_V1 = `# Validate orders before saving

## Context

\`OrderService.Submit\` saves every order as it is. Orders without a customer or lines end up in the database.

## Steps

1. **Create** \`OrderValidator\` with one method per rule
2. **Inject** it into \`OrderService\` and reject invalid orders early

| Rule | Error code |
|------|------------|
| Customer is set | \`CustomerRequired\` |
| At least one line | \`EmptyOrder\` |`;

const PLAN_V2 = `# Validate orders before saving

## Context

\`OrderService.Submit\` saves every order as it is. Orders without a customer or lines end up in the database.

## Steps

1. **Create** \`OrderValidator\` with one method per rule
2. **Inject** it into \`OrderService\` and reject invalid orders early
3. **Cover** every rule with a unit test in \`OrderValidatorTests\`

| Rule | Error code |
|------|------------|
| Customer is set | \`CustomerRequired\` |
| At least one line | \`EmptyOrder\` |
| Quantities above zero | \`InvalidQuantity\` |

## Verification

Run \`dotnet test\`; the new tests and the existing 38 must pass.`;

const PLAN = `## Plan

I'll move the checks into a dedicated \`OrderValidator\` and call it from \`OrderService\` before anything is saved.

1. **Create** \`OrderValidator\` with one method per rule
2. **Inject** it into \`OrderService\` and reject invalid orders early
3. **Cover** every rule with a unit test

| Rule | Error code |
|------|------------|
| Customer is set | \`CustomerRequired\` |
| At least one line | \`EmptyOrder\` |
| Quantities above zero | \`InvalidQuantity\` |

\`\`\`csharp
public sealed class OrderValidator
{
    public ValidationResult Check(Order order)
    {
        if (order.CustomerId == Guid.Empty)
            return ValidationResult.Fail("CustomerRequired");
        if (order.Lines.Count == 0)
            return ValidationResult.Fail("EmptyOrder");
        // Quantities must be positive
        return order.Lines.All(l => l.Quantity > 0)
            ? ValidationResult.Ok
            : ValidationResult.Fail("InvalidQuantity");
    }
}
\`\`\`

> The service now fails fast, so nothing invalid reaches the repository.`;

const FLUENT = `Good question. **FluentValidation** would work, but for three rules it adds more than it saves:

- another dependency to keep up to date
- rules spread over lambdas instead of plain methods
- harder to step through in the debugger

If the rule set grows past a dozen checks, switching is cheap: \`OrderValidator\` is the only place that changes.`;

const DOCS = `Updated \`docs/orders.md\` with a section on validation and the three error codes.`;

const TESTS = `All **42 tests** pass, including the new ones:

- \`Check_rejects_missing_customer\`
- \`Check_rejects_empty_order\`
- \`Check_rejects_zero_quantity\`
- \`Submit_does_not_save_invalid_order\``;

const entries = [
  user("u1", "09:12", "Add input validation to OrderService before orders are saved"),
  tool("a1", "m1", "grep -rn Save src/Orders"),
  exitPlan("p1", "09:13", PLAN_V1),
  planResult(
    "p1",
    true,
    "The user doesn't want to proceed with this tool use. To tell you how to proceed, the user said:\nalso check that quantities are above zero, and add tests",
  ),
  exitPlan("p2", "09:15", PLAN_V2),
  planResult("p2", false, "User has approved your plan. You can now start coding."),
  assistant("a2", "m2", PLAN),
  user("u2", "09:18", "Why not use FluentValidation for this?"),
  assistant("a3", "m3", FLUENT),
  user("u3", "09:21", "Write unit tests for every rule"),
  assistant("a4", "m4", "Added `OrderValidatorTests` with one test per rule."),
  {
    type: "attachment",
    uuid: "q1",
    timestamp: "2026-09-26T09:22:00.000Z",
    attachment: { type: "queued_command", prompt: "also update the docs", origin: { kind: "human" }, humanTurn: true },
  },
  assistant("a5", "m5", DOCS),
  user("u4", "09:25", "Run the tests"),
  tool("a6", "m6", "dotnet test"),
  assistant("a7", "m7", TESTS),
];

const ORDER_SERVICE = `namespace Shop.Orders;

public sealed class OrderService
{
    private readonly IOrderRepository _orders;

    public OrderService(IOrderRepository orders)
    {
        _orders = orders;
    }

    public void Submit(Order order)
    {
        order.SubmittedAt = DateTime.UtcNow;
        _orders.Save(order);
    }
}
`;

const ORDER_SERVICE_NEW = `namespace Shop.Orders;

/// <summary>
/// Validates and stores submitted orders.
/// </summary>
public sealed class OrderService
{
    private readonly IOrderRepository _orders;
    private readonly OrderValidator _validator;

    public OrderService(IOrderRepository orders, OrderValidator validator)
    {
        _orders = orders;
        _validator = validator;
    }

    public void Submit(Order order)
    {
        var result = _validator.Check(order);
        if (!result.IsValid)
            throw new InvalidOrderException(result.Error);

        order.SubmittedAt = DateTime.UtcNow;
        _orders.Save(order);
    }
}
`;

const ORDER_VALIDATOR = `namespace Shop.Orders;

public sealed class OrderValidator
{
    public ValidationResult Check(Order order)
    {
        if (order.CustomerId == Guid.Empty)
            return ValidationResult.Fail("CustomerRequired");
        if (order.Lines.Count == 0)
            return ValidationResult.Fail("EmptyOrder");
        // Quantities must be positive
        return order.Lines.All(l => l.Quantity > 0)
            ? ValidationResult.Ok
            : ValidationResult.Fail("InvalidQuantity");
    }
}
`;

const TESTS_FILE = `namespace Shop.Orders.Tests;

public class OrderValidatorTests
{
    private readonly OrderValidator _validator = new();

    [Fact]
    public void Check_rejects_missing_customer()
    {
        var order = new Order { CustomerId = Guid.Empty };
        Assert.Equal("CustomerRequired", _validator.Check(order).Error);
    }
}
`;

/** Same rule as projectSlug in src/transcript/locate.ts. */
const slug = (path) => path.replace(/[^a-zA-Z0-9]/g, "-");

/**
 * An older session for the Sessions view: prompts, edits and plans at the
 * given times (ISO), recorded as Claude Code would for `cwd` on `branch`.
 */
function olderSession({ id, cwd, branch, title, steps }) {
  const lines = [];
  if (title) lines.push({ type: "custom-title", customTitle: title, sessionId: id });
  steps.forEach((step, i) => {
    const base = { uuid: `${id}-${i}`, timestamp: step.at, cwd, gitBranch: branch, sessionId: id };
    if (step.prompt) lines.push({ ...base, type: "user", message: { role: "user", content: step.prompt } });
    if (step.edit)
      lines.push({
        ...base,
        type: "assistant",
        message: { id: `m${i}`, role: "assistant", content: [{ type: "tool_use", id: `e${i}`, name: "Edit", input: { file_path: join(cwd, step.edit) } }] },
      });
    if (step.plan) {
      lines.push({
        ...base,
        type: "assistant",
        message: { id: `m${i}`, role: "assistant", content: [{ type: "tool_use", id: `p${i}`, name: "ExitPlanMode", input: { plan: step.plan } }] },
      });
      lines.push({
        ...base,
        uuid: `${id}-${i}r`,
        type: "user",
        message: { role: "user", content: [{ type: "tool_result", tool_use_id: `p${i}`, is_error: !!step.rejected, content: "" }] },
      });
    }
  });
  return lines;
}

const OLDER_SESSIONS = (shop, docs) => [
  {
    id: "3b1e0c55-7a42-4f0e-9d7c-2c1f5e8a9b10",
    cwd: shop,
    branch: "feature/checkout",
    title: "checkout-refactor",
    steps: [
      { at: "2026-09-24T12:05:00.000Z", prompt: "Split CheckoutService into payment and shipping" },
      { at: "2026-09-24T12:14:00.000Z", plan: "# Split CheckoutService\n\n1. Extract PaymentGateway\n2. Extract ShippingCalculator", rejected: true },
      { at: "2026-09-24T12:21:00.000Z", plan: "# Split CheckoutService\n\n1. Extract PaymentGateway\n2. Extract ShippingCalculator\n3. Keep the public API" },
      { at: "2026-09-24T12:40:00.000Z", edit: "src/Checkout/CheckoutService.cs" },
      { at: "2026-09-24T12:52:00.000Z", edit: "src/Checkout/PaymentGateway.cs" },
      { at: "2026-09-24T13:05:00.000Z", edit: "src/Checkout/ShippingCalculator.cs" },
      { at: "2026-09-24T13:31:00.000Z", prompt: "Run the checkout tests" },
      { at: "2026-09-24T13:40:00.000Z", prompt: "Commit it" },
    ],
  },
  {
    id: "9c4d7e21-1f3a-4b6c-8e2d-5a7b9c0d1e2f",
    cwd: docs,
    branch: "main",
    steps: [
      { at: "2026-09-25T07:30:00.000Z", prompt: "Document the new order validation rules" },
      { at: "2026-09-25T07:44:00.000Z", edit: "docs/orders.md" },
      { at: "2026-09-25T07:52:00.000Z", prompt: "Link it from the index page" },
      { at: "2026-09-25T07:55:00.000Z", edit: "docs/index.md" },
    ],
  },
  {
    id: "5e8f2a90-3c4b-4d7e-a1f2-6b3c8d9e0a14",
    cwd: shop,
    branch: "main",
    title: "flaky-tests",
    steps: [
      { at: "2026-09-25T14:10:00.000Z", prompt: "OrderRepositoryTests fail every few runs, find out why" },
      { at: "2026-09-25T14:26:00.000Z", edit: "tests/Orders/OrderRepositoryTests.cs" },
      { at: "2026-09-25T14:31:00.000Z", prompt: "Make the clock injectable instead" },
      { at: "2026-09-25T14:48:00.000Z", edit: "src/Orders/OrderRepository.cs" },
    ],
  },
];

/**
 * A month of API responses for the Monitor view, ending on the demo day
 * (2026-09-26, local time): mornings faster than usual, a slow afternoon and
 * one usage limit error. Written as a subagent transcript of the current
 * session, which only the Monitor reads.
 */
function monitorHistory() {
  let seed = 42;
  const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const lines = [];
  const DAYS = 31;
  for (let back = DAYS - 1; back >= 0; back--) {
    const date = new Date(2026, 8, 26 - back);
    if (back > 0 && (date.getDay() === 0 || date.getDay() === 6)) continue;
    const demoDay = back === 0;
    for (let minute = 8 * 60 + Math.floor(random() * 30); minute < 19 * 60; minute += 2 + Math.floor(random() * 5)) {
      const hour = minute / 60;
      // Usual: ~70 tokens/s, slower while the US is awake. The demo day is quicker in the morning and slower after 14:00.
      let speed = 70 - (hour > 15 ? 18 : 0) + (random() - 0.5) * 30;
      if (demoDay) speed *= hour < 12 ? 1.25 : hour >= 14 && hour < 17 ? 0.6 : 1;
      const wait = (demoDay && hour >= 14 && hour < 17 ? 5 : 2) + random() * 3;
      const tokens = 150 + Math.floor(random() * 900);
      const start = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, minute, Math.floor(random() * 60));
      const first = new Date(start.getTime() + wait * 1000);
      const end = new Date(start.getTime() + (wait + tokens / speed) * 1000);
      const id = `msg_${lines.length}`;
      const model = random() < 0.8 ? "claude-opus-5-5" : "claude-sonnet-5";
      const base = { isSidechain: true, sessionId: SESSION };
      lines.push({ ...base, type: "user", timestamp: start.toISOString(), message: { role: "user", content: "…" } });
      for (const [at, out] of [[first, 1], [end, tokens]]) {
        lines.push({ ...base, type: "assistant", timestamp: at.toISOString(), message: { id, model, role: "assistant", content: [], usage: { output_tokens: out } } });
      }
    }
    if (demoDay) {
      lines.push({
        isSidechain: true,
        sessionId: SESSION,
        type: "assistant",
        isApiErrorMessage: true,
        timestamp: new Date(2026, 8, 26, 15, 42).toISOString(),
        message: { model: "<synthetic>", role: "assistant", content: [{ type: "text", text: "API Error: Rate limit reached" }] },
      });
    }
  }
  return lines;
}

export function createDemo(root) {
  const cwd = join(root, "shop");
  const configDir = join(root, "claude");

  const projectDir = join(configDir, "projects", slug(cwd));
  mkdirSync(projectDir, { recursive: true });
  // Claude Code records the folder and branch on every entry; the Sessions view shows them.
  const current = [
    { type: "custom-title", customTitle: "order-validation", sessionId: SESSION },
    ...entries.map((e) => ({ ...e, cwd, gitBranch: "main", sessionId: SESSION })),
  ];
  writeFileSync(join(projectDir, `${SESSION}.jsonl`), current.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const subagents = join(projectDir, SESSION, "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(subagents, "agent-history.jsonl"), monitorHistory().map((e) => JSON.stringify(e)).join("\n") + "\n");

  const docs = join(root, "docs-site");
  for (const session of OLDER_SESSIONS(cwd, docs)) {
    const dir = join(configDir, "projects", slug(session.cwd));
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${session.id}.jsonl`);
    writeFileSync(file, olderSession(session).map((e) => JSON.stringify(e)).join("\n") + "\n");
    // Older than the current session, which the viewer (without hooks) takes as the newest transcript.
    const last = new Date(session.steps.at(-1).at);
    utimesSync(file, last, last);
  }

  const write = (file, text) => {
    mkdirSync(join(cwd, file, ".."), { recursive: true });
    writeFileSync(join(cwd, file), text);
  };
  const git = (...args) =>
    execFileSync("git", ["-c", "user.name=demo", "-c", "user.email=demo@example.com", ...args], {
      cwd,
      stdio: "ignore",
    });

  write("src/Orders/OrderService.cs", ORDER_SERVICE);
  git("init", "-q", "-b", "main");
  git("add", ".");
  git("commit", "-q", "-m", "Initial commit");
  write("src/Orders/OrderService.cs", ORDER_SERVICE_NEW);
  write("src/Orders/OrderValidator.cs", ORDER_VALIDATOR);
  git("add", "src/Orders/OrderValidator.cs");
  write("tests/Orders/OrderValidatorTests.cs", TESTS_FILE);

  return { cwd, configDir };
}
