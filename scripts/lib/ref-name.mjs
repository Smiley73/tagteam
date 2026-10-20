// A name that becomes a Git ref, held to git-check-ref-format's rules and kept
// free of anything a shell would act on: no space, no ~^:?*[\, no control
// characters, no "..", no "@{", no trailing ".lock". Everything a shell would act
// on is excluded by that set and the metacharacter check after it.
//
// Two callers, one rule: the configuration validator, for `base` and
// `branchPrefix`, and the ship driver, for the plan branch it is about to create
// from a plan directory's name. `prefix` is for a branch prefix, which
// legitimately ends in "/" and so is checked as the ref it will become rather
// than as one itself.
export function refNameErrors(label, ref, { prefix = false } = {}) {
  const errors = [];
  if (ref.startsWith("/") || ref.startsWith("-") || ref.split("/").includes("..")) {
    errors.push(`${label} must be a conventional relative Git ref without traversal`);
  }
  const name = prefix ? ref.replace(/\/$/, "") : ref;
  if (/[\u0000- ~^:?*[\]\\]/.test(name)
    || name.includes("..") || name.includes("@{") || name.includes("//")
    || name === "@" || name.endsWith(".") || name.endsWith("/")
    || name.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock") || part === "")) {
    errors.push(`${label} is not a valid Git ref name: ${JSON.stringify(ref)}`);
  }
  if (/[$`"'&;|<>(){}!#]/.test(ref)) {
    errors.push(`${label} may not contain shell metacharacters: ${JSON.stringify(ref)}`);
  }
  if (ref.endsWith(".lock")) errors.push(`${label} may not end in .lock`);
  return errors;
}
