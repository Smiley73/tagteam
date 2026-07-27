#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const DETAILS = ({ shipId = "-", pr = "-", branch = "-", sha = "-", command = "-", artifact = "-" }) =>
  `Details: ship ${shipId}; PR ${pr}; branch ${branch}; commit ${sha}; command ${command}; artifact ${artifact}`;

export const messages = {
  reviewFailed(context) {
    return [
      "One or more checks did not return a usable review.",
      "The change is not considered ready to merge.",
      "Open the review file, resolve the failed checks, then resume the ship.",
      DETAILS(context)
    ].join("\n");
  },
  userVisible(context, planAnswer, shipAnswer) {
    return [
      `This change may be noticeable to people using the product (plan: ${planAnswer}; actual change: ${shipAnswer}).`,
      "It will wait for you instead of merging on its own.",
      "Review the pull request, then choose whether to merge it or send it back.",
      DETAILS(context)
    ].join("\n");
  },
  noEvidence(context) {
    return [
      "No automated test command applied, and no continuous-integration check ran.",
      "There is no executable evidence for this change.",
      "Review the pull request and approve it manually before it can merge.",
      DETAILS(context)
    ].join("\n");
  },
  singleProvider(context) {
    return [
      "This change was completed and reviewed with one substantive provider.",
      "It has fresh review coverage, but not independent cross-provider confirmation.",
      "Review the pull request and approve this exact candidate before it can merge.",
      DETAILS(context)
    ].join("\n");
  },
  unprotectedBase(context) {
    return [
      "The destination branch does not prevent direct pushes.",
      "Tagteam cannot guarantee that the reviewed base stays unchanged, so it will not merge automatically.",
      "Enable pull-request protection for the destination branch, or merge the ready pull request yourself.",
      DETAILS(context)
    ].join("\n");
  },
  mergeFailed(context) {
    return [
      "GitHub did not confirm the reviewed commit was merged onto the reviewed base.",
      "The train has stopped before starting another change.",
      "Inspect the pull request and the recorded merge details, then resume only after reconciling them.",
      DETAILS(context)
    ].join("\n");
  },
  verificationFailed(context) {
    return [
      "Local verification still fails after its repair attempt.",
      "The reviewed change will not be published or merged.",
      "Inspect the saved verification result, repair the change, then resume the ship.",
      DETAILS(context)
    ].join("\n");
  },
  ciFailed(context) {
    return [
      "A continuous-integration check failed and the automated repair did not clear it.",
      "The change will not merge while that check is failing.",
      "Inspect the failed-check log, repair the change, then resume the ship.",
      DETAILS(context)
    ].join("\n");
  },
  agentBudget(context) {
    return [
      "This change reached its configured model-call limit before all checks completed.",
      "The change is paused with its branch and evidence intact.",
      "Review the saved artifacts and raise the limit or narrow the work before resuming.",
      DETAILS(context)
    ].join("\n");
  },
  relayLost(context) {
    return [
      "A finished check could not be handed back to the run, even after re-reading it.",
      "The work itself is safe: its result is saved and will be reused instead of paid for again.",
      "Run the same command again with --resume to continue from the saved work.",
      DETAILS(context)
    ].join("\n");
  },
  planInterrupted(context) {
    return [
      "Planning stopped before the plan was ready to approve.",
      "The drafting and checking done so far is saved and nothing has been approved.",
      "Run the same plan command again with --resume to continue from the saved work.",
      DETAILS(context)
    ].join("\n");
  },
  configStale(context) {
    return [
      "This project's tagteam settings were written by an earlier version of tagteam.",
      "Tagteam now asks how much say you want over the look and feel of user-facing changes, and this project has no answer on file.",
      "Run the upgrade command to answer only the new questions; every existing choice is kept.",
      DETAILS(context)
    ].join("\n");
  },
  // Ship continues on settings that predate the interface questions, so this
  // is a single sentence said once, not the four-line stop that plan renders.
  configStaleShip(context) {
    return [
      "This project has no answer on file for how much say you want over the look and feel of user-facing changes, so this change will not stop to ask; the pull request still waits for you when the change is noticeable.",
      DETAILS(context)
    ].join("\n");
  },
  fixFailed(context) {
    return [
      "An automated repair stopped before it could produce a complete, recorded candidate.",
      "The worktree may contain partial edits and the change will not continue.",
      "Reconcile the worktree with the recorded candidate, then resume the ship.",
      DETAILS(context)
    ].join("\n");
  }
};

function parseArgs(argv) {
  const [key, ...rest] = argv;
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (!flag?.startsWith("--") || rest[index + 1] === undefined) throw new Error(`invalid argument: ${flag ?? "(missing)"}`);
    const name = flag.slice(2).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    values[name] = rest[index + 1];
  }
  return { key, values };
}

async function main() {
  try {
    const { key, values } = parseArgs(process.argv.slice(2));
    if (!key || typeof messages[key] !== "function") {
      throw new Error(`usage: messages.mjs <${Object.keys(messages).join("|")}> --ship-id <id> --pr <number> --branch <name> --sha <oid> --command <command> --artifact <path>`);
    }
    const context = {
      shipId: values.shipId,
      pr: values.pr,
      branch: values.branch,
      sha: values.sha,
      command: values.command,
      artifact: values.artifact
    };
    const rendered = key === "userVisible"
      ? messages[key](context, values.planAnswer ?? "unknown", values.shipAnswer ?? "unknown")
      : messages[key](context);
    process.stdout.write(`${rendered}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
