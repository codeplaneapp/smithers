export function buttonLabelForRunState(runState) {
  if (runState === "running") return "Cancel";
  if (runState === "done") return "Done";
  return "Run Workflow";
}

export function statusIdForRole(role) {
  if (role === "judge-final") return "judge_final";
  return role.replaceAll("-", "_");
}
