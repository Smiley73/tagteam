const SEVERITY_RANK = { nit: 0, minor: 1, major: 2, blocking: 3 };

export function fnv1a(value) {
  let hash = 0x811c9dc5;
  for (const byte of Buffer.from(String(value))) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function titleSlug(title) {
  return String(title).toLocaleLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function findingId(finding) {
  const key = [
    String(finding.dimension ?? "").toLocaleLowerCase(),
    String(finding.file ?? "").replaceAll("\\", "/").toLocaleLowerCase(),
    titleSlug(finding.title)
  ].join("|");
  return `TT-${fnv1a(key)}`;
}

function overlaps(left, right) {
  return Number(left.line_start) <= Number(right.line_end) && Number(right.line_start) <= Number(left.line_end);
}

function sameFinding(left, right) {
  if (left.dimension !== right.dimension || left.file !== right.file) return false;
  return titleSlug(left.title) === titleSlug(right.title) || overlaps(left, right);
}

export function mergeFindings(existing, incoming, { engine, round }) {
  const ledger = existing.map((finding) => ({ ...finding }));
  for (const raw of incoming) {
    const finding = {
      ...raw,
      id: raw.id?.startsWith("TT-") ? raw.id : findingId(raw),
      engine,
      round,
      status: raw.status ?? "open",
      occurrences: raw.occurrences ?? 1
    };
    const prior = ledger.find((candidate) => sameFinding(candidate, finding));
    if (!prior) {
      ledger.push(finding);
      continue;
    }
    prior.occurrences += 1;
    prior.lastSeenRound = round;
    prior.engines = [...new Set([...(prior.engines ?? [prior.engine]), engine])];
    if (prior.status === "fixed") prior.status = "recurring";
    if (SEVERITY_RANK[finding.severity] > SEVERITY_RANK[prior.severity]) prior.severity = finding.severity;
    if (finding.confidence > prior.confidence) prior.confidence = finding.confidence;
  }
  return ledger;
}

export function actionableFindings(ledger) {
  return ledger.filter((finding) =>
    (finding.status === "open" || finding.status === "recurring" || finding.status === "needs-human")
    && (finding.severity === "blocking" || finding.severity === "major")
  );
}

export function deferredFindings(ledger) {
  return ledger.filter((finding) =>
    (finding.status === "open" || finding.status === "recurring")
    && (finding.severity === "minor" || finding.severity === "nit")
  );
}

export function applyFixReport(ledger, report) {
  const byId = new Map((report.results ?? []).map((item) => [item.id, item]));
  return ledger.map((finding) => {
    const result = byId.get(finding.id);
    if (!result) return finding;
    const status = result.status === "fixed"
      ? "fixed"
      : result.status === "wont-fix" && (finding.severity === "minor" || finding.severity === "nit")
        ? "wont-fix"
        : result.status === "wont-fix"
          ? "needs-human"
          : "fix-failed";
    return { ...finding, status, fixExplanation: result.explanation };
  });
}

export function tallies(ledger) {
  const result = { total: ledger.length, bySeverity: {}, byDimension: {}, byEngine: {}, byStatus: {} };
  for (const finding of ledger) {
    for (const [bucket, key] of [
      ["bySeverity", finding.severity],
      ["byDimension", finding.dimension],
      ["byEngine", finding.engine],
      ["byStatus", finding.status]
    ]) {
      result[bucket][key] = (result[bucket][key] ?? 0) + 1;
    }
  }
  return result;
}
