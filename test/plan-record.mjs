// Records a plan set the way the driver does, for the suites that stage a plan
// at an order the driver itself would not reach. Not a suite: it asserts nothing.
//   plan-record.mjs <plan-dir> <kind> '<[{"label":…,"output":…}, …]>'
import { arriveCommand } from "../scripts/dispatch-set.mjs";
import { recordPlanSet } from "../scripts/lib/plan-sets.mjs";
import { planCallForLabel } from "../scripts/plan.mjs";

const [planDir, kind, agents] = process.argv.slice(2);
try {
  const sent = await recordPlanSet({ planDir, kind, agents: JSON.parse(agents), callForLabel: planCallForLabel });
  process.stdout.write(`${JSON.stringify({ set: { id: sent.id, labels: sent.labels, arrive: arriveCommand(sent.dir, sent.id) }, next: sent.record.next })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = error.exitCode ?? 1;
}
