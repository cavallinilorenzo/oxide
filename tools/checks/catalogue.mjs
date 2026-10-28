// The Check catalogue: the one place where "what runs" and "why" meet.
// Three faces: `plan` (what to run here), `conformance` (do workflows and
// docs agree with the catalogue) and `evaluateGate` (the CI `gate` verdict).
// Everything here is pure; run.mjs reads files and spawns processes.

const TIERS = ["fast", "pr", "daily", "release"];
const PLATFORMS = ["macos", "windows", "linux"];
const PLATFORM_LABEL = { macos: "macOS", windows: "Windows", linux: "Linux" };

export function validateCatalogue(catalogue) {
  const problems = [];
  const seen = new Set();
  for (const check of catalogue.checks) {
    const label = `check "${check.id}"`;
    if (seen.has(check.id)) problems.push(`duplicate id "${check.id}"`);
    seen.add(check.id);
    if (!check.name?.trim()) problems.push(`${label} needs a name`);
    if (!check.why?.trim()) problems.push(`${label} needs a non-empty why`);
    if (check.command !== null && !(Array.isArray(check.command) && check.command.length > 0)) {
      problems.push(`${label} command must be an argv array, or null when it only runs on GitHub`);
    }
    if (!check.tiers?.length || check.tiers.some((tier) => !TIERS.includes(tier))) {
      problems.push(`${label} tiers must be a non-empty subset of ${TIERS.join(", ")}`);
    }
    if (!check.platforms?.length || check.platforms.some((p) => !PLATFORMS.includes(p))) {
      problems.push(`${label} platforms must be a non-empty subset of ${PLATFORMS.join(", ")}`);
    }
    if (typeof check.blocking !== "boolean") problems.push(`${label} blocking must be a boolean`);
  }
  return problems;
}

function skipReason(check, { platform, event }) {
  if (check.events && !check.events.includes(event)) {
    return `only runs on ${check.events.join("/")} events`;
  }
  if (check.command === null) return "runs only on GitHub";
  if (!check.platforms.includes(platform)) {
    const only = check.platforms.length === 1 ? `${PLATFORM_LABEL[check.platforms[0]]} only` : null;
    return only ?? `not run on ${PLATFORM_LABEL[platform]} (runs on ${check.platforms.map((p) => PLATFORM_LABEL[p]).join(", ")})`;
  }
  return null;
}

// `target` is a tier name or a check id. Returns the ordered checks to run and
// the ones skipped, each with a reason. A single check named by id that cannot
// run here is reported as skipped too, never silently dropped.
export function plan(catalogue, { target, platform, event }) {
  const byId = catalogue.checks.find((check) => check.id === target);
  const selected = byId ? [byId] : TIERS.includes(target) ? catalogue.checks.filter((c) => c.tiers.includes(target)) : null;
  if (!selected) {
    const valid = [...catalogue.checks.map((c) => c.id), ...TIERS.filter((t) => t === "fast" || t === "pr")];
    throw new Error(`Unknown target "${target}". Valid targets: ${valid.join(", ")}`);
  }
  const run = [];
  const skipped = [];
  for (const check of selected) {
    const reason = skipReason(check, { platform, event });
    if (reason) skipped.push({ check, reason });
    else run.push({ check });
  }
  return { run, skipped };
}

// Reports every disagreement between the catalogue, the parsed workflows
// (`[{ file, doc }]`) and the DevOps guide text. An empty list means they agree.
export function conformance({ catalogue, workflows, guide }) {
  const problems = [];
  const jobKey = (workflow, id) => `${workflow}#${id}`;
  const claimed = new Map(catalogue.checks.filter((c) => c.job).map((c) => [jobKey(c.job.workflow, c.job.id), c]));
  const existing = new Set();

  for (const { file, doc } of workflows) {
    const gateNeeds = [doc.jobs?.gate?.needs ?? []].flat();
    for (const id of Object.keys(doc.jobs ?? {})) {
      existing.add(jobKey(file, id));
      if (id === "gate") continue;
      if (!claimed.has(jobKey(file, id))) problems.push(`${file} job "${id}" has no catalogue entry`);
    }
    if (doc.jobs?.gate) {
      for (const check of catalogue.checks) {
        if (check.job?.workflow !== file || !check.blocking || !check.tiers.includes("pr")) continue;
        if (existing.has(jobKey(file, check.job.id)) && !gateNeeds.includes(check.job.id)) {
          problems.push(`check "${check.id}" is blocking but ${file} job "${check.job.id}" is not in gate needs`);
        }
      }
    }
  }

  for (const check of catalogue.checks) {
    if (!check.why?.trim()) problems.push(`check "${check.id}" has an empty why`);
    const needsJob = check.tiers.some((tier) => tier !== "fast");
    if (needsJob && !(check.job && existing.has(jobKey(check.job.workflow, check.job.id)))) {
      problems.push(`check "${check.id}" is in the catalogue but no workflow runs it`);
    }
    if (!guide.includes(`\`${check.id}\``)) {
      problems.push(`check "${check.id}" has no section in the DevOps guide`);
    }
  }
  return problems;
}

// `results` maps each job `gate` needs to its result. `skippedOn` lists, per
// job, the events where being skipped is by design. Anything but success is a
// failure otherwise, so a job that never ran cannot count as green.
export function evaluateGate({ results, event, skippedOn = {} }) {
  const bad = Object.entries(results)
    .filter(([job, result]) => result !== "success" && !(result === "skipped" && skippedOn[job]?.includes(event)))
    .map(([job, result]) => `${job} (${result})`);
  if (bad.length > 0) return { ok: false, message: `gate failed: ${bad.join(", ")}` };
  return { ok: true, message: "gate passed: every job succeeded" };
}
