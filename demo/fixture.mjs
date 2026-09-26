// Builds a self-contained demo: a fake Claude Code config dir with one session
// transcript, and a small C# git repository with uncommitted changes.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
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
  message: { id, role: "assistant", content: [{ type: "text", text }] },
});
const tool = (uuid, id, command) => ({
  type: "assistant",
  uuid,
  message: { id, role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command } }] },
});

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

export function createDemo(root) {
  const cwd = join(root, "shop");
  const configDir = join(root, "claude");

  const projectDir = join(configDir, "projects", slug(cwd));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");

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
